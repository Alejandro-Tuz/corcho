/**
 * El estado de una sala, en un solo sitio (store/, según la estructura de CLAUDE.md).
 * Sin librería nueva: React 19 trae `useSyncExternalStore`, que es exactamente el
 * contrato que hace falta para un store externo al árbol de componentes -no se
 * justifica una dependencia para lo que ya viene con React (CLAUDE.md: "no agregar
 * dependencias sin decirlo explícitamente y justificar por qué no alcanza con lo que
 * ya hay").
 *
 * `createRoomStore(room, identity)` arma la conexión (`socket.ts`), el estado inicial,
 * y cablea `socket.onEvent` -> `dispatch.ts` -> los métodos `applyX` de acá adentro.
 * Ese cableado vive en un solo lugar, acá, no repartido.
 *
 * Dos mitades, una sola implementación:
 * - `RoomCommands` (exportado hacia afuera como `store.actions`): lo que un
 *   componente llama para HACER algo. Mutación optimista + `socket.send()` en el
 *   mismo método -nunca dos llamadas separadas que un componente pueda desincronizar.
 * - `RoomApplyActions` (privado, solo lo usa el `dispatch()` cableado acá adentro):
 *   lo que corrige/confirma cuando llega la respuesta real del servidor.
 *
 * ## Estado optimista con reconciliación (invariante 7)
 *
 * Cada acción sobre una nota deja un `PendingNoteOp` en `pendingNoteOps[id]`. Si se
 * confirma, se pisa con los valores autoritativos y se borra el pending. Si se
 * rechaza (evento tipado como `note.claim_rejected`, o un `error` genérico con ese
 * `note_id`), `rollbackPendingOp` deshace -el rebote que pide la invariante-.
 *
 * Dos excepciones a "mutar `notes[id]` al instante", las dos por la misma clase de
 * motivo -ver el docstring de `PendingNoteOp` en `store/types.ts` para el detalle
 * completo de cada una-:
 *
 * - `claim`/`release` no tocan `taken_count`/`claims` hasta que confirma el
 *   servidor: es un contador COMPARTIDO, y mezclar mi incremento optimista con la
 *   confirmación de otra persona en la misma carrera no tiene una forma robusta de
 *   deshacerse (bug real encontrado con dos pestañas en carrera de verdad por el
 *   mismo cupo). `pending` solo deshabilita el botón mientras se espera.
 * - `note.delete` NO borra la nota de `notes` de entrada, solo marca
 *   `pendingNoteOps[id] = {kind:'delete'}` para que la UI deshabilite el control
 *   mientras tanto. Borrar optimistamente y tener que hacerla reaparecer ante un
 *   rechazo es más parpadeo que beneficio -a diferencia de crear o mover, achicar no
 *   tiene nada de "instantáneo" que ganar-, y de paso deja el enganche que el pulido
 *   del día 3 va a necesitar tal cual ("se elimina del store al terminar la
 *   animación, no al recibir el evento": hoy sin animación se borra apenas confirma
 *   el servidor; el día 3 alguien intercepta este mismo punto para animar antes).
 */

import { useSyncExternalStore } from 'react'
import type {
  Background,
  ChatMessageOut,
  ChatMessageState,
  ChatTypingOut,
  ErrorEvent,
  NoteClaimOut,
  NoteClaimRejected,
  NoteColor,
  NoteCreateOut,
  NoteDeleteOut,
  NoteKind,
  NoteMoveOut,
  NoteReleaseOut,
  NoteReleaseRejected,
  NoteState,
  NoteStatus,
  NoteUpdateOut,
  ParticipantState,
  PresenceCursorOut,
  PresenceDraftingOut,
  PresenceDraggingOut,
  PresenceJoined,
  PresenceLeft,
  Reaction,
  ReactionToggleOut,
  RoomBackgroundOut,
  RoomSnapshot,
  RoomSummary,
  RoomSummaryRejected,
  RoomSummaryRequested,
} from '../realtime/protocol'
import { connectToRoom } from '../realtime/socket'
import { dispatch } from '../realtime/dispatch'
import { saveIdentity } from '../lib/identity'
import type { StoredIdentity } from '../lib/identity'
import { createInitialState } from './types'
import type { RoomApplyActions, RoomCommands, RoomState } from './types'
import {
  appendActivity,
  BACKGROUND_LABELS,
  noteKindLabel,
  previewNoteText,
  STATUS_LABELS,
} from './activity'

/** Un poco por encima de la duración de la animación CSS `note-fall`
 * (Note.css) -ver el comentario en `applyNoteDelete`. */
const FALLING_NOTE_DURATION_MS = 650

/** Cuánto queda visible un rechazo/falla del resumen con IA antes de limpiarse solo
 * -mismo patrón que `fallingNotes`: el store se encarga del timeout, no el
 * componente que lo muestra (`RoomSummaryButton.tsx`). */
const SUMMARY_NOTICE_DURATION_MS = 5000

