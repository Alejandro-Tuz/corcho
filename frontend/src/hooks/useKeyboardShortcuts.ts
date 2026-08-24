/**
 * Atajos de teclado (CLAUDE.md, "Nuevo, aprobado"): `N` nota nueva, `/` buscar,
 * `Esc` cierra lo que esté abierto. Tercer inquilino de `hooks/`
 * (`useNotificationSound.ts`, `useFollowScroll.ts`).
 *
 * ## `N`/`/`: se ignoran mientras el foco está en un campo de texto
 *
 * Ahí esas teclas son caracteres, no atajos -escribir una reseña con la letra
 * "n", o una URL con "/", no puede abrir el composer ni saltar al buscador-.
 * Mismo chequeo que ya usa "seguir a una persona" para el mismo problema
 * (`lib/domFocus.ts`, `isTypingTarget`), extraído a un solo lugar cuando apareció
 * el segundo consumidor.
 *
 * También se ignoran mientras haya un `<dialog>` nativo abierto (composer o
 * detalle de una nota), aunque el foco en ese momento esté en un botón y no en un
 * campo de texto -"N" con el detalle de una nota abierto no tiene un
 * comportamiento definido con `<dialog>` nativo apilado, y no aporta nada: cerrar
 * el que ya está abierto es lo que corresponde primero, no sumar otro encima.
 *
 * ## `Esc`: al revés a propósito
 *
 * Nunca se ignora por foco -es justo la tecla que se usa DESDE ADENTRO de lo que
 * se quiere cerrar, lo opuesto de `N`/`/`-. El composer y el detalle de una nota
 * ya se cierran solos con Esc: son `<dialog>` nativo, el navegador ya les da esa
 * tecla gratis (`onCancel`, `NoteComposer.tsx`/`NoteDetail.tsx`), así que lo único
 * que hace falta acá es el buscador -un `<input>` común, sin ese comportamiento
 * nativo-. Si hay un `<dialog>` abierto, este handler no toca el buscador: "lo que
 * está abierto" en ese momento es el diálogo, no las dos cosas a la vez -evita que
 * cerrar el detalle de una nota con Esc también borre de paso una búsqueda activa
 * sin ninguna relación con eso.
 */

import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../lib/domFocus'

function hasOpenDialog(): boolean {
  return document.querySelector('dialog[open]') !== null
}

export function useKeyboardShortcuts({
  onNewNote,
  searchQuery,
  onClearSearch,
}: {
  onNewNote: () => void
  searchQuery: string
  onClearSearch: () => void
}): React.RefObject<HTMLInputElement | null> {
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (hasOpenDialog()) return // el <dialog> ya se cierra solo (onCancel)
        const searching = searchQuery !== '' || document.activeElement === searchInputRef.current
        if (!searching) return
        e.preventDefault()
        onClearSearch()
        searchInputRef.current?.blur()
        return
      }

      if (isTypingTarget(document.activeElement) || hasOpenDialog()) return

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        onNewNote()
      } else if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onNewNote, searchQuery, onClearSearch])

  return searchInputRef
}
