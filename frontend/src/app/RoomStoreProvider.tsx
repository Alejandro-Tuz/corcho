import type { ReactNode } from 'react'
import type { RoomStore } from '../store/roomStore'
import { RoomStoreContext } from './RoomStoreContext'

export function RoomStoreProvider({
  store,
  children,
}: {
  store: RoomStore
  children: ReactNode
}) {
  return <RoomStoreContext.Provider value={store}>{children}</RoomStoreContext.Provider>
}
