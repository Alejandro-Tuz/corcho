/**
 * Las tres columnas del Kanban, fijas en el código -no hay tabla (CLAUDE.md,
 * "Decisiones de diseño ya tomadas"). Lo único que se persiste es `status`; esto es
 * puramente la etiqueta visible de cada valor, en el orden en que se dibujan.
 */

import type { NoteStatus } from '../../realtime/protocol'

export const COLUMNS: readonly { status: NoteStatus; label: string }[] = [
  { status: 'blocked', label: 'Bloqueado' },
  { status: 'in_progress', label: 'En curso' },
  { status: 'done', label: 'Listo' },
]
