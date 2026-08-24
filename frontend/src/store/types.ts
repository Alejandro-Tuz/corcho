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
 * de infrecuente.
 *
 * Dos bugs reales encontrados con dos pestañas en carrera de verdad por el mismo
 * cupo, y por qué `claim`/`release` no llevan datos que optimistamente muten
 * `notes[id]` en absoluto (a diferencia de `update`/`move`/`reaction`):
 *
 * 1. Con un `restore` de la nota entera, un rechazo la PISABA con esa foto vieja -y
 *    un `taken_count`/`claims` que mientras tanto se actualizó de verdad, porque la
 *    OTRA persona sí ganó el cupo, se perdía en el pisado.
 * 2. Cambiar a "deshacer relativo al estado actual" (restar mi propio aporte en vez
 *    de restaurar una foto) tampoco alcanzaba: `taken_count` es un contador
 *    COMPARTIDO que la confirmación de OTRA persona ya deja en su valor
 *    autoritativo mientras la mía sigue pendiente, así que mi resta relativa
 *    terminaba descontando de un número que mi propio incremento optimista nunca
 *    había llegado a tocar -quedaba mal para cualquiera de los dos lados de la
 *    carrera según el orden de llegada-.
 *
 * La salida que sí es robusta: `claim`/`release` no tocan `notes[id]` hasta que
 * llega la confirmación -`pending` solo deshabilita el botón mientras se espera-.
 * El número solo se mueve una vez, cuando el servidor lo confirma, así que no hay
 * nada que mezclar ni que deshacer. `reaction` no tiene este problema -no hay un
 * contador agregado, cada entrada de `reactions` es independiente- así que sigue
 * optimista, deshaciendo relativo al estado actual (opción 2, que para reacciones sí
 * es correcta). `update`/`move` necesitan una foto -no hay forma de "deshacer" un
 * cambio de texto o posición sin saber cuál era el anterior-, acotada a los campos
 * que cada una toca: son campos exclusivos del autor, nadie más los toca a la vez,
 * así que no arrastran el mismo riesgo que un contador compartido.
 */
export type PendingNoteOp =
  | { kind: 'create' }
  | { kind: 'update'; restore: { text: string; color: NoteColor } }
  | { kind: 'move'; restore: { position_x: number; position_y: number; status: NoteStatus } }
  | { kind: 'claim' }
  | { kind: 'release' }
  | { kind: 'reaction'; emoji: Reaction }
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

/**
 * Un renglón ya formateado de la franja de actividad (bloque 4, `features/activity/`).
 * Se arma en `store/activity.ts` en el momento en que cada `applyX` de
 * `roomStore.ts` lo amerita -no todos los eventos entran, ver ese módulo-. `color`
 * es el `ParticipantColor` de quien disparó el evento, para el punto de color en la
 * franja; `null` en los pocos casos sin un autor claro a quien atribuírselo (p. ej.
 * `room.background`, que no viaja con `participant_id`).
 */
export interface ActivityEntry {
  id: string
  at: string
  text: string
  color: ParticipantColor | null
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
  /** Ventana acotada de los últimos eventos, más nuevo al final. Efímera igual que
   * `presence`: `applyRoomSnapshot` la reinicia vacía, no sobrevive a una
   * reconexión. */
  activity: ActivityEntry[]
  /** Foto de una nota ya borrada de `notes`, mientras `NoteFalling.tsx` la anima
   * cayendo (pulido día 3). `roomStore.ts` la agrega en `applyNoteDelete` y la
   * limpia sola con un timeout -ver el docstring de ese componente. */
  fallingNotes: Record<string, NoteState>

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
    activity: [],
    fallingNotes: {},
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
