/**
 * `/`: crear una sala nueva y navegar a `/{slug}`. Navegación con `window.location`,
 * no un router -no hay uno en el proyecto y con una sola pantalla real (la sala) no
 * se justifica la dependencia (CLAUDE.md: no agregar sin justificar)-. Una recarga
 * completa al entrar a la sala es aceptable acá: no hay estado que preservar antes de
 * eso. Mismo criterio, en el sentido contrario, para volver acá desde una sala
 * (`Canvas.tsx`: un `<a href="/">` común en la marca) y para crear otra sala sin
 * pasar por acá (el botón "+" al lado de esa marca, mismo `createRoom` de
 * `lib/api.ts`).
 */

import { useState } from 'react'
import { createRoom } from '../lib/api'
import './Landing.css'

export function Landing() {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    setCreating(true)
    setError(null)
    try {
      const slug = await createRoom()
      window.location.href = `/${slug}`
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
