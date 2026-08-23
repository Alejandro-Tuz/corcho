/**
 * Un post-it: arrastre entre columnas, borrado, cupos con rebote, nota fantasma, y
 * -bloque 3- reacciones. Solo el autor arrastra o borra (autoría del backend,
 * `services/notes.py`); cualquiera reacciona o toma/suelta un cupo.
 *
 * ## Arrastre consciente de columnas
 *
 * Con columnas (`features/canvas/Column.tsx`), una nota vive DENTRO del contenedor
 * de su `status` -su `position_x/y` son relativos a esa columna, no al lienzo entero
 * (decisión ya tomada en CLAUDE.md: la columna no se deriva de `x`)-. Pero un
 * arrastre tiene que poder cruzar de columna visualmente ANTES de soltar, y mientras
 * está en el aire no sabemos a qué columna va a caer. Resolución:
 *
 * - Mientras SE ARRASTRA (mía o fantasma de otro): `position: fixed`, coordenadas de
 *   PANTALLA. Así la nota puede volar sobre cualquier columna sin importar de cuál es
 *   hijo en el DOM -no hace falta reparentarla, ni saber en qué columna está "ahora"
 *   durante el gesto-.
 * - Al SOLTAR (mi propio arrastre): `document.elementFromPoint()` en la posición del
 *   mouse dice bajo qué columna cayó (atributo `data-column-status` de
 *   `Column.tsx`). Ahí sí se calculan `position_x/y` relativos a ESA columna, y se
 *   manda `note.move` con esa posición y ese `status` en el mismo evento -exactamente
 *   lo que pide la decisión ya tomada-. `pointerEvents: 'none'` mientras se arrastra
 *   para que `elementFromPoint` no encuentre a la nota misma bajo el mouse en vez de
 *   la columna -la captura del puntero (`setPointerCapture`) sigue entregando los
 *   eventos igual, así que esto no rompe nada del propio arrastre-.
 * - Cuando estable (nadie la arrastra): vuelve a `position: absolute` normal, dentro
 *   de su columna, con `position_x/y` tal cual las persiste el backend.
 *
 * `document.querySelector` en vez de pasar refs por props/contexto: hay un solo
 * lienzo y tres columnas en toda la app en un momento dado, no se justifica la
 * plomería extra para este tamaño de proyecto (mismo criterio "feo primero").
 *
 * ## Fantasma (`presence.dragging`)
 *
 * Lo que se MANDA sigue siendo relativo al lienzo entero (mismo origen que
 * `presence.cursor`, `data-canvas-root` en `Canvas.tsx`) -no a una columna: no hace
 * falta esa precisión para una vista transitoria en la pantalla de otra persona-. Lo
 * que se DIBUJA acá convierte esa coordenada de lienzo a la pantalla de quien mira,
 * sumando el origen de SU PROPIO lienzo -que puede tener otro tamaño de ventana-.
 *
 * `restore` de `moveNote` para un eventual rechazo se captura al soltar, contra lo
 * que el store cree en ese instante -ver el docstring de `PendingNoteOp` en
 * `store/types.ts`-, no contra dónde arrancó el arrastre.
 */

import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { throttle } from '../../realtime/throttle'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import { REACTIONS } from '../../lib/constants'
import type { NoteStatus, Reaction } from '../../realtime/protocol'

const DRAG_BROADCAST_INTERVAL_MS = 50

interface DragState {
  pointerId: number
  grabOffsetX: number
  grabOffsetY: number
}

function columnStatusAtPoint(clientX: number, clientY: number): NoteStatus | null {
  const el = document.elementFromPoint(clientX, clientY)
  const columnEl = el instanceof Element ? el.closest('[data-column-status]') : null
  const status = columnEl?.getAttribute('data-column-status')
  return status === 'blocked' || status === 'in_progress' || status === 'done' ? status : null
}

function rectOf(selector: string): DOMRect | null {
  return document.querySelector(selector)?.getBoundingClientRect() ?? null
}

