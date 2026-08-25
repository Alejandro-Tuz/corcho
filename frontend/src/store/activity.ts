/**
 * Formateo de texto para la franja de actividad (bloque 4). `roomStore.ts` es
 * quien decide EN QUÉ `applyX` corresponde un renglón nuevo y con qué datos -acá
 * solo vive cómo se arma el texto en español y el recorte de la ventana, para no
 * inflar más ese archivo con estas responsabilidades bien distintas (reconciliar
 * estado optimista vs. redactar una frase).
 *
 * Eventos que SÍ dejan renglón: alguien se conecta/desconecta, crea/borra/mueve
 * (solo si cambia de columna) una nota, toma/suelta un cupo, reacciona (solo al
 * activar, no al desactivar -el toggle de "sacar" una reacción no aporta nada que
 * mirar), cambia el fondo, manda un mensaje de chat, o pide un resumen de la sala
 * (`room.summary_requested`) -el resultado (`room.summary`) NO deja un segundo
 * renglón: ya tiene su propia superficie dedicada (`RoomSummaryButton.tsx`), un
 * duplicado acá sería ruido.
 *
 * Eventos que a propósito NO dejan renglón: `note.update` (texto/color editado
 * -pasa seguido mientras alguien piensa en voz alta, sería la mitad de la franja
 * en cualquier sesión real), los rechazos de cupo (van solo a quien los pidió, no
 * son "actividad de la sala"), y los cuatro efímeros de presencia (invariante 6,
 * ni siquiera llegan como `ServerEvent` persistible).
 *
 * `STATUS_LABELS`/`BACKGROUND_LABELS` duplican a propósito las etiquetas que ya
 * existen en `features/canvas/columns.ts` y `features/canvas/backgroundColor.ts`
 * en vez de importarlas: `store/` no depende de `features/` en esta estructura
 * (ver CLAUDE.md), y son tres y cinco strings fijos, no un catálogo que vaya a
 * cambiar de un lado sin el otro.
 *
 * `appendActivity` toma un quinto parámetro opcional, `isChatMessage` -ver el
 * docstring de `ActivityEntry` en `store/types.ts` sobre por qué hace falta
 * marcarlo, no inferirlo de `text`.
 */

import type { Background, NoteKind, NoteStatus, ParticipantColor } from '../realtime/protocol'
import type { ActivityEntry } from './types'

const MAX_ENTRIES = 40
const NOTE_TEXT_PREVIEW_LENGTH = 40

export function appendActivity(
  activity: ActivityEntry[],
  text: string,
  color: ParticipantColor | null,
  participantId: string | null,
  isChatMessage = false,
): ActivityEntry[] {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    text,
    color,
    participantId,
    isChatMessage,
  }
  const next = [...activity, entry]
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
}

/** Recorta el texto de una nota o mensaje para que quepa en un renglón de la
 * franja -nunca el motivo por el que algo se corta en otro lado (el post-it o el
 * mensaje siguen mostrando el texto completo donde corresponda). */
export function previewNoteText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > NOTE_TEXT_PREVIEW_LENGTH
    ? `${trimmed.slice(0, NOTE_TEXT_PREVIEW_LENGTH).trimEnd()}…`
    : trimmed
}

export function noteKindLabel(kind: NoteKind): string {
  return kind === 'shared' ? 'una nota compartida' : 'una nota'
}

export const STATUS_LABELS: Record<NoteStatus, string> = {
  blocked: 'Bloqueado',
  in_progress: 'En curso',
  done: 'Listo',
}

export const BACKGROUND_LABELS: Record<Background, string> = {
  bone: 'Hueso',
  warm_gray: 'Gris cálido',
  sage: 'Salvia',
  fog_blue: 'Azul niebla',
  charcoal: 'Carbón',
  dots_sage: 'Lunares salvia',
  dots_blue: 'Lunares azules',
  dots_dark: 'Lunares oscuros',
}
