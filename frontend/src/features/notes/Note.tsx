/**
 * Un post-it: arrastre entre columnas, borrado, cupos con rebote, nota fantasma, y
 * -bloque 3- reacciones. Solo el autor arrastra o borra (autoría del backend,
 * `services/notes.py`); cualquiera reacciona o toma/suelta un cupo.
 *
 * El aspecto (color sólido, esquina doblada plana, chip de autor, rotación fija
 * por nota) vive en `Note.css` -ver su docstring para el porqué de cada
 * decisión, dirección visual aprobada el día 3-. Este archivo solo decide QUÉ
 * clase e inline styles aplicar; nunca CÓMO se ve una clase.
 *
 * `note-card--dimmed`: buscar y resaltar-a-una-persona (`CanvasFocusContext.ts`,
 * ahí está el porqué completo de cómo se combinan los dos).
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
 *   lo que pide la decisión ya tomada. `pointerEvents: 'none'` mientras se arrastra
 *   para que `elementFromPoint` no encuentre a la nota misma bajo el mouse en vez de
 *   la columna -la captura del puntero (`setPointerCapture`) sigue entregando los
 *   eventos igual, así que esto no rompe nada del propio arrastre-.
 * - Cuando estable (nadie la arrastra): vuelve a `position: absolute` normal, dentro
 *   de su columna, con `position_x/y` tal cual las persiste el backend, y con su
 *   rotación fija (`noteRotationDeg`) -sin rotación mientras se arrastra o como
 *   fantasma: una nota "levantada" se endereza, es la misma seña que el hover.
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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { useCanvasFocus } from '../canvas/CanvasFocusContext'
import { throttle } from '../../realtime/throttle'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { checklistProgress, parseChecklist, proseOnly } from '../../lib/checklist'
import { NOTE_COLOR_HEX } from '../../lib/noteColor'
import { noteRotationDeg } from '../../lib/noteRotation'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import { REACTIONS } from '../../lib/constants'
import { noteMatchesSearch } from '../../store/selectors'
import type { NoteStatus, ParticipantState, Reaction } from '../../realtime/protocol'
import { NoteDetail } from './NoteDetail'
import './Note.css'

const DRAG_BROADCAST_INTERVAL_MS = 50
/** Un poco por encima de la duración de la animación CSS `note-land` (Note.css). */
const LANDING_ANIMATION_MS = 340

/** Estilo con la custom property `--note-rot` -ver Note.css sobre por qué la
 * rotación viaja como custom property y no como parte de `transform` inline. */
type NoteStyle = CSSProperties & { '--note-rot'?: string }

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

function authorMark(author: ParticipantState | undefined): string {
  return author !== undefined ? AVATAR_EMOJI[author.avatar] : '❔'
}

