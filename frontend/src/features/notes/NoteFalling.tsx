/**
 * Snapshot puramente visual de una nota recién borrada: cae con una animación en
 * vez de desaparecer de golpe (pulido día 3, CLAUDE.md). Vive separado de
 * `Note.tsx` a propósito -sin drag, sin cupos, sin reacciones interactivas, nada
 * de sus hooks de arrastre: para cuando esto se dibuja la nota YA NO EXISTE en
 * `state.notes`, es pura decoración de salida, no hay ninguna acción que quepa
 * ofrecer sobre ella.
 *
 * `roomStore.ts` guarda esta foto en `state.fallingNotes[id]` en el momento en
 * que aplica `note.delete`, y la limpia sola con un timeout que coincide con la
 * duración de la animación `note-fall` (Note.css) -este componente no le avisa a
 * nadie cuándo terminó, ni falta que hace: cuando el store la limpia, `Column.tsx`
 * deja de renderizarlo, punto.
 */

import type { CSSProperties } from 'react'
import { useRoom } from '../../app/RoomStoreContext'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { NOTE_COLOR_HEX } from '../../lib/noteColor'
import { noteRotationDeg } from '../../lib/noteRotation'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import type { NoteState } from '../../realtime/protocol'
import './Note.css'

type NoteStyle = CSSProperties & { '--note-rot'?: string }

export function NoteFalling({ note }: { note: NoteState }) {
  const author = useRoom((s) => s.participants[note.author_id])
  const mark = author !== undefined ? AVATAR_EMOJI[author.avatar] : '❔'
  const pinColor = author !== undefined ? PARTICIPANT_COLOR_HEX[author.color] : '#999'

  const style: NoteStyle = {
    position: 'absolute',
    left: note.position_x,
    top: note.position_y,
    background: NOTE_COLOR_HEX[note.color],
    '--note-rot': `${String(noteRotationDeg(note.id))}deg`,
  }

  return (
    <div className="note-card note-card--falling" style={style} aria-hidden>
      <div className="note-pin">
        <span className="note-pin-shadow" />
        <span className="note-pin-head" style={{ background: pinColor }}>
          <span className="note-pin-icon">{mark}</span>
        </span>
      </div>
      <span className="note-author">{author?.name ?? ''}</span>
      <div className="note-text">{note.text}</div>
    </div>
  )
}
