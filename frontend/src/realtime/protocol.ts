/**
 * EL CONTRATO entre backend y frontend para `/ws/{room}`.
 *
 * Espejo manual de `backend/app/realtime/protocol.py` (invariante: cambian en el mismo
 * commit; no hay generación automática de uno a partir del otro). Los nombres de campo
 * quedan en snake_case tal como viajan por el wire, para que este archivo sea un espejo
 * literal y no haga falta una capa de conversión de casing.
 *
 * ## Forma del envelope
 *
 * Cada evento es un objeto plano con su propio `type`. No hay un `payload` anidado.
 *
 * ## Mismo `type`, dos formas
 *
 * Para toda acción sobre un recurso ya existente, lo que manda el cliente (`*In`) y lo
 * que el servidor confirma a la sala comparten el mismo `type`, pero son interfaces
 * distintas: el cliente nunca es autoridad sobre `participant_id`/`author_id`, ni sobre
 * contadores o timestamps. Única excepción: `RoomJoinIn.participant_id`, porque ese
 * mensaje ES el que establece la identidad del socket al reconectar (ver docstring de
 * protocol.py para el detalle completo de esta y las demás decisiones).
 *
 * ## Correlación para estado optimista
 *
 * Sin ids de operación genéricos: se reusa el `id` generado en cliente para
 * `note.create`/`chat.message` (el servidor lo reemite tal cual), y `note_id` para
 * acciones sobre una nota existente, incluidos los rechazos.
 *
 * ## Rechazos
 *
 * `note.claim`/`note.release` tienen su propio evento de rechazo tipado (carrera
 * esperable por uso normal, enviado solo al socket que lo pidió). La autoría de
 * `note.update`/`note.move` (bug o manipulación, nunca alcanzable desde la UI legítima)
 * no tiene evento propio: cae en `ErrorEvent` con `code: "forbidden"` y `note_id`.
 *
 * ## Eventos efímeros
 *
 * Agrupados al final de este archivo y listados en `EPHEMERAL_EVENT_TYPES`: alta
 * frecuencia, no se persisten (invariante 6), el backend nunca los guarda.
 * `presence.dragging` se limpia con `note.move` (el cliente lo manda SIEMPRE al
 * soltar, aunque no haya cambiado nada) o con `presence.left`. `presence.drafting`
 * tiene `active` explícito porque cancelar no deja ningún evento que lo reemplace.
 */

// --- Catálogos (espejo de backend/app/core/constants.py) ---------------------------

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'orange'
export type ParticipantColor = 'coral' | 'teal' | 'violet' | 'amber' | 'sky' | 'rose'
export type Avatar =
  | 'fox'
  | 'penguin'
  | 'turtle'
  | 'owl'
  | 'bee'
  | 'whale'
  | 'hedgehog'
  | 'octopus'
// Cinco sólidos (hueso, gris cálido, salvia, azul niebla, uno oscuro) + tres
// variantes con lunares, sumadas en el pulido del día 3 (espejo de BACKGROUNDS
// en constants.py -ver su comentario sobre por qué se sumaron patrones).
export type Background =
  | 'bone'
  | 'warm_gray'
  | 'sage'
  | 'fog_blue'
  | 'charcoal'
  | 'dots_sage'
  | 'dots_blue'
  | 'dots_dark'
export type Reaction = '✓' | '👀' | '🔥'

export type NoteKind = 'own' | 'shared'
export type NoteStatus = 'blocked' | 'in_progress' | 'done'

// --- Estado compartido ---------------------------------------------------------------
// Misma forma para un evento puntual (p. ej. la salida de note.create) y para los
// elementos de las listas de room.snapshot.

export interface ReactionEntry {
  emoji: Reaction
  participant_id: string
}

export interface NoteState {
  id: string
  author_id: string
  kind: NoteKind
  status: NoteStatus
  text: string
  color: NoteColor
  position_x: number
  position_y: number
  capacity: number | null
  taken_count: number
  created_at: string
  updated_at: string
  claims: string[]
  reactions: ReactionEntry[]
}

