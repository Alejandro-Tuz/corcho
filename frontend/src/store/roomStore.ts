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
 * Cada acción sobre una nota deja un `PendingNoteOp` en `pendingNoteOps[id]` con el
 * valor de `notes[id]` de un instante antes (`restore`). Si la acción se confirma, se
 * pisa con los valores autoritativos y se borra el pending. Si se rechaza (evento
 * tipado como `note.claim_rejected`, o un `error` genérico con ese `note_id`), se
 * vuelve a `restore` -el rebote que pide la invariante-.
 *
 * Excepción a "mutar al instante": `note.delete` NO borra la nota de `notes` de
 * entrada, solo marca `pendingNoteOps[id] = {kind:'delete'}` para que la UI
 * deshabilite el control mientras tanto. Borrar optimistamente y tener que hacerla
 * reaparecer ante un rechazo es más parpadeo que beneficio -a diferencia de crear o
 * mover, achicar no tiene nada de "instantáneo" que ganar-, y de paso deja el enganche
 * que el pulido del día 3 va a necesitar tal cual ("se elimina del store al terminar
 * la animación, no al recibir el evento": hoy sin animación se borra apenas confirma
 * el servidor; el día 3 alguien intercepta este mismo punto para animar antes).
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
} from '../realtime/protocol'
import { connectToRoom } from '../realtime/socket'
import { dispatch } from '../realtime/dispatch'
import { saveIdentity } from '../lib/identity'
import type { StoredIdentity } from '../lib/identity'
import { createInitialState } from './types'
import type { RoomApplyActions, RoomCommands, RoomState } from './types'

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
    const restore = state.notes[id]
    if (restore === undefined) return
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...restore, text, color } },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'update', restore } },
    }))
    socket.send({ type: 'note.update', id, text, color })
  }

  function moveNote(id: string, positionX: number, positionY: number, status: NoteStatus): void {
    // `restore` = lo que el store cree AHORA, no la posición de drag-start del
    // componente: ver el docstring de `PendingNoteOp` en store/types.ts.
    const restore = state.notes[id]
    if (restore === undefined) return
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...restore, position_x: positionX, position_y: positionY, status } },
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

    const restore = current
    setState((s) => ({
      ...s,
      notes: {
        ...s.notes,
        [id]: {
          ...current,
          taken_count: current.taken_count + 1,
          claims: [...current.claims, me.participantId],
        },
      },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'claim', restore } },
    }))
    socket.send({ type: 'note.claim', note_id: id })
  }

  function releaseNote(id: string): void {
    const current = state.notes[id]
    const me = state.me
    if (current === undefined || me === null) return
    if (!current.claims.includes(me.participantId)) return
    if (state.pendingNoteOps[id]?.kind === 'release') return

    const restore = current
    setState((s) => ({
      ...s,
      notes: {
        ...s.notes,
        [id]: {
          ...current,
          taken_count: Math.max(0, current.taken_count - 1),
          claims: current.claims.filter((p) => p !== me.participantId),
        },
      },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'release', restore } },
    }))
    socket.send({ type: 'note.release', note_id: id })
  }

  function toggleReaction(id: string, emoji: Reaction): void {
    const current = state.notes[id]
    const me = state.me
    if (current === undefined || me === null) return

    const restore = current
    const already = current.reactions.some(
      (r) => r.participant_id === me.participantId && r.emoji === emoji,
    )
    const reactions = already
      ? current.reactions.filter((r) => !(r.participant_id === me.participantId && r.emoji === emoji))
      : [...current.reactions, { emoji, participant_id: me.participantId }]

    setState((s) => ({
      ...s,
      notes: { ...s.notes, [id]: { ...current, reactions } },
      pendingNoteOps: { ...s.pendingNoteOps, [id]: { kind: 'reaction', restore } },
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
    setState((s) => ({ ...s, chatMessages: [...s.chatMessages, message] }))
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

  // --- aplicar: ServerEvent -> store, llamado solo por dispatch() -------------------

  function rollbackNote(noteId: string): void {
    setState((s) => {
      const pending = s.pendingNoteOps[noteId]
      if (pending === undefined) return s
      if (pending.kind === 'create') {
        return { ...s, notes: omit(s.notes, noteId), pendingNoteOps: omit(s.pendingNoteOps, noteId) }
      }
      if (pending.kind === 'delete') {
        return { ...s, pendingNoteOps: omit(s.pendingNoteOps, noteId) } // nunca se tocó `notes`
      }
      return {
        ...s,
        notes: { ...s.notes, [noteId]: pending.restore },
        pendingNoteOps: omit(s.pendingNoteOps, noteId),
      }
    })
  }

  function applyRoomSnapshot(event: RoomSnapshot): void {
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
    setState((s) => ({ ...s, participants: { ...s.participants, [event.id]: event } }))
  }

  function applyPresenceLeft(event: PresenceLeft): void {
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
      }
    })
  }

  function applyNoteCreate(event: NoteCreateOut): void {
    setState((s) => ({
      ...s,
      notes: { ...s.notes, [event.id]: event },
      pendingNoteOps: omit(s.pendingNoteOps, event.id),
    }))
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
    setState((s) => ({
      ...s,
      notes: omit(s.notes, event.id),
      pendingNoteOps: omit(s.pendingNoteOps, event.id),
    }))
  }

  function applyNoteClaim(event: NoteClaimOut): void {
    setState((s) => {
      const current = s.notes[event.note_id]
      if (current === undefined) return s
      const claims = current.claims.includes(event.participant_id)
        ? current.claims
        : [...current.claims, event.participant_id]
      const pending = s.pendingNoteOps[event.note_id]
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, taken_count: event.taken_count, claims } },
        pendingNoteOps:
          pending?.kind === 'claim' ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
      }
    })
  }

  function applyNoteClaimRejected(event: NoteClaimRejected): void {
    rollbackNote(event.note_id)
  }

  function applyNoteRelease(event: NoteReleaseOut): void {
    setState((s) => {
      const current = s.notes[event.note_id]
      if (current === undefined) return s
      const claims = current.claims.filter((p) => p !== event.participant_id)
      const pending = s.pendingNoteOps[event.note_id]
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, taken_count: event.taken_count, claims } },
        pendingNoteOps:
          pending?.kind === 'release' ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
      }
    })
  }

  function applyNoteReleaseRejected(event: NoteReleaseRejected): void {
    rollbackNote(event.note_id)
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
      return {
        ...s,
        notes: { ...s.notes, [event.note_id]: { ...current, reactions } },
        pendingNoteOps:
          pending?.kind === 'reaction' ? omit(s.pendingNoteOps, event.note_id) : s.pendingNoteOps,
      }
    })
  }

  function applyChatMessage(event: ChatMessageOut): void {
    setState((s) => {
      const idx = s.chatMessages.findIndex((m) => m.id === event.id)
      if (idx === -1) return { ...s, chatMessages: [...s.chatMessages, event] }
      const chatMessages = [...s.chatMessages]
      chatMessages[idx] = event // eco de mi propio mensaje optimista: se pisa con lo autoritativo
      return { ...s, chatMessages }
    })
  }

  function applyRoomBackground(event: RoomBackgroundOut): void {
    setState((s) => ({ ...s, background: event.background }))
  }

  function applyError(event: ErrorEvent): void {
    // Sin note_id no hay a qué nota revertir (chat, fondo de sala: ver
    // docstring de sendChatMessage más arriba).
    if (event.note_id !== null) rollbackNote(event.note_id)
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

  function applyChatTyping(event: ChatTypingOut): void {
    setState((s) => {
      const typing = { ...s.presence.typing }
      if (event.active) {
        typing[event.participant_id] = { noteId: event.note_id }
      } else {
        delete typing[event.participant_id]
      }
      return { ...s, presence: { ...s.presence, typing } }
    })
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

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}
