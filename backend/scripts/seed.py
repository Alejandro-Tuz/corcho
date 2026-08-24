"""Sala precargada para la demo (CLAUDE.md, "Comprometido, pendiente" #1).

Crea una sala nueva con participantes ficticios, notas repartidas en las tres columnas
-cupos a medio llenar, checklists en distintos estados de progreso, reacciones- y unos
pocos mensajes de chat para que la sala se sienta usada. Reusa los servicios reales
(`services/rooms.py`, `services/notes.py`, `services/claims.py`) en vez de insertar filas
a mano donde existe una función que ya hace esa escritura correctamente -mismo motivo por
el que un test de integración llamaría a esas funciones y no armaría el INSERT él mismo:
si la lógica de negocio cambia, este script no puede quedar desincronizado con ella.

Los mensajes de chat son la única excepción: se construyen directo con el modelo
`ChatMessage`, no con `services.chat.create_message`. Motivo, ya documentado en el
docstring de `chat.list_messages`: Postgres congela `now()` al inicio de la transacción,
no por sentencia -varios mensajes creados sin ese valor explícito, en la misma
transacción, saldrían con `created_at` idéntico y su orden relativo quedaría al azar-.
Acá se pasa un `created_at` explícito y creciente por mensaje, así que el problema no
llega a existir: no depende de comittear entre uno y otro.

Participantes ficticios: se crean con `rooms.join_room` (mismo camino que un `room.join`
real) y se marcan desconectados enseguida con `rooms.mark_disconnected` -si no, quedan
con `disconnected_at IS NULL` para siempre y la sala se ve con gente "conectada" que en
realidad no tiene ningún socket abierto, apenas se entra a mirarla.

Toda la siembra va en una sola transacción (un solo `session.commit()` al final): si algo
falla a mitad de camino, no queda una sala a medio sembrar.

Uso (desde `backend\\`, con el venv activo):
    python scripts\\seed.py
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.chat_message import ChatMessage
from app.realtime.protocol import ParticipantState
from app.services import claims, notes, rooms

FAKE_PARTICIPANTS: list[dict[str, str]] = [
    {"name": "Cande", "avatar": "fox", "color": "coral"},
    {"name": "Bruno", "avatar": "owl", "color": "teal"},
    {"name": "Fefa", "avatar": "turtle", "color": "violet"},
    {"name": "Nico", "avatar": "whale", "color": "amber"},
]

# Cada nota: en qué columna, quién la escribió, tipo, color, texto (con checklist en
# markdown donde corresponde -misma convención que lib/checklist.ts en el frontend,
# nunca un campo aparte, ver CLAUDE.md "Nota expandible"-), y si es compartida, cupos y
# quiénes los tomaron (índices sobre FAKE_PARTICIPANTS). `reactions` son pares (índice,
# emoji). Deliberadamente variados en progreso de checklist (0%, ~33%, 50%, 100%) y en
# cupos (vacío, a medio llenar, completo) -no todas las notas iguales, para que la sala
# sembrada muestre los distintos estados que la UI sabe representar.
NOTE_SPECS: list[dict] = [
    {
        "label": "legal",
        "status": "blocked",
        "author": 0,
        "kind": "shared",
        "capacity": 4,
        "color": "pink",
        "text": (
            "Esperar el visto bueno de legales sobre los términos del contrato con el "
            "proveedor nuevo.\n\n"
            "- [x] mandar el borrador\n"
            "- [ ] esperar respuesta\n"
            "- [ ] firmar y archivar"
        ),
        "claimed_by": [1, 2],
        "reactions": [],
    },
    {
        "label": "staging",
        "status": "blocked",
        "author": 1,
        "kind": "own",
        "capacity": None,
        "color": "blue",
        "text": "Sin acceso al servidor de staging todavía -pedido a infra desde el lunes.",
        "claimed_by": [],
        "reactions": [(0, "👀")],
    },
    {
        "label": "demo",
        "status": "in_progress",
        "author": 0,
        "kind": "shared",
        "capacity": 2,
        "color": "yellow",
        "text": (
            "Preparar la demo del viernes para el resto del equipo.\n\n"
            "- [x] armar el guion\n"
            "- [x] probar el proyector\n"
            "- [ ] ensayar con todos\n"
            "- [ ] mandar la invitación"
        ),
        "claimed_by": [3],
        "reactions": [(1, "🔥"), (2, "🔥"), (3, "✓")],
    },
    {
        "label": "pr482",
        "status": "in_progress",
        "author": 2,
        "kind": "own",
        "capacity": None,
        "color": "green",
        "text": (
            "Revisar los comentarios del PR #482.\n\n"
            "- [x] corregir el nombre de la variable\n"
            "- [ ] agregar el test que falta\n"
            "- [ ] pedir review de nuevo"
        ),
        "claimed_by": [],
        "reactions": [],
    },
    {
        "label": "desayuno",
        "status": "in_progress",
        "author": 1,
        "kind": "shared",
        "capacity": 3,
        "color": "orange",
        "text": "¿Quién se anota para traer el desayuno del jueves?",
        "claimed_by": [],
        "reactions": [(0, "✓")],
    },
    {
        "label": "onboarding",
        "status": "in_progress",
        "author": 3,
        "kind": "own",
        "capacity": None,
        "color": "pink",
        "text": (
            "Escribir la guía de onboarding para gente nueva.\n\n"
            "- [ ] estructura general\n"
            "- [ ] sección de accesos\n"
            "- [ ] sección de herramientas"
        ),
        "claimed_by": [],
        "reactions": [],
    },
    {
        "label": "migracion",
        "status": "done",
        "author": 1,
        "kind": "own",
        "capacity": None,
        "color": "blue",
        "text": "Migración de la base a la versión nueva, sin downtime.",
        "claimed_by": [],
        "reactions": [(0, "✓"), (2, "✓"), (3, "✓")],
    },
    {
        "label": "encuesta",
        "status": "done",
        "author": 2,
        "kind": "shared",
        "capacity": 3,
        "color": "pink",
        "text": (
            "Encuesta de satisfacción del equipo, todos respondieron.\n\n"
            "- [x] armar las preguntas\n"
            "- [x] mandarla\n"
            "- [x] cerrar y compartir resultados"
        ),
        "claimed_by": [0, 1, 3],
        "reactions": [(0, "🔥")],
    },
]

# (autor, destinatario de la nota o None, texto, hace cuántos minutos). Orden
# cronológico ascendente -el más viejo primero-, igual que lo que `chat.list_messages`
# devuelve. `note_label` referencia NOTE_SPECS; None es un mensaje general de la sala.
CHAT_SPECS: list[tuple[int, str | None, str, int]] = [
    (1, None, "che, subí la propuesta de agenda para la demo del viernes", 38),
    (0, "demo", "dale, la reviso hoy a la tarde", 30),
    (2, None, "¿alguien probó el build nuevo en staging?", 18),
    (3, "staging", "yo sigo esperando el acceso todavía 🙃", 9),
    (0, "encuesta", "quedó buena la encuesta, gracias a los que respondieron", 2),
]

COLUMN_POSITION_X = 24
COLUMN_POSITION_Y_START = 24
# 240, no 180: una nota con cupos + chip de checklist + reacciones a la vez mide más
# que el min-height base de .note-card (132px) -verificado a mano contra el navegador
# real: con 180 dos tarjetas se pisaban, la de abajo tapaba la esquina de la de arriba.
COLUMN_POSITION_Y_STEP = 240


def _seed_participants(session: Session, room_slug: str) -> list[ParticipantState]:
    participants = []
    for data in FAKE_PARTICIPANTS:
        result = rooms.join_room(
            session,
            room_slug,
            participant_id=None,
            name=data["name"],
            avatar=data["avatar"],
            color=data["color"],
        )
        assert result.participant is not None  # participant_id=None siempre crea
        rooms.mark_disconnected(session, result.participant.id)
        participants.append(result.participant)
    return participants


def _seed_notes(
    session: Session, room_slug: str, participants: list[ParticipantState]
) -> dict[str, uuid.UUID]:
    note_ids: dict[str, uuid.UUID] = {}
    column_counts: dict[str, int] = {"blocked": 0, "in_progress": 0, "done": 0}

    for spec in NOTE_SPECS:
        status = spec["status"]
        i = column_counts[status]
        column_counts[status] += 1

        note_id = uuid.uuid4()
        note_ids[spec["label"]] = note_id
        author = participants[spec["author"]]

        notes.create_note(
            session,
            room_slug,
            author.id,
            id=note_id,
            kind=spec["kind"],
            status=status,
            text=spec["text"],
            color=spec["color"],
            position_x=COLUMN_POSITION_X,
            position_y=COLUMN_POSITION_Y_START + i * COLUMN_POSITION_Y_STEP,
            capacity=spec["capacity"],
        )

        for claimer_index in spec["claimed_by"]:
            claims.take(session, note_id, participants[claimer_index].id)

        for reactor_index, emoji in spec["reactions"]:
            notes.toggle_reaction(session, note_id, participants[reactor_index].id, emoji)

    return note_ids


def _seed_chat(
    session: Session,
    room_slug: str,
    note_ids: dict[str, uuid.UUID],
    participants: list[ParticipantState],
) -> None:
    now = datetime.now(UTC)
    for author_index, note_label, text, minutes_ago in CHAT_SPECS:
        session.add(
            ChatMessage(
                id=uuid.uuid4(),
                room_id=room_slug,
                note_id=note_ids[note_label] if note_label is not None else None,
                author_id=participants[author_index].id,
                text=text,
                # Explícito, no server_default: es el motivo por el que este script no
                # pisa el bug de `now()` congelado por transacción documentado en
                # `services/chat.py` -cada mensaje lleva su propio timestamp, no
                # importa que todo esto viaje en la misma transacción.
                created_at=now - timedelta(minutes=minutes_ago),
            )
        )


def main() -> None:
    session = SessionLocal()
    try:
        room = rooms.create_room(session, name="Sprint del equipo")
        participants = _seed_participants(session, room.slug)
        note_ids = _seed_notes(session, room.slug, participants)
        _seed_chat(session, room.slug, note_ids, participants)
        session.commit()
        slug = room.slug
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    print(f"Sala sembrada: {slug}")
    print(f"http://localhost:5173/{slug}")


if __name__ == "__main__":
    main()
