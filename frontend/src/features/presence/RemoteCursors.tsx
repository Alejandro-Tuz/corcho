/**
 * Cursores de los demás participantes -nunca el propio: ya está bajo el mouse de
 * quien mira su pantalla-. Un punto de color (`ParticipantColor`, la misma paleta que
 * el borde de nota fantasma -CLAUDE.md: "cursor, borde de nota fantasma, iniciales
 * del avatar" comparten paleta a propósito) más el nombre en texto al lado.
 *
 * Sin ícono, sin animación de entrada/salida: un punto se mueve o no se mueve, no
 * hace falta más para que cumpla su función (día 3 decide si merece algo más).
 *
 * `presence.cursor` no tiene "salió del lienzo" en el protocolo (decisión ya tomada,
 * ver protocol.ts): si alguien saca el mouse del lienzo, su punto se queda quieto en
 * la última posición reportada hasta el próximo movimiento adentro, o hasta que se
 * desconecte (`presence.left` sí lo limpia). No es un bug de acá, es el protocolo.
 */

import { useRoom } from '../../app/RoomStoreContext'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'

export function RemoteCursors() {
  const cursors = useRoom((s) => s.presence.cursors)
  const participants = useRoom((s) => s.participants)
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)

  return (
    <>
      {Object.entries(cursors)
        .filter(([participantId]) => participantId !== myParticipantId)
        .map(([participantId, cursor]) => {
          const participant = participants[participantId]
          const color =
            participant !== undefined ? PARTICIPANT_COLOR_HEX[participant.color] : '#999'
          return (
            <div
              key={participantId}
              style={{
                position: 'absolute',
                left: cursor.x,
                top: cursor.y,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  transform: 'translate(-50%, -50%)',
                }}
              />
              {participant !== undefined && (
                <span
                  style={{
                    position: 'absolute',
                    left: 8,
                    top: -6,
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                    color,
                  }}
                >
                  {participant.name}
                </span>
              )}
            </div>
          )
        })}
    </>
  )
}
