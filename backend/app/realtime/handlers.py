"""Despacho: tipo de mensaje -> servicio -> evento del protocolo (invariante 2).

`dispatch()` es lo único que `realtime/endpoint.py` llama por cada mensaje posterior a
`room.join`. Acá se traduce el `Outcome` tipado de cada servicio a los eventos de
`protocol.py`, incluido decidir a quién van: las respuestas solo-para-quien-lo-pidió
(un rechazo de cupo, un error, la confirmación de un ping) se mandan de inmediato con
`manager.send_to_socket()` -no persistieron nada, no hay motivo para esperar-; lo que
le importa a toda la sala se **devuelve**, no se manda acá.

Ese devolver en vez de mandar es a propósito, y corrige un bug real: antes,
`dispatch()` recibía el `broker` y llamaba `broker.publish()` él mismo, lo que
significaba que el `session.commit()` de `endpoint.py` -que viene después, en el
caller- esperaba a que el broadcast completo terminara (entrega local a todos los
sockets de la sala + publish a Redis) antes de soltar la fila que acababa de escribir.
Un socket lento o medio muerto en esa sala podía dejar el commit -y con él, el lock de
Postgres- colgado mucho más de lo que la escritura en sí necesitaba: cualquier otra
persona reclamando el mismo cupo se quedaba esperando ese lock, no una demora de
milisegundos sino de lo que tardara ese socket en fallar. Devolviendo el evento a
difundir (o `None`) y dejando que `endpoint.py` llame a `broker.publish()` recién
después de `session.commit()`, el commit nunca espera a un socket ajeno. `handlers.py`
ya no importa `RedisBroker` en absoluto -no lo necesita para nada más.

Sin lógica de negocio acá: cada rama es servicio -> if/else sobre el outcome -> evento.
La única lógica propia de este módulo es esa traducción, y el aviso de mejor esfuerzo de
`dispatch()` cuando algo revienta a mitad de camino (ver su docstring).
"""

import contextlib
import uuid

from fastapi import WebSocket
from sqlalchemy.orm import Session

from app.realtime.manager import ConnectionManager
from app.realtime.protocol import (
    ChatMessageIn,
    ChatMessageOut,
    ChatTypingIn,
    ChatTypingOut,
    ClientEvent,
    ErrorEvent,
    NoteClaimIn,
    NoteClaimOut,
    NoteClaimRejected,
    NoteCreateIn,
    NoteCreateOut,
    NoteDeleteIn,
    NoteDeleteOut,
    NoteMoveIn,
    NoteMoveOut,
    NoteReleaseIn,
    NoteReleaseOut,
    NoteReleaseRejected,
    NoteUpdateIn,
    NoteUpdateOut,
    Ping,
    Pong,
    PresenceCursorIn,
    PresenceCursorOut,
    PresenceDraftingIn,
    PresenceDraftingOut,
    PresenceDraggingIn,
    PresenceDraggingOut,
    ReactionToggleIn,
    ReactionToggleOut,
    RoomBackgroundIn,
    RoomBackgroundOut,
    RoomJoinIn,
    ServerEvent,
)
from app.services import chat, claims, notes, rooms
from app.services.claims import ClaimOutcome, ReleaseOutcome
from app.services.notes import NoteOutcome, ReactionOutcome
from app.services.rooms import BackgroundOutcome


def _note_id_of(event: ClientEvent) -> uuid.UUID | None:
    """Mejor esfuerzo para poblar `ErrorEvent.note_id` cuando una excepción
    inesperada -no uno de los `Outcome` ya contemplados- interrumpe el manejo de un
    evento sobre una nota puntual. `None` para lo que no es sobre una nota (chat,
    fondo, presencia): ahí no hay nada que reconciliar por `note_id`, y esos casos
    quedan en manos del timeout de reconciliación que le toca al cliente (ver
    docstring de `dispatch()`)."""
    match event:
        case NoteCreateIn() | NoteUpdateIn() | NoteMoveIn() | NoteDeleteIn():
            return event.id
        case NoteClaimIn() | NoteReleaseIn() | ReactionToggleIn():
            return event.note_id
        case _:
            return None


