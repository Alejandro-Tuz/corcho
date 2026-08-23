/**
 * El `RoomStore` de la sala actual, disponible para cualquier componente adentro de
 * `RoomStoreProvider` (`RoomStoreProvider.tsx`) sin pasarlo prop por prop.
 *
 * Separado de `RoomStoreProvider.tsx` -que sí tiene JSX- porque `react-refresh`
 * (`eslint-plugin-react-refresh`) exige que un archivo `.tsx` solo exporte
 * componentes: mezclar el `Context` y estos hooks con el componente `Provider` en el
 * mismo archivo rompe esa regla.
 */

import { createContext, useContext } from 'react'
import type { RoomCommands, RoomState } from '../store/types'
import type { RoomStore } from '../store/roomStore'
import { useRoomStore } from '../store/roomStore'

export const RoomStoreContext = createContext<RoomStore | null>(null)

function requireStore(store: RoomStore | null): RoomStore {
  if (store === null) {
    throw new Error('useRoom/useRoomActions solo se puede usar adentro de <RoomStoreProvider>')
  }
  return store
}

export function useRoom<T>(selector: (state: RoomState) => T): T {
  const store = requireStore(useContext(RoomStoreContext))
  return useRoomStore(store, selector)
}

export function useRoomActions(): RoomCommands {
  const store = requireStore(useContext(RoomStoreContext))
  return store.actions
}