/** Red de seguridad para `chat.typing`, no el mecanismo principal -ver
 * `applyChatTyping` más abajo y el docstring de `ChatPanel.tsx` (Composer) sobre la
 * capa 1, del lado de quien escribe. Más larga que el intervalo de refresco de esa
 * capa (3s) a propósito: en el camino normal, un `active:false` explícito o un
 * refresco llegan primero y este timeout ni se nota. Solo actúa cuando algo se
 * perdió -la pestaña de quien escribía se cerró de golpe, un paquete se perdió. */
const TYPING_STALE_MS = 6000

export interface RoomStore {
  getState(): RoomState
  subscribe(listener: () => void): () => void
  actions: RoomCommands
  /** Desconexión intencional: salir de la sala. No es "borrar la sala" ni nada del
   * backend, solo cerrar el socket y dejar de escuchar. */
  close(): void
}

/**
 * Hook genérico: no asume dónde vive la instancia de `RoomStore` (eso es de `app/`,
 * un Context o similar -todavía no construido, es el siguiente paso después de este).
 *
 * El `selector` tiene que devolver algo que ya vive en el estado (`s.me`,
 * `s.notes[id]`, `s.connectionStatus`...) o el resultado de una función memoizada
 * como `sortNotesByCreation` -nunca construir un array/objeto nuevo inline
 * (`s => Object.values(s.notes)`, `s => s.foo.filter(...)`): `useSyncExternalStore`
 * compara por igualdad referencial, y un selector que arma un valor nuevo en cada
 * llamada re-renderiza el componente en cada cambio de CUALQUIER cosa en el store, no
 * solo de lo que le importa.
 */