async def dispatch(
    session: Session,
    room: str,
    participant_id: uuid.UUID,
    event: ClientEvent,
    websocket: WebSocket,
    manager: ConnectionManager,
) -> ServerEvent | None:
    """Único punto de entrada desde `endpoint.py` para todo mensaje posterior a
    `room.join`. Devuelve el evento a difundir a la sala si corresponde -el caller
    (`endpoint.py`) es quien decide cuándo publicarlo, después de `session.commit()`,
    ver el docstring del módulo-, o `None` si esta acción no le importa a nadie más
    que a quien la pidió (un rechazo, un error, un `pong`) o no cambió nada
    (`ClaimOutcome.ALREADY_HELD`).

    Si algo inesperado revienta a mitad de camino -un bug de servicio, una restricción
    de Postgres no prevista, cualquier cosa que no sea uno de los `Outcome` ya
    traducidos más abajo-, no puede quedar en silencio total: el estado optimista del
    cliente para esa nota ya está pintado con el valor provisorio, y sin una
    confirmación (positiva o de rechazo) se queda así para siempre, que es peor que el
    equivalente en una API REST normal. Por eso, antes de dejar que la excepción siga
    subiendo, se le manda al socket que la disparó un `error` de mejor esfuerzo
    reutilizando el código `invalid_message` que ya existe en el protocolo -no hace
    falta uno nuevo: al cliente ya le alcanza con "esto que mandaste no se procesó,
    revertí tu vista optimista", no con distinguir la causa exacta-, con `note_id`
    cuando el evento era sobre una nota (la gran mayoría de la superficie: crear,
    editar, mover, borrar, cupos, reacciones). Para lo que no tiene `note_id` -chat,
    fondo de sala- no hay campo con el que correlacionar en el protocolo actual sin
    tocarlo, así que ahí no se manda nada puntual: la red de seguridad es un timeout de
    reconciliación en el cliente (si una entrada optimista no recibe su eco en N
    segundos, se revierte igual, con o sin `error` explícito) -pendiente del lado del
    frontend, no de este commit-.

    El envío del error es de mejor esfuerzo (`contextlib.suppress`): si el socket ya
    está muerto, no hay a quién avisarle, y no vale la pena que ese segundo fallo tape
    el primero. `endpoint.py` sigue siendo quien decide el rollback de la sesión y
    logea -acá no se atrapa nada para esconderlo, siempre se relanza."""
    try:
        return await _dispatch(session, room, participant_id, event, websocket, manager)
    except Exception:
        note_id = _note_id_of(event)
        if note_id is not None:
            with contextlib.suppress(Exception):
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(
                        code="invalid_message",
                        message="no se pudo procesar la acción, probá de nuevo",
                        note_id=note_id,
                    ),
                )
        raise