export interface ParticipantState {
  id: string
  name: string
  avatar: Avatar
  color: ParticipantColor
  connected_at: string
  /** null = conectado. room.snapshot trae a todo el que pasó por la sala, no solo a
   * los presentes ahora: un mensaje de chat de alguien offline necesita con qué
   * renderizar nombre y avatar. */
  disconnected_at: string | null
}

export interface ChatMessageState {
  id: string
  note_id: string | null
  author_id: string
  text: string
  created_at: string
}

// --- room.join / room.snapshot -------------------------------------------------------

export interface RoomJoinIn {
  type: 'room.join'
  /** Única excepción a "ningún *In lleva participant_id" (ver docstring arriba). null
   * en la primera visita a la sala. */
  participant_id: string | null
  name: string
  avatar: Avatar
  color: ParticipantColor
}

/**
 * Enviado solo al socket que se unió, nunca a la sala.
 *
 * `participant_id`: la identidad que este socket acaba de establecer con
 * `room.join`. Es el único lugar sin ambigüedad para que el cliente aprenda su
 * propio id -`PresenceJoined` no alcanza: no se difunde en una reconexión
 * (`is_first=False`), y en el primer join correlacionarlo por orden de llegada o por
 * nombre/avatar/color es frágil (joins simultáneos, catálogo chico de valores
 * repetibles).
 */
export interface RoomSnapshot {
  type: 'room.snapshot'
  participant_id: string
  slug: string
  name: string | null
  background: Background
  notes: NoteState[]
  participants: ParticipantState[]
  chat_messages: ChatMessageState[]
}

// --- presencia (por conexión, no por mensaje del cliente) ----------------------------

export interface PresenceJoined extends ParticipantState {
  type: 'presence.joined'
}

export interface PresenceLeft {
  type: 'presence.left'
  participant_id: string
}

// --- notas -----------------------------------------------------------------------------

export interface NoteCreateIn {
  type: 'note.create'
  id: string
  kind: NoteKind
  status: NoteStatus
  /** Hasta NOTE_TEXT_MAX_LENGTH (lib/constants.ts) -espejo del `Field(max_length=2000)`
   * de protocol.py y del CHECK "text_length" de la tabla notes. */
  text: string
  color: NoteColor
  position_x: number
  position_y: number
  /** null si kind === 'own'; requerido y > 0 si kind === 'shared' (espeja el CHECK
   * "kind_capacity" de la tabla notes). */
  capacity: number | null
}

export interface NoteCreateOut extends NoteState {
  type: 'note.create'
}

export interface NoteUpdateIn {
  type: 'note.update'
  id: string
  /** Mismo límite que NoteCreateIn.text -ver ese comentario. */
  text: string
  color: NoteColor
}

export interface NoteUpdateOut {
  type: 'note.update'
  id: string
  text: string
  color: NoteColor
  updated_at: string
}

export interface NoteMoveIn {
  type: 'note.move'
  id: string
  position_x: number
  position_y: number
  status: NoteStatus
}

export interface NoteMoveOut {
  type: 'note.move'
  id: string
  position_x: number
  position_y: number
  status: NoteStatus
}

export interface NoteDeleteIn {
  type: 'note.delete'
  id: string
}

export interface NoteDeleteOut {
  type: 'note.delete'
  id: string
}

// --- cupos: la única concurrencia real ------------------------------------------------

export interface NoteClaimIn {
  type: 'note.claim'
  note_id: string
}

export interface NoteClaimOut {
  type: 'note.claim'
  note_id: string
  participant_id: string
  taken_count: number
}

/** Enviado solo al socket que lo pidió. */
export interface NoteClaimRejected {
  type: 'note.claim_rejected'
  note_id: string
  participant_id: string
  reason: 'full'
}

export interface NoteReleaseIn {
  type: 'note.release'
  note_id: string
}

export interface NoteReleaseOut {
  type: 'note.release'
  note_id: string
  participant_id: string
  taken_count: number
}

