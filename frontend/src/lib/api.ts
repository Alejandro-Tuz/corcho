/**
 * `POST /rooms`: crear una sala nueva. Un solo lugar -`Landing.tsx` (la primera
 * sala) y `Canvas.tsx` (otra, desde dentro de una sala existente) llaman a la
 * misma función en vez de duplicar el `fetch` y el manejo de error.
 */

import { apiBaseUrl } from './backendUrl'

interface RoomCreateResponse {
  slug: string
}

export async function createRoom(): Promise<string> {
  const res = await fetch(`${apiBaseUrl()}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`status ${String(res.status)}`)
  const data = (await res.json()) as RoomCreateResponse
  return data.slug
}
