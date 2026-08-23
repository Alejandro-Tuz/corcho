/**
 * El lienzo: tres columnas fijas (bloque 3) + fondo de la sala + los cursores de los
 * demás. Toda nota nueva arranca en la primera columna (`status: 'blocked'`); de ahí
 * en más, `Note.tsx` decide a qué columna se mueve según dónde se suelta el
 * arrastre -ver su docstring, es donde vive la parte interesante de columnas.
 *
 * Creación por `window.prompt()`, no un formulario: es la interacción más fea posible
 * a propósito -"funcionalidad primero, diseño después", CLAUDE.md- y evita construir
 * un modal para algo que el pulido del día 3 va a rehacer de cero.
 *
 * El cursor propio se manda desde acá (`onPointerMove` sobre el lienzo entero, no
 * por nota ni por columna) porque `presence.cursor` viaja en coordenadas del lienzo
 * completo, no de una columna -no hace falta esa precisión para un cursor-.
 * `data-canvas-root` es el mismo gancho que usa `Note.tsx` para convertir la posición
 * de un fantasma ajeno a la pantalla de quien mira.
 */

import { useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { throttle } from '../../realtime/throttle'
import { BACKGROUNDS } from '../../lib/constants'
import { RemoteCursors } from '../presence/RemoteCursors'
import { BACKGROUND_COLORS } from './backgroundColor'
import { Column } from './Column'
import { COLUMNS } from './columns'

const CURSOR_BROADCAST_INTERVAL_MS = 50

export function Canvas() {
  const connectionStatus = useRoom((s) => s.connectionStatus)
  const background = useRoom((s) => s.background)
  const actions = useRoomActions()

  const canvasRef = useRef<HTMLDivElement>(null)
  const throttledSendCursor = useMemo(
    () => throttle(actions.sendCursor, CURSOR_BROADCAST_INTERVAL_MS),
    [actions],
  )

  if (connectionStatus === 'room_not_found') {
    return (
      <div style={{ padding: 16 }}>
        <p>Esta sala no existe.</p>
      </div>
    )
  }

  function handleCreateOwn(): void {
    const text = window.prompt('Texto de la nota:')
    if (text === null || text.trim() === '') return
    actions.createNote({
      kind: 'own',
      status: 'blocked',
      text: text.trim(),
      color: 'yellow',
      positionX: randomOffset(),
      positionY: randomOffset(),
      capacity: null,
    })
  }

  function handleCreateShared(): void {
    const text = window.prompt('Texto de la nota:')
    if (text === null || text.trim() === '') return
    const capacityRaw = window.prompt('¿Cuántos cupos?', '2')
    const parsed = capacityRaw === null ? Number.NaN : Number.parseInt(capacityRaw, 10)
    const capacity = Number.isFinite(parsed) && parsed > 0 ? parsed : 2
    actions.createNote({
      kind: 'shared',
      status: 'blocked',
      text: text.trim(),
      color: 'blue',
      positionX: randomOffset(),
      positionY: randomOffset(),
      capacity,
    })
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    throttledSendCursor(e.clientX - rect.left, e.clientY - rect.top)
  }

  return (
    <div>
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={handleCreateOwn}>
          + nota propia
        </button>
        <button type="button" onClick={handleCreateShared}>
          + nota compartida
        </button>

        <span style={{ marginLeft: 16 }}>fondo:</span>
        {BACKGROUNDS.map((bg) => (
          <button
            key={bg}
            type="button"
            title={bg}
            onClick={() => actions.setBackground(bg)}
            style={{
              width: 20,
              height: 20,
              padding: 0,
              background: BACKGROUND_COLORS[bg],
              border: bg === background ? '2px solid black' : '1px solid #999',
            }}
          />
        ))}

        <span style={{ marginLeft: 16 }}>({connectionStatus})</span>
      </div>

      <div
        ref={canvasRef}
        data-canvas-root
        onPointerMove={handlePointerMove}
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '82vh',
          background: BACKGROUND_COLORS[background],
          border: '1px solid #999',
          overflow: 'visible',
        }}
      >
        {COLUMNS.map((col) => (
          <Column key={col.status} status={col.status} label={col.label} />
        ))}
        <RemoteCursors />
      </div>
    </div>
  )
}

function randomOffset(): number {
  return 20 + Math.random() * 150
}
