/**
 * `Avatar` -> emoji para mostrarlo en el onboarding y en el chip de autor de cada
 * nota (pulido día 3). Un emoji ya es reconocible de por sí y no pide traer
 * íconos propios ni un asset pipeline para un catálogo fijo de ocho valores.
 */

import type { Avatar } from '../realtime/protocol'

export const AVATAR_EMOJI: Record<Avatar, string> = {
  fox: '🦊',
  penguin: '🐧',
  turtle: '🐢',
  owl: '🦉',
  bee: '🐝',
  whale: '🐳',
  hedgehog: '🦔',
  octopus: '🐙',
}
