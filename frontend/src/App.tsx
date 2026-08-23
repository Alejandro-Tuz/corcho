/**
 * Ruteo mínimo por path, sin librería de router (ver docstring de `app/Landing.tsx`):
 * `/` es crear sala, `/{slug}` es la sala. `popstate` alcanza porque la única
 * navegación propia de la SPA es esa -entrar a una sala existente por link/QR llega
 * como carga completa, no como navegación en cliente.
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

  const room = path.replace(/^\/+/, '').replace(/\/+$/, '')

  if (room === '') {
    return <Landing />
  }
  return <RoomPage room={room} />
}

export default App
