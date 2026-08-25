/**
 * "Bajar solo con cada mensaje nuevo, salvo que la persona esté leyendo hacia
 * arriba" -genérico, no atado a chat, aunque hoy el único consumidor sea
 * `features/chat/ChatPanel.tsx`. Quinto inquilino de `hooks/`.
 *
 * Dos referencias para la misma pregunta ("¿estoy en el fondo?"), a propósito:
 * `isAtBottomRef` es la que lee el efecto de auto-scroll, SIEMPRE actualizada en el
 * mismo instante que el estado -si ese efecto leyera `isAtBottom` (estado) en vez
 * del ref, dependería de él en su arreglo de dependencias, y entonces
 * correría de nuevo con cada scroll, no solo cuando `itemCount` crece. Una closure
 * vieja del estado (sin esa dependencia) sería aún peor: siempre vería el valor de
 * la primera vez que se armó el efecto. El ref no tiene ese problema -`.current` es
 * siempre el de ahora, sin importar cuándo se leyó el efecto por última vez-.
 * `isAtBottom` (estado) es la mitad pensada para el consumidor: algo reactivo que
 * un componente pueda leer para, por ejemplo, publicarlo hacia otro lado
 * (`ChatContext.ts`, `watching`).
 *
 * `stickNextScroll()`: para el caso de "mandé mi propio mensaje mientras leía
 * hacia arriba, igual quiero verlo aparecer" -fuerza el PRÓXIMO scroll disparado
 * por un cambio de `itemCount`, sin importar `isAtBottomRef` en ese momento. No
 * hace falta para el caso de "se acaba de abrir el panel": ese va con
 * `scrollToBottom()` directo, en un efecto propio del componente que sepa qué es
 * "abierto" -este hook no lo sabe, ni le hace falta saberlo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const NEAR_BOTTOM_THRESHOLD_PX = 64

export function useStickyScroll<T extends HTMLElement>(
  itemCount: number,
): {
  containerRef: React.RefObject<T | null>
  isAtBottom: boolean
  scrollToBottom: () => void
  stickNextScroll: () => void
} {
  const containerRef = useRef<T>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)
  const forceNextRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    function handleScroll(): void {
      if (el === null) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const next = distance <= NEAR_BOTTOM_THRESHOLD_PX
      isAtBottomRef.current = next
      setIsAtBottom(next)
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    if (!isAtBottomRef.current && !forceNextRef.current) return
    forceNextRef.current = false
    el.scrollTop = el.scrollHeight
    // El propio `scrollTop` de arriba ya deja al contenedor en el fondo -adelantar
    // el ref/estado acá evita depender de que el `scroll` nativo dispare a tiempo
    // (algunos navegadores lo hacen async, un instante después de este efecto).
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [itemCount])

  // useCallback, no funciones planas: un consumidor (ChatPanel.tsx) las usa en el
  // arreglo de dependencias de su propio efecto ("scrollear al fondo cuando el
  // panel se abre") -sin identidad estable, ese efecto correría en CADA render
  // mientras el panel está abierto, no solo al abrirlo, y le ganaría el scroll a
  // mano a cualquiera que esté leyendo hacia arriba.
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [])

  const stickNextScroll = useCallback(() => {
    forceNextRef.current = true
  }, [])

  return { containerRef, isAtBottom, scrollToBottom, stickNextScroll }
}