export function Note({ noteId }: { noteId: string }) {
  const note = useRoom((s) => s.notes[noteId])
  const pending = useRoom((s) => s.pendingNoteOps[noteId])
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)
  const participants = useRoom((s) => s.participants)
  const remoteDragging = useRoom((s) =>
    note === undefined ? undefined : s.presence.dragging[note.author_id],
  )
  const draggerColor = useRoom((s) =>
    note === undefined ? undefined : s.participants[note.author_id]?.color,
  )
  const actions = useRoomActions()

  const dragStateRef = useRef<DragState | null>(null)
  const [dragScreenPosition, setDragScreenPosition] = useState<{ x: number; y: number } | null>(
    null,
  )
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

  const isDraggingLocally = dragScreenPosition !== null
  const ghostCanvasPosition =
    !isDraggingLocally && remoteDragging !== undefined && remoteDragging.noteId === noteId
      ? { x: remoteDragging.positionX, y: remoteDragging.positionY }
      : null
  const isGhost = ghostCanvasPosition !== null

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!isMine) return
    // Bug real encontrado con Playwright: los handlers de arrastre están en la nota
    // entera, así que sin este chequeo, un click en CUALQUIER botón de adentro
    // (reacciones, cupos, borrar) también dispara pointerdown acá y
    // setPointerCapture se queda con el click antes de que le llegue al botón -la
    // nota "se mueve un pixel" en vez de tomarse el cupo o reaccionar. Si el punto
    // de partida es un botón, no se inicia el arrastre: se deja que el click siga su
    // curso normal.
    if (e.target instanceof HTMLElement && e.target.closest('button') !== null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    dragStateRef.current = {
      pointerId: e.pointerId,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
    }
    setDragScreenPosition({ x: rect.left, y: rect.top })
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    const screenX = e.clientX - drag.grabOffsetX
    const screenY = e.clientY - drag.grabOffsetY
    setDragScreenPosition({ x: screenX, y: screenY })

    const canvasRect = rectOf('[data-canvas-root]')
    if (canvasRect !== null) {
      throttledSendDragging(noteId, screenX - canvasRect.left, screenY - canvasRect.top)
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (drag === null || drag.pointerId !== e.pointerId || note === undefined) return
    const screenX = e.clientX - drag.grabOffsetX
    const screenY = e.clientY - drag.grabOffsetY
    dragStateRef.current = null
    setDragScreenPosition(null)
    // Antes que nada: si quedó una llamada de presence.dragging en cola del
    // throttle, cancelarla. Si se deja disparar sola después de esto, llega tarde
    // -después de que note.move ya limpió el fantasma- y lo vuelve a dejar pegado
    // para siempre (ver docstring de throttle.ts).
    throttledSendDragging.cancel()

    const targetStatus = columnStatusAtPoint(e.clientX, e.clientY) ?? note.status
    const targetColumnRect = rectOf(`[data-column-status="${targetStatus}"]`)
    const relativeX = targetColumnRect !== null ? screenX - targetColumnRect.left : note.position_x
    const relativeY = targetColumnRect !== null ? screenY - targetColumnRect.top : note.position_y

    actions.moveNote(noteId, relativeX, relativeY, targetStatus)
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>): void {
    // El navegador puede cancelar un gesto a mitad de camino (un gesto del sistema,
    // por ejemplo). Sin note.move que mandar -no hay una posición final confiable-,
    // pero igual hay que soltar el estado local y cancelar la cola del throttle: si
    // no, la nota queda "arrastrándose" para siempre del lado de este cliente, y
    // puede quedar un presence.dragging pendiente de disparar tarde (mismo bug que
    // en handlePointerUp).
    const drag = dragStateRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    dragStateRef.current = null
    setDragScreenPosition(null)
    throttledSendDragging.cancel()
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

  const ghostBorderColor = draggerColor !== undefined ? PARTICIPANT_COLOR_HEX[draggerColor] : '#666'

  let positionStyle: CSSProperties
  if (isDraggingLocally) {
    positionStyle = { position: 'fixed', left: dragScreenPosition.x, top: dragScreenPosition.y }
  } else if (ghostCanvasPosition !== null) {
    const canvasRect = rectOf('[data-canvas-root]')
    positionStyle = {
      position: 'fixed',
      left: (canvasRect?.left ?? 0) + ghostCanvasPosition.x,
      top: (canvasRect?.top ?? 0) + ghostCanvasPosition.y,
    }
  } else {
    positionStyle = { position: 'absolute', left: note.position_x, top: note.position_y }
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{
        ...positionStyle,
        width: 160,
        minHeight: 90,
        border: isGhost ? `2px dashed ${ghostBorderColor}` : '1px solid #666',
        background: '#ddd',
        padding: 8,
        boxSizing: 'border-box',
        cursor: isMine ? 'grab' : 'default',
        opacity: isPendingDelete ? 0.4 : isGhost ? 0.7 : 1,
        pointerEvents: isPendingDelete || isDraggingLocally || isGhost ? 'none' : 'auto',
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

      <ReactionBar
        noteId={noteId}
        reactions={note.reactions}
        participants={participants}
        myParticipantId={myParticipantId}
        onToggle={actions.toggleReaction}
      />

      {isMine && (
        <button type="button" onClick={handleDelete} disabled={isPendingDelete}>
          borrar
        </button>
      )}
    </div>
  )
}

function ReactionBar({
  reactions,
  participants,
  myParticipantId,
  onToggle,
  noteId,
}: {
  noteId: string
  reactions: { emoji: Reaction; participant_id: string }[]
  participants: Record<string, { name: string } | undefined>
  myParticipantId: string | null
  onToggle: (noteId: string, emoji: Reaction) => void
}) {
  return (
    <div>
      {REACTIONS.map((emoji) => {
        const reactors = reactions.filter((r) => r.emoji === emoji)
        const iReacted =
          myParticipantId !== null && reactors.some((r) => r.participant_id === myParticipantId)
        const names = reactors.map((r) => participants[r.participant_id]?.name ?? '?').join(', ')
        return (
          <button
            key={emoji}
            type="button"
            title={names}
            onClick={() => onToggle(noteId, emoji)}
            style={{ fontWeight: iReacted ? 'bold' : 'normal' }}
          >
            {emoji} {reactors.length > 0 ? reactors.length : ''}
          </button>
        )
      })}
    </div>
  )
}
