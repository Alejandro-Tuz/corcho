/**
 * Conexión WebSocket a `/ws/{room}`: apertura, reconexión con backoff, heartbeat, y el
 * envío -normal (encolado si hace falta) o efímero (descartado si hace falta)-. No
 * conoce ninguna forma de dato de negocio, solo el envelope de `protocol.ts`; qué
 * hacer con cada evento es de `dispatch.ts` y `store/` (mismo reparto que
 * `handlers.py` despacha / `services/` implementa en el backend).
 *
 * ## Cola de reenvío, acotada a propósito
 *
 * Solo se encola lo que **nunca llegó a salir**: si `send()` se llama con el socket ya
 * `OPEN`, ese mensaje se considera irrecuperablemente enviado. Si la conexión se corta
 * un instante después, no hay forma de saber si el servidor lo procesó o no, y
 * reintentarlo a ciegas puede duplicar una acción (`note.create` con el mismo `id`
 * chocaría contra la PK en Postgres). Esa ambigüedad la resuelve la reconciliación
 * optimista del store (`pendingNoteOps`), no un reintento de transporte.
 *
 * Los eventos efímeros (`presence.*`, `chat.typing`) nunca se encolan -un cursor viejo
 * reenviado tras reconectar es peor que no mandar nada, la próxima posición ya está en
 * camino-. Esto se fuerza a nivel de tipos con `DurableClientEvent`/`EphemeralClientEvent`,
 * no solo con disciplina: `send()` no acepta un evento efímero ni `sendEphemeral()`
 * uno durable, error de compilación en los dos sentidos.
 *
 * ## Heartbeat
 *
 * Cada `HEARTBEAT_INTERVAL_MS` se manda `ping` si el socket está `OPEN`. Si pasan
 * `HEARTBEAT_TIMEOUT_MS` sin recibir *ningún* mensaje del servidor -no hace falta que
 * sea específicamente `pong`, cualquier evento entrante ya prueba que la conexión
 * sigue viva-, se fuerza el cierre del socket. Sin esto, un corte a mitad de camino
 * (un proxy que mata conexiones idle, WiFi que se degrada) puede dejar un WebSocket
 * que el navegador todavía reporta `OPEN` pero que no lleva nada a ningún lado.
 *
 * ## Reconexión
 *
 * Backoff exponencial desde `BACKOFF_INITIAL_MS`, tope `BACKOFF_MAX_MS`, reiniciado
 * recién cuando se confirma `room.snapshot` -no en el `onopen` del WebSocket: abrir la
 * conexión no significa que el `room.join` haya funcionado-. Dos casos que NO
 * reintentan: un cierre intencional (`close()` llamado por la app) y
 * `code === 4004` (sala inexistente, decisión ya tomada en `endpoint.py` -el slug no
 * va a empezar a existir por reintentar-), que pasan a `status: 'room_not_found'`.
 */

import type { ClientEvent, Ping, RoomJoinIn, ServerEvent } from './protocol'
import { EPHEMERAL_EVENT_TYPES } from './protocol'
import type { StoredIdentity } from '../lib/identity'

type EphemeralType = (typeof EPHEMERAL_EVENT_TYPES)[number]

/** Todo lo que se puede mandar con `send()`: se encola si el socket no está `OPEN`. */
export type DurableClientEvent = Exclude<ClientEvent, RoomJoinIn | Ping | { type: EphemeralType }>

/** Todo lo que se manda con `sendEphemeral()`: se descarta -nunca se encola- si el
 * socket no está `OPEN`. */
export type EphemeralClientEvent = Extract<ClientEvent, { type: EphemeralType }>

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'room_not_found'

export interface RoomSocket {
  status(): ConnectionStatus
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void
  onEvent(cb: (event: ServerEvent) => void): () => void
  send(event: DurableClientEvent): void
  sendEphemeral(event: EphemeralClientEvent): void
  /** Desconexión intencional (salir de la sala): no dispara reconexión. */
  close(): void
}

const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 10_000
const BACKOFF_INITIAL_MS = 500
const BACKOFF_MAX_MS = 8_000
const ROOM_NOT_FOUND_CLOSE_CODE = 4004

