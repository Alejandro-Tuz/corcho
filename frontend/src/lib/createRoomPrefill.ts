/**
 * Prellenado de nombre/avatar/color al crear una sala nueva DESDE otra
 * (`Canvas.tsx`, botón "+" junto a la marca) -CLAUDE.md, hueco de navegación: no
 * había forma de crear otra sala ni de volver a la portada sin editar la URL a
 * mano.
 *
 * `sessionStorage`, no query string en la URL de la sala nueva -se consideraron
 * los dos-. `window.location.href` (misma navegación dura que ya usa
 * `Landing.tsx` para entrar a una sala) tira el contexto de JS entero, así que
 * hace falta algo que sobreviva esa recarga; un query string lo hace, pero un
 * nombre de pila quedaría en el historial del navegador -el `replaceState` que lo
 * limpiaría corre recién en la página nueva, después de que la navegación ya
 * ocurrió- y, el día que esto se despliegue, en el log de acceso del servidor que
 * sirva la sala. `sessionStorage` sobrevive la misma recarga sin ninguna de las
 * dos exposiciones, y de paso es por PESTAÑA -exactamente el alcance de este
 * gesto: crear una sala nueva siempre sigue en la misma pestaña (`window.location.
 * href`, no `window.open`), nunca tiene por qué filtrarse a otra.
 *
 * Lectura y borrado separados a propósito -`peekCreatePrefill` (idempotente, solo
 * lee) y `clearCreatePrefill` (borra)-, en vez de un único "consumir" que haga las
 * dos cosas juntas: `Onboarding.tsx` necesita leer el mismo valor en tres
 * `useState` distintos (nombre, avatar, color), y en React 18 StrictMode los
 * inicializadores perezosos de `useState` corren dos veces en desarrollo -un
 * "consumir" que borra en la primera lectura devolvería `null` en la segunda,
 * perdiendo el prellenado un tercio de las veces. `clearCreatePrefill` corre
 * aparte, una sola vez, en un efecto -`sessionStorage.removeItem` sobre una clave
 * que ya no está es un no-op inofensivo, así que tampoco importa que ESE efecto
 * corra dos veces en StrictMode.
 */

import type { Avatar, ParticipantColor } from '../realtime/protocol'
import { AVATARS, PARTICIPANT_COLORS } from './constants'

const KEY = 'corcho:create_prefill'

export interface CreatePrefill {
  name: string
  avatar: Avatar
  color: ParticipantColor
}

export function saveCreatePrefill(identity: CreatePrefill): void {
  sessionStorage.setItem(KEY, JSON.stringify(identity))
}

export function peekCreatePrefill(): CreatePrefill | null {
  const raw = sessionStorage.getItem(KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isCreatePrefill(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clearCreatePrefill(): void {
  sessionStorage.removeItem(KEY)
}

// Validación liviana, mismo criterio que `isStoredIdentity` en `lib/identity.ts`:
// nunca se confía a ciegas en algo leído de un storage del navegador.
function isCreatePrefill(value: unknown): value is CreatePrefill {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    v.name.trim() !== '' &&
    (AVATARS as readonly string[]).includes(v.avatar as string) &&
    (PARTICIPANT_COLORS as readonly string[]).includes(v.color as string)
  )
}
