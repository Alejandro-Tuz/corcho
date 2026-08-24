/**
 * Reemplaza los `window.prompt()` del día 2 (CLAUDE.md, pulido día 3): un modal
 * mínimo para crear una nota -tipo (propia/compartida), texto, color y cupos si
 * corresponde-. `<dialog>` nativo en vez de armar uno a mano o traer una
 * librería: foco atrapado, `Esc` cierra, `::backdrop` gratis, y controlarlo es
 * `showModal()`/`close()` -no se justifica más máquina que esa para un modal de
 * un solo formulario (CLAUDE.md: no agregar dependencias sin justificar por qué
 * no alcanza con lo que ya hay).
 *
 * `Canvas.tsx` es dueño de si está abierto (`open`) y de qué hacer con el
 * resultado (`onCreate` llama a `actions.createNote`) -este componente no toca
 * el store, solo junta el formulario.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { NOTE_COLORS } from '../../lib/constants'
import { NOTE_COLOR_HEX } from '../../lib/noteColor'
import type { NoteColor, NoteKind } from '../../realtime/protocol'
import './NoteComposer.css'

const DEFAULT_CAPACITY = 2

export function NoteComposer({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (input: { kind: NoteKind; text: string; color: NoteColor; capacity: number | null }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [kind, setKind] = useState<NoteKind>('own')
  const [text, setText] = useState('')
  const [color, setColor] = useState<NoteColor>(NOTE_COLORS[0])
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY)

  // `<dialog>` se abre/cierra de forma imperativa (`showModal`/`close`), no hay
  // un atributo declarativo que lo haga -por eso este efecto en vez de un
  // simple `open={open}` en el JSX.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open && !dialog.open) {
      dialog.showModal()
      setKind('own')
      setText('')
      setColor(NOTE_COLORS[0])
      setCapacity(DEFAULT_CAPACITY)
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '') return
    onCreate({ kind, text: trimmed, color, capacity: kind === 'shared' ? capacity : null })
    onClose()
  }

  function handleCapacityChange(raw: string): void {
    const parsed = Number.parseInt(raw, 10)
    setCapacity(Number.isFinite(parsed) && parsed > 0 ? parsed : 1)
  }

  return (
    // onClose/onCancel cubren las dos formas de cerrar que no pasan por el botón
    // "Cancelar": Esc, y un click en el backdrop (que dispara `close()` del
    // propio `<dialog>` sin que este componente haga nada).
    <dialog ref={dialogRef} className="composer" onClose={onClose} onCancel={onClose}>
      <form onSubmit={handleSubmit} className="composer-form">
        <h2 className="composer-title">Nueva nota</h2>

        <div className="composer-kind" role="tablist" aria-label="Tipo de nota">
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'own'}
            className={kind === 'own' ? 'composer-tab composer-tab--active' : 'composer-tab'}
            onClick={() => setKind('own')}
          >
            Propia
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'shared'}
            className={kind === 'shared' ? 'composer-tab composer-tab--active' : 'composer-tab'}
            onClick={() => setKind('shared')}
          >
            Compartida
          </button>
        </div>

        <textarea
          className="composer-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="¿Qué hay que hacer?"
          maxLength={280}
          autoFocus
          rows={3}
        />

        {kind === 'shared' && (
          <label className="composer-capacity">
            Cupos
            <input
              type="number"
              min={1}
              max={20}
              value={capacity}
              onChange={(e) => handleCapacityChange(e.target.value)}
            />
          </label>
        )}

        <div className="composer-colors" role="radiogroup" aria-label="Color de la nota">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              className={c === color ? 'composer-swatch composer-swatch--active' : 'composer-swatch'}
              style={{ background: NOTE_COLOR_HEX[c] }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        <div className="composer-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={text.trim() === ''}>
            Pegar en el corcho
          </button>
        </div>
      </form>
    </dialog>
  )
}
