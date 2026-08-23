"""Salas: crear, unirse (con reidentificación) y armar el snapshot inicial.

`join_room` es la pieza delicada, por la reidentificación del CLAUDE.md: si el
`participant_id` que manda el cliente existe y es de esta sala, se reactiva esa fila en
vez de crear una nueva -si no, cada reconexión huerfaniza los cupos y las notas de esa
persona-. El resultado distingue "reactivó" de "creó" porque `presence.joined` solo se
difunde en la transición real a conectado, y esa decisión la toma `manager.connect()`
en el caller, no este servicio: acá solo se informa qué pasó.
"""

import uuid
from enum import Enum, auto
from typing import NamedTuple

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.core.constants import Avatar, Background, ParticipantColor
from app.core.ids import new_room_slug
from app.models.note import Note
from app.models.participant import Participant
from app.models.room import Room
from app.realtime.protocol import ParticipantState, RoomSnapshot
from app.services import chat
from app.services.notes import to_note_state


class JoinOutcome(Enum):
    ROOM_NOT_FOUND = auto()
    REACTIVATED = auto()  # participant_id existía y era de esta sala
    CREATED = auto()  # ausente, inexistente, o de otra sala


class JoinResult(NamedTuple):
    outcome: JoinOutcome
    participant: ParticipantState | None  # None solo si ROOM_NOT_FOUND


def _to_participant_state(participant: Participant) -> ParticipantState:
    return ParticipantState(
        id=participant.id,
        name=participant.name,
        avatar=participant.avatar,
        color=participant.color,
        connected_at=participant.connected_at,
        disconnected_at=participant.disconnected_at,
    )


def create_room(session: Session, *, name: str | None = None) -> Room:
    """Genera el slug (`core.ids.new_room_slug`) e inserta la fila. Sin desenlaces que
    distinguir: siempre crea. Devuelve el modelo ORM tal cual -esto es REST, no WS; la
    conversión a schema de salida es de `api/v1/rooms.py`, no de acá-."""
    room = Room(slug=new_room_slug(), name=name)
    session.add(room)
    session.flush()
    return room


def join_room(
    session: Session,
    room_slug: str,
    *,
    participant_id: uuid.UUID | None,
    name: str,
    avatar: Avatar,
    color: ParticipantColor,
) -> JoinResult:
    """Reactiva si `participant_id` existe y es de esta sala: `disconnected_at` a
    NULL, actualiza `name` y `avatar`. NO actualiza `color` -se mantiene el de la
    primera vez, para que el cursor y el borde de nota fantasma de esa persona no
    cambien de un reconecte a otro-. Si no existe, es de otra sala, o vino `None`:
    crea un participante nuevo con los tres datos."""
    room = session.get(Room, room_slug)
    if room is None:
        return JoinResult(JoinOutcome.ROOM_NOT_FOUND, None)

    participant = None
    if participant_id is not None:
        candidate = session.get(Participant, participant_id)
        if candidate is not None and candidate.room_id == room_slug:
            participant = candidate

    if participant is not None:
        participant.name = name
        participant.avatar = avatar
        participant.disconnected_at = None
        session.flush()
        return JoinResult(JoinOutcome.REACTIVATED, _to_participant_state(participant))

    participant = Participant(room_id=room_slug, name=name, avatar=avatar, color=color)
    session.add(participant)
    session.flush()
    return JoinResult(JoinOutcome.CREATED, _to_participant_state(participant))


def mark_disconnected(session: Session, participant_id: uuid.UUID) -> None:
    """Contraparte de `join_room`: se llama solo cuando `manager.disconnect()` ya
    confirmó que este fue el último socket de esta persona en la sala -la transición
    real a "desconectado" (invariante de multi-pestaña, CLAUDE.md). Sin resultado
    tipado que distinguir, a diferencia de `join_room`: quien llama ya sabe que hubo
    una transición real, acá solo se persiste. `func.now()` en vez de un timestamp de
    Python, mismo criterio que `connected_at` (server_default): el reloj de la verdad
    es el de Postgres."""
    participant = session.get(Participant, participant_id)
    if participant is None:
        return  # no debería pasar: participant_id vino de una conexión ya identificada
    participant.disconnected_at = func.now()
    session.flush()


class BackgroundOutcome(Enum):
    ROOM_NOT_FOUND = auto()
    OK = auto()


def set_background(session: Session, room_slug: str, background: Background) -> BackgroundOutcome:
    """UPDATE directo -no `session.get` + mutar-: cambiar una sola columna no
    necesita traer la fila entera a Python. `rowcount` alcanza para distinguir sala
    inexistente de éxito: no hace falta SAVEPOINT, no hay una carrera real que cubrir
    acá -el peor caso concurrente es "el último que escribe gana", aceptable para el
    fondo del lienzo-."""
    result = session.execute(
        update(Room).where(Room.slug == room_slug).values(background=background)
    )
    if result.rowcount == 0:
        return BackgroundOutcome.ROOM_NOT_FOUND
    return BackgroundOutcome.OK


def get_snapshot(session: Session, room_slug: str) -> RoomSnapshot | None:
    """`None` si la sala no existe. Dos consultas en total, nunca una por nota:

    1. `Room` con `selectinload` de `notes` (+ `claims`, + `reactions`) y de
       `participants`, en un solo viaje adicional a la consulta principal por
       relación -no una por fila-.
    2. `chat.list_messages`, aparte: necesita `ORDER BY` + `LIMIT`, que no sale
       prolijo de un `selectinload` sobre la relación `Room.chat_messages` (que
       tampoco tiene orden propio definido en el modelo).

    Participantes: todos los que pasaron por la sala, conectados o no (decisión ya
    tomada) -si no, un mensaje de chat de alguien offline no tiene con qué renderizar
    nombre y avatar-.

    `session.get()` no sirve acá: no aplica bien un `selectinload` encadenado dos
    niveles (`notes` -> `claims`/`reactions`) y termina disparando una consulta de
    claims y otra de reactions *por nota* -un N+1 real, verificado a mano contra
    Postgres (`event.listen` sobre `before_cursor_execute`): 14 consultas para 5
    notas con `session.get()`, 6 consultas para las mismas 5 notas con `select()`, y
    ese número no crece con más notas-. `select(Room).where(...)` sí respeta la
    cadena completa."""
    room = session.execute(
        select(Room)
        .where(Room.slug == room_slug)
        .options(
            selectinload(Room.notes).selectinload(Note.claims),
            selectinload(Room.notes).selectinload(Note.reactions),
            selectinload(Room.participants),
        )
    ).scalar_one_or_none()
    if room is None:
        return None

    return RoomSnapshot(
        slug=room.slug,
        name=room.name,
        background=room.background,
        notes=[to_note_state(note) for note in room.notes],
        participants=[_to_participant_state(p) for p in room.participants],
        chat_messages=chat.list_messages(session, room_slug),
    )
