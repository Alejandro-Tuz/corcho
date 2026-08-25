/**
 * Botón "Resumen" de la toolbar + panel flotante con el resumen del tablero
 * generado por IA (CLAUDE.md, "Nuevo, aprobado" #5). A propósito NO es un
 * `<dialog>` como el composer o el detalle de una nota: el pedido explícito era que
 * se lea "de un vistazo sin dejar de ver el tablero", y un `<dialog>` nativo
 * bloquea el lienzo mientras está abierto -lo opuesto de eso-. Es un panel no-modal
 * de toda la vida: se cierra con click afuera o Esc mediante un listener propio, no
 * pasa por `hooks/useKeyboardShortcuts.ts` -ese hook reserva Esc para lo que YA
 * tiene tratamiento nativo (`<dialog>`) o el buscador, y este panel no es ninguno
 * de los dos-. Hueco conocido y no blindado, mismo nivel que otros ya documentados
 * en el proyecto: `N`/`/` no saben que este panel existe, así que abrir el composer
 * con el panel abierto no tiene un comportamiento pulido definido.
 *
 * Botón vs. panel, dos responsabilidades separadas: el botón SOLO abre/cierra el
 * panel, nunca pide un resumen -pedirlo es una acción explícita adentro del panel
 * ("generar resumen"/"actualizar"), para que un click accidental en la toolbar
 * nunca dispare una llamada a la IA-.
 *
 * "No leído": puramente local a este componente, nunca en el store -mismo criterio
 * que `CanvasFocusContext.ts` para "qué mirar en esta pantalla": no es estado de
 * sala compartido con nadie más, es una preferencia de este visor. Se compara
 * `state.summary.generatedAt` contra la marca de tiempo del último que ESTE
 * componente mostró (`lastSeenAt`); abrir el panel actualiza esa marca.
 */

import { useEffect, useRef, useState } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { formatClockTime } from '../../lib/time'
import './RoomSummaryButton.css'

export function RoomSummaryButton() {
  const summary = useRoom((s) => s.summary)
  const generating = useRoom((s) => s.summaryGenerating)
  const notice = useRoom((s) => s.summaryNotice)
  const participants = useRoom((s) => s.participants)
  const actions = useRoomActions()

  const [open, setOpen] = useState(false)
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null)
  const widgetRef = useRef<HTMLDivElement>(null)

  const unread = summary !== null && summary.generatedAt !== lastSeenAt

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      if (widgetRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleToggle(): void {
    setOpen((wasOpen) => {
      const next = !wasOpen
      if (next && summary !== null) setLastSeenAt(summary.generatedAt)
      return next
    })
  }

  const requester =
    generating !== null ? (participants[generating.requestedBy]?.name ?? 'Alguien') : null

  return (
    <div className="summary-widget" ref={widgetRef}>
      <button
        type="button"
        className="btn summary-toggle-btn"
        onClick={handleToggle}
        aria-expanded={open}
        title="Resumen del tablero, generado por IA"
      >
        <SparkleIcon />
        {generating !== null ? 'Generando…' : 'Resumen'}
        {unread && generating === null && <span className="summary-unread-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="summary-panel" role="dialog" aria-label="Resumen del tablero">
          {generating !== null ? (
            <p className="summary-panel-status">{requester} pidió un resumen, generando…</p>
          ) : summary !== null ? (
            <>
              <p className="summary-panel-text">{summary.text}</p>
              <div className="summary-panel-footer">
                <span className="summary-panel-meta">{formatClockTime(summary.generatedAt)}</span>
                <button type="button" className="btn" onClick={actions.requestSummary}>
                  actualizar
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="summary-panel-status">Todavía no se pidió un resumen en esta sala.</p>
              <button type="button" className="btn btn-primary" onClick={actions.requestSummary}>
                generar resumen
              </button>
            </>
          )}
          {notice !== null && <p className="summary-panel-notice">{notice.text}</p>}
        </div>
      )}
    </div>
  )
}

// SVG inline, no un glifo de fuente -mismo motivo que el resto de los íconos del
// proyecto (SpeakerIcon/MutedIcon en Canvas.tsx, FollowIcon en ParticipantList.tsx):
// un carácter como "✨" corre el mismo riesgo de tofu en algunas plataformas que ya
// corren los emoji de avatar, evitable a mano sin costo.
function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" width="13" height="13" fill="none" aria-hidden="true">
      <path
        d="M10 2l1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6L10 2z"
        fill="currentColor"
      />
      <path
        d="M16 12l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"
        fill="currentColor"
      />
    </svg>
  )
}