/** Enviado solo al socket que lo pidió: intentó soltar un cupo que no tenía. */
export interface NoteReleaseRejected {
  type: 'note.release_rejected'
  note_id: string
  participant_id: string
  reason: 'not_held'
}

// --- reacciones --------------------------------------------------------------------

export interface ReactionToggleIn {
  type: 'reaction.toggle'
  note_id: string
  emoji: Reaction
}

export interface ReactionToggleOut {
  type: 'reaction.toggle'
  note_id: string
  participant_id: string
  emoji: Reaction
  active: boolean
}

// --- chat ------------------------------------------------------------------------------

export interface ChatMessageIn {
  type: 'chat.message'
  id: string
  note_id: string | null
  text: string
}

export interface ChatMessageOut extends ChatMessageState {
  type: 'chat.message'
}

// --- sala ------------------------------------------------------------------------------

export interface RoomBackgroundIn {
  type: 'room.background'
  background: Background
}

export interface RoomBackgroundOut {
  type: 'room.background'
  background: Background
}

// --- error genérico (enviado solo al socket que lo disparó) --------------------------

export interface ErrorEvent {
  type: 'error'
  code: 'forbidden' | 'invalid_message' | 'not_found'
  message: string
  /** Presente cuando el error se atribuye a una nota puntual (p. ej. el "forbidden" de
   * note.update/note.move sobre una nota ajena), para revertir la edición optimista. */
  note_id: string | null
}

// --- keepalive -----------------------------------------------------------------------

export interface Ping {
  type: 'ping'
}

export interface Pong {
  type: 'pong'
}

// --- efímeros: no se persisten (invariante 6) -----------------------------------------

export interface PresenceCursorIn {
  type: 'presence.cursor'
  x: number
  y: number
}

export interface PresenceCursorOut {
  type: 'presence.cursor'
  participant_id: string
  x: number
  y: number
}

export interface PresenceDraggingIn {
  type: 'presence.dragging'
  note_id: string
  position_x: number
  position_y: number
}

export interface PresenceDraggingOut {
  type: 'presence.dragging'
  participant_id: string
  note_id: string
  position_x: number
  position_y: number
}

export interface PresenceDraftingIn {
  type: 'presence.drafting'
  kind: NoteKind
  position_x: number
  position_y: number
  active: boolean
}

export interface PresenceDraftingOut {
  type: 'presence.drafting'
  participant_id: string
  kind: NoteKind
  position_x: number
  position_y: number
  active: boolean
}

export interface ChatTypingIn {
  type: 'chat.typing'
  note_id: string | null
  active: boolean
}

export interface ChatTypingOut {
  type: 'chat.typing'
  participant_id: string
  note_id: string | null
  active: boolean
}

// --- uniones discriminadas -----------------------------------------------------------

export type ClientEvent =
  | RoomJoinIn
  | NoteCreateIn
  | NoteUpdateIn
  | NoteMoveIn
  | NoteDeleteIn
  | NoteClaimIn
  | NoteReleaseIn
  | ReactionToggleIn
  | ChatMessageIn
  | RoomBackgroundIn
  | Ping
  | PresenceCursorIn
  | PresenceDraggingIn
  | PresenceDraftingIn
  | ChatTypingIn

export type ServerEvent =
  | RoomSnapshot
  | PresenceJoined
  | PresenceLeft
  | NoteCreateOut
  | NoteUpdateOut
  | NoteMoveOut
  | NoteDeleteOut
  | NoteClaimOut
  | NoteClaimRejected
  | NoteReleaseOut
  | NoteReleaseRejected
  | ReactionToggleOut
  | ChatMessageOut
  | RoomBackgroundOut
  | ErrorEvent
  | Pong
  | PresenceCursorOut
  | PresenceDraggingOut
  | PresenceDraftingOut
  | ChatTypingOut

type EventType = ClientEvent['type'] | ServerEvent['type']

export const EPHEMERAL_EVENT_TYPES = [
  'presence.cursor',
  'presence.dragging',
  'presence.drafting',
  'chat.typing',
] as const satisfies readonly EventType[]