export function useRoomStore<T>(store: RoomStore, selector: (state: RoomState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}

export function createRoomStore(room: string, identity: StoredIdentity): RoomStore {
  let state: RoomState = createInitialState()
  const listeners = new Set<() => void>()
  // Bookkeeping privado del backstop de `chat.typing` (`applyChatTyping`, más
  // abajo) -no vive en `RoomState`, ningún componente necesita leerlo, solo
  // cancelar/reprogramar el timeout de cada participante.
  const typingStaleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function setState(updater: (s: RoomState) => RoomState): void {
    state = updater(state)
    for (const listener of listeners) listener()
  }

  const socket = connectToRoom(room, identity)

  // --- comandos: componente -> mutación optimista + socket.send() -------------------

  function createNote(input: {
    kind: NoteKind
    status: NoteStatus
    text: string
    color: NoteColor
    positionX: number
    positionY: number
    capacity: number | null
  }): string {
    const id = crypto.randomUUID()
    const me = state.me
    if (me === null) return id // no debería pasar: la UI que ofrece crear ya requiere estar conectado

    const now = new Date().toISOString()
    const note: NoteState = {
      id,
      author_id: me.participantId,
      kind: input.kind,
      status: input.status,
      text: input.text,
      color: input.color,
      position_x: input.positionX,
      position_y: input.positionY,
      capacity: input.capacity,
      taken_count: 0,
      created_at: now,
      updated_at: now,
      claims: [],
      reactions: [],
    }
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: note },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'create' } },
    }))
    socket.send({
      type: 'note.create',
      id,
      kind: input.kind,
      status: input.status,
      text: input.text,
      color: input.color,
      position_x: input.positionX,
      position_y: input.positionY,
      capacity: input.capacity,
    })
    return id
  }

  function updateNote(id: string, text: string, color: NoteColor): void {
    const current = state.notes[id]
    if (current === undefined) return
    const restore = { text: current.text, color: current.color }
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...current, text, color } },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'update', restore } },
    }))
    socket.send({ type: 'note.update', id, text, color })
  }

  function moveNote(id: string, positionX: number, positionY: number, status: NoteStatus): void {
    // `restore` = lo que el store cree AHORA (solo los campos que esta acción
    // toca), no la posición de drag-start del componente: ver el docstring de
    // `PendingNoteOp` en store/types.ts.
    const current = state.notes[id]
    if (current === undefined) return
    const restore = {
      position_x: current.position_x,
      position_y: current.position_y,
      status: current.status,
    }
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...current, position_x: positionX, position_y: positionY, status } },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'move', restore } },
    }))
    socket.send({ type: 'note.move', id, position_x: positionX, position_y: positionY, status })
  }

  function deleteNote(id: string): void {
    if (state.notes[id] === undefined) return
    setState((s) => ({ ...s, pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'delete' } } }))
    socket.send({ type: 'note.delete', id })
  }

  function claimNote(id: string): void {
    const current = state.notes[id]
    const me = state.me
    if (current === undefined || me === null) return
    if (current.claims.includes(me.participantId)) return // ya lo tengo
    if (state.pendingNoteOps[id]?.kind === 'claim') return // ya hay un claim en vuelo: sin doble clic

    // A propósito NO optimista sobre `taken_count`/`claims` -a diferencia del resto
    // de las acciones-. Bug real encontrado con dos pestañas en carrera de verdad
    // por el mismo cupo: `taken_count` es un contador COMPARTIDO que cualquiera
    // puede tocar al mismo tiempo, y `note.claim` de otra persona ya lo actualiza a
    // su valor autoritativo (`event.taken_count`) mientras mi propio claim sigue
    // pendiente -mezclar mi incremento optimista con esa actualización ajena
    // duplicaba o perdía cuenta según el orden de llegada, sin una forma limpia de
    // "deshacer solo lo mío" que sobreviva a un contador que otro ya movió-. Acá
    // alcanza con marcar `pending` para deshabilitar el botón (sin doble clic
    // mientras se espera) y dejar que el número lo mueva únicamente el evento
    // confirmado -en localhost, imperceptible; el rebote de un rechazo es entonces
    // "el botón vuelve a estar habilitado", no "el número salta y vuelve".
    setState((s) => ({
      ...s,
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'claim' } },
    }))
    socket.send({ type: 'note.claim', note_id: id })
  }

  function releaseNote(id: string): void {
    const current = state.notes[id]
    const me = state.me
    if (current === undefined || me === null) return
    if (!current.claims.includes(me.participantId)) return
    if (state.pendingNoteOps[id]?.kind === 'release') return

    // Mismo criterio que claimNote: no optimista sobre el contador compartido.
    setState((s) => ({
      ...s,
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'release' } },
    }))
    socket.send({ type: 'note.release', note_id: id })
  }

  function toggleReaction(id: string, emoji: Reaction): void {
    const current = state.notes[id]
    const me = state.me
    if (current === undefined || me === null) return

    const already = current.reactions.some(
      (r) => r.participant_id === me.participantId && r.emoji === emoji,
    )
    const reactions = already
      ? current.reactions.filter((r) => !(r.participant_id === me.participantId && r.emoji === emoji))
      : [...current.reactions, { emoji, participant_id: me.participantId }]

    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...current, reactions } },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'reaction', emoji } },
    }))
    socket.send({ type: 'reaction.toggle', note_id: id, emoji })
  }

  function sendChatMessage(text: string, noteId: string | null): void {
    const me = state.me
    if (me === null) return
    const id = crypto.randomUUID()
    const message: ChatMessageState = {
      id,
      note_id: noteId,
      author_id: me.participantId,
      text,
      created_at: new Date().toISOString(),
    }
    // Optimista, sin `pendingNoteOps` -no es una nota, y `error` no trae con qué
    // correlacionar un fallo de chat.message (ver CLAUDE.md, día 1: sin campo de
    // protocolo para eso, la red de seguridad es un timeout de reconciliación del
    // lado de features/chat cuando se construya -bloque 5, no hoy).
    setState((s) => ({
      ...s,
      chatMessages: [...s.chatMessages, message],
      activity: appendActivity(
        s.activity,
        `${me.name}: "${previewNoteText(text)}"`,
        me.color,
        me.participantId,
      ),
    }))
    socket.send({ type: 'chat.message', id, note_id: noteId, text })
  }

  function setBackground(background: Background): void {
    setState((s) => ({ ...s, background }))
    socket.send({ type: 'room.background', background })
  }

  function sendCursor(x: number, y: number): void {
    socket.sendEphemeral({ type: 'presence.cursor', x, y })
  }

  function sendDragging(noteId: string, positionX: number, positionY: number): void {
    socket.sendEphemeral({
      type: 'presence.dragging',
      note_id: noteId,
      position_x: positionX,
      position_y: positionY,
    })
  }

  function sendDrafting(kind: NoteKind, positionX: number, positionY: number, active: boolean): void {
    socket.sendEphemeral({
      type: 'presence.drafting',
      kind,
      position_x: positionX,
      position_y: positionY,
      active,
    })
  }

  function sendTyping(noteId: string | null, active: boolean): void {
    socket.sendEphemeral({ type: 'chat.typing', note_id: noteId, active })
  }

  function requestSummary(): void {
    // Sin mutación optimista, a propósito -mismo criterio que claimNote/releaseNote:
    // el servidor puede rechazar (límite de uso, ya hay uno en curso), y no hay nada
    // sensato que pintar de entrada. `applyRoomSummaryRequested` es quien recién
    // marca "generando" cuando el servidor confirma que arrancó.
    socket.send({ type: 'room.summary_request' })
  }

  // --- aplicar: ServerEvent -> store, llamado solo por dispatch() -------------------

  /**
   * Deshace la acción pendiente de una nota cuando el servidor la rechaza -evento
   * tipado, o `error` genérico-. Cada rama deshace SOLO lo que esa acción tocó,
   * relativo al estado ACTUAL de la nota, nunca pisando la nota entera con una foto
   * vieja: `claim`/`release`/`reaction` en particular tienen que sobrevivir a una
   * actualización legítima y concurrente de OTRA persona que haya llegado mientras
   * la mía esperaba respuesta -bug real encontrado con dos pestañas en carrera por
   * el mismo cupo: si acá se restauraba la nota entera a como estaba antes de mi
   * click, el cupo que la otra persona sí ganó desaparecía de mi pantalla-. Ver
   * también el docstring de `PendingNoteOp` en `store/types.ts`.
   */
  function rollbackPendingOp(noteId: string): void {
    setState((s) => {
      const pending = s.pendingNoteOps[noteId]
      if (pending === undefined) return s

      if (pending.kind === 'create') {
        return { ...s, notes: omit(s.notes, noteId), pendingNoteOps: omit(s.pendingNoteOps, noteId) }
      }

      const current = s.notes[noteId]
      if (current === undefined) {
        // La nota ya no está -otro evento la sacó mientras tanto-: nada que
        // deshacer sobre datos que ya no existen, solo soltar el pending.
        return { ...s, pendingNoteOps: omit(s.pendingNoteOps, noteId) }
      }

      if (pending.kind === 'delete') {
        return { ...s, pendingNoteOps: omit(s.pendingNoteOps, noteId) } // nunca se tocó `notes`
      }

      if (pending.kind === 'update' || pending.kind === 'move') {
        return {
          ...s,
          notes: { ...s.notes, [noteId]: { ...current, ...pending.restore } },
          pendingNoteOps: omit(s.pendingNoteOps, noteId),
        }
      }

      if (pending.kind === 'claim' || pending.kind === 'release') {
        // claimNote/releaseNote no tocan `notes` de manera optimista (ver sus
        // docstrings): nada que deshacer más que el pending, el número nunca se
        // movió hasta que confirmara.
        return { ...s, pendingNoteOps: omit(s.pendingNoteOps, noteId) }
      }

      const me = s.me
      if (me === null) return { ...s, pendingNoteOps: omit(s.pendingNoteOps, noteId) }

      // pending.kind === 'reaction': re-alternar el mismo emoji, relativo a las
      // reacciones actuales -no a una foto vieja-.
      const stillMine = current.reactions.some(
        (r) => r.participant_id === me.participantId && r.emoji === pending.emoji,
      )
      const reactions = stillMine
        ? current.reactions.filter((r) => !(r.participant_id === me.participantId && r.emoji === pending.emoji))
        : [...current.reactions, { emoji: pending.emoji, participant_id: me.participantId }]
      return {
        ...s,
        notes: { ...s.notes, [noteId]: { ...current, reactions } },
        pendingNoteOps: omit(s.pendingNoteOps, noteId),
      }
    })
  }

  function applyRoomSnapshot(event: RoomSnapshot): void {
    // Una reconexión reinicia `presence.typing` a `{}` más abajo -ningún timeout de
    // vencimiento pendiente sigue teniendo sentido después de eso.
    for (const timer of typingStaleTimers.values()) clearTimeout(timer)
    typingStaleTimers.clear()

    setState((s) => {
      const notes: Record<string, NoteState> = {}
      for (const note of event.notes) notes[note.id] = note

      const participants: Record<string, ParticipantState> = {}
      for (const p of event.participants) participants[p.id] = p

      const myParticipant = participants[event.participant_id]

      return {
        ...s,
        slug: event.slug,
        name: event.name,
        background: event.background,
        me:
          myParticipant === undefined
            ? null
            : {
                participantId: myParticipant.id,
                name: myParticipant.name,
                avatar: myParticipant.avatar,
                color: myParticipant.color,
              },
        notes,
        // Una reconexión trae la verdad completa desde cero: nada queda "en vuelo".
        pendingNoteOps: {},
        participants,
        chatMessages: event.chat_messages,
        // Ventana de "lo que está pasando ahora", no un historial: reinicia vacía
        // igual que `presence` efímera, un renglón de antes del corte no aporta
        // nada una vez reconectado.
        activity: [],
        // Ídem: nadie sigue viendo caer una nota que se borró antes del corte.
        fallingNotes: {},
        // El último resumen guardado sí sobrevive a una reconexión -viene de Redis,
        // no de este socket-; "generando"/el aviso transitorio no, son de esta
        // conexión puntual.
        summary:
          event.summary === null
            ? null
            : { text: event.summary.text, generatedAt: event.summary.generated_at },
        summaryGenerating: null,
        summaryNotice: null,
        // Efímero, no sobrevive a una reconexión -nadie sigue arrastrando ni con el
        // cursor en el mismo lugar del otro lado tras un corte.
        presence: { cursors: {}, dragging: {}, drafting: {}, typing: {} },
      }
    })
    saveIdentity(room, {
      participantId: event.participant_id,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
    })
  }

  function applyPresenceJoined(event: PresenceJoined): void {
    setState((s) => ({
      ...s,
      participants: { ...s.participants, [event.id]: event },
      // "se conectó" y no "se unió": este mismo evento cubre tanto la primera
      // visita a la sala como una reconexión que reactiva una fila existente
      // (ver decisión de reidentificación en CLAUDE.md) -no hay forma de
      // distinguirlas desde acá, y ninguna de las dos frases sería exacta para
      // la otra mitad de los casos.
      activity: appendActivity(s.activity, `${event.name} se conectó a la sala`, event.color, event.id),
    }))
  }

  function applyPresenceLeft(event: PresenceLeft): void {
    // Prolijidad, no corrección: un timeout de chat.typing que siguiera vivo acá
    // haría un `omit` inofensivo sobre una entrada que este mismo evento ya borra
    // abajo -pero no hay motivo para dejarlo colgado 6s de más sin nada que hacer.
    const pendingTimer = typingStaleTimers.get(event.participant_id)
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    typingStaleTimers.delete(event.participant_id)

    setState((s) => {
      const current = s.participants[event.participant_id]
      if (current === undefined) return s
      return {
        ...s,
        participants: {
          ...s.participants,
          // El servidor no manda el timestamp exacto en PresenceLeft, solo el id;
          // una marca aproximada alcanza -nada consume disconnected_at con
          // precisión de milisegundos, solo "¿sigue conectado?".
          [event.participant_id]: { ...current, disconnected_at: new Date().toISOString() },
        },
        presence: {
          cursors: omit(s.presence.cursors, event.participant_id),
          dragging: omit(s.presence.dragging, event.participant_id),
          drafting: omit(s.presence.drafting, event.participant_id),
          typing: omit(s.presence.typing, event.participant_id),
        },
        activity: appendActivity(
          s.activity,
          `${current.name} se desconectó`,
          current.color,
          event.participant_id,
        ),
      }
    })
  }

  function applyNoteCreate(event: NoteCreateOut): void {
    setState((s) => {
      const author = s.participants[event.author_id]
      return {
        ...s,
        notes: { ...s.notes, [event.id]: event },
        pendingNoteOps: omit(s.pendingNoteOps, event.id),
        activity: appendActivity(
          s.activity,
          `${author?.name ?? 'alguien'} creó ${noteKindLabel(event.kind)}: "${previewNoteText(event.text)}"`,
          author?.color ?? null,
          event.author_id,
        ),
      }
    })
  }

  function applyNoteUpdate(event: NoteUpdateOut): void {
    setState((s) => {
      const current = s.notes[event.id]
      if (current === undefined) return s
      const pending = s.pendingNoteOps[event.id]
      return {
        ...s,
        notes: {
          ...s.notes,
          [event.id]: { ...current, text: event.text, color: event.color, updated_at: event.updated_at },
        },
        pendingNoteOps: pending?.kind === 'update' ? omit(s.pendingNoteOps, event.id) : s.pendingNoteOps,
      }
    })
  }

  function applyNoteMove(event: NoteMoveOut): void {
    setState((s) => {
      const current = s.notes[event.id]
      if (current === undefined) return s
      const pending = s.pendingNoteOps[event.id]

      // presence.dragging no tiene un "stop" propio en el protocolo (docstring de
      // protocol.ts): se limpia acá, cuando llega el note.move que el que arrastraba
      // manda SIEMPRE al soltar. NoteMoveOut no trae participant_id -no hace falta,
      // solo el autor puede mover una nota, así que el fantasma a limpiar es siempre
      // el de `current.author_id`-. Se compara también `noteId` por las dudas: si ese
      // participante ya está arrastrando otra cosa para cuando llega este evento, no
      // hay que tocarle esa entrada.
      const draggingEntry = s.presence.dragging[current.author_id]
      const dragging =
        draggingEntry !== undefined && draggingEntry.noteId === event.id
          ? omit(s.presence.dragging, current.author_id)
          : s.presence.dragging

      // Solo deja renglón si CAMBIÓ de columna -reposicionar dentro de la misma
      // columna pasa todo el tiempo y no es la clase de cosa que esta franja
      // necesita anunciar (ver docstring de store/activity.ts). OJO acá: en la
      // pantalla de quien arrastró, `current.status` YA es el nuevo valor -
      // `moveNote` lo pisa de forma optimista antes de que esta confirmación
      // llegue-, así que comparar contra `current.status` da un falso "no
      // cambió" siempre que el propio autor sea quien mueve. El status de
      // ANTES del arrastre, para quien lo inició, vive en `pending.restore`
      // (docstring de `PendingNoteOp`); para cualquier otra pantalla -que
      // nunca tocó esta nota de forma optimista- `current.status` sigue
      // siendo el real.
      const priorStatus = pending?.kind === 'move' ? pending.restore.status : current.status
      const columnChanged = priorStatus !== event.status
      const author = s.participants[current.author_id]

      return {
        ...s,
        notes: {
          ...s.notes,
          [event.id]: {
            ...current,
            position_x: event.position_x,
            position_y: event.position_y,
            status: event.status,
          },
        },
        pendingNoteOps: pending?.kind === 'move' ? omit(s.pendingNoteOps, event.id) : s.pendingNoteOps,
        presence: { ...s.presence, dragging },
        activity: columnChanged
          ? appendActivity(
              s.activity,
              `${author?.name ?? 'alguien'} movió "${previewNoteText(current.text)}" a ${STATUS_LABELS[event.status]}`,
              author?.color ?? null,
              current.author_id,
            )
          : s.activity,
      }
    })
  }
  // Hueco conocido, sin blindar a propósito (mismo criterio que move_note en el
  // backend): si ese note.move es RECHAZADO en vez de confirmado, el rechazo
  // (`error`) llega solo a quien arrastraba, nunca se difunde -así que el resto de
  // la sala nunca se entera y el fantasma queda pegado en la última posición
  // reportada. Se autocorrige solo con el próximo arrastre real de esa persona, o
  // con su próxima desconexión (`presence.left` ya limpia cualquier fantasma). Caso
  // raro -depende de que otra pestaña propia borre la nota a mitad del arrastre-, no
  // vale la pena más máquina para esto en tres días.

  function applyNoteDelete(event: NoteDeleteOut): void {
    let deletedNote: NoteState | undefined
    setState((s) => {
      // El autor y el texto hay que leerlos ANTES de sacar la nota de `notes` -una
      // vez borrada no queda de dónde recuperarlos para el renglón de la franja.
      const note = s.notes[event.id]
      deletedNote = note
      const author = note !== undefined ? s.participants[note.author_id] : undefined
      return {
        ...s,
        notes: omit(s.notes, event.id),
        pendingNoteOps: omit(s.pendingNoteOps, event.id),
        // La nota sale de `notes` ya mismo (la fuente de verdad no puede seguir
        // teniendo algo que el servidor ya borró), pero queda una foto acá para
        // que `NoteFalling.tsx` la anime cayendo en vez de desaparecer de golpe
        // -pulido día 3, CLAUDE.md. Se limpia sola con el timeout de abajo.
        fallingNotes: note === undefined ? s.fallingNotes : { ...s.fallingNotes, [event.id]: note },
        activity:
          note === undefined
            ? s.activity
            : appendActivity(
                s.activity,
                `${author?.name ?? 'alguien'} borró una nota: "${previewNoteText(note.text)}"`,
                author?.color ?? null,
                note.author_id,
              ),
      }
    })
    if (deletedNote !== undefined) {
      // Un poco más que la duración de la animación CSS (`note-fall`,
      // Note.css) para no cortarla a mitad de camino. Si la sala se cierra
      // antes de que dispare, este `setTimeout` termina llamando a un
      // `setState` sin listeners -inofensivo, no hay nada que limpiar del
      // lado de un timeout que se dispara una sola vez.
      setTimeout(() => {
        setState((s) => ({ ...s, fallingNotes: omit(s.fallingNotes, event.id) }))
      }, FALLING_NOTE_DURATION_MS)
    }
  }

  function applyNoteClaim(event: NoteClaimOut): void {
    setState((s) => {
      const current = s.notes[event.note_id]
      if (current === undefined) return s
      const claims = current.claims.includes(event.participant_id)
        ? current.claims
        : [...current.claims, event.participant_id]
      const pending = s.pendingNoteOps[event.note_id]
      // Bug real encontrado con dos pestañas: `note.claim` es un broadcast, así que
      // ESTE evento puede ser la confirmación de un `claimNote` ajeno, no del mío.
      // Sin comparar `event.participant_id` contra `s.me`, el `claim` de Beto podía
      // limpiar el `pending` de Alicia -que seguía esperando el suyo-, y cuando el
      // rechazo de Alicia llegaba después, `rollbackNote` no encontraba nada que
      // deshacer: su propio id le quedaba pegado en `claims` para siempre, viéndose
      // a sí misma con un cupo que en realidad nunca tuvo.
      const isMine = pending?.kind === 'claim' && event.participant_id === s.me?.participantId
      const actor = s.participants[event.participant_id]
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, taken_count: event.taken_count, claims } },
        pendingNoteOps: isMine ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
        activity: appendActivity(
          s.activity,
          `${actor?.name ?? 'alguien'} tomó un cupo en "${previewNoteText(current.text)}"`,
          actor?.color ?? null,
          event.participant_id,
        ),
      }
    })
  }

  function applyNoteClaimRejected(event: NoteClaimRejected): void {
    rollbackPendingOp(event.note_id)
  }

  function applyNoteRelease(event: NoteReleaseOut): void {
    setState((s) => {
      const current = s.notes[event.note_id]
      if (current === undefined) return s
      const claims = current.claims.filter((p) => p !== event.participant_id)
      const pending = s.pendingNoteOps[event.note_id]
      // Mismo bug que en applyNoteClaim: sin comparar participant_id, la suelta de
      // otra persona podía limpiar mi propio pending.
      const isMine = pending?.kind === 'release' && event.participant_id === s.me?.participantId
      const actor = s.participants[event.participant_id]
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, taken_count: event.taken_count, claims } },
        pendingNoteOps: isMine ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
        activity: appendActivity(
          s.activity,
          `${actor?.name ?? 'alguien'} soltó un cupo en "${previewNoteText(current.text)}"`,
          actor?.color ?? null,
          event.participant_id,
        ),
      }
    })
  }

  function applyNoteReleaseRejected(event: NoteReleaseRejected): void {
    rollbackPendingOp(event.note_id)
  }

  function applyReactionToggle(event: ReactionToggleOut): void {
    setState((s) => {
      const current = s.notes[event.note_id]
      if (current === undefined) return s
      const already = current.reactions.some(
        (r) => r.participant_id === event.participant_id && r.emoji === event.emoji,
      )
      const reactions = event.active
        ? already
          ? current.reactions
          : [...current.reactions, { emoji: event.emoji, participant_id: event.participant_id }]
        : current.reactions.filter(
            (r) => !(r.participant_id === event.participant_id && r.emoji === event.emoji),
          )
      const pending = s.pendingNoteOps[event.note_id]
      // Mismo bug que en applyNoteClaim/applyNoteRelease: cualquiera reacciona a
      // cualquier nota (sin autoría), así que este evento puede ser la reacción de
      // otra persona a la misma nota donde yo tengo un toggle propio en vuelo.
      const isMine = pending?.kind === 'reaction' && event.participant_id === s.me?.participantId
      const actor = s.participants[event.participant_id]
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, reactions } },
        pendingNoteOps: isMine ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
        // Solo al activar: sacarse una reacción no aporta nada que mirar en la
        // franja (docstring de store/activity.ts).
        activity: event.active
          ? appendActivity(
              s.activity,
              `${actor?.name ?? 'alguien'} reaccionó ${event.emoji} a "${previewNoteText(current.text)}"`,
              actor?.color ?? null,
              event.participant_id,
            )
          : s.activity,
      }
    })
  }

  function applyChatMessage(event: ChatMessageOut): void {
    setState((s) => {
      const idx = s.chatMessages.findIndex((m) => m.id === event.id)
      if (idx === -1) {
        // Mensaje ajeno visto por primera vez -el propio ya dejó su renglón en
        // `sendChatMessage`, optimista; este `idx !== -1` de abajo es justamente
        // ESE eco, así que no duplica.
        const author = s.participants[event.author_id]
        return {
          ...s,
          chatMessages: [...s.chatMessages, event],
          activity: appendActivity(
            s.activity,
            `${author?.name ?? 'alguien'}: "${previewNoteText(event.text)}"`,
            author?.color ?? null,
            event.author_id,
            true, // isChatMessage: ver store/types.ts, lo necesita useNotificationSound
          ),
        }
      }
      const chatMessages = [...s.chatMessages]
      chatMessages[idx] = event // eco de mi propio mensaje optimista: se pisa con lo autoritativo
      return { ...s, chatMessages }
    })
  }

  function applyRoomBackground(event: RoomBackgroundOut): void {
    setState((s) => ({
      ...s,
      background: event.background,
      // `room.background` no viaja con `participant_id` (protocol.ts): sin autor
      // a quien atribuírselo, renglón sin punto de color.
      activity: appendActivity(
        s.activity,
        `Fondo cambiado a ${BACKGROUND_LABELS[event.background]}`,
        null,
        null,
      ),
    }))
  }

  function applyError(event: ErrorEvent): void {
    // Sin note_id no hay a qué nota revertir (chat, fondo de sala: ver
    // docstring de sendChatMessage más arriba).
    if (event.note_id !== null) rollbackPendingOp(event.note_id)
  }

  /** Mensaje transitorio de "no se pudo" -mismo patrón de autolimpieza que
   * `fallingNotes` (`applyNoteDelete`): el propio store arma el timeout, no el
   * componente que lo muestra. Compara el texto antes de limpiar por si ya llegó
   * un aviso más nuevo mientras este esperaba su turno. */
  function showSummaryNotice(text: string): void {
    setState((s) => ({ ...s, summaryNotice: { text } }))
    setTimeout(() => {
      setState((s) => (s.summaryNotice?.text === text ? { ...s, summaryNotice: null } : s))
    }, SUMMARY_NOTICE_DURATION_MS)
  }

  function applyRoomSummaryRequested(event: RoomSummaryRequested): void {
    setState((s) => {
      const requester = s.participants[event.requested_by]
      return {
        ...s,
        summaryGenerating: { requestedBy: event.requested_by },
        summaryNotice: null,
        activity: appendActivity(
          s.activity,
          `${requester?.name ?? 'alguien'} pidió un resumen de la sala`,
          requester?.color ?? null,
          event.requested_by,
        ),
      }
    })
  }

  function applyRoomSummary(event: RoomSummary): void {
    setState((s) => ({
      ...s,
      summaryGenerating: null,
      // Un intento fallido nunca pisa el último resumen que sí funcionó -se deja
      // `s.summary` tal cual estaba.
      summary: event.text !== null ? { text: event.text, generatedAt: event.generated_at } : s.summary,
    }))
    if (event.error !== null) showSummaryNotice('No se pudo generar el resumen, probá de nuevo.')
  }

  function applyRoomSummaryRejected(event: RoomSummaryRejected): void {
    showSummaryNotice(summaryRejectionText(event))
  }

  function applyPresenceCursor(event: PresenceCursorOut): void {
    setState((s) => ({
      ...s,
      presence: {
        ...s.presence,
        cursors: { ...s.presence.cursors, [event.participant_id]: { x: event.x, y: event.y } },
      },
    }))
  }

  function applyPresenceDragging(event: PresenceDraggingOut): void {
    setState((s) => ({
      ...s,
      presence: {
        ...s.presence,
        dragging: {
          ...s.presence.dragging,
          [event.participant_id]: {
            noteId: event.note_id,
            positionX: event.position_x,
            positionY: event.position_y,
          },
        },
      },
    }))
  }

  function applyPresenceDrafting(event: PresenceDraftingOut): void {
    setState((s) => {
      const drafting = { ...s.presence.drafting }
      if (event.active) {
        drafting[event.participant_id] = {
          kind: event.kind,
          positionX: event.position_x,
          positionY: event.position_y,
        }
      } else {
        delete drafting[event.participant_id]
      }
      return { ...s, presence: { ...s.presence, drafting } }
    })
  }

  /**
   * `active: true` es siempre "seguís viendo a esta persona escribir por 6s más",
   * nunca un simple set-and-forget: cancela cualquier timeout de vencimiento previo
   * de ESTE participante (si venía escribiendo hace rato, el refresco de la capa 1
   * de `ChatPanel.tsx` llega justo para esto) y arma uno nuevo. `active: false`
   * -explícito, o implícito al vencer el timeout- cancela y borra sin
   * reprogramar nada.
   *
   * El timeout vive en `typingStaleTimers` (closure de `createRoomStore`), no en
   * `RoomState`: es el mecanismo, no algo que ningún componente necesite leer.
   */
  function applyChatTyping(event: ChatTypingOut): void {
    const pendingTimer = typingStaleTimers.get(event.participant_id)
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    typingStaleTimers.delete(event.participant_id)

    setState((s) => {
      const typing = { ...s.presence.typing }
      if (event.active) {
        typing[event.participant_id] = { noteId: event.note_id }
      } else {
        delete typing[event.participant_id]
      }
      return { ...s, presence: { ...s.presence, typing } }
    })

    if (event.active) {
      const timer = setTimeout(() => {
        typingStaleTimers.delete(event.participant_id)
        setState((s) => ({
          ...s,
          presence: { ...s.presence, typing: omit(s.presence.typing, event.participant_id) },
        }))
      }, TYPING_STALE_MS)
      typingStaleTimers.set(event.participant_id, timer)
    }
  }

  const applyActions: RoomApplyActions = {
    applyRoomSnapshot,
    applyPresenceJoined,
    applyPresenceLeft,
    applyNoteCreate,
    applyNoteUpdate,
    applyNoteMove,
    applyNoteDelete,
    applyNoteClaim,
    applyNoteClaimRejected,
    applyNoteRelease,
    applyNoteReleaseRejected,
    applyReactionToggle,
    applyChatMessage,
    applyRoomBackground,
    applyError,
    applyPresenceCursor,
    applyPresenceDragging,
    applyPresenceDrafting,
    applyChatTyping,
    applyRoomSummaryRequested,
    applyRoomSummary,
    applyRoomSummaryRejected,
  }

  const unsubscribeEvents = socket.onEvent((event) => {
    dispatch(event, applyActions)
  })
  const unsubscribeStatus = socket.onStatusChange((status) => {
    setState((s) => ({ ...s, connectionStatus: status }))
  })

  const commands: RoomCommands = {
    createNote,
    updateNote,
    moveNote,
    deleteNote,
    claimNote,
    releaseNote,
    toggleReaction,
    sendChatMessage,
    setBackground,
    sendCursor,
    sendDragging,
    sendDrafting,
    sendTyping,
    requestSummary,
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    actions: commands,
    close() {
      unsubscribeEvents()
      unsubscribeStatus()
      socket.close()
    },
  }
}

function summaryRejectionText(event: RoomSummaryRejected): string {
  switch (event.reason) {
    case 'already_generating':
      return 'Ya se está generando un resumen, esperá un toque.'
    case 'unavailable':
      return 'El resumen con IA no está disponible en este servidor.'
    case 'rate_limited': {
      const seconds = event.retry_after_seconds ?? 0
      const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`
      return `Ya se pidió un resumen hace poco -esperá ${wait}.`
    }
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}
