/**
 * El lienzo: fondo de la sala + las notas encima. Bloque 1 (CLAUDE.md, día 2): crear
 * y arrastrar. Sin columnas todavía (bloque 3) -por eso toda nota nueva arranca en
 * `status: 'blocked'` fijo, sin selector: no hay dónde mostrar ese dato todavía-, sin
 * cupos interactivos (bloque 2: hoy la capacidad se ve pero no se toma/suelta), sin
 * cursores ni nota fantasma de otros participantes (bloque 2 también).
 *
 * Creación por `window.prompt()`, no un formulario: es la interacción más fea posible
 * a propósito -"funcionalidad primero, diseño después", CLAUDE.md- y evita construir
 * un modal para algo que el pulido del día 3 va a rehacer de cero.
 */

import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { sortNotesByCreation } from '../../store/selectors'
import { Note } from '../notes/Note'
import { BACKGROUND_COLORS } from './backgroundColor'

export function Canvas() {
  const connectionStatus = useRoom((s) => s.connectionStatus)
  const background = useRoom((s) => s.background)
  const noteIds = useRoom((s) => sortNotesByCreation(s.notes))
  const actions = useRoomActions()

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

  return (
    <div>
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={handleCreateOwn}>
          + nota propia
        </button>
        <button type="button" onClick={handleCreateShared}>
          + nota compartida
        </button>
        <span>({connectionStatus})</span>
      </div>

      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '82vh',
          background: BACKGROUND_COLORS[background],
          border: '1px solid #999',
          overflow: 'hidden',
        }}
      >
        {noteIds.map((id) => (
          <Note key={id} noteId={id} />
        ))}
      </div>
    </div>
  )
}

function randomOffset(): number {
  return 40 + Math.random() * 300
}
