/**
 * `NoteColor` -> color CSS real + tinta de texto sobre esa nota. Hasta el
 * pulido del día 3, `Note.tsx` pintaba toda nota con `background: '#ddd'` fijo
 * sin importar el color elegido en su creación -no era una decisión de diseño,
 * el mapeo nunca se había escrito. Paleta aprobada: papel con pigmento, más
 * saturada que la de fondo de sala o participante -tiene que distinguirse
 * puesta sobre el corcho, no solo entre sí.
 */

import type { NoteColor } from '../realtime/protocol'

export const NOTE_COLOR_HEX: Record<NoteColor, string> = {
  yellow: '#F7CB3D',
  pink: '#EF8FA0',
  blue: '#5FAED4',
  green: '#86BF62',
  orange: '#EE8F49',
}

// La tinta (un solo tono oscuro para las cinco, como un marcador sobre
// cualquier papel de color) vive en `--note-ink` (index.css) -no se duplica
// acá: Note.css es el único lugar que la pinta.
