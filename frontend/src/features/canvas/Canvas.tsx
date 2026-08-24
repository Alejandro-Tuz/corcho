/**
 * El lienzo: tres columnas fijas (bloque 3) + fondo de la sala + los cursores de los
 * demás. Toda nota nueva arranca en la primera columna (`status: 'blocked'`); de ahí
 * en más, `Note.tsx` decide a qué columna se mueve según dónde se suelta el
 * arrastre -ver su docstring, es donde vive la parte interesante de columnas.
 *
 * Creación por `NoteComposer` (pulido día 3): reemplaza los `window.prompt()` del
 * día 2, que eran la interacción más fea posible a propósito ("funcionalidad
 * primero, diseño después", CLAUDE.md).
 *
 * El cursor propio se manda desde acá (`onPointerMove` sobre el lienzo entero, no
 * por nota ni por columna) porque `presence.cursor` viaja en coordenadas del lienzo
 * completo, no de una columna -no hace falta esa precisión para un cursor-.
 * `data-canvas-root` es el mismo gancho que usa `Note.tsx` para convertir la posición
 * de un fantasma ajeno a la pantalla de quien mira.
 *
 * El botón de silencio de la toolbar es la única parte visible del sonido de
 * notificación acá -toda la lógica de cuándo sonar vive en
 * `hooks/useNotificationSound.ts`, este componente solo llama al hook y pinta el
 * ícono que corresponda.
 *
 * Dueño de `CanvasFocusContext` (buscar + resaltar-a-una-persona + seguir): arma los
 * `useState` y provee el valor -ver el docstring de ese módulo para el porqué de
 * que viva separado de `RoomStoreContext`, cómo se combinan buscar/resaltar, y por
 * qué seguir es un control aparte de resaltar en vez del mismo click. El contador
 * junto al campo de búsqueda ("3/8", o "sin coincidencias" en 0) usa la misma
 * `noteMatchesSearch` que `Note.tsx` para decidir su propia atenuación -un solo
 * lugar que sabe qué es "matchear", no dos copias de ese criterio. El scroll de
 * seguir en sí vive en `hooks/useFollowScroll.ts`, invocado acá porque este
 * componente ya tiene `followedParticipantId` a mano.
 *
 * Atajos de teclado (`hooks/useKeyboardShortcuts.ts`, ahí el porqué completo de
 * cada decisión) por el mismo motivo: `composerOpen`/`searchQuery` ya viven acá.
 * El hook devuelve el `ref` del campo de búsqueda -lo necesita tanto para
 * enfocarlo (`/`) como para saber si Esc lo debe vaciar.
 *
 * Exportar a markdown (`store/exportMarkdown.ts` arma el string, `lib/downloadFile.ts`
 * dispara la descarga): un botón más de la toolbar, sin estado propio -no hay nada
 * que recordar entre un export y el siguiente.
 *
 * `noteId` (enlace directo a una nota, `App.tsx` -> `RoomPage.tsx`) va directo a
 * `hooks/useLinkedNote.ts`, que decide si existe, resalta y centra la vista -acá
 * solo se pinta el aviso de "no existe" cuando el hook lo pide.
 */

import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { useFollowScroll } from '../../hooks/useFollowScroll'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useLinkedNote } from '../../hooks/useLinkedNote'
import { useNotificationSound } from '../../hooks/useNotificationSound'
import { throttle } from '../../realtime/throttle'
import { BACKGROUNDS } from '../../lib/constants'
import { downloadTextFile } from '../../lib/downloadFile'
import { roomToMarkdown } from '../../store/exportMarkdown'
import { noteMatchesSearch } from '../../store/selectors'
import { Activity } from '../activity/Activity'
import { NoteComposer } from '../notes/NoteComposer'
import { ParticipantList } from '../presence/ParticipantList'
import { RemoteCursors } from '../presence/RemoteCursors'
import { BACKGROUND_COLORS } from './backgroundColor'
import { CanvasFocusContext } from './CanvasFocusContext'
import { Column } from './Column'
import { COLUMNS } from './columns'
import type { ConnectionStatus } from '../../realtime/socket'
import './Canvas.css'

const CURSOR_BROADCAST_INTERVAL_MS = 50

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'conectando',
  connected: 'conectado',
  reconnecting: 'reconectando',
  room_not_found: 'sala inexistente',
}

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'canvas-status--connecting',
  connected: 'canvas-status--connected',
  reconnecting: 'canvas-status--connecting',
  room_not_found: 'canvas-status--down',
}

