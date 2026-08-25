/**
 * Panel de chat lateral (CLAUDE.md, "Comprometido, pendiente" #4: último ítem
 * grande de lo comprometido). Empuja el lienzo, no lo tapa -mismo principio que ya
 * rige buscar/resaltar ("atenuar, no ocultar"): tapar notas justo mientras se
 * charla sobre ellas sería peor-. Colapsado por defecto: una tira angosta pegada
 * al borde (`Canvas.css`, `.room-layout`/`.chat-panel`, `position: sticky` para
 * seguir fija en pantalla en un tablero mucho más alto que la ventana), que crece
 * al panel completo al abrir. El backend (`services/chat.py`, los eventos de
 * `protocol.py`, `chat_messages` en `room.snapshot`) ya existía entero: esto es
 * solo frontend.
 *
 * `ChatContext.ts` (abierto/cerrado, filtro por tarea, "watching") vive un nivel
 * arriba, en `Canvas.tsx` -ver el docstring de ese contexto para el porqué de un
 * archivo propio en vez de sumarlo a `CanvasFocusContext`.
 *
 * ## Autoscroll y no leídos, la misma señal
 *
 * `hooks/useStickyScroll.ts` calcula `isAtBottom` sobre la lista YA FILTRADA (lo
 * que de verdad se está mirando). `watching = open && isAtBottom` se publica a
 * `ChatContext` para que `useNotificationSound.ts` -un componente hermano, no
 * descendiente- sepa si silenciar un `chat.message` ajeno. El contador de no
 * leídos es GLOBAL (sobre `chatMessages` sin filtrar, decisión tomada
 * explícitamente para no perseguir un contador por cada nota filtrada) y se
 * resetea cuando `watching` es `true` -abrir el panel sin llegar al fondo no
 * alcanza-, más una vez extra en la transición a `connected`: `room.snapshot`
 * llega ANTES que esa transición (orden ya garantizado, lo usa
 * `hooks/useLinkedNote.ts`), así que sin este segundo reset los hasta 200
 * mensajes de historial se contarían como "no leídos" en cada reconexión.
 *
 * ## `chat.typing`: capa 2 de 2
 *
 * La capa 1 (quien escribe: idle-timeout, refresco throttled) vive en
 * `ChatComposer` acá abajo. Esta pantalla solo LEE `state.presence.typing` -la
 * capa 2 (red de seguridad si la capa 1 nunca llega a mandar el `false`) vive en
 * `store/roomStore.ts`, `applyChatTyping`-. La línea de "está escribiendo" se
 * filtra por `filterNoteId`: alguien escribiendo en otra nota no debería aparecer
 * mientras se mira el hilo de una nota puntual (`filterNoteId === null` -> se
 * ignora el filtro, se muestra cualquiera).
 *
 * ## Etiqueta de nota y el caso de `note_id` no nulo apuntando a una nota borrada
 *
 * `note_id === null` no se puede distinguir entre "nunca tuvo nota" y "la tenía,
 * se borró antes de llegar" (`services/chat.py` ya lo hace así a propósito, `ON
 * DELETE SET NULL`): en los dos casos, sin etiqueta, es la lectura correcta de un
 * campo que efectivamente es `null` ahora. Caso distinto y más chico: un mensaje
 * con `note_id` NO nulo cuya nota se borró DESPUÉS de que este cliente ya lo tenía
 * en `chatMessages` -`note.delete` no reemite los mensajes que la perdieron, así
 * que la copia local queda con el id viejo hasta la próxima reconexión-. Ahí la
 * búsqueda en `state.notes` falla y se muestra "una nota borrada" en vez de un
 * chip roto o silencioso. Hueco conocido, documentado con el mismo nivel que la
 * limitación de `move_note` en CLAUDE.md: se autocorrige solo con el próximo
 * `room.snapshot`, no vale la pena blindarlo más.
 *
 * ## Pulido visual: dirección aprobada sobre un mockup de tres mensajes antes de
 * aplicarla acá (mismo criterio que el post-it, día 3)
 *
 * Cuatro cambios, ninguno inventa paleta nueva: alineación + fondo con tinte cork
 * para distinguir un mensaje propio de uno ajeno; el nombre en
 * `PARTICIPANT_COLOR_HEX[author.color]` -mismo color que ya tiene el cursor y el
 * pin de sus notas, gratis-; un avatar chico (`AVATAR_EMOJI`, técnica de
 * `.note-pin-head`/`.note-pin-icon`: círculo de color de participante, ícono en
 * escala de grises, nunca una silueta blanca pura); y una forma de burbuja que se
 * lea "de la misma familia" que el post-it -radio bajo, esquina doblada plana,
 * misma doble sombra suave que `.note-card`- en vez de texto suelto sobre el
 * fondo. La etiqueta "en: nota" y la hora en monoespaciada no se tocaron -ya
 * estaban bien resueltas.
 *
 * ## Avatar atenuado si el autor está desconectado, según el estado ACTUAL -a
 * propósito, no un efecto colateral
 *
 * `chat-message-avatar--offline` se decide contra
 * `state.participants[author_id].disconnected_at` en el momento del RENDER, no
 * contra una foto de si esa persona estaba conectada cuando mandó el mensaje. El
 * chat es historial, no presencia: si atenuara según una foto congelada al
 * enviar, un mensaje que se está leyendo ahora nunca reflejaría que quien lo
 * escribió ya se fue. Decisión de producto tomada a conciencia, pedida así
 * explícitamente: un mensaje viejo SÍ se atenúa de golpe en cuanto su autor se
 * desconecta, mientras se lo está mirando -es información útil ("¿tiene sentido
 * esperar respuesta?"), no un defecto a esconder. Mismo tratamiento que ya usa
 * `ParticipantList.tsx` para lo mismo (`opacity: 0.4`), no uno nuevo -y acotado
 * SOLO al avatar: ni el nombre (que sigue con su color de participante) ni el
 * texto se atenúan, es un dato secundario que no puede competir con el mensaje ni
 * con la identidad de quien lo escribió.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRoom, useRoomActions } from '../../app/RoomStoreContext'
import { useStickyScroll } from '../../hooks/useStickyScroll'
import { AVATAR_EMOJI } from '../../lib/avatarEmoji'
import { noteTitle } from '../../lib/checklist'
import { CHAT_TEXT_MAX_LENGTH } from '../../lib/constants'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import { formatClockTime } from '../../lib/time'
import { throttle } from '../../realtime/throttle'
import type { Avatar, ChatMessageState, ParticipantColor } from '../../realtime/protocol'
import { distinctChatNoteIds } from '../../store/selectors'
import { useChatFocus } from './ChatContext'
import './ChatPanel.css'

const TYPING_IDLE_MS = 4000
const TYPING_REFRESH_INTERVAL_MS = 3000

function typingLabel(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} está escribiendo…`
  if (names.length === 2) return `${names[0]} y ${names[1]} están escribiendo…`
  return 'Varias personas están escribiendo…'
}

export function ChatPanel() {
  const { open, toggleOpen, filterNoteId, setFilterNoteId, setWatching } = useChatFocus()
  const chatMessages = useRoom((s) => s.chatMessages)
  const notes = useRoom((s) => s.notes)
  const participants = useRoom((s) => s.participants)
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)
  const connectionStatus = useRoom((s) => s.connectionStatus)
  const typingByParticipant = useRoom((s) => s.presence.typing)
  const noteIds = useRoom((s) => distinctChatNoteIds(s.chatMessages))

  const filteredMessages = useMemo(
    () => (filterNoteId === null ? chatMessages : chatMessages.filter((m) => m.note_id === filterNoteId)),
    [chatMessages, filterNoteId],
  )

  const { containerRef, isAtBottom, scrollToBottom, stickNextScroll } = useStickyScroll<HTMLDivElement>(
    filteredMessages.length,
  )

  const watching = open && isAtBottom
  useEffect(() => {
    setWatching(watching)
  }, [watching, setWatching])

  // Al abrir, no queda ninguna posición previa que preservar -estaba oculto-, así
  // que arranca en el fondo siempre.
  useEffect(() => {
    if (open) scrollToBottom()
  }, [open, scrollToBottom])

  // Ajustado durante el render, no en un efecto -mismo patrón que `prevStatus`/
  // `justLanded` en Note.tsx para "sincronizar estado cuando algo cambió": React
  // vuelve a renderizar antes de pintar, sin el render en cascada de un `setState`
  // dentro de `useEffect` (y sin que ESLint lo marque -`react-hooks/set-state-in-
  // effect`- por buena razón, acá si aplicaría).
  //
  // Dos disparadores para el mismo reset, cada uno cubre lo que el otro no:
  // `watching` (panel abierto y en el fondo -"esto se está viendo en vivo") y la
  // transición a `connected` (el snapshot ya trajo hasta 200 mensajes de historial
  // ANTES de esa transición -orden ya garantizado, lo usa `hooks/useLinkedNote.ts`-,
  // así que sin este segundo disparador esos 200 se contarían como "no leídos" en
  // cada reconexión, panel abierto o no).
  const [lastSeenCount, setLastSeenCount] = useState(chatMessages.length)
  if (watching && lastSeenCount !== chatMessages.length) {
    setLastSeenCount(chatMessages.length)
  }
  const [prevConnectionStatus, setPrevConnectionStatus] = useState(connectionStatus)
  if (connectionStatus !== prevConnectionStatus) {
    setPrevConnectionStatus(connectionStatus)
    if (connectionStatus === 'connected') setLastSeenCount(chatMessages.length)
  }
  const unreadCount = Math.max(0, chatMessages.length - lastSeenCount)

  const noteOptions = useMemo(
    () =>
      noteIds.map((id) => ({
        id,
        label: notes[id] !== undefined ? noteTitle(notes[id].text) : 'nota borrada',
      })),
    [noteIds, notes],
  )

  const typingNames = Object.entries(typingByParticipant)
    .filter(
      ([participantId, info]) =>
        participantId !== myParticipantId && (filterNoteId === null || info.noteId === filterNoteId),
    )
    .map(([participantId]) => participants[participantId]?.name ?? 'alguien')
  const typingText = typingLabel(typingNames)

  return (
    <div className={open ? 'chat-panel chat-panel--open' : 'chat-panel'}>
      <button
        type="button"
        className="chat-toggle-btn"
        onClick={toggleOpen}
        aria-expanded={open}
        title={open ? 'Cerrar chat' : 'Abrir chat'}
      >
        <ChatIcon />
        {!open && unreadCount > 0 && (
          <span className="chat-unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="chat-panel-body">
          <div className="chat-header">
            <span className="chat-header-title">Chat</span>
            {noteOptions.length > 0 && (
              <select
                className="chat-filter-select"
                value={filterNoteId ?? ''}
                onChange={(e) => setFilterNoteId(e.target.value === '' ? null : e.target.value)}
                aria-label="Filtrar mensajes por nota"
              >
                <option value="">Todos</option>
                {noteOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="chat-messages" ref={containerRef}>
            {filteredMessages.length === 0 ? (
              <p className="chat-empty">
                {filterNoteId === null ? 'Todavía no hay mensajes.' : 'Sin mensajes para esta nota.'}
              </p>
            ) : (
              filteredMessages.map((m) => {
                const author = participants[m.author_id]
                return (
                  <ChatMessageRow
                    key={m.id}
                    message={m}
                    isMine={m.author_id === myParticipantId}
                    authorName={author?.name ?? 'alguien'}
                    authorAvatar={author?.avatar ?? null}
                    authorColor={author?.color ?? null}
                    authorOffline={author !== undefined && author.disconnected_at !== null}
                    noteChipLabel={noteChipLabelFor(m, notes)}
                  />
                )
              })
            )}
          </div>

          {typingText !== null && <p className="chat-typing">{typingText}</p>}

          <ChatComposer filterNoteId={filterNoteId} stickNextScroll={stickNextScroll} />
        </div>
      )}
    </div>
  )
}

function noteChipLabelFor(
  message: ChatMessageState,
  notes: Record<string, { text: string } | undefined>,
): string | null {
  if (message.note_id === null) return null
  const note = notes[message.note_id]
  return note !== undefined ? noteTitle(note.text) : 'una nota borrada'
}

function ChatMessageRow({
  message,
  isMine,
  authorName,
  authorAvatar,
  authorColor,
  authorOffline,
  noteChipLabel,
}: {
  message: ChatMessageState
  isMine: boolean
  authorName: string
  authorAvatar: Avatar | null
  authorColor: ParticipantColor | null
  authorOffline: boolean
  noteChipLabel: string | null
}) {
  // Fallback gris (#999), no un color del catálogo: mismo criterio que
  // `pinColor` en Note.tsx para un autor que -no debería pasar, los
  // participantes nunca se borran (invariante 8)- no se encuentra en
  // `state.participants`.
  const color = authorColor !== null ? PARTICIPANT_COLOR_HEX[authorColor] : '#999'
  return (
    <div className={isMine ? 'chat-message chat-message--mine' : 'chat-message'}>
      <span
        className={
          authorOffline ? 'chat-message-avatar chat-message-avatar--offline' : 'chat-message-avatar'
        }
        style={{ background: color }}
      >
        <span className="chat-message-avatar-icon">
          {authorAvatar !== null ? AVATAR_EMOJI[authorAvatar] : '❔'}
        </span>
      </span>
      <div className="chat-message-bubble">
        <div className="chat-message-head">
          <span className="chat-message-author" style={{ color }}>
            {authorName}
          </span>
          <span className="chat-message-time">{formatClockTime(message.created_at)}</span>
        </div>
        <p className="chat-message-text">{message.text}</p>
        {noteChipLabel !== null && <span className="chat-message-tag">en: {noteChipLabel}</span>}
      </div>
    </div>
  )
}

/**
 * Capa 1 de `chat.typing` (ver docstring del módulo para la capa 2). `active: true`
 * al pasar de "sin texto" a "con texto", refrescado -throttled, no en cada tecla-
 * mientras se sigue escribiendo de corrido, para que el backstop de 6s de
 * `roomStore.ts` nunca lo dé por perdido en medio de una oración larga. `active:
 * false` en tres momentos: se vacía el campo, se manda el mensaje, o pasan
 * `TYPING_IDLE_MS` sin una tecla más -esto último es la parte que el protocolo por
 * sí solo no cubre: alguien que deja de escribir sin borrar nada nunca dispara un
 * evento que lo diga, así que hace falta este timeout de inactividad para decirlo
 * en su nombre-.
 *
 * El efecto de limpieza de abajo cubre DOS casos con el mismo código, a propósito:
 * cambiar de nota filtrada a mitad de un tecleo (el cleanup de un efecto con
 * `[filterNoteId]` en las dependencias corre con la closure VIEJA, antes de que el
 * nuevo efecto se registre -exactamente "avisá que dejaste de escribir en la nota
 * anterior"-) y cerrar el panel (`Canvas.tsx` solo monta este componente con `open`,
 * así que cerrar desmonta, y el cleanup de ESE MISMO efecto corre igual).
 */