async def _dispatch(
    session: Session,
    room: str,
    participant_id: uuid.UUID,
    event: ClientEvent,
    websocket: WebSocket,
    manager: ConnectionManager,
) -> ServerEvent | None:
    match event:
        case RoomJoinIn():
            # La identidad de la conexión se establece una única vez, con el primer
            # mensaje (ver endpoint.py). Un segundo room.join en el mismo socket no
            # tiene nada que hacer: no está soportado, y no es una carrera esperable
            # como los cupos -no cae en un rechazo tipado propio-.
            await manager.send_to_socket(
                websocket,
                ErrorEvent(code="invalid_message", message="ya estás conectado a esta sala"),
            )
            return None

        case NoteCreateIn():
            note = notes.create_note(
                session,
                room,
                participant_id,
                id=event.id,
                kind=event.kind,
                status=event.status,
                text=event.text,
                color=event.color,
                position_x=event.position_x,
                position_y=event.position_y,
                capacity=event.capacity,
            )
            return NoteCreateOut(**note.model_dump())

        case NoteUpdateIn():
            result = notes.update_note(
                session, event.id, participant_id, text=event.text, color=event.color
            )
            if result.outcome is NoteOutcome.NOT_FOUND:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(code="not_found", message="la nota no existe", note_id=event.id),
                )
                return None
            if result.outcome is NoteOutcome.FORBIDDEN:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(
                        code="forbidden", message="no sos el autor de esta nota", note_id=event.id
                    ),
                )
                return None
            return NoteUpdateOut(
                id=event.id, text=result.text, color=result.color, updated_at=result.updated_at
            )

        case NoteMoveIn():
            result = notes.move_note(
                session,
                event.id,
                participant_id,
                position_x=event.position_x,
                position_y=event.position_y,
                status=event.status,
            )
            if result.outcome is NoteOutcome.NOT_FOUND:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(code="not_found", message="la nota no existe", note_id=event.id),
                )
                return None
            if result.outcome is NoteOutcome.FORBIDDEN:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(
                        code="forbidden", message="no sos el autor de esta nota", note_id=event.id
                    ),
                )
                return None
            return NoteMoveOut(
                id=event.id,
                position_x=result.position_x,
                position_y=result.position_y,
                status=result.status,
            )

        case NoteDeleteIn():
            outcome = notes.delete_note(session, event.id, participant_id)
            if outcome is NoteOutcome.NOT_FOUND:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(code="not_found", message="la nota no existe", note_id=event.id),
                )
                return None
            if outcome is NoteOutcome.FORBIDDEN:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(
                        code="forbidden", message="no sos el autor de esta nota", note_id=event.id
                    ),
                )
                return None
            return NoteDeleteOut(id=event.id)

        case NoteClaimIn():
            result = claims.take(session, event.note_id, participant_id)
            match result.outcome:
                case ClaimOutcome.NOT_FOUND:
                    await manager.send_to_socket(
                        websocket,
                        ErrorEvent(
                            code="not_found", message="la nota no existe", note_id=event.note_id
                        ),
                    )
                    return None
                case ClaimOutcome.FULL:
                    await manager.send_to_socket(
                        websocket,
                        NoteClaimRejected(
                            note_id=event.note_id, participant_id=participant_id, reason="full"
                        ),
                    )
                    return None
                case ClaimOutcome.ALREADY_HELD:
                    return None  # idempotente: nadie tomó nada nuevo, nada que difundir
                case ClaimOutcome.TAKEN:
                    return NoteClaimOut(
                        note_id=event.note_id,
                        participant_id=participant_id,
                        taken_count=result.taken_count,
                    )

        case NoteReleaseIn():
            result = claims.release(session, event.note_id, participant_id)
            match result.outcome:
                case ReleaseOutcome.NOT_FOUND:
                    await manager.send_to_socket(
                        websocket,
                        ErrorEvent(
                            code="not_found", message="la nota no existe", note_id=event.note_id
                        ),
                    )
                    return None
                case ReleaseOutcome.NOT_HELD:
                    await manager.send_to_socket(
                        websocket,
                        NoteReleaseRejected(
                            note_id=event.note_id, participant_id=participant_id, reason="not_held"
                        ),
                    )
                    return None
                case ReleaseOutcome.RELEASED:
                    return NoteReleaseOut(
                        note_id=event.note_id,
                        participant_id=participant_id,
                        taken_count=result.taken_count,
                    )

        case ReactionToggleIn():
            result = notes.toggle_reaction(session, event.note_id, participant_id, event.emoji)
            if result.outcome is ReactionOutcome.NOT_FOUND:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(
                        code="not_found", message="la nota no existe", note_id=event.note_id
                    ),
                )
                return None
            return ReactionToggleOut(
                note_id=event.note_id,
                participant_id=participant_id,
                emoji=event.emoji,
                active=result.active,
            )

        case ChatMessageIn():
            message = chat.create_message(
                session, room, participant_id, id=event.id, note_id=event.note_id, text=event.text
            )
            return ChatMessageOut(**message.model_dump())

        case RoomBackgroundIn():
            outcome = rooms.set_background(session, room, event.background)
            if outcome is BackgroundOutcome.ROOM_NOT_FOUND:
                await manager.send_to_socket(
                    websocket, ErrorEvent(code="not_found", message="la sala no existe")
                )
                return None
            return RoomBackgroundOut(background=event.background)

        case Ping():
            await manager.send_to_socket(websocket, Pong())
            return None

        # --- efímeros: solo se reenvían, nunca tocan la base (invariante 6) ---------

        case PresenceCursorIn():
            return PresenceCursorOut(participant_id=participant_id, x=event.x, y=event.y)

        case PresenceDraggingIn():
            return PresenceDraggingOut(
                participant_id=participant_id,
                note_id=event.note_id,
                position_x=event.position_x,
                position_y=event.position_y,
            )

        case PresenceDraftingIn():
            return PresenceDraftingOut(
                participant_id=participant_id,
                kind=event.kind,
                position_x=event.position_x,
                position_y=event.position_y,
                active=event.active,
            )

        case ChatTypingIn():
            return ChatTypingOut(
                participant_id=participant_id, note_id=event.note_id, active=event.active
            )
