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
 */

import { useRoom } from '../../app/RoomStoreContext'
import { sortNotesByColumn } from '../../store/selectors'
import { Note } from '../notes/Note'
import type { NoteStatus } from '../../realtime/protocol'

export function Column({ status, label }: { status: NoteStatus; label: string }) {
  const noteIds = useRoom((s) => sortNotesByColumn(s.notes)[status])

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 8px', fontWeight: 'bold', borderBottom: '1px solid #999' }}>
        {label} ({noteIds.length})
      </div>
      <div
        data-column-status={status}
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'visible',
          borderLeft: '1px dashed #bbb',
        }}
      >
        {noteIds.map((id) => (
          <Note key={id} noteId={id} />
        ))}
      </div>
    </div>
  )
}
