/**
 * "Quién está en la sala" (CLAUDE.md, "Nuevo, aprobado" #9 -resaltar-, y alcance
 * original: se nos había pasado tener esto en algún lado de la UI). Un chip de
 * avatar por participante, en la toolbar del lienzo (`Canvas.tsx`).
 *
 * Lista completa, no solo conectados: `sortParticipantsForList`
 * (`store/selectors.ts`) trae a todo el que pasó por la sala -sus notas siguen ahí,
 * resaltarlas es igual de útil que las de alguien presente ahora mismo-, conectados
 * primero y con una opacidad más baja para quien ya se fue (`.participant-chip--
 * offline`), pero clickeable en los dos casos: ninguna de las dos cosas deshabilita
 * el click.
 *
 * Click: `toggleHighlight` (`CanvasFocusContext`) -selección única, clickear a
 * alguien ya resaltado lo saca. Nada acá decide si mostrar el estado de "conectado"
 * con más detalle que la opacidad -no hace falta más para lo que este chip resuelve.
 */

import { useRoom } from '../../app/RoomStoreContext'
import { useCanvasFocus } from '../canvas/CanvasFocusContext'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import { sortParticipantsForList } from '../../store/selectors'
import './ParticipantList.css'

export function ParticipantList() {
  const participants = useRoom((s) => sortParticipantsForList(s.participants))
  const { highlightedParticipantId, toggleHighlight } = useCanvasFocus()

  if (participants.length === 0) return null

  return (
    <div className="participant-list">
      {participants.map((p) => {
        const isOffline = p.disconnected_at !== null
        const isHighlighted = p.id === highlightedParticipantId
        return (
          <button
            key={p.id}
            type="button"
            className={
              isOffline
                ? 'participant-chip participant-chip--offline'
                : 'participant-chip'
            }
            style={{ background: PARTICIPANT_COLOR_HEX[p.color] }}
            aria-pressed={isHighlighted}
            aria-label={`Resaltar las notas de ${p.name}`}
            title={isOffline ? `${p.name} (desconectado)` : p.name}
            onClick={() => toggleHighlight(p.id)}
          >
            <span className="participant-chip-icon">{AVATAR_EMOJI[p.avatar]}</span>
          </button>
        )
      })}
    </div>
  )
}
