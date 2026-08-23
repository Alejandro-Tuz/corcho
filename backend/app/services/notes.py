"""Notas: crear, actualizar, mover, borrar, reaccionar.

Autoría: solo el autor actualiza, mueve o borra su nota. Se valida acá, no en el
handler (invariante 2). No es una carrera esperable como los cupos -la UI legítima
nunca ofrece estos controles sobre una nota ajena-, así que un único `NoteOutcome`
(NOT_FOUND / FORBIDDEN / OK) alcanza para las tres: es lo mismo que `handlers.py`
traduce a `error` con `code="forbidden"` (decisión ya tomada en `protocol.py`).

`update_note`/`move_note` usan `session.get(Note, note_id)` + mutar atributos + flush,
no SQL condicional con SAVEPOINT como `claims.py`: no hay una carrera que cubrir acá
-salvo una excepción, ver el docstring de `move_note`-.

`reaction.toggle` no valida autoría -cualquiera reacciona a cualquier nota-, así que su
resultado es más simple: existe o no.
"""

import uuid
from datetime import datetime
from enum import Enum, auto
from typing import NamedTuple

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.constants import NoteColor, Reaction
from app.models.note import Note
from app.models.reaction import Reaction as ReactionRow
from app.realtime.protocol import NoteKind, NoteState, NoteStatus
from app.realtime.protocol import ReactionEntry as ReactionEntrySchema


class NoteOutcome(Enum):
    NOT_FOUND = auto()
    FORBIDDEN = auto()  # existe, pero participant_id no es el autor
    OK = auto()


class UpdateResult(NamedTuple):
    outcome: NoteOutcome
    text: str | None
    color: str | None
    updated_at: datetime | None


class MoveResult(NamedTuple):
    outcome: NoteOutcome
    position_x: float | None
    position_y: float | None
    status: str | None


class ReactionOutcome(Enum):
    NOT_FOUND = auto()
    OK = auto()


class ReactionResult(NamedTuple):
    outcome: ReactionOutcome
    active: bool | None  # True = quedó puesta, False = se sacó; None si NOT_FOUND


def to_note_state(note: Note) -> NoteState:
    """Proyección completa de una nota (con claims y reacciones). Pública:
    `services/rooms.py` la reusa para no repetir el mapeo de campos."""
    return NoteState(
        id=note.id,
        author_id=note.author_id,
        kind=note.kind,
        status=note.status,
        text=note.text,
        color=note.color,
        position_x=note.position_x,
        position_y=note.position_y,
        capacity=note.capacity,
        taken_count=note.taken_count,
        created_at=note.created_at,
        updated_at=note.updated_at,
        claims=[claim.participant_id for claim in note.claims],
        reactions=[
            ReactionEntrySchema(emoji=r.emoji, participant_id=r.participant_id)
            for r in note.reactions
        ],
    )


def create_note(
    session: Session,
    room_slug: str,
    author_id: uuid.UUID,
    *,
    id: uuid.UUID,
    kind: NoteKind,
    status: NoteStatus,
    text: str,
    color: NoteColor,
    position_x: float,
    position_y: float,
    capacity: int | None,
) -> NoteState:
    """Siempre crea: `room_slug`/`author_id` vienen de la identidad ya establecida en
    la conexión (room.join), no de un id arbitrario del cliente. `kind`/`capacity` ya
    se validaron en `protocol.py`; si algo llegara inconsistente de todos modos, el
    CHECK `kind_capacity` de Postgres es el backstop -no se revalida acá por tercera
    vez-. `claims=[]` y `reactions=[]` sin consulta extra: una nota recién creada no
    puede tener ninguna todavía."""
    note = Note(
        id=id,
        room_id=room_slug,
        author_id=author_id,
        kind=kind,
        status=status,
        text=text,
        color=color,
        position_x=position_x,
        position_y=position_y,
        capacity=capacity,
        taken_count=0,
    )
    session.add(note)
    session.flush()
    return NoteState(
        id=note.id,
        author_id=note.author_id,
        kind=note.kind,
        status=note.status,
        text=note.text,
        color=note.color,
        position_x=note.position_x,
        position_y=note.position_y,
        capacity=note.capacity,
        taken_count=note.taken_count,
        created_at=note.created_at,
        updated_at=note.updated_at,
        claims=[],
        reactions=[],
    )


def update_note(
    session: Session,
    note_id: uuid.UUID,
    participant_id: uuid.UUID,
    *,
    text: str,
    color: NoteColor,
) -> UpdateResult:
    note = session.get(Note, note_id)
    if note is None:
        return UpdateResult(NoteOutcome.NOT_FOUND, None, None, None)
    if note.author_id != participant_id:
        return UpdateResult(NoteOutcome.FORBIDDEN, None, None, None)

    note.text = text
    note.color = color
    session.flush()
    return UpdateResult(NoteOutcome.OK, note.text, note.color, note.updated_at)