export function Canvas({ noteId }: { noteId: string | null }) {
  const connectionStatus = useRoom((s) => s.connectionStatus)
  const background = useRoom((s) => s.background)
  const notes = useRoom((s) => s.notes)
  const slug = useRoom((s) => s.slug)
  const roomName = useRoom((s) => s.name)
  const participants = useRoom((s) => s.participants)
  const actions = useRoomActions()
  const { muted, toggleMuted } = useNotificationSound()

  const [composerOpen, setComposerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedParticipantId, setHighlightedParticipantId] = useState<string | null>(null)
  const [followedParticipantId, setFollowedParticipantId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const throttledSendCursor = useMemo(
    () => throttle(actions.sendCursor, CURSOR_BROADCAST_INTERVAL_MS),
    [actions],
  )

  function toggleHighlight(participantId: string): void {
    setHighlightedParticipantId((current) => (current === participantId ? null : participantId))
  }

  function toggleFollow(participantId: string): void {
    setFollowedParticipantId((current) => (current === participantId ? null : participantId))
  }

  useFollowScroll(followedParticipantId, () => setFollowedParticipantId(null))
  const searchInputRef = useKeyboardShortcuts({
    onNewNote: () => setComposerOpen(true),
    searchQuery,
    onClearSearch: () => setSearchQuery(''),
  })
  const { linkedNoteId, noteNotFound } = useLinkedNote(
    noteId,
    searchQuery,
    highlightedParticipantId,
  )

  if (connectionStatus === 'room_not_found') {
    return (
      <div className="canvas-empty">
        <p>Esta sala no existe.</p>
      </div>
    )
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    throttledSendCursor(e.clientX - rect.left, e.clientY - rect.top)
  }

  function handleExport(): void {
    const markdown = roomToMarkdown({ slug, name: roomName, notes, participants })
    const datePart = new Date().toISOString().slice(0, 10)
    downloadTextFile(`corcho-${slug ?? 'sala'}-${datePart}.md`, markdown, 'text/markdown;charset=utf-8')
  }

  const noteList = Object.values(notes)
  const matchingNoteCount =
    searchQuery.trim() === ''
      ? noteList.length
      : noteList.filter((n) => noteMatchesSearch(n, searchQuery)).length

  return (
    <CanvasFocusContext.Provider
      value={{
        searchQuery,
        setSearchQuery,
        highlightedParticipantId,
        toggleHighlight,
        followedParticipantId,
        toggleFollow,
        linkedNoteId,
      }}
    >
      <div>
        <div className="canvas-toolbar">
          <span className="canvas-brand">Corcho</span>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setComposerOpen(true)}
            title="Nota nueva (N)"
          >
            + nota
          </button>

          <button
            type="button"
            className="btn"
            onClick={handleExport}
            title="Descargar el tablero como markdown"
          >
            exportar
          </button>

          <div className="canvas-bg-picker">
            <span className="canvas-bg-label">fondo</span>
            {BACKGROUNDS.map((bg) => (
              <button
                key={bg}
                type="button"
                title={bg}
                aria-pressed={bg === background}
                className={bg === background ? 'canvas-bg-swatch canvas-bg-swatch--active' : 'canvas-bg-swatch'}
                onClick={() => actions.setBackground(bg)}
                style={{ background: BACKGROUND_COLORS[bg] }}
              />
            ))}
          </div>

          <ParticipantList />

          <div className="canvas-search">
            <input
              ref={searchInputRef}
              type="search"
              className="canvas-search-input"
              placeholder="Buscar… ( / )"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery.trim() !== '' && (
              <span
                className={
                  matchingNoteCount === 0
                    ? 'canvas-search-count canvas-search-count--empty'
                    : 'canvas-search-count'
                }
              >
                {matchingNoteCount === 0 ? 'sin coincidencias' : `${matchingNoteCount}/${noteList.length}`}
              </span>
            )}
          </div>

          <span className={`canvas-status ${STATUS_CLASS[connectionStatus]}`}>
            {STATUS_LABEL[connectionStatus]}
          </span>

          <button
            type="button"
            className="canvas-mute-btn"
            onClick={toggleMuted}
            aria-pressed={muted}
            aria-label={muted ? 'Activar sonido de notificaciones' : 'Silenciar notificaciones'}
            title={muted ? 'Activar sonido de notificaciones' : 'Silenciar notificaciones'}
          >
            {muted ? <MutedIcon /> : <SpeakerIcon />}
          </button>
        </div>

        {noteNotFound && (
          <div className="canvas-note-notice">
            La nota de ese enlace ya no existe -se borró, o el link no es válido.
          </div>
        )}

        <Activity />

        <div
          ref={canvasRef}
          data-canvas-root
          onPointerMove={handlePointerMove}
          className="canvas-board"
          style={{ background: BACKGROUND_COLORS[background] }}
        >
          {COLUMNS.map((col) => (
            <Column key={col.status} status={col.status} label={col.label} />
          ))}
          <RemoteCursors />
        </div>

        <NoteComposer
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          onCreate={(input) =>
            actions.createNote({
              kind: input.kind,
              status: 'blocked',
              text: input.text,
              color: input.color,
              positionX: randomOffset(),
              positionY: randomOffset(),
              capacity: input.capacity,
            })
          }
        />
      </div>
    </CanvasFocusContext.Provider>
  )
}

function randomOffset(): number {
  return 20 + Math.random() * 150
}

// SVG inline, no un glifo de fuente -mismo motivo que ExpandIcon/CheckIcon en
// Note.tsx: un carácter como "🔇"/"🔊" corre el mismo riesgo de tofu en algunas
// plataformas que ya corren los emoji de avatar, evitable a mano sin costo.
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M3 8v4h3l4 3V5L6 8H3z" fill="currentColor" />
      <path
        d="M13.5 7a4 4 0 0 1 0 6M15.7 5a7 7 0 0 1 0 10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MutedIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M3 8v4h3l4 3V5L6 8H3z" fill="currentColor" />
      <path d="M13 7l5 5M18 7l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
