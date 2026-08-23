"""La única concurrencia real del proyecto. Corre contra el Postgres real de
`docker-compose` -no hay base de test separada en `.env.example`-.

La fixture `session` liga la `Session` a una conexión con una transacción externa y
`join_transaction_mode="create_savepoint"`: los `commit()` internos de
`app.services.claims` (que en realidad son SAVEPOINTs, ver ese módulo) no tocan la
transacción externa, así que el `rollback()` final de la fixture deshace todo sin
importar cuántas veces el servicio haya "committeado". Nada queda en la base entre
tests.

La excepción es `test_concurrent_take_last_slot_one_wins_one_rejected`: dos hilos
necesitan dos conexiones reales e independientes para que Postgres los serialice de
verdad a nivel de fila -compartir una sesión los volvería secuenciales y no probaría
nada-. Ese test arma sus propios datos con una sesión que sí commitea, y al final borra
la `Room` que creó (cascada se lleva participantes, nota y claim) para no dejar basura
en la base de desarrollo.
"""

import threading
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy.orm import Session

from app.core.ids import new_room_slug
from app.db.session import engine
from app.models.note import Note
from app.models.participant import Participant
from app.models.room import Room
from app.services import claims


@pytest.fixture
def session() -> Iterator[Session]:
    connection = engine.connect()
    trans = connection.begin()
    db = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield db
    finally:
        db.close()
        trans.rollback()
        connection.close()


def _make_room(session: Session) -> Room:
    room = Room(slug=new_room_slug())
    session.add(room)
    session.flush()
    return room


def _make_participant(session: Session, room: Room, name: str = "Ana") -> Participant:
    participant = Participant(room_id=room.slug, name=name, avatar="fox", color="coral")
    session.add(participant)
    session.flush()
    return participant


def _make_note(
    session: Session,
    room: Room,
    author: Participant,
    *,
    kind: str = "shared",
    capacity: int | None = 1,
    taken_count: int = 0,
) -> Note:
    note = Note(
        room_id=room.slug,
        author_id=author.id,
        kind=kind,
        status="in_progress",
        text="tarea",
        color="yellow",
        position_x=0,
        position_y=0,
        capacity=capacity,
        taken_count=taken_count,
    )
    session.add(note)
    session.flush()
    return note


# --- take -----------------------------------------------------------------------------


def test_take_last_available_slot(session: Session) -> None:
    room = _make_room(session)
    author = _make_participant(session, room)
    claimer = _make_participant(session, room, "Beto")
    note = _make_note(session, room, author, capacity=1, taken_count=0)

    result = claims.take(session, note.id, claimer.id)

    assert result == claims.ClaimResult(claims.ClaimOutcome.TAKEN, 1)


def test_take_twice_same_participant_is_idempotent(session: Session) -> None:
    room = _make_room(session)
    author = _make_participant(session, room)
    claimer = _make_participant(session, room, "Beto")
    note = _make_note(session, room, author, capacity=2, taken_count=0)

    first = claims.take(session, note.id, claimer.id)
    second = claims.take(session, note.id, claimer.id)

    assert first == claims.ClaimResult(claims.ClaimOutcome.TAKEN, 1)
    assert second == claims.ClaimResult(claims.ClaimOutcome.ALREADY_HELD, 1)


def test_own_note_cannot_be_claimed(session: Session) -> None:
    room = _make_room(session)
    author = _make_participant(session, room)
    claimer = _make_participant(session, room, "Beto")
    note = _make_note(session, room, author, kind="own", capacity=None, taken_count=0)

    result = claims.take(session, note.id, claimer.id)

    assert result == claims.ClaimResult(claims.ClaimOutcome.FULL, None)


def test_take_note_not_found(session: Session) -> None:
    result = claims.take(session, uuid.uuid4(), uuid.uuid4())

    assert result == claims.ClaimResult(claims.ClaimOutcome.NOT_FOUND, None)


def test_concurrent_take_last_slot_one_wins_one_rejected() -> None:
    setup = Session(bind=engine)
    room = _make_room(setup)
    author = _make_participant(setup, room)
    claimer_a = _make_participant(setup, room, "A")
    claimer_b = _make_participant(setup, room, "B")
    note = _make_note(setup, room, author, capacity=1, taken_count=0)
    setup.commit()

    barrier = threading.Barrier(2)
    results: dict[str, claims.ClaimResult] = {}

    def worker(name: str, participant_id: uuid.UUID) -> None:
        thread_session = Session(bind=engine)
        try:
            barrier.wait()
            results[name] = claims.take(thread_session, note.id, participant_id)
            thread_session.commit()
        finally:
            thread_session.close()

    t1 = threading.Thread(target=worker, args=("a", claimer_a.id))
    t2 = threading.Thread(target=worker, args=("b", claimer_b.id))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    outcomes = {result.outcome for result in results.values()}
    assert outcomes == {claims.ClaimOutcome.TAKEN, claims.ClaimOutcome.FULL}
    winner = next(r for r in results.values() if r.outcome is claims.ClaimOutcome.TAKEN)
    assert winner.taken_count == 1

    setup.delete(room)
    setup.commit()
    setup.close()


# --- release --------------------------------------------------------------------------


def test_release_then_take_again(session: Session) -> None:
    room = _make_room(session)
    author = _make_participant(session, room)
    claimer = _make_participant(session, room, "Beto")
    note = _make_note(session, room, author, capacity=1, taken_count=0)

    claims.take(session, note.id, claimer.id)
    released = claims.release(session, note.id, claimer.id)
    retaken = claims.take(session, note.id, claimer.id)

    assert released == claims.ReleaseResult(claims.ReleaseOutcome.RELEASED, 0)
    assert retaken == claims.ClaimResult(claims.ClaimOutcome.TAKEN, 1)


def test_double_release(session: Session) -> None:
    room = _make_room(session)
    author = _make_participant(session, room)
    claimer = _make_participant(session, room, "Beto")
    note = _make_note(session, room, author, capacity=1, taken_count=0)

    claims.take(session, note.id, claimer.id)
    first = claims.release(session, note.id, claimer.id)
    second = claims.release(session, note.id, claimer.id)

    assert first == claims.ReleaseResult(claims.ReleaseOutcome.RELEASED, 0)
    assert second == claims.ReleaseResult(claims.ReleaseOutcome.NOT_HELD, None)


def test_release_note_not_found(session: Session) -> None:
    result = claims.release(session, uuid.uuid4(), uuid.uuid4())

    assert result == claims.ReleaseResult(claims.ReleaseOutcome.NOT_FOUND, None)