def move_note(
    session: Session,
    note_id: uuid.UUID,
    participant_id: uuid.UUID,
    *,
    position_x: float,
    position_y: float,
    status: NoteStatus,
) -> MoveResult:
    """Posición y status en la misma llamada -decisión ya tomada: un arrastre que
    cruza de columna actualiza los dos a la vez-.

    Limitación conocida, sin blindar a propósito: esta es la segunda concurrencia real
    del proyecto, además de los cupos, y acá no hay nada que la resuelva. Dos eventos
    `note.move` para la misma nota -la misma persona con dos pestañas, o simplemente
    paquetes que se reordenan en la red mientras se arrastra a alta frecuencia
    (presence.dragging)- pueden llegar y aplicarse fuera de orden: el que llega
    después siempre gana, aunque corresponda a un instante anterior del arrastre. No
    hay control de versión ni timestamp de por medio para descartar el más viejo. El
    costo de blindar esto (versionar la nota, o serializar por note_id) no se justifica
    en tres días: el peor caso visible es una nota que "salta" un instante a una
    posición vieja antes de asentarse en la correcta, no una pérdida de datos ni un
    estado inconsistente en la base."""
    note = session.get(Note, note_id)
    if note is None:
        return MoveResult(NoteOutcome.NOT_FOUND, None, None, None)
    if note.author_id != participant_id:
        return MoveResult(NoteOutcome.FORBIDDEN, None, None, None)

    note.position_x = position_x
    note.position_y = position_y
    note.status = status
    session.flush()
    return MoveResult(NoteOutcome.OK, note.position_x, note.position_y, note.status)


def delete_note(session: Session, note_id: uuid.UUID, participant_id: uuid.UUID) -> NoteOutcome:
    """Borrado físico. `session.delete(note)` + flush, nada más: claims y reactions
    cascadean por el `ON DELETE CASCADE` de Postgres (`passive_deletes=True` en el
    modelo, no hace falta traerlos a Python para borrarlos uno por uno), y
    `chat_messages` sobreviven por el `ON DELETE SET NULL` de su FK. Ninguna de las dos
    cascadas se toca a mano acá."""
    note = session.get(Note, note_id)
    if note is None:
        return NoteOutcome.NOT_FOUND
    if note.author_id != participant_id:
        return NoteOutcome.FORBIDDEN

    session.delete(note)
    session.flush()
    return NoteOutcome.OK


def toggle_reaction(
    session: Session,
    note_id: uuid.UUID,
    participant_id: uuid.UUID,
    emoji: Reaction,
) -> ReactionResult:
    """Sin chequeo de autoría: cualquier participante reacciona a cualquier nota.

    DELETE antes que INSERT, mismo motivo que en `claims.py`: el `rowcount` de un
    DELETE es confiable con psycopg3 (se verificó ahí). Si dos toggles del mismo
    emoji en la misma nota llegan juntos, el INSERT que sigue a un DELETE que no
    encontró nada puede chocar contra la PK compuesta (note_id, participant_id,
    emoji) -la misma trampa que ya costó encontrar en `claims.take`, en dos sitios
    distintos del código-. Se resuelve exactamente igual que ahí: `ON CONFLICT DO
    NOTHING` + `RETURNING` para saber si insertó, nunca su `rowcount` -con psycopg3,
    el `rowcount` de un `INSERT ... ON CONFLICT DO NOTHING` da -1 siempre haya
    insertado o no, verificado a mano contra Postgres real en `claims.py`-."""
    if session.get(Note, note_id) is None:
        return ReactionResult(ReactionOutcome.NOT_FOUND, None)

    deleted = session.execute(
        delete(ReactionRow).where(
            ReactionRow.note_id == note_id,
            ReactionRow.participant_id == participant_id,
            ReactionRow.emoji == emoji,
        )
    )
    if deleted.rowcount > 0:
        return ReactionResult(ReactionOutcome.OK, False)

    inserted = session.execute(
        pg_insert(ReactionRow)
        .values(note_id=note_id, participant_id=participant_id, emoji=emoji)
        .on_conflict_do_nothing(
            index_elements=[ReactionRow.note_id, ReactionRow.participant_id, ReactionRow.emoji]
        )
        .returning(ReactionRow.note_id)
    ).first()

    if inserted is not None:
        return ReactionResult(ReactionOutcome.OK, True)  # esta llamada insertó

    # inserted es None: el conflicto es real, no el bug de rowcount. Otra petición
    # concurrente insertó la misma fila entre el DELETE y este INSERT y ya ganó. A
    # diferencia de take() -donde este caso decide deshacer el INSERT y rechazar-, acá
    # el desenlace es idéntico al de la rama anterior: la reacción quedó puesta.
    return ReactionResult(ReactionOutcome.OK, True)
