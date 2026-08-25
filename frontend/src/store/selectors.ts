/**
 * Derivados del estado que no se guardan como tal -para que ningún cliente pueda
 * quedar desincronizado del de otro por el orden de llegada de los eventos, y para
 * que no exista un segundo lugar donde se pueda desincronizar de `notes`.
 */

import type { ChatMessageState, NoteState, NoteStatus, ParticipantState } from '../realtime/protocol'

/**
 * Orden de notas: `(created_at, id)` ascendente, no orden de llegada.
 *
 * `created_at` porque es el único dato con sentido de "cuándo apareció esta nota" que
 * ya viaja en el wire y vale lo mismo para todos los clientes -a diferencia del orden
 * en que a CADA cliente le llegó su `note.create` (broadcast en vivo para unos,
 * adentro de `room.snapshot` al reconectar para otros; y el propio `room.snapshot` no
 * garantiza ningún orden particular en `notes`, es una consulta sin `ORDER BY`
 * explícito del lado del backend).
 *
 * `id` como desempate determinista para el caso ya documentado en CLAUDE.md
 * (`chat.list_messages`, misma limitación aplicable acá): Postgres congela `now()`
 * dentro de una misma transacción, así que varias notas creadas sin commitear entre
 * medio -`scripts/seed.py`- pueden compartir `created_at` exacto. No pasa en el uso
 * real vía WS (cada `note.create` es su propia transacción).
 *
 * Se usa también como orden de apilamiento visual (`features/canvas`): la nota más
 * nueva se dibuja arriba. Mover una nota NO cambia su lugar acá -el orden depende
 * solo de `created_at`, nunca de `updated_at`- así que arrastrar una nota vieja no la
 * "trae al frente".
 *
 * Comparación por string, sin parsear a `Date`: los timestamps llegan en ISO 8601 con
 * offset UTC y precisión constante (los pone Postgres vía pydantic), formato que
 * ordena igual lexicográfica que cronológicamente.
 *
 * Memoizado por identidad de `notes`: como el store nunca muta un `Record` en el
 * lugar (siempre lo reemplaza al cambiar algo), la única vez que hace falta
 * recalcular es cuando `notes` cambió de verdad -no en cada re-render por un cursor
 * moviéndose-. `WeakMap` en vez de un cache con límite manual: cuando un `notes`
 * viejo deja de estar referenciado en ningún lado, su entrada se libera sola.
 */
const orderCache = new WeakMap<Record<string, NoteState>, string[]>()

export function sortNotesByCreation(notes: Record<string, NoteState>): string[] {
  const cached = orderCache.get(notes)
  if (cached !== undefined) return cached

  const sorted = Object.values(notes)
    .sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
    .map((note) => note.id)

  orderCache.set(notes, sorted)
  return sorted
}

/**
 * Las tres columnas fijas del Kanban (CLAUDE.md: "tres fijas... enum en el código,
 * no tabla"), cada una con los ids de sus notas ya en el mismo orden que
 * `sortNotesByCreation` -un solo recorrido de esa lista, repartido por `status`, en
 * vez de tres `.filter()` separados que romperían la estabilidad referencial que
 * pide `useRoomStore` (cada `.filter()` inline devolvería un array nuevo en cada
 * render). Memoizado igual que `sortNotesByCreation`, por identidad de `notes`.
 */
const columnCache = new WeakMap<Record<string, NoteState>, Record<NoteStatus, string[]>>()

export function sortNotesByColumn(notes: Record<string, NoteState>): Record<NoteStatus, string[]> {
  const cached = columnCache.get(notes)
  if (cached !== undefined) return cached

  const columns: Record<NoteStatus, string[]> = { blocked: [], in_progress: [], done: [] }
  for (const id of sortNotesByCreation(notes)) {
    const note = notes[id]
    if (note !== undefined) columns[note.status].push(id)
  }

  columnCache.set(notes, columns)
  return columns
}

