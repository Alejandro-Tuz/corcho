/**
 * Identidad persistida por sala en localStorage: el `participant_id` que el servidor
 * asigna en el primer `room.join`, más lo que hizo falta para llegar a él (nombre,
 * avatar, color) para no repetir el onboarding en cada recarga de página (decisión ya
 * tomada en CLAUDE.md: reidentificación al reconectar).
 *
 * Una clave de localStorage por sala -no una identidad global-: un `participant_id`
 * solo vale dentro de la sala donde se creó.
 *
 * La validación acá adentro es liviana (¿tiene forma de identidad?), no un espejo del
 * catálogo de `constants.py`: si un valor quedara inválido (un avatar que se sacó del
 * catálogo, por ejemplo -no debería pasar, el catálogo solo crece, ver CLAUDE.md-) el
 * `room.join` que arme `socket.ts` no validaría contra `protocol.py` y el servidor lo
 * trataría como mensaje corrupto. No es el caso que este módulo necesita blindar.
 */

import type { Avatar, ParticipantColor } from '../realtime/protocol'

export interface StoredIdentity {
  /** null = todavía no confirmado por el servidor (primera vez en esta sala). */
  participantId: string | null
  name: string
  avatar: Avatar
  color: ParticipantColor
}

const KEY_PREFIX = 'corcho:identity:'

export function loadIdentity(room: string): StoredIdentity | null {
  const raw = localStorage.getItem(KEY_PREFIX + room)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isStoredIdentity(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveIdentity(room: string, identity: StoredIdentity): void {
  localStorage.setItem(KEY_PREFIX + room, JSON.stringify(identity))
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (typeof v.participantId === 'string' || v.participantId === null) &&
    typeof v.name === 'string' &&
    typeof v.avatar === 'string' &&
    typeof v.color === 'string'
  )
}
