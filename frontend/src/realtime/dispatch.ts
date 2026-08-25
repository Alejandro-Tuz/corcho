/**
 * Evento entrante -> store. Lo que `handlers.py` es a `services/` en el backend:
 * despacha por `event.type`, no implementa nada -cada rama es una sola llamada a
 * `RoomApplyActions`, la lógica de qué significa cada evento vive en `roomStore.ts`.
 *
 * Importa el tipo `RoomApplyActions` de `store/types.ts` en vez de que `store/`
 * importe de acá: `roomStore.ts` sí importa `dispatch` (la función, para conectarla a
 * `socket.onEvent`), así que si este módulo importara algo de `roomStore.ts` sería un
 * ciclo. `store/types.ts` no importa ni de acá ni de `roomStore.ts`, así que no hay tal
 * problema.
 *
 * `pong` nunca llega hasta acá: `socket.ts` ya lo consume para resolver el heartbeat,
 * y `ServerEvent` (protocol.ts) ni siquiera modela un `ping` entrante -el servidor
 * nunca inicia uno-. El `case 'pong'` de abajo es solo para que el `switch` sea
 * exhaustivo sin un `default` que esconda un tipo de evento nuevo sin manejar.
 */

import type { ServerEvent } from './protocol'
import type { RoomApplyActions } from '../store/types'

export function dispatch(event: ServerEvent, actions: RoomApplyActions): void {
  switch (event.type) {
    case 'room.snapshot':
      actions.applyRoomSnapshot(event)
      return
    case 'presence.joined':
      actions.applyPresenceJoined(event)
      return
    case 'presence.left':
      actions.applyPresenceLeft(event)
      return
    case 'note.create':
      actions.applyNoteCreate(event)
      return
    case 'note.update':
      actions.applyNoteUpdate(event)
      return
    case 'note.move':
      actions.applyNoteMove(event)
      return
    case 'note.delete':
      actions.applyNoteDelete(event)
      return
    case 'note.claim':
      actions.applyNoteClaim(event)
      return
    case 'note.claim_rejected':
      actions.applyNoteClaimRejected(event)
      return
    case 'note.release':
      actions.applyNoteRelease(event)
      return
    case 'note.release_rejected':
      actions.applyNoteReleaseRejected(event)
      return
    case 'reaction.toggle':
      actions.applyReactionToggle(event)
      return
    case 'chat.message':
      actions.applyChatMessage(event)
      return
    case 'room.background':
      actions.applyRoomBackground(event)
      return
    case 'error':
      actions.applyError(event)
      return
    case 'presence.cursor':
      actions.applyPresenceCursor(event)
      return
    case 'presence.dragging':
      actions.applyPresenceDragging(event)
      return
    case 'presence.drafting':
      actions.applyPresenceDrafting(event)
      return
    case 'chat.typing':
      actions.applyChatTyping(event)
      return
    case 'room.summary_requested':
      actions.applyRoomSummaryRequested(event)
      return
    case 'room.summary':
      actions.applyRoomSummary(event)
      return
    case 'room.summary_rejected':
      actions.applyRoomSummaryRejected(event)
      return
    case 'pong':
      return // ver docstring del módulo: no debería llegar acá, pero no rompe nada
    default: {
      const _exhaustive: never = event
      void _exhaustive
    }
  }
}
