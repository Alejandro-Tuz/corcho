/**
 * Catálogos visuales, espejo de `backend/app/core/constants.py` -mismos valores,
 * pero como arrays en tiempo de ejecución en vez de solo tipos: hacen falta para
 * poder iterarlos al armar los selectores de onboarding. Los tipos ya viven en
 * `realtime/protocol.ts` (`Avatar`, `ParticipantColor`, etc.); acá solo se agregan
 * los valores.
 *
 * Mismo criterio que protocol.py/protocol.ts (invariante 4 de CLAUDE.md): se
 * mantienen a mano, sin generación automática. Si el catálogo cambia de un lado,
 * cambia del otro en el mismo commit.
 */

import type { Avatar, Background, NoteColor, ParticipantColor, Reaction } from '../realtime/protocol'

export const AVATARS: readonly Avatar[] = [
  'fox',
  'penguin',
  'turtle',
  'owl',
  'bee',
  'whale',
  'hedgehog',
  'octopus',
]

export const PARTICIPANT_COLORS: readonly ParticipantColor[] = [
  'coral',
  'teal',
  'violet',
  'amber',
  'sky',
  'rose',
]

export const NOTE_COLORS: readonly NoteColor[] = ['yellow', 'pink', 'blue', 'green', 'orange']

export const BACKGROUNDS: readonly Background[] = [
  'bone',
  'warm_gray',
  'sage',
  'fog_blue',
  'charcoal',
  'dots_sage',
  'dots_blue',
  'dots_dark',
]

export const REACTIONS: readonly Reaction[] = ['✓', '👀', '🔥']

/** Espejo del `Field(max_length=2000)` de `NoteCreateIn`/`NoteUpdateIn` en protocol.py
 * y del CHECK "text_length" de la tabla notes (backend/app/models/note.py) -no es un
 * catálogo, pero mismo criterio: un solo lugar, a mano, cambia junto con el backend.
 * Usado por `features/notes/NoteDetail.tsx` para el `maxLength` del textarea de
 * detalle. La creación rápida (`NoteComposer.tsx`) usa un tope propio más chico (280,
 * pensado para un título corto), no este. */
export const NOTE_TEXT_MAX_LENGTH = 2000
