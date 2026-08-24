/**
 * "Expandir" una nota: el modal donde vive el detalle que no entra en el post-it
 * -descripción larga y checklist- (CLAUDE.md, pulido día 3 extendido: nota
 * expandible). Mismo patrón que `NoteComposer.tsx`: `<dialog>` nativo, nada de
 * librería. A diferencia del composer, este se monta bajo demanda -`Note.tsx` solo lo
 * renderiza mientras el usuario lo tiene abierto- porque acá SÍ hace falta un estado
 * de edición por instancia (`draft`), y montar uno por nota todo el tiempo (treinta
 * notas, treinta diálogos) no se justifica.
 *
 * `createPortal` a `document.body`, no un `<dialog>` hijo directo de la nota:
 * `.note-card` tiene `transform: rotate(...)` siempre puesto (Note.css, rotación fija
 * por nota), y un ancestro con `transform` pasa a ser el "containing block" de
 * cualquier elemento en la capa superior que cuelgue de él -el `<dialog>` de
 * `showModal()` quedaría rotado y desplazado junto con la nota en vez de centrado en
 * la pantalla. El portal lo saca de ese árbol.
 *
 * Legible por cualquiera, editable solo por el autor (`isMine`): sin `isMine`, el
 * textarea se reemplaza por texto plano y los checkboxes quedan deshabilitados -misma
 * autoridad que ya rige `update_note`/`move_note` en el backend, esto no la duplica,
 * solo la refleja en la UI.
 *
 * ## Una sola superficie de texto, no dos campos ocultos
 *
 * `note.text` sigue siendo UN campo de texto plano (protocol.py no cambia). La
 * convención de `lib/checklist.ts`: una línea `- [ ] algo` / `- [x] algo` es un ítem
 * de checklist, todo lo demás es prosa. Pero esa prosa y ese checklist NO son dos
 * regiones separadas que el usuario nunca ve mezcladas: el textarea de acá abajo
 * muestra el texto crudo, líneas de checklist incluidas, y la lista de checkboxes es
 * una vista derivada EN VIVO de ese mismo texto -no una traducción que ocurre recién
 * al guardar. Escribir "- [ ] comprar café" a mano en el textarea lo vuelve un ítem
 * tildable de inmediato. Decisión tomada así, explícitamente, frente a la alternativa
 * de esconder las líneas de checklist del textarea: esa alternativa se sentía mágica
 * -parseaba algo que el usuario nunca veía como tal- en vez de coherente.
 *
 * ## Regla de sincronización (por qué dos pestañas del mismo autor no se pisan tan
 * fácil como parece)
 *
 * `draft` es la copia local editable; `dirty` dice si diverge de `note.text`.
 * Mientras `dirty` es `false`, un efecto la mantiene pegada a `note.text` en vivo
 * -cualquier confirmación (otra pestaña del mismo autor, la propia de este modal) se
 * adopta sin preguntar, porque no hay nada propio sin guardar que perder. En cuanto el
 * usuario escribe una tecla en el textarea, `dirty` pasa a `true` y el draft deja de
 * seguir al store hasta el próximo guardado.
 *
 * Tildar, destildar, agregar o borrar un ítem SIEMPRE guarda de inmediato (un
 * `note.update` por click, mismo camino optimista que cualquier otra acción sobre una
 * nota -invariante 7-) y deja `dirty` en `false` otra vez. Si en ese instante no había
 * prosa sin guardar, ese guardado ya parte de la versión más fresca posible -la
 * resincronización en vivo se lo garantiza sin ninguna lectura especial-. La prosa, en
 * cambio, se guarda recién al perder foco del textarea o al cerrar el modal (Esc y
 * click en el backdrop incluidos, vía `onCancel`/`onClose` del `<dialog>`), nunca
 * tecla por tecla -evita un `note.update` por cada letra.
 *
 * Límite real, documentado con el mismo nivel de detalle que la limitación de
 * `note.move` en CLAUDE.md: mientras el usuario está escribiendo prosa (`dirty ===
 * true`), el draft no se resincroniza -no hay forma de mezclar tecleo en curso con un
 * cambio remoto sin edición colaborativa de verdad, que el proyecto ya decidió no
 * construir (CRDTs, fuera de alcance). Si la MISMA persona edita la prosa en dos
 * pestañas casi al mismo tiempo, o tilda un ítem en una mientras todavía no guardó la
 * prosa que estaba escribiendo en la otra, gana quien guarda último: pisa el campo
 * entero, sin mezclar. Solo puede pasar entre pestañas del propio autor -es el único
 * que edita, `isMine`- y se autocorrige con la próxima actualización real que llegue,
 * igual que `note.move`.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  addChecklistItem,
  checklistProgress,
  parseChecklist,
  proseOnly,
  removeChecklistItem,
  toggleChecklistLine,
} from '../../lib/checklist'
import { NOTE_TEXT_MAX_LENGTH } from '../../lib/constants'
import type { NoteState } from '../../realtime/protocol'
import './NoteDetail.css'

export function NoteDetail({
  note,
  isMine,
  authorName,
  onClose,
  onSave,
}: {
  note: NoteState
  isMine: boolean
  authorName: string
  onClose: () => void
  onSave: (text: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(note.text)
  const [dirty, setDirty] = useState(false)
  const [newItemText, setNewItemText] = useState('')

  // Montado bajo demanda (ver docstring del módulo): se abre una sola vez, al
  // montar, no hay un prop `open` que ida-y-vuelva como en NoteComposer.
  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // Mientras no hay tecleo propio sin guardar, el draft sigue al texto confirmado
  // -ver el docstring del módulo sobre por qué esto es la mitad segura de la regla
  // de sincronización-. Ajustado durante el render, no en un efecto: mismo patrón
  // que `prevStatus`/`justLanded` en Note.tsx para "sincronizar estado cuando algo
  // cambió" sin el render en cascada de un `setState` dentro de `useEffect`.
  const [lastSyncedText, setLastSyncedText] = useState(note.text)
  if (!dirty && note.text !== lastSyncedText) {
    setLastSyncedText(note.text)
    setDraft(note.text)
  }

  function flushProse(): void {
    if (!dirty) return
    onSave(draft)
    setDirty(false)
  }

  function handleDialogClose(): void {
    flushProse()
    onClose()
  }

  function commitChecklistChange(next: string): void {
    setDraft(next)
    onSave(next)
    setDirty(false)
  }

  function handleAddItem(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = newItemText.trim()
    if (trimmed === '') return
    commitChecklistChange(addChecklistItem(draft, trimmed))
    setNewItemText('')
  }

  const items = parseChecklist(draft)
  const progress = checklistProgress(items)
  const showChecklist = items.length > 0 || isMine

  return createPortal(
    <dialog
      ref={dialogRef}
      className="detail"
      onClose={handleDialogClose}
      onCancel={handleDialogClose}
    >
      <div className="detail-body">
        <div className="detail-header">
          <h2 className="detail-title">Detalle de la nota</h2>
          <span className="detail-author">de {authorName}</span>
        </div>

        {isMine ? (
          <textarea
            className="detail-text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setDirty(true)
            }}
            onBlur={flushProse}
            maxLength={NOTE_TEXT_MAX_LENGTH}
            placeholder="Descripción, contexto, lo que haga falta. Una línea que empiece con - [ ] se vuelve un ítem tildable."
            rows={6}
            autoFocus
          />
        ) : (
          <p className="detail-text detail-text--readonly">{proseOnly(draft) || 'Sin descripción.'}</p>
        )}

        {showChecklist && (
          <div className="detail-checklist">
            {items.length > 0 && (
              <span className="detail-checklist-progress">
                {progress.done}/{progress.total}
              </span>
            )}
            <ul className="detail-checklist-list">
              {items.map((item) => (
                <li key={item.line} className="detail-checklist-item">
                  <label>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      disabled={!isMine}
                      onChange={() => commitChecklistChange(toggleChecklistLine(draft, item.line))}
                    />
                    <span
                      className={
                        item.checked
                          ? 'detail-checklist-item-text detail-checklist-item-text--done'
                          : 'detail-checklist-item-text'
                      }
                    >
                      {item.text}
                    </span>
                  </label>
                  {isMine && (
                    <button
                      type="button"
                      className="detail-checklist-remove"
                      onClick={() => commitChecklistChange(removeChecklistItem(draft, item.line))}
                      aria-label="Borrar ítem"
                      title="Borrar ítem"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {isMine && (
              <form className="detail-checklist-add" onSubmit={handleAddItem}>
                <input
                  type="text"
                  value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)}
                  placeholder="Agregar ítem…"
                  maxLength={200}
                />
                <button type="submit" className="btn" disabled={newItemText.trim() === ''}>
                  Agregar
                </button>
              </form>
            )}
          </div>
        )}

        <div className="detail-actions">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            Cerrar
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}
