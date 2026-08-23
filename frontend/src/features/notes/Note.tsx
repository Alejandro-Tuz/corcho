/**
 * Un post-it: arrastre y borrado. Solo el autor puede arrastrar o borrar (validación
 * de autoría del backend, `services/notes.py`; acá se refleja no ofreciendo el
 * control, no hay nada que la UI legítima necesite intentar sobre una nota ajena).
 *
 * El arrastre es 100% local hasta soltar -Pointer Events con `setPointerCapture`,
 * sin `presence.dragging` todavía (eso es "nota fantasma", bloque 2)-. Recién en
 * `pointerup` se llama a `moveNote`, que aplica la mutación optimista y manda
 * `note.move`. `restore` para un eventual rechazo se captura ahí adentro, contra lo
 * que el store cree en ese instante -ver el docstring de `PendingNoteOp` en
 * `store/types.ts`-, no contra la posición donde arrancó este arrastre.
 *
 * Sin CSS elaborado: una caja con borde, nada de sombra ni tipografía elegida (día 3).
 */

import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'

interface DragState {
  pointerId: number
  startX: number
  startY: number
  noteStartX: number
  noteStartY: number
}

export function Note({ noteId }: { noteId: string }) {
  const note = useRoom((s) => s.notes[noteId])
  const pending = useRoom((s) => s.pendingNoteOps[noteId])
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)
  const actions = useRoomActions()

  const dragStateRef = useRef<DragState | null>(null)
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null)

  if (note === undefined) return null

  const isMine = note.author_id === myParticipantId
  const isPendingDelete = pending?.kind === 'delete'

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!isMine || note === undefined) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      noteStartX: note.position_x,
      noteStartY: note.position_y,
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    setDragPosition({
      x: drag.noteStartX + (e.clientX - drag.startX),
      y: drag.noteStartY + (e.clientY - drag.startY),
    })
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (drag === null || drag.pointerId !== e.pointerId || note === undefined) return
    const finalX = drag.noteStartX + (e.clientX - drag.startX)
    const finalY = drag.noteStartY + (e.clientY - drag.startY)
    dragStateRef.current = null
    setDragPosition(null)
    actions.moveNote(noteId, finalX, finalY, note.status)
  }

  function handleDelete(): void {
    actions.deleteNote(noteId)
  }

  const x = dragPosition?.x ?? note.position_x
  const y = dragPosition?.y ?? note.position_y

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 160,
        minHeight: 90,
        border: '1px solid #666',
        background: '#ddd',
        padding: 8,
        boxSizing: 'border-box',
        cursor: isMine ? 'grab' : 'default',
        opacity: isPendingDelete ? 0.4 : 1,
        pointerEvents: isPendingDelete ? 'none' : 'auto',
      }}
    >
      <div>{note.text}</div>
      <div>{note.kind === 'shared' ? `${note.taken_count}/${note.capacity ?? 0} cupos` : 'propia'}</div>
      {isMine && (
        <button type="button" onClick={handleDelete} disabled={isPendingDelete}>
          borrar
        </button>
      )}
    </div>
  )
}
