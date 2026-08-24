/**
 * El lienzo: tres columnas fijas (bloque 3) + fondo de la sala + los cursores de los
 * demás. Toda nota nueva arranca en la primera columna (`status: 'blocked'`); de ahí
 * en más, `Note.tsx` decide a qué columna se mueve según dónde se suelta el
 * arrastre -ver su docstring, es donde vive la parte interesante de columnas.
 *
 * Creación por `NoteComposer` (pulido día 3): reemplaza los `window.prompt()` del
 * día 2, que eran la interacción más fea posible a propósito ("funcionalidad
 * primero, diseño después", CLAUDE.md).
 *
 * El cursor propio se manda desde acá (`onPointerMove` sobre el lienzo entero, no
 * por nota ni por columna) porque `presence.cursor` viaja en coordenadas del lienzo
 * completo, no de una columna -no hace falta esa precisión para un cursor-.
 * `data-canvas-root` es el mismo gancho que usa `Note.tsx` para convertir la posición
 * de un fantasma ajeno a la pantalla de quien mira.
 */

import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { throttle } from '../../realtime/throttle'
import { BACKGROUNDS } from '../../lib/constants'
import { Activity } from '../activity/Activity'
import { NoteComposer } from '../notes/NoteComposer'
import { RemoteCursors } from '../presence/RemoteCursors'
import { BACKGROUND_COLORS } from './backgroundColor'
import { Column } from './Column'
import { COLUMNS } from './columns'
import type { ConnectionStatus } from '../../realtime/socket'
import './Canvas.css'

const CURSOR_BROADCAST_INTERVAL_MS = 50

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'conectando',
  connected: 'conectado',
  reconnecting: 'reconectando',
  room_not_found: 'sala inexistente',
}

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'canvas-status--connecting',
  connected: 'canvas-status--connected',
  reconnecting: 'canvas-status--connecting',
  room_not_found: 'canvas-status--down',
}

export function Canvas() {
  const connectionStatus = useRoom((s) => s.connectionStatus)
  const background = useRoom((s) => s.background)
  const actions = useRoomActions()

  const [composerOpen, setComposerOpen] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const throttledSendCursor = useMemo(
    () => throttle(actions.sendCursor, CURSOR_BROADCAST_INTERVAL_MS),
    [actions],
  )

  if (connectionStatus === 'room_not_found') {
    return (
      <div className="canvas-empty">
        <p>Esta sala no existe.</p>
      </div>
    )
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    throttledSendCursor(e.clientX - rect.left, e.clientY - rect.top)
  }

  return (
    <div>
      <div className="canvas-toolbar">
        <span className="canvas-brand">Corcho</span>

        <button type="button" className="btn btn-primary" onClick={() => setComposerOpen(true)}>
          + nota
        </button>

        <div className="canvas-bg-picker">
          <span className="canvas-bg-label">fondo</span>
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg}
              type="button"
              title={bg}
              aria-pressed={bg === background}
              className={bg === background ? 'canvas-bg-swatch canvas-bg-swatch--active' : 'canvas-bg-swatch'}
              onClick={() => actions.setBackground(bg)}
              style={{ background: BACKGROUND_COLORS[bg] }}
            />
          ))}
        </div>

        <span className={`canvas-status ${STATUS_CLASS[connectionStatus]}`}>
          {STATUS_LABEL[connectionStatus]}
        </span>
      </div>

      <Activity />

      <div
        ref={canvasRef}
        data-canvas-root
        onPointerMove={handlePointerMove}
        className="canvas-board"
        style={{ background: BACKGROUND_COLORS[background] }}
      >
        {COLUMNS.map((col) => (
          <Column key={col.status} status={col.status} label={col.label} />
        ))}
        <RemoteCursors />
      </div>

      <NoteComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreate={(input) =>
          actions.createNote({
            kind: input.kind,
            status: 'blocked',
            text: input.text,
            color: input.color,
            positionX: randomOffset(),
            positionY: randomOffset(),
            capacity: input.capacity,
          })
        }
      />
    </div>
  )
}

function randomOffset(): number {
  return 20 + Math.random() * 150
}
