/**
 * Exportar el tablero a markdown (CLAUDE.md, "Nuevo, aprobado"). Puro frontend: lee
 * el `RoomState` que ya existe y arma un string -nada que el backend tenga que
 * saber, el disparador real (`downloadTextFile`, `lib/downloadFile.ts`) tampoco
 * sabe nada de notas ni de salas.
 *
 * Reusa `sortNotesByColumn` (mismo orden que se ve en pantalla, por columna) y
 * `STATUS_LABELS` de `store/activity.ts` -mismas etiquetas que ya usa la franja de
 * actividad, un solo lugar- y el parseo de checklist de `lib/checklist.ts` -el
 * checklist ya vive como markdown dentro de `note.text` (misma convención que
 * `NoteDetail.tsx`), así que exportarlo es reproducir esa sintaxis, no inventar
 * una nueva.
 *
 * Título de cada nota: `noteTitle` (`lib/checklist.ts`) -primera línea de la
 * prosa, o el texto del primer ítem si la nota es 100% checklist-, para que el
 * título acá sea reconocible como la misma nota que se ve en el lienzo. El resto
 * de la prosa (si hay más de una línea) va como párrafo aparte, para no duplicar
 * la primera línea dos veces cuando la nota es de una sola oración -el caso
 * común.
 *
 * Cada bloque (nota, columna, documento) se arma como una lista de PÁRRAFOS ya
 * completos, unida recién al final con `\n\n` -nunca líneas vacías sueltas
 * arrastradas dentro de un array que después se junta con `\n`- para que el
 * espaciado entre bloques sea el mismo tenga o no contenido el bloque anterior.
 */

import { checklistProgress, noteTitle, parseChecklist, proseOnly } from '../lib/checklist'
import type { NoteState, NoteStatus, ParticipantState } from '../realtime/protocol'
import { STATUS_LABELS } from './activity'
import { sortNotesByColumn } from './selectors'

const STATUS_ORDER: readonly NoteStatus[] = ['blocked', 'in_progress', 'done']

function participantName(participants: Record<string, ParticipantState>, id: string): string {
  return participants[id]?.name ?? 'alguien'
}

function noteToMarkdown(note: NoteState, participants: Record<string, ParticipantState>): string {
  const items = parseChecklist(note.text)
  const proseLines = proseOnly(note.text)
    .split('\n')
    .filter((line) => line.trim() !== '')
  const title = noteTitle(note.text)
  const restProse = proseLines.slice(1).join('\n\n')

  const author = participantName(participants, note.author_id)
  const kindParagraph =
    note.kind === 'shared'
      ? `_${author} · compartida — ${note.taken_count}/${note.capacity ?? 0} cupos${
          note.claims.length > 0
            ? ` (${note.claims.map((id) => participantName(participants, id)).join(', ')})`
            : ''
        }_`
      : `_${author} · propia_`

  const paragraphs = [`### ${title}`]
  if (restProse !== '') paragraphs.push(restProse)
  paragraphs.push(kindParagraph)

  if (items.length > 0) {
    const progress = checklistProgress(items)
    const checklistLines = items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
    paragraphs.push(`Checklist: ${progress.done}/${progress.total}\n${checklistLines.join('\n')}`)
  }

  if (note.reactions.length > 0) {
    const byEmoji = new Map<string, string[]>()
    for (const r of note.reactions) {
      const names = byEmoji.get(r.emoji) ?? []
      names.push(participantName(participants, r.participant_id))
      byEmoji.set(r.emoji, names)
    }
    const reactionsText = [...byEmoji.entries()]
      .map(([emoji, names]) => `${emoji} ×${names.length} (${names.join(', ')})`)
      .join(', ')
    paragraphs.push(`_Reacciones: ${reactionsText}_`)
  }

  return paragraphs.join('\n\n')
}

function columnToMarkdown(
  status: NoteStatus,
  noteIds: readonly string[],
  notes: Record<string, NoteState>,
  participants: Record<string, ParticipantState>,
): string {
  const header = `## ${STATUS_LABELS[status]} (${noteIds.length})`
  if (noteIds.length === 0) return `${header}\n\n_Sin notas._`

  const noteBlocks = noteIds
    .map((id) => notes[id])
    .filter((n): n is NoteState => n !== undefined)
    .map((note) => noteToMarkdown(note, participants))

  return [header, ...noteBlocks].join('\n\n')
}

export function roomToMarkdown(state: {
  slug: string | null
  name: string | null
  notes: Record<string, NoteState>
  participants: Record<string, ParticipantState>
}): string {
  const columns = sortNotesByColumn(state.notes)
  const title = state.name ?? state.slug ?? 'Corcho'
  const exportedAt = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

  const sections = STATUS_ORDER.map((status) =>
    columnToMarkdown(status, columns[status], state.notes, state.participants),
  )

  return [`# Corcho — ${title}`, `_Exportado ${exportedAt}_`, ...sections].join('\n\n')
}
