/**
 * Orquesta: identidad -> store -> lienzo. Si no hay identidad guardada para esta
 * sala, `Onboarding`; una vez que hay una (guardada o recién completada), se crea el
 * `RoomStore` (conecta el socket) en un `useEffect` -no en el cuerpo del render: crear
 * la conexión es un efecto secundario real, y en `StrictMode` de desarrollo React
 * monta-desmonta-remonta efectos una vez a propósito (para encontrar fugas); acá es
 * inofensivo porque `close()` deja todo prolijo-.
 */

import { useEffect, useState } from 'react'
import type { StoredIdentity } from '../lib/identity'
import { loadIdentity } from '../lib/identity'
import { createRoomStore } from '../store/roomStore'
import type { RoomStore } from '../store/roomStore'
import { Onboarding } from '../features/onboarding/Onboarding'
import { Canvas } from '../features/canvas/Canvas'
import { RoomStoreProvider } from './RoomStoreProvider'

export function RoomPage({ room }: { room: string }) {
  const [identity, setIdentity] = useState<StoredIdentity | null>(() => loadIdentity(room))
  const [store, setStore] = useState<RoomStore | null>(null)

  useEffect(() => {
    if (identity === null) return
    const newStore = createRoomStore(room, identity)
    // El store no es un valor derivable puro -tiene un socket vivo detrás, un
    // recurso externo real, exactamente lo que un efecto existe para sincronizar-.
    // Publicarlo para que el render lo vea exige setState acá: no hay forma de
    // calcularlo en el cuerpo del render sin volver a crear la conexión en cada
    // renderizado. La regla apunta a estado que sí se podría derivar en el render;
    // no es este caso.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(newStore)
    return () => {
      newStore.close()
      setStore(null)
    }
  }, [room, identity])

  if (identity === null) {
    return <Onboarding room={room} onComplete={setIdentity} />
  }
  if (store === null) {
    return (
      <p style={{ padding: 16, fontFamily: 'var(--font-ui)', color: 'var(--ink-soft)' }}>conectando...</p>
    )
  }

  return (
    <RoomStoreProvider store={store}>
      <Canvas />
    </RoomStoreProvider>
  )
}
