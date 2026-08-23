/**
 * Nombre + avatar + color, y adentro -sin registro (CLAUDE.md). No llama a
 * `saveIdentity`: eso lo hace `roomStore.applyRoomSnapshot` en cuanto el servidor
 * confirma el `participant_id` real, único lugar que escribe en localStorage (para
 * no tener dos caminos que puedan desincronizarse). Acá solo se junta lo que hace
 * falta para mandar el primer `room.join`.
 *
 * Sin CSS elaborado a propósito (día 2: funcionalidad primero): avatar y color se
 * eligen de una lista de botones con el nombre en texto, no íconos ni swatches -esos
 * son pulido visual del día 3.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Avatar, ParticipantColor } from '../../realtime/protocol'
import type { StoredIdentity } from '../../lib/identity'
import { AVATARS, PARTICIPANT_COLORS } from '../../lib/constants'

export function Onboarding({
  room,
  onComplete,
}: {
  room: string
  onComplete: (identity: StoredIdentity) => void
}) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<Avatar>(AVATARS[0])
  const [color, setColor] = useState<ParticipantColor>(PARTICIPANT_COLORS[0])

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return
    onComplete({ participantId: null, name: trimmed, avatar, color })
  }

  return (
    <form onSubmit={handleSubmit} style={{ padding: 16, maxWidth: 480 }}>
      <h1>Entrar a la sala {room}</h1>

      <label>
        Nombre
        <br />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          autoFocus
        />
      </label>

      <fieldset style={{ marginTop: 12 }}>
        <legend>Avatar</legend>
        {AVATARS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAvatar(a)}
            aria-pressed={a === avatar}
            style={{ fontWeight: a === avatar ? 'bold' : 'normal' }}
          >
            {a}
          </button>
        ))}
      </fieldset>

      <fieldset style={{ marginTop: 12 }}>
        <legend>Color</legend>
        {PARTICIPANT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            aria-pressed={c === color}
            style={{ fontWeight: c === color ? 'bold' : 'normal' }}
          >
            {c}
          </button>
        ))}
      </fieldset>

      <button type="submit" style={{ marginTop: 12 }}>
        Entrar
      </button>
    </form>
  )
}
