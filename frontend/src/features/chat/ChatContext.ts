/**
 * Panel de chat: abierto/cerrado, filtro por tarea, y "se está viendo en vivo"
 * (CLAUDE.md, "Comprometido, pendiente" #4). Deliberadamente NO una extensión de
 * `CanvasFocusContext` -se pensó primero como eso, pero ese contexto tiene un
 * contrato preciso y ya documentado ("la MISMA cuenta de intersección que atenúa
 * notas"), y nada de lo de acá atenúa nada en el lienzo: es una preferencia
 * distinta, sobre una superficie distinta (qué mensajes ver), que solo necesita el
 * mismo tipo de mecanismo -compartir un valor con un descendiente varios niveles
 * más abajo (`features/notes/NoteDetail.tsx`) sin prop-drilling-. Mismo patrón de
 * archivo que `CanvasFocusContext.ts` por el mismo motivo (regla de
 * `react-refresh`: un `.tsx` solo exporta componentes): Context + hook acá, sin
 * JSX; `Canvas.tsx` arma el `useState` y provee el valor.
 *
 * ## `filterNoteId`: un solo estado para leer y escribir
 *
 * No es solo "qué mensajes mostrar" -también es "con qué `note_id` se manda el
 * próximo mensaje": `ChatPanel.tsx` le pasa el filtro activo tal cual a
 * `sendChatMessage`. Filtrando en "todos" (`null`), los mensajes nuevos son chat
 * general; filtrando a una nota, quedan etiquetados con ella. Sin un selector
 * aparte para "elegir con qué nota etiquetar": es el mismo control que ya se usa
 * para mirar.
 *
 * ## `watching`
 *
 * `true` solo cuando el panel está abierto Y con el scroll en el fondo -"se está
 * viendo llegar en vivo", ver `hooks/useStickyScroll.ts`-. `ChatPanel.tsx` lo
 * publica acá desde su propio `isAtBottom` en un efecto; dos consumidores lo leen
 * por motivos distintos:
 *
 * - El contador de no leídos (local a `ChatPanel.tsx`, no vive acá: es un dato que
 *   solo ese componente necesita) se resetea cuando `watching` es `true`.
 * - `hooks/useNotificationSound.ts` no suena un `chat.message` ajeno mientras
 *   `watching` es `true` -ver su docstring para el porqué de que lo reciba como
 *   parámetro y no con su propio `useContext` acá.
 */

import { createContext, useContext } from 'react'

export interface ChatFocusValue {
  open: boolean
  toggleOpen: () => void
  /** Abre el panel. Si se pasa un `note_id`, además fija el filtro a esa nota -lo
   * que usa "Ver chat de esta nota" en `NoteDetail.tsx`. Sin argumento (o
   * `undefined`), abre sin tocar el filtro actual. */
  openChat: (noteId?: string | null) => void
  filterNoteId: string | null
  setFilterNoteId: (noteId: string | null) => void
  watching: boolean
  setWatching: (watching: boolean) => void
}

export const ChatContext = createContext<ChatFocusValue | null>(null)

export function useChatFocus(): ChatFocusValue {
  const value = useContext(ChatContext)
  if (value === null) {
    throw new Error('useChatFocus solo se puede usar adentro de <Canvas>')
  }
  return value
}
