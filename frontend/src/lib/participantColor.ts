/**
 * `ParticipantColor` -> color CSS real. Hace falta un color de verdad (no un texto,
 * a diferencia del selector de `onboarding`) porque CLAUDE.md ya definió para qué
 * sirve esta paleta: "cursor, borde de nota fantasma, iniciales del avatar" -sin
 * color no hay forma de distinguir de un vistazo el cursor o el fantasma de una
 * persona del de otra. Valores provisorios, a definir mejor en el pulido del día 3.
 */

import type { ParticipantColor } from '../realtime/protocol'

export const PARTICIPANT_COLOR_HEX: Record<ParticipantColor, string> = {
  coral: '#e8735c',
  teal: '#2f9e94',
  violet: '#8672c9',
  amber: '#d99a2b',
  sky: '#4a97c9',
  rose: '#c96a94',
}
