/**
 * ¿El foco está en algo donde escribir? La comparten dos consumidores: "seguir a
 * una persona" (`hooks/useFollowScroll.ts`, la usó primero -un gesto de scroll con
 * teclado no puede confundirse con escribir un espacio en el buscador) y los
 * atajos de teclado (`hooks/useKeyboardShortcuts.ts` -`N`/`/` son caracteres, no
 * atajos, mientras se está escribiendo en un campo). Extraída a un solo lugar en
 * vez de duplicada: la definición de "campo de texto" (`INPUT`, `TEXTAREA`,
 * `contentEditable`) solo debería poder cambiar en un sitio.
 */
export function isTypingTarget(el: Element | null): boolean {
  if (el === null) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el instanceof HTMLElement && el.isContentEditable
}
