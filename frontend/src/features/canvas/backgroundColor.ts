/**
 * Único mapeo de identificador de fondo -> color CSS real. No es "CSS elaborado": es
 * el mínimo para que el fondo tenga algún efecto visible -sin esto la función
 * "fondo compartido" (bloque 3) no tendría nada que mostrar-. Valores provisorios,
 * a definir mejor en el pulido del día 3; hoy solo tienen que distinguirse entre sí a
 * distancia, como pide CLAUDE.md.
 */

import type { Background } from '../../realtime/protocol'

export const BACKGROUND_COLORS: Record<Background, string> = {
  bone: '#f2efe9',
  warm_gray: '#e6e1da',
  sage: '#dde3d9',
  fog_blue: '#dfe6ec',
  charcoal: '#333333',
}
