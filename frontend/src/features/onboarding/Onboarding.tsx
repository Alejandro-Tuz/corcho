/**
 * Nombre + avatar + color, y adentro -sin registro (CLAUDE.md). No llama a
 * `saveIdentity`: eso lo hace `roomStore.applyRoomSnapshot` en cuanto el servidor
 * confirma el `participant_id` real, único lugar que escribe en localStorage (para
 * no tener dos caminos que puedan desincronizarse). Acá solo se junta lo que hace
 * falta para mandar el primer `room.join`.
 *
 * Avatar y color como selectores visuales (pulido día 3): el catálogo de avatares
 * se muestra como emoji (`avatarEmoji.ts`, sin traer íconos propios) pasado a
 * blanco liso -mismo tratamiento que el pin de `Note.css`, para que no se
 * sientan "simples emojis" sueltos- sobre el color de participante YA
 * elegido, así la persona ve en el selector mismo cómo va a quedar su pin
 * antes de entrar. El de colores usa los swatches reales de
 * `PARTICIPANT_COLOR_HEX` -antes estos dos eran botones de puro texto con el
 * nombre del valor, a propósito, para no construir esto dos veces (CLAUDE.md,
 * día 2: "funcionalidad primero, diseño después").
 *
 * ## Prellenado al crear una sala nueva desde otra
 *
 * `lib/createRoomPrefill.ts` (ahí el porqué completo de `sessionStorage` en vez
 * de query string). El formulario arranca con lo que esa persona ya usaba en la
 * sala de la que vino -no la salta, sigue siendo editable entero: decisión
 * tomada a conciencia, "prellenado pero editable" en vez de "reusar sin
 * preguntar" (asumiría en silencio que es la misma persona) o "preguntar en
 * blanco siempre" (ignora que el caso común es que sí lo es). `peekCreatePrefill`
 * -de solo lectura- alimenta los tres `useState`; `clearCreatePrefill` -el
 * borrado- corre aparte, en un efecto, por lo que documenta ese módulo sobre
 * StrictMode.
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Avatar, ParticipantColor } from '../../realtime/protocol'
import type { StoredIdentity } from '../../lib/identity'
import { AVATARS, PARTICIPANT_COLORS } from '../../lib/constants'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { clearCreatePrefill, peekCreatePrefill } from '../../lib/createRoomPrefill'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import './Onboarding.css'

export function Onboarding({
  room,
  onComplete,
}: {
  room: string
  onComplete: (identity: StoredIdentity) => void
}) {
  const [name, setName] = useState(() => peekCreatePrefill()?.name ?? '')
  const [avatar, setAvatar] = useState<Avatar>(() => peekCreatePrefill()?.avatar ?? AVATARS[0])
  const [color, setColor] = useState<ParticipantColor>(
    () => peekCreatePrefill()?.color ?? PARTICIPANT_COLORS[0],
  )

  useEffect(() => {
    clearCreatePrefill()
  }, [])

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return
    onComplete({ participantId: null, name: trimmed, avatar, color })
  }

  return (
    <div className="onboarding-shell">
      <form onSubmit={handleSubmit} className="onboarding-card">
        <h1 className="onboarding-brand">Corcho</h1>
        <p className="onboarding-sub">
          Entrando a la sala <code>{room}</code>
        </p>

        <label className="onboarding-field">
          Nombre
          <input
            className="onboarding-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="¿Cómo te llamás?"
            required
            autoFocus
          />
        </label>

        <div className="onboarding-field">
          Avatar
          <div className="onboarding-grid" role="radiogroup" aria-label="Avatar">
            {AVATARS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={a === avatar}
                aria-label={a}
                className={a === avatar ? 'onboarding-avatar onboarding-avatar--active' : 'onboarding-avatar'}
                style={{ background: PARTICIPANT_COLOR_HEX[color] }}
                onClick={() => setAvatar(a)}
              >
                <span className="onboarding-avatar-icon">{AVATAR_EMOJI[a]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="onboarding-field">
          Color
          <div className="onboarding-grid" role="radiogroup" aria-label="Color">
            {PARTICIPANT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                className={c === color ? 'onboarding-color onboarding-color--active' : 'onboarding-color'}
                style={{ background: PARTICIPANT_COLOR_HEX[c] }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <button type="submit" className="btn btn-primary onboarding-submit">
          Entrar a la sala
        </button>
      </form>
    </div>
  )
}