/**
 * Alto mínimo de una columna (pulido: el espacio de trabajo crece hacia abajo a
 * medida que se acumulan notas, en vez de quedar fijo con las últimas
 * desbordando sin scroll). Devuelve un número (`px`), no un objeto -no hace
 * falta memoizar con `WeakMap` como arriba: `useRoomStore` compara por
 * `Object.is`, y dos números iguales ya son iguales para esa comparación sin
 * ayuda, a diferencia de un array u objeto nuevo en cada llamada.
 *
 * Estimación de "cuánto ocupa una nota debajo de su `position_y`" a propósito
 * generosa y NO medida contra el DOM real -eso pediría un `ResizeObserver` por
 * nota, que no paga para esto en tres días. En el peor caso (texto muy largo en
 * una nota muy abajo) el post-it sobresale un poco del panel de su columna; no
 * rompe nada, solo se ve un poco corto el panel.
 */
const NOTE_FOOTPRINT_PX = 260
const COLUMN_MIN_HEIGHT_PX = 520

export function columnMinHeightPx(notes: Record<string, NoteState>, status: NoteStatus): number {
  let maxBottom = 0
  for (const note of Object.values(notes)) {
    if (note.status !== status) continue
    maxBottom = Math.max(maxBottom, note.position_y + NOTE_FOOTPRINT_PX)
  }
  return Math.max(COLUMN_MIN_HEIGHT_PX, maxBottom)
}

/**
 * Buscar (`features/canvas/CanvasFocusContext.ts`): substring simple, sin acentos ni
 * fuzzy matching, contra `note.text` CRUDO -no la prosa recortada que pinta la
 * tarjeta (`checklistPreviewText` en `Note.tsx`). Como el checklist vive como
 * markdown dentro del mismo campo (`lib/checklist.ts`), esto alcanza el contenido de
 * los ítems gratis, sin parsear nada aparte.
 *
 * Query vacía/en blanco = "sin búsqueda activa": todo matchea. Así el llamador
 * (`Note.tsx`) no necesita una rama aparte para "¿hay búsqueda o no?" -esta función
 * ya lo resuelve, un solo lugar.
 */
export function noteMatchesSearch(note: NoteState, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') return true
  return note.text.toLowerCase().includes(trimmed)
}

/**
 * Orden de la lista de participantes (`features/presence/ParticipantList.tsx`):
 * conectados primero, después desconectados -pero TODOS presentes, a propósito: el
 * snapshot ya trae a todo el que pasó por la sala porque sus notas siguen ahí
 * (docstring de `RoomSnapshot` en protocol.py), y resaltar las notas de alguien que
 * se desconectó hace un rato es igual de útil que resaltar las de alguien presente.
 * Dentro de cada grupo, alfabético por nombre -sin un timestamp con sentido para
 * "cuándo apareció esta persona en la lista" que valga la pena ordenar por él en vez
 * de por nombre, a diferencia de `sortNotesByCreation`.
 *
 * Memoizado igual que `sortNotesByCreation`/`sortNotesByColumn`: mismo motivo,
 * mismo patrón (el store nunca muta `participants` en el lugar).
 */
const participantOrderCache = new WeakMap<Record<string, ParticipantState>, ParticipantState[]>()

export function sortParticipantsForList(
  participants: Record<string, ParticipantState>,
): ParticipantState[] {
  const cached = participantOrderCache.get(participants)
  if (cached !== undefined) return cached

  const sorted = Object.values(participants).sort((a, b) => {
    const aConnected = a.disconnected_at === null
    const bConnected = b.disconnected_at === null
    if (aConnected !== bConnected) return aConnected ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  participantOrderCache.set(participants, sorted)
  return sorted
}

/**
 * `note_id` distintos entre los mensajes de chat -para el selector de filtro por
 * tarea (`features/chat/ChatPanel.tsx`). En orden de primera aparición, no
 * alfabético ni por título: resolver el título (y decidir qué hacer si la nota ya
 * no existe, ver CLAUDE.md sobre ese hueco conocido) es responsabilidad del panel,
 * que sí tiene `state.notes` a mano -acá no.
 *
 * Memoizado igual que el resto de este archivo, por identidad de `messages`.
 */
const chatNoteIdsCache = new WeakMap<ChatMessageState[], string[]>()

export function distinctChatNoteIds(messages: ChatMessageState[]): string[] {
  const cached = chatNoteIdsCache.get(messages)
  if (cached !== undefined) return cached

  const seen = new Set<string>()
  const ids: string[] = []
  for (const message of messages) {
    if (message.note_id === null || seen.has(message.note_id)) continue
    seen.add(message.note_id)
    ids.push(message.note_id)
  }

  chatNoteIdsCache.set(messages, ids)
  return ids
}