function ChatComposer({
  filterNoteId,
  stickNextScroll,
}: {
  filterNoteId: string | null
  stickNextScroll: () => void
}) {
  const actions = useRoomActions()
  const [text, setText] = useState('')
  const isTypingRef = useRef(false)
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const throttledSendTypingTrue = useMemo(
    () => throttle((noteId: string | null) => actions.sendTyping(noteId, true), TYPING_REFRESH_INTERVAL_MS),
    [actions],
  )

  function clearIdleTimer(): void {
    if (idleTimeoutRef.current !== null) {
      clearTimeout(idleTimeoutRef.current)
      idleTimeoutRef.current = null
    }
  }

  function stopTyping(): void {
    clearIdleTimer()
    throttledSendTypingTrue.cancel()
    if (isTypingRef.current) {
      isTypingRef.current = false
      actions.sendTyping(filterNoteId, false)
    }
  }

  function handleChange(value: string): void {
    setText(value)
    if (value.trim() === '') {
      stopTyping()
      return
    }
    if (!isTypingRef.current) {
      isTypingRef.current = true
      actions.sendTyping(filterNoteId, true)
    } else {
      throttledSendTypingTrue(filterNoteId)
    }
    clearIdleTimer()
    idleTimeoutRef.current = setTimeout(stopTyping, TYPING_IDLE_MS)
  }

  useEffect(() => {
    return () => {
      clearIdleTimer()
      throttledSendTypingTrue.cancel()
      if (isTypingRef.current) {
        isTypingRef.current = false
        actions.sendTyping(filterNoteId, false)
      }
    }
    // Ver docstring de ChatComposer: este cleanup corre tanto al cambiar
    // `filterNoteId` como al desmontar (panel cerrado), y en los dos casos es
    // exactamente lo que hace falta.
  }, [filterNoteId, actions, throttledSendTypingTrue])

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '') return
    stopTyping()
    stickNextScroll()
    actions.sendChatMessage(trimmed, filterNoteId)
    setText('')
  }

  return (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <input
        type="text"
        className="chat-composer-input"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        maxLength={CHAT_TEXT_MAX_LENGTH}
        placeholder={filterNoteId === null ? 'Mensaje a toda la sala…' : 'Mensaje sobre esta nota…'}
      />
      <button type="submit" className="btn btn-primary" disabled={text.trim() === ''}>
        enviar
      </button>
    </form>
  )
}

// SVG inline, no un glifo de fuente -mismo motivo que el resto de los íconos del
// proyecto (SpeakerIcon en Canvas.tsx, SparkleIcon en RoomSummaryButton.tsx).
function ChatIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H8l-4 3v-3H3a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}
