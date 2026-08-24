/**
 * "Seguir a una persona" (CLAUDE.md, "Nuevo, aprobado"): mueve la ventana para
 * mantener a la vista el cursor de `followedParticipantId`, mientras haya alguien
 * elegido (`CanvasFocusContext.ts` tiene el porqué de que sea un control aparte de
 * resaltar). Vertical solamente -el lienzo crece hacia abajo con las tres columnas
 * fijas de hoy, no hacia los costados; horizontal queda para cuando se aborde
 * responsive.
 *
 * ## Se detiene solo, sin escuchar `presence.left` aparte
 *
 * Sigue `participant.disconnected_at`, NO la ausencia de una entrada en
 * `presence.cursors` -primer borrador, corregido antes de darlo por terminado:
 * alguien recién conectado que todavía no movió el mouse tampoco tiene entrada ahí
 * todavía, y con esa señal el seguimiento se cortaría solo un instante después de
 * arrancarlo. `disconnected_at` es la señal correcta -la misma que
 * `applyPresenceLeft` (`store/roomStore.ts`) ya pone en `!== null` al
 * desconectarse- y no tiene ese falso positivo: sigue derivando de estado que ya
 * existe, no de escuchar el evento aparte.
 *
 * ## Por qué el scroll no se pisa a sí mismo
 *
 * `presence.cursor` llega cada 50ms (`CURSOR_BROADCAST_INTERVAL_MS`, `Canvas.tsx`).
 * Un `scrollTo({behavior:'smooth'})` por tick se pisaría a sí mismo -la animación
 * real tarda 300-500ms, mucho más que el intervalo entre ticks-. En vez de apostar
 * a un intervalo fijo que "normalmente" dure más que la animación,
 * `scrollInFlightRef` marca la condición real: pasa a `true` al pedir un
 * `scrollTo` y solo vuelve a `false` cuando el evento nativo `scrollend` confirma
 * que terminó (con un `setTimeout` de respaldo por si no llega a dispararse).
 * Mientras esté en `true`, ningún tick pide otro `scrollTo`, sin importar cuánto
 * haya tardado el anterior en la práctica. Tampoco se scrollea si no hace falta:
 * solo si el cursor salió de una zona muerta central (40% del alto de la ventana).
 *
 * ## Cortar al primer scroll manual
 *
 * El evento nativo `scroll` no distingue "lo hice yo" de "lo hizo quien mira la
 * pantalla" -mi propio `scrollTo` también lo dispara, muchas veces mientras dura la
 * animación-. Dos caminos, no uno:
 *
 * - Gestos inequívocos, que este código nunca dispara: `wheel`, `touchmove`, y las
 *   teclas de scroll (flechas, `PageUp/Down`, `Home/End`, espacio) -siempre que el
 *   foco no esté en un campo de texto, si no escribir un espacio en el buscador
 *   cortaría el seguimiento por accidente. Cortan al toque, sin mirar ninguna
 *   bandera.
 * - `scroll` en sí, para el hueco que los de arriba no cubren: arrastrar la barra
 *   lateral del navegador no dispara `wheel` ni `touchmove`. Si llega un `scroll`
 *   mientras `scrollInFlightRef` está en `false` -ningún `scrollTo` propio
 *   corriendo en este momento-, no fui yo: corta.
 *
 * Hueco conocido, no blindado a propósito: si alguien agarra la barra lateral
 * justo en la ventana de 300-500ms en que un `scrollTo` propio sigue animando, ese
 * arrastre puntual no corta el seguimiento hasta que esa animación termine
 * -`wheel`/`touchmove`/teclado siguen cortando igual, ninguno depende de la
 * bandera-. Ventana angosta y de bajo costo -el próximo tick real iba a mover la
 * vista poco después de todos modos-, no vale más máquina en tres días.
 */

import { useEffect, useRef } from 'react'
import { useRoom } from '../app/RoomStoreContext'

const DEAD_ZONE_RATIO = 0.3 // 30% arriba y 30% abajo -cursor "cómodo" en el 40% central
const SCROLL_END_FALLBACK_MS = 800 // bien por encima de cualquier smooth scroll real

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
])

function isTypingTarget(el: Element | null): boolean {
  if (el === null) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el instanceof HTMLElement && el.isContentEditable
}

export function useFollowScroll(followedParticipantId: string | null, onStop: () => void): void {
  const cursor = useRoom((s) =>
    followedParticipantId === null ? undefined : s.presence.cursors[followedParticipantId],
  )
  const isFollowedOnline = useRoom((s) => {
    if (followedParticipantId === null) return true // nada que evaluar todavía
    const participant = s.participants[followedParticipantId]
    return participant !== undefined && participant.disconnected_at === null
  })
  const scrollInFlightRef = useRef(false)

  useEffect(() => {
    if (followedParticipantId !== null && !isFollowedOnline) onStop()
  }, [followedParticipantId, isFollowedOnline, onStop])

  // El scroll en sí, solo cuando el cursor sale de la zona muerta y no hay uno
  // propio ya animando.
  useEffect(() => {
    if (followedParticipantId === null || cursor === undefined) return
    if (scrollInFlightRef.current) return

    const canvasRoot = document.querySelector('[data-canvas-root]')
    if (canvasRoot === null) return
    const cursorPageY = canvasRoot.getBoundingClientRect().top + window.scrollY + cursor.y

    const viewportHeight = window.innerHeight
    const margin = viewportHeight * DEAD_ZONE_RATIO
    const viewTop = window.scrollY
    const viewBottom = viewTop + viewportHeight
    const comfortable = cursorPageY > viewTop + margin && cursorPageY < viewBottom - margin
    if (comfortable) return

    const target = Math.max(0, cursorPageY - viewportHeight / 2)
    scrollInFlightRef.current = true
    window.scrollTo({ top: target, behavior: 'smooth' })
  }, [followedParticipantId, cursor])

  // Gestos manuales -ver docstring del módulo para el porqué de cada uno.
  useEffect(() => {
    if (followedParticipantId === null) return

    function stopIfNotTyping(): void {
      if (isTypingTarget(document.activeElement)) return
      onStop()
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (SCROLL_KEYS.has(e.key)) stopIfNotTyping()
    }

    function handleScrollEnd(): void {
      scrollInFlightRef.current = false
    }

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    function handleScroll(): void {
      if (!scrollInFlightRef.current) {
        onStop()
        return
      }
      // Respaldo: si `scrollend` no llega, la bandera no puede quedar en `true`
      // para siempre -eso dejaría el seguimiento sordo a cualquier scroll manual
      // futuro. Se reprograma en cada evento mientras la animación sigue en curso.
      if (fallbackTimer !== null) clearTimeout(fallbackTimer)
      fallbackTimer = setTimeout(() => {
        scrollInFlightRef.current = false
      }, SCROLL_END_FALLBACK_MS)
    }

    window.addEventListener('wheel', stopIfNotTyping, { passive: true })
    window.addEventListener('touchmove', stopIfNotTyping, { passive: true })
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('scrollend', handleScrollEnd)

    return () => {
      window.removeEventListener('wheel', stopIfNotTyping)
      window.removeEventListener('touchmove', stopIfNotTyping)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('scrollend', handleScrollEnd)
      if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    }
  }, [followedParticipantId, onStop])
}
