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
 * Dos controles independientes por participante, a propósito (ver el docstring de
 * `CanvasFocusContext.ts` para el porqué completo de por qué no es un solo click):
 *
 * - El avatar entero alterna resaltar (`toggleHighlight`) -para cualquiera,
 *   conectado o no.
 * - Un ícono chico en la esquina, SOLO en participantes conectados, alterna seguir
 *   (`toggleFollow`) -no tiene sentido ofrecerlo para alguien desconectado, no hay
 *   cursor que perseguir.
 *
 * Ninguno enciende al otro.
 */

import { useRoom } from '../../app/RoomStoreContext'
import { useCanvasFocus } from '../canvas/CanvasFocusContext'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import { sortParticipantsForList } from '../../store/selectors'
import './ParticipantList.css'

export function ParticipantList() {
  const participants = useRoom((s) => sortParticipantsForList(s.participants))
  const { highlightedParticipantId, toggleHighlight, followedParticipantId, toggleFollow } =
    useCanvasFocus()

  if (participants.length === 0) return null

  return (
    <div className="participant-list">
      {participants.map((p) => {
        const isOffline = p.disconnected_at !== null
        const isHighlighted = p.id === highlightedParticipantId
        const isFollowed = p.id === followedParticipantId
        return (
          <div key={p.id} className="participant-item">
            <button
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

            {!isOffline && (
              <button
                type="button"
                className="participant-follow-btn"
                aria-pressed={isFollowed}
                aria-label={`Seguir el cursor de ${p.name}`}
                title={`Seguir el cursor de ${p.name}`}
                onClick={() => toggleFollow(p.id)}
              >
                <FollowIcon />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// SVG inline, no un glifo de fuente -mismo motivo que el resto de los íconos del
// proyecto (ExpandIcon en Note.tsx, SpeakerIcon en Canvas.tsx): un carácter como
// "🎯" corre el mismo riesgo de tofu en algunas plataformas.
function FollowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="9" height="9" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  )
}
