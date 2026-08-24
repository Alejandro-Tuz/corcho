/**
 * `/`: crear una sala nueva y navegar a `/{slug}`. Navegación con `window.location`,
 * no un router -no hay uno en el proyecto y con una sola pantalla real (la sala) no
 * se justifica la dependencia (CLAUDE.md: no agregar sin justificar)-. Una recarga
 * completa al entrar a la sala es aceptable acá: no hay estado que preservar antes de
 * eso.
 */

import { useState } from 'react'
import { apiBaseUrl } from '../lib/backendUrl'
import './Landing.css'

interface RoomCreateResponse {
  slug: string
}

export function Landing() {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(`${apiBaseUrl()}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(`status ${String(res.status)}`)
      const data = (await res.json()) as RoomCreateResponse
      window.location.href = `/${data.slug}`
    } catch {
      setError('no se pudo crear la sala, reintentá')
      setCreating(false)
    }
  }

  return (
    <div className="landing-shell">
      <div className="landing-card">
        <h1 className="landing-brand">Corcho</h1>
        <p className="landing-sub">Un lienzo compartido para pendientes y updates, en vivo.</p>
        <button type="button" className="btn btn-primary landing-create" onClick={() => void handleCreate()} disabled={creating}>
          {creating ? 'creando...' : 'crear sala'}
        </button>
        {error !== null && <p className="landing-error">{error}</p>}
      </div>
    </div>
  )
}