/** SVG inline, no un glifo de fuente: un carácter como "⛶" se ve como caja vacía en
 * algunas plataformas -mismo riesgo de renderizado que ya corre `authorMark` con los
 * emoji de avatar, pero acá no hace falta correrlo, un ícono de cuatro flechas es
 * trivial a mano y no depende de qué fuente de emoji tenga el sistema. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <path
        d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Mismo motivo que ExpandIcon: para el chip de progreso del checklist, en vez de un
 * glifo tipo "☑" con el mismo riesgo de tofu. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3.2 3.2L13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Note({ noteId }: { noteId: string }) {
  const note = useRoom((s) => s.notes[noteId])
  const pending = useRoom((s) => s.pendingNoteOps[noteId])
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)
  const participants = useRoom((s) => s.participants)
  const remoteDragging = useRoom((s) =>
    note === undefined ? undefined : s.presence.dragging[note.author_id],
  )
  const author = useRoom((s) => (note === undefined ? undefined : s.participants[note.author_id]))
  const actions = useRoomActions()
  const { searchQuery, highlightedParticipantId } = useCanvasFocus()

  const dragStateRef = useRef<DragState | null>(null)
  const [dragScreenPosition, setDragScreenPosition] = useState<{ x: number; y: number } | null>(
    null,
  )
  const [detailOpen, setDetailOpen] = useState(false)
  const throttledSendDragging = useMemo(
    () => throttle(actions.sendDragging, DRAG_BROADCAST_INTERVAL_MS),
    [actions],
  )

  // "Aterrizaje": un pulso breve cuando la nota CAMBIA de columna -para que se
  // note el cambio tanto en la pantalla de quien arrastra como en la de
  // cualquiera que esté mirando cuando llega la confirmación-, nunca al
  // reposicionar dentro de la misma columna. Comparar contra un `status`
  // guardado (no contra un valor fijo) es el patrón de React para "ajustar
  // estado cuando algo cambió" sin `useEffect`: se ejecuta durante el render,
  // React vuelve a renderizar antes de pintar, sin parpadeo. El valor inicial
  // de `prevStatus` es el propio `status` de arranque -así una reconexión
  // (`room.snapshot`) o el primer montaje nunca disparan el pulso por las
  // dudas.
  const [prevStatus, setPrevStatus] = useState(note?.status ?? null)
  const [justLanded, setJustLanded] = useState(false)
  if (note !== undefined && note.status !== prevStatus) {
    setPrevStatus(note.status)
    setJustLanded(true)
  }
  useEffect(() => {
    if (!justLanded) return
    const timeout = setTimeout(() => setJustLanded(false), LANDING_ANIMATION_MS)
    return () => clearTimeout(timeout)
  }, [justLanded])

  if (note === undefined) return null

  const isMine = note.author_id === myParticipantId
  // Ver docstring de lib/checklist.ts: el post-it muestra solo la prosa (o, si no
  // hay, el primer ítem a modo de título) más un chip de progreso -nunca la lista
  // entera de ítems, eso queda para NoteDetail.
  const checklistItems = parseChecklist(note.text)
  const checklistPreviewText = proseOnly(note.text) || (checklistItems[0]?.text ?? '')
  const checklistProgressCount = checklistProgress(checklistItems)
  const isPendingDelete = pending?.kind === 'delete'
  // Buscar y resaltar (CanvasFocusContext): se combinan por intersección, nunca uno
  // pisa al otro -atenuada si falla CUALQUIERA de los filtros activos. Un filtro
  // inactivo (query vacía, nadie resaltado) "matchea siempre" y no aporta nada a la
  // cuenta, ver docstring del contexto para el porqué completo.
  const matchesSearch = noteMatchesSearch(note, searchQuery)
  const matchesHighlight =
    highlightedParticipantId === null || note.author_id === highlightedParticipantId
  const isDimmed = !matchesSearch || !matchesHighlight
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
    //
    // `instanceof Element`, no `instanceof HTMLElement`: segundo bug real,
    // encontrado al agregar el botón de expandir (ExpandIcon, nota expandible,
    // pulido día 3 extendido) -el primer botón de una nota con un ícono SVG en vez
    // de texto plano. Un `<svg>`/`<path>` es `SVGElement`, no `HTMLElement`, así
    // que `instanceof HTMLElement` daba `false` para un click que arrancaba sobre
    // el ícono y la guarda nunca se activaba: el arrastre se armaba igual y se
    // comía el click antes de que llegara a React. `Element` es el ancestro común
    // de ambos y sigue teniendo `.closest()`.
    if (e.target instanceof Element && e.target.closest('button') !== null) return
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

  const pinColor = author !== undefined ? PARTICIPANT_COLOR_HEX[author.color] : '#999'
  // Sin rotación mientras se arrastra o como fantasma: una nota "en el aire" se
  // endereza, la misma seña visual que el hover (Note.css).
  const rotationDeg = isDraggingLocally || isGhost ? 0 : noteRotationDeg(noteId)

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

  const cardClass = [
    'note-card',
    isMine ? 'note-card--interactive' : '',
    isGhost ? 'note-card--ghost' : '',
    isPendingDelete ? 'note-card--pending' : '',
    justLanded ? 'note-card--landed' : '',
    isDimmed ? 'note-card--dimmed' : '',
  ]
    .filter((c) => c !== '')
    .join(' ')

  const cardStyle: NoteStyle = {
    ...positionStyle,
    background: NOTE_COLOR_HEX[note.color],
    cursor: isMine ? 'grab' : 'default',
    pointerEvents: isPendingDelete || isDraggingLocally || isGhost ? 'none' : 'auto',
    // El fantasma se marca con un contorno del color de quien lo arrastra -no un
    // `border`, que sumaría al box model y correría la esquina doblada-.
    outline: isGhost ? `2px dashed ${pinColor}` : undefined,
    outlineOffset: isGhost ? 2 : undefined,
    '--note-rot': `${String(rotationDeg)}deg`,
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={cardClass}
      style={cardStyle}
    >
      <div className="note-pin">
        <span className="note-pin-shadow" />
        <span className="note-pin-head" style={{ background: pinColor }}>
          <span className="note-pin-icon">{authorMark(author)}</span>
        </span>
      </div>
      <span className="note-author">{author?.name ?? ''}</span>

      <div className="note-text">{checklistPreviewText}</div>

      {note.kind === 'own' && <span className="note-kind-tag">propia</span>}

      {(note.kind === 'shared' || checklistItems.length > 0) && (
        <div className="note-foot">
          {note.kind === 'shared' && (
            <>
              <span className="note-pill">
                {note.taken_count}/{note.capacity ?? 0}
              </span>
              {hasClaimed ? (
                <button type="button" className="note-claim-btn" onClick={handleRelease} disabled={releasePending}>
                  {releasePending ? '…' : 'soltar'}
                </button>
              ) : (
                <button type="button" className="note-claim-btn" onClick={handleClaim} disabled={isFull || claimPending}>
                  {claimPending ? '…' : isFull ? 'completo' : 'tomar cupo'}
                </button>
              )}
            </>
          )}
          {checklistItems.length > 0 && (
            <span className="note-pill note-pill--checklist">
              <CheckIcon /> {checklistProgressCount.done}/{checklistProgressCount.total}
            </span>
          )}
        </div>
      )}

      <ReactionBar
        noteId={noteId}
        reactions={note.reactions}
        participants={participants}
        myParticipantId={myParticipantId}
        onToggle={actions.toggleReaction}
      />

      <button
        type="button"
        className="note-expand-btn"
        onClick={() => setDetailOpen(true)}
        aria-label={isMine ? 'Editar detalle' : 'Ver detalle'}
        title={isMine ? 'Editar detalle' : 'Ver detalle'}
      >
        <ExpandIcon />
      </button>

      {isMine && (
        <button
          type="button"
          className="note-delete-btn"
          onClick={handleDelete}
          disabled={isPendingDelete}
          aria-label="Borrar nota"
          title="Borrar nota"
        >
          ×
        </button>
      )}

      {detailOpen && (
        <NoteDetail
          note={note}
          isMine={isMine}
          authorName={author?.name ?? ''}
          onClose={() => setDetailOpen(false)}
          onSave={(text) => actions.updateNote(noteId, text, note.color)}
        />
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
    <div className="note-reacts">
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
            className={iReacted ? 'note-react-chip note-react-chip--active' : 'note-react-chip'}
            onClick={() => onToggle(noteId, emoji)}
          >
            {emoji} {reactors.length > 0 ? reactors.length : ''}
          </button>
        )
      })}
    </div>
  )
}
