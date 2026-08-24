/**
 * Checklist como markdown DENTRO de `notes.text` -sin migración ni tabla ni eventos
 * de protocolo nuevos, decisión tomada explícitamente para no acercarse a edición de
 * texto simultánea con estructura propia (fuera de alcance en CLAUDE.md, necesitaría
 * CRDTs). Convención: una línea `- [ ] algo` / `- [x] algo` es un ítem de checklist;
 * cualquier otra línea es prosa libre. `NoteDetail.tsx` documenta con más detalle POR
 * QUÉ el textarea de detalle muestra el texto crudo tal cual -sin esconder estas
 * líneas- y cómo evita que esto choque con el multi-pestaña del mismo autor.
 *
 * Funciones puras, sin estado: siempre operan sobre el string que se les pasa, nunca
 * sobre una copia guardada acá. Esa es la propiedad de la que depende `NoteDetail.tsx`
 * para no pisar cambios de otra pestaña -leer siempre el texto más fresco antes de
 * transformarlo, no una foto vieja-.
 */

const CHECKLIST_LINE = /^\s*-\s\[( |x|X)\]\s?(.*)$/

export interface ChecklistItem {
  /** Índice de línea dentro del `text` completo -no una posición dentro de la lista
   * de ítems-, para poder tildar/borrar exactamente esa línea sin ambigüedad aunque
   * haya prosa intercalada. */
  line: number
  checked: boolean
  text: string
}

export function parseChecklist(text: string): ChecklistItem[] {
  return text.split('\n').reduce<ChecklistItem[]>((items, raw, line) => {
    const match = CHECKLIST_LINE.exec(raw)
    if (match !== null) items.push({ line, checked: match[1].trim() !== '', text: match[2] })
    return items
  }, [])
}

export function checklistProgress(items: readonly ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.checked).length, total: items.length }
}

/** El texto SIN las líneas de checklist -lo que el post-it muestra como cuerpo
 * (`Note.tsx`), separado del chip de progreso. */
export function proseOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !CHECKLIST_LINE.test(line))
    .join('\n')
    .trim()
}

export function toggleChecklistLine(text: string, line: number): string {
  const lines = text.split('\n')
  const match = lines[line] !== undefined ? CHECKLIST_LINE.exec(lines[line]) : null
  if (match === null) return text
  const flipped = match[1].trim() === '' ? 'x' : ' '
  lines[line] = `- [${flipped}] ${match[2]}`
  return lines.join('\n')
}

export function removeChecklistItem(text: string, line: number): string {
  const lines = text.split('\n')
  if (lines[line] === undefined) return text
  lines.splice(line, 1)
  return lines.join('\n')
}

/** Agrega el ítem nuevo justo después del último ítem de checklist existente -para
 * que la lista quede agrupada en vez de dispersa- o, si no hay ninguno todavía, al
 * final del texto (con una línea en blanco de separador si ya había prosa). */
export function addChecklistItem(text: string, itemText: string): string {
  const lines = text.split('\n')
  let lastChecklistLine = -1
  lines.forEach((line, i) => {
    if (CHECKLIST_LINE.test(line)) lastChecklistLine = i
  })
  const newLine = `- [ ] ${itemText}`
  if (lastChecklistLine >= 0) {
    lines.splice(lastChecklistLine + 1, 0, newLine)
    return lines.join('\n')
  }
  const trimmed = text.trimEnd()
  return trimmed === '' ? newLine : `${trimmed}\n\n${newLine}`
}
