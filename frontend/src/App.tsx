/**
 * Ruteo mínimo por path, sin librería de router (ver docstring de `app/Landing.tsx`):
 * `/` es crear sala, `/{slug}` es la sala, `/{slug}/{noteId}` es un enlace directo a
 * una nota puntual de esa sala. `popstate` alcanza porque la única navegación propia
 * de la SPA es esa -entrar a una sala (o a una nota) existente por link/QR llega como
 * carga completa, no como navegación en cliente.
 */

import { useEffect, useState } from 'react'
import { Landing } from './app/Landing'
import { RoomPage } from './app/RoomPage'

function App() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    function handlePopState(): void {
      setPath(window.location.pathname)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  const [room, noteId] = trimmed.split('/').filter((segment) => segment !== '')

  if (room === undefined) {
    return <Landing />
  }
  return <RoomPage room={room} noteId={noteId ?? null} />
}

export default App
