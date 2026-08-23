/**
 * Forma del estado de una sala, y las dos interfaces que lo rodean:
 *
 * - `RoomCommands`: lo que un componente llama para HACER algo (crear una nota,
 *   tomar un cupo, mandar el cursor). Mezcla mutación optimista + `socket.send()` en
 *   un solo método -para que un componente nunca pueda llamar una mitad del par y
 *   olvidarse de la otra-.
 * - `RoomApplyActions`: lo que `dispatch.ts` llama al recibir un `ServerEvent` del
 *   servidor. Nunca toca el socket. `dispatch.ts` importa esta interfaz -no al revés-
 *   para no crear un ciclo entre `realtime/` y `store/` (ver docstring de
 *   `dispatch.ts`).
 *
 * `roomStore.ts` implementa las dos; solo `RoomCommands` sale hacia los componentes.
 */

import type {
  Avatar,
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
  ParticipantColor,
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
import type { ConnectionStatus } from '../realtime/socket'

/**
 * Único marcador de "esta nota tiene una acción local sin confirmar" por nota -no uno
 * por tipo de acción-. Simplificación consciente: si dos acciones de distinto tipo se
 * cruzan en vuelo sobre la misma nota (edición y arrastre casi al mismo tiempo, por
 * ejemplo), la segunda pisa el `pending` de la primera. Un rechazo en ese cruce raro
 * revierte a un estado optimista-pero-no-confirmado en vez de al último real -se
 * autocorrige con el próximo evento real que llegue-. Cubrir esto con una cola de
 * deshacer por nota es la complejidad que no compensa en tres días para un cruce así
 * de infrecuente (mismo criterio ya aceptado para dos ediciones seguidas).
 *
 * `restore`: el valor de `notes[id]` justo antes de esta mutación optimista -es decir,
 * lo último que el store creía cierto en ese instante-, no un valor capturado antes.
 * Para `note.move` en particular esto importa: `restore` se toma al soltar el
 * arrastre, no al agarrar la nota, porque el store pudo haber recibido una
 * confirmación más reciente (de otra pestaña propia, por ejemplo) mientras el
 * arrastre -que es puramente local hasta soltar, ver `features/notes`- estaba en
 * curso. Revertir a la posición de drag-start ignoraría esa actualización más nueva.
 */
export type PendingNoteOp =
  | { kind: 'create' }
  | { kind: 'update' | 'move' | 'claim' | 'release' | 'reaction'; restore: NoteState }
  | { kind: 'delete' }

export interface CursorPresence {
  x: number
  y: number
}

export interface DraggingPresence {
  noteId: string
  positionX: number
  positionY: number
}

export interface DraftingPresence {
  kind: NoteKind
  positionX: number
  positionY: number
}

export interface TypingPresence {
  noteId: string | null
}

export interface RoomState {
  slug: string | null
  name: string | null
  background: Background
  connectionStatus: ConnectionStatus
  me: { participantId: string; name: string; avatar: Avatar; color: ParticipantColor } | null

  /** Tal cual viaja por el wire: un componente lee `notes[id]` como un `NoteState`
   * de siempre. El orden de dibujado NO se guarda acá -se deriva, ver
   * `selectors.ts`-. */
  notes: Record<string, NoteState>
  pendingNoteOps: Record<string, PendingNoteOp>

  participants: Record<string, ParticipantState>
  /** Ya llegan ordenados cronológicamente desde `room.snapshot`
   * (`chat.list_messages`); los que se agregan en vivo se appendean al final. */
  chatMessages: ChatMessageState[]

  presence: {
    cursors: Record<string, CursorPresence>
    dragging: Record<string, DraggingPresence>
    drafting: Record<string, DraftingPresence>
    typing: Record<string, TypingPresence>
  }
}

export function createInitialState(): RoomState {
  return {
    slug: null,
    name: null,
    background: 'bone',
    connectionStatus: 'connecting',
    me: null,
    notes: {},
    pendingNoteOps: {},
    participants: {},
    chatMessages: [],
    presence: { cursors: {}, dragging: {}, drafting: {}, typing: {} },
  }
}

export interface RoomCommands {
  /** Devuelve el `id` generado en cliente (creación optimista, invariante del modelo
   * de datos: `notes.id` se genera en cliente). */
  createNote(input: {
    kind: NoteKind
    status: NoteStatus
    text: string
    color: NoteColor
    positionX: number
    positionY: number
    capacity: number | null
  }): string
  updateNote(id: string, text: string, color: NoteColor): void
  /** Una sola vez por arrastre, al soltar -no por cada `pointermove`. Ver docstring
   * de `PendingNoteOp` sobre qué es `restore` acá. */
  moveNote(id: string, positionX: number, positionY: number, status: NoteStatus): void
  deleteNote(id: string): void
  claimNote(id: string): void
  releaseNote(id: string): void
  toggleReaction(id: string, emoji: Reaction): void
  sendChatMessage(text: string, noteId: string | null): void
  setBackground(background: Background): void
  sendCursor(x: number, y: number): void
  sendDragging(noteId: string, positionX: number, positionY: number): void
  sendDrafting(kind: NoteKind, positionX: number, positionY: number, active: boolean): void
  sendTyping(noteId: string | null, active: boolean): void
}

export interface RoomApplyActions {
  applyRoomSnapshot(event: RoomSnapshot): void
  applyPresenceJoined(event: PresenceJoined): void
  applyPresenceLeft(event: PresenceLeft): void
  applyNoteCreate(event: NoteCreateOut): void
  applyNoteUpdate(event: NoteUpdateOut): void
  applyNoteMove(event: NoteMoveOut): void
  applyNoteDelete(event: NoteDeleteOut): void
  applyNoteClaim(event: NoteClaimOut): void
  applyNoteClaimRejected(event: NoteClaimRejected): void
  applyNoteRelease(event: NoteReleaseOut): void
  applyNoteReleaseRejected(event: NoteReleaseRejected): void
  applyReactionToggle(event: ReactionToggleOut): void
  applyChatMessage(event: ChatMessageOut): void
  applyRoomBackground(event: RoomBackgroundOut): void
  applyError(event: ErrorEvent): void
  applyPresenceCursor(event: PresenceCursorOut): void
  applyPresenceDragging(event: PresenceDraggingOut): void
  applyPresenceDrafting(event: PresenceDraftingOut): void
  applyChatTyping(event: ChatTypingOut): void
}
