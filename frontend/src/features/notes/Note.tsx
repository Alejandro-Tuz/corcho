/**
 * Un post-it: arrastre, borrado, y -bloque 2- cupos con rebote y nota fantasma.
 * Solo el autor puede arrastrar o borrar (validación de autoría del backend,
 * `services/notes.py`; acá se refleja no ofreciendo el control, no hay nada que la
 * UI legítima necesite intentar sobre una nota ajena). Cualquiera puede tomar o
 * soltar un cupo en una nota `shared` -sin chequeo de autoría, decisión ya tomada-.
 *
 * ## Arrastre propio vs. fantasma ajeno
 *
 * Mi propio arrastre es 100% local hasta soltar (`dragPosition`, estado del
 * componente) -no depende del store ni de `presence.dragging` para dibujarse: cero
 * latencia de red en lo que yo veo de mi propia mano-. Sí manda `presence.dragging`
 * (throttled) para que las OTRAS pantallas vean la nota moverse en vivo; eso es lo
 * que hace `Note` en la pantalla de otra persona cuando `note.author_id` tiene una
 * entrada en `presence.dragging`: la dibuja en esa posición en vez de en
 * `note.position_x/y`, con opacidad reducida y borde del color del que arrastra
 * -el fantasma-. `restore` de `moveNote` para un eventual rechazo se captura al
 * soltar, contra lo que el store cree en ese instante -ver el docstring de
 * `PendingNoteOp` en `store/types.ts`-, no contra dónde arrancó el arrastre.
 *
 * Sin CSS elaborado: cajas con borde, nada de sombra ni tipografía elegida (día 3).
 */

import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { throttle } from '../../realtime/throttle'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'

const DRAG_BROADCAST_INTERVAL_MS = 50

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
  const remoteDragging = useRoom((s) =>
    note === undefined ? undefined : s.presence.dragging[note.author_id],
  )
  const draggerColor = useRoom((s) =>
    note === undefined ? undefined : s.participants[note.author_id]?.color,
  )
  const actions = useRoomActions()

  const dragStateRef = useRef<DragState | null>(null)
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null)
  const throttledSendDragging = useMemo(
    () => throttle(actions.sendDragging, DRAG_BROADCAST_INTERVAL_MS),
    [actions],
  )

  if (note === undefined) return null

  const isMine = note.author_id === myParticipantId
  const isPendingDelete = pending?.kind === 'delete'
  const hasClaimed = myParticipantId !== null && note.claims.includes(myParticipantId)
  const isFull = note.capacity !== null && note.taken_count >= note.capacity
  const claimPending = pending?.kind === 'claim'
  const releasePending = pending?.kind === 'release'

  const ghostPosition =
    remoteDragging !== undefined && remoteDragging.noteId === noteId
      ? { x: remoteDragging.positionX, y: remoteDragging.positionY }
      : null
  const isGhost = ghostPosition !== null

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
    const x = drag.noteStartX + (e.clientX - drag.startX)
    const y = drag.noteStartY + (e.clientY - drag.startY)
    setDragPosition({ x, y })
    throttledSendDragging(noteId, x, y)
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

  function handleClaim(): void {
    actions.claimNote(noteId)
  }

  function handleRelease(): void {
    actions.releaseNote(noteId)
  }

  const x = dragPosition?.x ?? ghostPosition?.x ?? note.position_x
  const y = dragPosition?.y ?? ghostPosition?.y ?? note.position_y
  const ghostBorderColor =
    draggerColor !== undefined ? PARTICIPANT_COLOR_HEX[draggerColor] : '#666'

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
        border: isGhost ? `2px dashed ${ghostBorderColor}` : '1px solid #666',
        background: '#ddd',
        padding: 8,
        boxSizing: 'border-box',
        cursor: isMine ? 'grab' : 'default',
        opacity: isPendingDelete ? 0.4 : isGhost ? 0.7 : 1,
        pointerEvents: isPendingDelete ? 'none' : 'auto',
      }}
    >
      <div>{note.text}</div>

      {note.kind === 'shared' && (
        <div>
          <span>
            {note.taken_count}/{note.capacity ?? 0} cupos
          </span>
          {hasClaimed ? (
            <button type="button" onClick={handleRelease} disabled={releasePending}>
              soltar cupo
            </button>
          ) : (
            <button type="button" onClick={handleClaim} disabled={isFull || claimPending}>
              tomar cupo
            </button>
          )}
        </div>
      )}
      {note.kind === 'own' && <div>propia</div>}

      {isMine && (
        <button type="button" onClick={handleDelete} disabled={isPendingDelete}>
          borrar
        </button>
      )}
    </div>
  )
}
