"""Cupos: tomar y soltar. La única concurrencia real del proyecto (ver
`tests/test_claims.py` y la sección "Concurrencia de los cupos" de `CLAUDE.md`).

`take` y `release` reciben la `Session`, no la abren: no controlan su ciclo de vida.
Ninguna de las dos llama a `session.commit()` ni a `session.rollback()` sobre la
transacción externa -eso es del caller-. Cuando una necesita deshacer solo su propia
escritura (cupo lleno, nada que soltar) usa un SAVEPOINT (`session.begin_nested()`), no
un rollback de toda la transacción: un rechazo es un resultado esperado, no un fallo que
deba abortar lo que el caller venía haciendo.

Tomar y soltar devuelven un resultado tipado, nunca solo un `int`: hace falta poder
distinguir "tomó un cupo nuevo" de "ya lo tenía" (esto último no difunde `note.claim` a
la sala, porque nadie tomó nada), y "nota inexistente" de "sin cupo". `handlers.py`
decide qué evento de `protocol.py` armar a partir del `outcome`; esta capa no sabe nada
de WebSockets ni de protocolo.
"""

import uuid
from enum import Enum, auto
from typing import NamedTuple

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models.note import Note
from app.models.note_claim import NoteClaim


class ClaimOutcome(Enum):
    NOT_FOUND = auto()  # note_id no existe
    TAKEN = auto()  # tomó un cupo nuevo
    ALREADY_HELD = auto()  # ya lo tenía: idempotente, nada nuevo que difundir
    FULL = auto()  # sin cupo (incluye 'own': capacity IS NULL, ver CLAUDE.md)


class ReleaseOutcome(Enum):
    NOT_FOUND = auto()  # note_id no existe
    RELEASED = auto()  # soltó el cupo
    NOT_HELD = auto()  # no tenía nada que soltar (doble suelta, o desincronizado)


class ClaimResult(NamedTuple):
    outcome: ClaimOutcome
    taken_count: int | None  # None cuando no cambió nada


class ReleaseResult(NamedTuple):
    outcome: ReleaseOutcome
    taken_count: int | None


def _note_exists(session: Session, note_id: uuid.UUID) -> bool:
    return session.execute(select(Note.id).where(Note.id == note_id)).first() is not None


def _current_taken_count(session: Session, note_id: uuid.UUID) -> int:
    return session.execute(select(Note.taken_count).where(Note.id == note_id)).scalar_one()


def take(session: Session, note_id: uuid.UUID, participant_id: uuid.UUID) -> ClaimResult:
    if not _note_exists(session, note_id):
        return ClaimResult(ClaimOutcome.NOT_FOUND, None)

    savepoint = session.begin_nested()

    # INSERT antes que el UPDATE (invariante): la PK compuesta rechaza el duplicado
    # rápido y limpio. ON CONFLICT DO NOTHING en vez de dejar que tire IntegrityError:
    # un doble clic del mismo participante es un resultado idempotente esperable.
    #
    # rowcount no sirve acá: con psycopg3, un INSERT ... ON CONFLICT DO NOTHING
    # devuelve rowcount == -1 tanto si insertó como si no (verificado a mano contra
    # Postgres real). RETURNING sí es confiable: solo trae fila para lo que
    # efectivamente se insertó, nada para lo que chocó contra el conflicto.
    inserted = session.execute(
        pg_insert(NoteClaim)
        .values(note_id=note_id, participant_id=participant_id)
        .on_conflict_do_nothing(index_elements=[NoteClaim.note_id, NoteClaim.participant_id])
        .returning(NoteClaim.note_id)
    ).first()

    if inserted is None:
        savepoint.commit()  # libera el SAVEPOINT; no hubo nada que deshacer
        return ClaimResult(ClaimOutcome.ALREADY_HELD, _current_taken_count(session, note_id))

    row = session.execute(
        update(Note)
        .where(Note.id == note_id, Note.taken_count < Note.capacity)
        .values(taken_count=Note.taken_count + 1)
        .returning(Note.taken_count)
    ).first()

    if row is None:
        # Sin cupo -o nota 'own', capacity IS NULL, misma rama sin código aparte-.
        # Deshace solo el INSERT de este SAVEPOINT; la transacción del caller sigue viva.
        savepoint.rollback()
        return ClaimResult(ClaimOutcome.FULL, None)

    savepoint.commit()
    return ClaimResult(ClaimOutcome.TAKEN, row.taken_count)


def release(session: Session, note_id: uuid.UUID, participant_id: uuid.UUID) -> ReleaseResult:
    if not _note_exists(session, note_id):
        return ReleaseResult(ReleaseOutcome.NOT_FOUND, None)

    savepoint = session.begin_nested()

    deleted = session.execute(
        delete(NoteClaim).where(
            NoteClaim.note_id == note_id, NoteClaim.participant_id == participant_id
        )
    )

    if deleted.rowcount == 0:
        # Nada que soltar: no se toca el contador (invariante). Sin esto, dos sueltas
        # seguidas decrementarían dos veces y taken_count quedaría por debajo de la
        # realidad.
        savepoint.rollback()  # no-op, cierra el SAVEPOINT prolijo
        return ReleaseResult(ReleaseOutcome.NOT_HELD, None)

    row = session.execute(
        update(Note)
        .where(Note.id == note_id, Note.taken_count > 0)
        .values(taken_count=Note.taken_count - 1)
        .returning(Note.taken_count)
    ).first()
    savepoint.commit()

    taken_count = row.taken_count if row is not None else _current_taken_count(session, note_id)
    return ReleaseResult(ReleaseOutcome.RELEASED, taken_count)
