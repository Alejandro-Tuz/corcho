/**
 * Enlace directo a una nota (CLAUDE.md, "Nuevo, aprobado"): `/{slug}/{noteId}`
 * (`App.tsx`) resalta esa nota al entrar y centra la vista sobre ella. Cuarto
 * inquilino de `hooks/` (`useNotificationSound.ts`, `useFollowScroll.ts`,
 * `useKeyboardShortcuts.ts`).
 *
 * ## "No existe" no se confunde con "todavía no cargó"
 *
 * El chequeo de si `noteId` está en `state.notes` recién corre cuando
 * `connectionStatus === 'connected'` -esa transición, en `realtime/socket.ts`, pasa
 * ÚNICAMENTE tras procesar `room.snapshot` (`setStatus('connected')` vive adentro
 * del `if (isSnapshot)`, nunca antes), así que es la señal exacta de "ya sé todo lo
 * que hay que saber sobre esta sala" -no un timeout ni una aproximación-. Sin esto,
 * alguien que abre el link y todavía está conectando vería el aviso de "no existe"
 * un instante antes de que la nota apareciera.
 *
 * Si a esa altura la nota no está, el fallo NO es silencioso -a diferencia de
 * resaltar a alguien desconectado, acá quien mira no hizo ningún click: no tiene
 * forma de distinguir "el link estaba roto" de "la app se colgó" sin un aviso-.
 * `noteNotFound` se apaga solo, pasado `NOTICE_DURATION_MS`.
 *
 * ## Se apaga solo, y cede ante el primer filtro manual
 *
 * No es un filtro persistente como buscar/resaltar -es un salto de una sola vez al
 * entrar-, así que el resaltado se apaga solo pasado `HIGHLIGHT_DURATION_MS› (mismo
 * criterio que el pulso de "aterrizaje" en `Note.tsx`, `LANDING_ANIMATION_MS`: una
 * duración fija, no un estado que alguien tenga que apagar a mano). También cede si
 * la persona mirando la pantalla arranca a buscar o resalta a alguien -mismo
 * criterio que "seguir a una persona" cediendo ante el primer scroll manual: lo
 * automático se corre apenas hay una acción deliberada.
 *
 * La URL NO se limpia -a propósito, ver CLAUDE.md-: es el enlace que alguien acaba
 * de mandar, borrarlo de la barra de direcciones se lo saca de encima antes de que
 * lo pueda copiar o guardar. Recargar la página más tarde vuelve a llevar a la misma
 * nota; es lo que se espera de cualquier enlace, no un efecto pegajoso.
 */

import { useEffect, useRef, useState } from 'react'
import { useRoom } from '../app/RoomStoreContext'

const HIGHLIGHT_DURATION_MS = 4000
const NOTICE_DURATION_MS = 5000

export function useLinkedNote(
  noteId: string | null,
  searchQuery: string,
  highlightedParticipantId: string | null,
): { linkedNoteId: string | null; noteNotFound: boolean } {
  const connected = useRoom((s) => s.connectionStatus === 'connected')
  const noteExists = useRoom((s) => noteId !== null && s.notes[noteId] !== undefined)
  const [linkedNoteId, setLinkedNoteId] = useState<string | null>(null)
  const [noteNotFound, setNoteNotFound] = useState(false)
  const triggeredRef = useRef(false)

  useEffect(() => {
    if (noteId === null || !connected || triggeredRef.current) return
    triggeredRef.current = true

    if (!noteExists) {
      // No es estado derivable en el render: dispara una vez, cuando `connected`
      // pasa a `true` -no en cada render- y arranca un timer real (mismo patrón
      // ya aceptado en `RoomPage.tsx` para `setStore`, ver el comentario ahí).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNoteNotFound(true)
      const timer = setTimeout(() => setNoteNotFound(false), NOTICE_DURATION_MS)
      return () => clearTimeout(timer)
    }

    setLinkedNoteId(noteId)
    try {
      document
        .querySelector(`[data-note-id="${noteId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    } catch {
      // Selector inválido por lo que sea (un id con forma rara colado en la URL):
      // sin scroll, no rompe nada más -el resaltado ya se puso arriba.
    }
    const timer = setTimeout(() => setLinkedNoteId(null), HIGHLIGHT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [noteId, connected, noteExists])

  // El primer filtro manual gana: mismo criterio que "seguir a una persona"
  // cediendo ante el primer scroll manual (`useFollowScroll.ts`). Ajustado
  // durante el render, no en un efecto -mismo patrón que `lastSyncedText` en
  // `NoteDetail.tsx`: es estado que SÍ se puede derivar de otro estado ya
  // presente (`searchQuery`, `highlightedParticipantId`), a diferencia del
  // disparo de arriba, que depende de un timer real.
  if (linkedNoteId !== null && (searchQuery.trim() !== '' || highlightedParticipantId !== null)) {
    setLinkedNoteId(null)
  }

  return { linkedNoteId, noteNotFound }
}
