/**
 * Buscar y resaltar-a-una-persona (CLAUDE.md, "Nuevo, aprobado" #7/#9): dos filtros
 * de atención sobre el mismo lienzo, NO estado de sala. Deliberadamente separado de
 * `RoomStoreContext`/`RoomState`: `searchQuery` y `highlightedParticipantId` son una
 * preferencia de qué mirar en ESTA pantalla, no algo que viaje por WS ni que la
 * reconciliación optimista de `roomStore.ts` tenga que entender -mezclarlos con
 * `RoomState` sería confundir "estado de la sala" con "cómo la estoy mirando ahora".
 *
 * Mismo split que `RoomStoreContext.ts`/`RoomStoreProvider` por la misma regla de
 * `react-refresh` (un archivo `.tsx` solo puede exportar componentes): el `Context`
 * y el hook viven acá, sin JSX; `Canvas.tsx` es quien arma los `useState` y provee el
 * valor -no hace falta un archivo de Provider aparte como con `RoomStoreProvider`
 * porque `Canvas.tsx` ya es un componente propio, envolver su propio JSX con
 * `<CanvasFocusContext.Provider>` no agrega ningún export nuevo a ese archivo.
 *
 * ## Cómo conviven los dos filtros
 *
 * Se combinan por intersección, nunca uno pisa al otro: una nota queda a opacidad
 * normal solo si pasa TODOS los filtros activos (`Note.tsx` es quien arma esa
 * cuenta, con `noteMatchesSearch` de `store/selectors.ts` para el de buscar). Con
 * los dos activos, buscar "demo" + resaltar a Bruno no es "todo lo de Bruno más todo
 * lo de demo" (unión) sino "las notas de Bruno que mencionan demo" (intersección) -
 * cada filtro angosta, ninguno amplía lo que el otro ya angostó. Con uno solo
 * activo, el otro no aporta nada a la cuenta (un filtro inactivo "matchea siempre").
 *
 * ## Resaltar a alguien que se desconecta
 *
 * `highlightedParticipantId` es solo un id: no le importa si esa persona sigue
 * conectada o no, y nada en este módulo ni en `applyPresenceLeft`
 * (`store/roomStore.ts`) lo toca cuando alguien se desconecta. Decisión deliberada,
 * no un descuido: ya está decidido que resaltar a alguien desconectado es tan válido
 * como resaltar a alguien presente (`sortParticipantsForList` lista a todo el mundo,
 * no solo a quien está conectado ahora) -así que si la persona resaltada se
 * desconecta MIENTRAS está resaltada, no hay ningún motivo para que deje de estarlo:
 * sus notas eran igual de válidas para resaltar un segundo antes de desconectarse
 * que un segundo después. Se limpia solo con el mismo gesto de siempre (clickearla
 * de nuevo en la lista) o resaltando a otra persona.
 *
 * ## `followedParticipantId`: control separado de resaltar, a propósito
 *
 * Los dos bullets del plan describían "clic en alguien de la lista" para las dos
 * cosas, mismo gesto -pero no pueden serlo sin una excepción rara: resaltar ya
 * funciona sobre cualquiera, conectado o no; seguir NO tiene sentido sobre alguien
 * desconectado, no hay cursor que perseguir. Un solo click que hiciera las dos
 * cosas cambiaría de comportamiento según el estado de la otra persona, sin ninguna
 * señal visual de por qué. Por eso son dos controles en `ParticipantList.tsx`: el
 * avatar sigue alternando resaltar para cualquiera; un ícono aparte, que solo
 * aparece en participantes conectados, alterna seguir. Ninguno enciende al otro
 * -click en el avatar nunca dispara seguir, click en seguir nunca fuerza el
 * resaltado- para que cada control haga solo lo que dice y se combinen a mano si
 * se quieren las dos cosas a la vez.
 *
 * El scroll en sí (a qué distancia, cuándo, cómo se corta con un gesto manual) vive
 * en `hooks/useFollowScroll.ts` -acá solo el id de a quién se sigue y el toggle.
 */

import { createContext, useContext } from 'react'

export interface CanvasFocusValue {
  searchQuery: string
  setSearchQuery: (query: string) => void
  highlightedParticipantId: string | null
  toggleHighlight: (participantId: string) => void
  followedParticipantId: string | null
  toggleFollow: (participantId: string) => void
}

export const CanvasFocusContext = createContext<CanvasFocusValue | null>(null)

export function useCanvasFocus(): CanvasFocusValue {
  const value = useContext(CanvasFocusContext)
  if (value === null) {
    throw new Error('useCanvasFocus solo se puede usar adentro de <Canvas>')
  }
  return value
}
