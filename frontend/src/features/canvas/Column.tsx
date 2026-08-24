/**
 * Un contenedor de columna: encabezado + una caja `position: relative` donde las
 * notas de ese `status` se dibujan con `position_x/y` relativos a ESTA caja, no al
 * lienzo entero. Es la pieza que hace cumplir la decisión ya tomada en CLAUDE.md:
 * "la columna NO se deriva de la x" -acá la columna la decide `status`, la posición
 * dentro de la columna la decide `position_x/y`, son independientes.
 *
 * `data-column-status` es el gancho que usa `Note.tsx` para averiguar, con
 * `document.elementFromPoint()` en el momento de soltar un arrastre, sobre qué
 * columna cayó -ver el docstring de `Note.tsx` para el porqué de esa elección en vez
 * de medir anchos de columna a mano.
 *
 * También dibuja las notas que se acaban de borrar y siguen "cayendo"
 * (`NoteFalling.tsx`, pulido día 3) -viven en `state.fallingNotes`, no en
 * `state.notes`, así que no pasan por `sortNotesByColumn`.
 */

import { useRoom } from '../../app/RoomStoreContext'
import { columnMinHeightPx, sortNotesByColumn } from '../../store/selectors'
import { Note } from '../notes/Note'
import { NoteFalling } from '../notes/NoteFalling'
import type { NoteStatus } from '../../realtime/protocol'
import './Column.css'

export function Column({ status, label }: { status: NoteStatus; label: string }) {
  const noteIds = useRoom((s) => sortNotesByColumn(s.notes)[status])
  const minHeight = useRoom((s) => columnMinHeightPx(s.notes, status))
  const fallingNotes = useRoom((s) => s.fallingNotes)
  // Pocas a la vez y de vida corta (ver docstring de `NoteFalling`): filtrar acá
  // en cada render no vale la memoización que sí necesita `sortNotesByColumn`
  // para la lista principal, mucho más grande y mucho más leída.
  const fallingForStatus = Object.values(fallingNotes).filter((n) => n.status === status)

  return (
    <div className="column">
      <div className="column-head">
        <span>{label}</span>
        <span className="column-count">{noteIds.length}</span>
      </div>
      <div data-column-status={status} className="column-body" style={{ minHeight }}>
        {noteIds.map((id) => (
          <Note key={id} noteId={id} />
        ))}
        {fallingForStatus.map((note) => (
          <NoteFalling key={note.id} note={note} />
        ))}
      </div>
    </div>
  )
}
