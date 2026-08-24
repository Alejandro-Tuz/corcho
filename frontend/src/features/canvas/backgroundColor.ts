/**
 * Único mapeo de identificador de fondo -> valor CSS de `background` real (color
 * sólido, o un patrón). Pulido día 3, segunda vuelta: los cinco sólidos originales
 * quedaban casi indistinguibles entre sí -"la diferencia de tono es casi mínima",
 * feedback directo-, así que se separaron más en tono/saturación; y se sumaron tres
 * variantes con lunares a pedido, para más variedad de la que un solo color permite.
 *
 * Cada valor es lo que se le puede pasar directo a `style.background` -para un
 * sólido, un hex; para un lunar, un shorthand de dos capas (`radial-gradient(...)
 * tamaño, color-base`) que Canvas.tsx aplica exactamente igual sin saber la
 * diferencia. Los lunares llevan alto contraste contra su base a propósito -la
 * razón original para "sin patrones" era que un patrón sutil no se nota a
 * distancia; si hay patrón, que se note tanto como un cambio de color sólido.
 */

import type { Background } from '../../realtime/protocol'

function dots(dotColor: string, base: string): string {
  return `radial-gradient(${dotColor} 3px, transparent 3.4px) 0 0/20px 20px, ${base}`
}

export const BACKGROUND_COLORS: Record<Background, string> = {
  bone: '#f3eee2',
  warm_gray: '#c9b6a0',
  sage: '#8fae86',
  fog_blue: '#7ca0be',
  charcoal: '#2e2a26',
  dots_sage: dots('#6f9468', '#eef2e7'),
  dots_blue: dots('#5c86a8', '#e8eef4'),
  dots_dark: dots('rgba(243, 238, 226, 0.55)', '#2e2a26'),
}