export function connectToRoom(room: string, identity: StoredIdentity): RoomSocket {
  let ws: WebSocket | null = null
  let status: ConnectionStatus = 'connecting'
  let intentionalClose = false
  let backoffMs = BACKOFF_INITIAL_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null
  // Confirmado por el primer room.snapshot; hasta entonces, lo que trajo `identity`
  // (null en la primera visita a la sala). Sin este seguimiento propio, cada
  // reconexión mandaría room.join con participant_id=null de nuevo y el servidor
  // crearía un participante nuevo en vez de reactivar el original (CLAUDE.md:
  // "sin esto, cada reconexión huerfaniza los cupos y las notas de esa persona").
  let participantId: string | null = identity.participantId

  const outbox: DurableClientEvent[] = []
  const statusListeners = new Set<(status: ConnectionStatus) => void>()
  const eventListeners = new Set<(event: ServerEvent) => void>()

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return
    status = next
    for (const cb of statusListeners) cb(next)
  }

  function sendRaw(event: ClientEvent): void {
    ws?.send(JSON.stringify(event))
  }

  function open(): void {
    const socket = new WebSocket(wsUrl(room))
    ws = socket
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    // Sin listener de 'error': en el WebSocket del navegador siempre le sigue un
    // 'close', que es donde se decide la reconexión (evita disparar el reintento
    // dos veces por el mismo corte).
    socket.addEventListener('close', handleClose)
  }

  function handleOpen(): void {
    sendRaw({
      type: 'room.join',
      participant_id: participantId,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
    })
    startHeartbeat()
  }

  function handleMessage(ev: MessageEvent<unknown>): void {
    resetHeartbeatWatchdog()

    const event = parseServerEvent(ev.data)
    if (event === null) return // no valida contra el envelope: se ignora, no tumba nada
    if (event.type === 'pong') return // el heartbeat ya se resolvió arriba, nadie más lo necesita

    const isSnapshot = event.type === 'room.snapshot'
    if (isSnapshot) {
      participantId = event.participant_id
      backoffMs = BACKOFF_INITIAL_MS
      setStatus('connected')
    }

    for (const cb of eventListeners) cb(event)

    if (isSnapshot) flushOutbox()
  }

  function handleClose(ev: CloseEvent): void {
    stopHeartbeat()
    ws = null
    if (intentionalClose) return
    if (ev.code === ROOM_NOT_FOUND_CLOSE_CODE) {
      setStatus('room_not_found')
      return
    }
    setStatus('reconnecting')
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    reconnectTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
      open()
    }, backoffMs)
  }

  function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
      sendRaw({ type: 'ping' })
      armHeartbeatWatchdog()
    }, HEARTBEAT_INTERVAL_MS)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
    if (heartbeatWatchdog !== null) clearTimeout(heartbeatWatchdog)
    heartbeatTimer = null
    heartbeatWatchdog = null
  }

  function armHeartbeatWatchdog(): void {
    if (heartbeatWatchdog !== null) clearTimeout(heartbeatWatchdog)
    heartbeatWatchdog = setTimeout(() => {
      // Silencio total tras un ping: la conexión está a medio morir aunque el
      // navegador todavía la reporte OPEN. Forzar el cierre dispara handleClose ->
      // reconexión, en vez de quedarse "conectado" mintiendo.
      ws?.close()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  function resetHeartbeatWatchdog(): void {
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog)
      heartbeatWatchdog = null
    }
  }

  function flushOutbox(): void {
    while (outbox.length > 0) {
      const event = outbox.shift()
      if (event !== undefined) sendRaw(event)
    }
  }

  open()

  return {
    status: () => status,
    onStatusChange(cb) {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    onEvent(cb) {
      eventListeners.add(cb)
      return () => eventListeners.delete(cb)
    },
    send(event) {
      if (ws?.readyState === WebSocket.OPEN && status === 'connected') {
        sendRaw(event)
      } else {
        outbox.push(event)
      }
    },
    sendEphemeral(event) {
      // Nunca se encola: si no está listo para mandarlo ya, mandarlo tarde es peor
      // que no mandarlo (ver docstring del módulo).
      if (ws?.readyState === WebSocket.OPEN && status === 'connected') {
        sendRaw(event)
      }
    },
    close() {
      intentionalClose = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      stopHeartbeat()
      ws?.close()
    },
  }
}

function wsUrl(room: string): string {
  // VITE_WS_URL es el escape hatch para producción (Render): wiring pendiente de
  // cuándo se aborde el deploy. El default asume el backend en el puerto 8000 del
  // mismo host -sirve sin configuración para `npm run dev` contra
  // `uvicorn app.main:app --reload` local, que es el único entorno que importa hoy.
  const configured = import.meta.env.VITE_WS_URL as string | undefined
  if (configured !== undefined) return `${configured}/ws/${room}`
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.hostname}:8000/ws/${room}`
}

/**
 * Sin librería de validación de esquemas (no hay una en el proyecto, y no se
 * justifica solo para esto): se confía en la forma que manda el propio backend -a
 * diferencia de `protocol.py` validando lo que manda el cliente, acá el emisor es el
 * mismo equipo, no una entrada adversaria-. Chequeo mínimo: JSON parseable con un
 * `type` de tipo string: alcanza para no reventar ante un mensaje corrupto o una
 * conexión a un servidor equivocado.
 */
function parseServerEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      typeof (parsed as { type: unknown }).type === 'string'
    ) {
      return parsed as ServerEvent
    }
    return null
  } catch {
    return null
  }
}
