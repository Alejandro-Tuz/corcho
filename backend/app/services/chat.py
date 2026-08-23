"""Chat: insertar mensaje y leer el historial. Append-only -sin update ni delete de
mensajes, decisión ya tomada-.

`list_messages` es la única lectura de historial en todo el backend: `services/rooms.py`
la reusa para `room.snapshot` en vez de traer el historial completo por su cuenta, así
que el límite que aplica acá aplica también ahí.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.chat_message import ChatMessage
from app.models.note import Note
from app.realtime.protocol import ChatMessageState


def _to_state(message: ChatMessage) -> ChatMessageState:
    return ChatMessageState(
        id=message.id,
        note_id=message.note_id,
        author_id=message.author_id,
        text=message.text,
        created_at=message.created_at,
    )


def create_message(
    session: Session,
    room_slug: str,
    author_id: uuid.UUID,
    *,
    id: uuid.UUID,
    note_id: uuid.UUID | None,
    text: str,
) -> ChatMessageState:
    """Siempre crea: `room_slug`/`author_id` vienen de la identidad ya establecida en
    la conexión, igual que en `notes.create_note`.

    Si `note_id` viene y no existe -la nota se borró mientras alguien escribía, o el
    cliente manda un id de memoria que ya no vale-, el mensaje se guarda igual con
    `note_id=NULL` en vez de rechazarse: es la misma garantía que ya rige para cuando
    la nota se borra *después* de que el mensaje existe (`ON DELETE SET NULL`, "un
    mensaje es una intervención independiente, no un atributo de la nota"), aplicada
    también para *antes*."""
    if note_id is not None and session.get(Note, note_id) is None:
        note_id = None

    message = ChatMessage(id=id, room_id=room_slug, note_id=note_id, author_id=author_id, text=text)
    session.add(message)
    session.flush()
    return _to_state(message)


def list_messages(session: Session, room_slug: str, *, limit: int = 200) -> list[ChatMessageState]:
    """`ORDER BY created_at DESC LIMIT :limit` en la consulta -así el índice
    `ix_chat_messages_room_created` sirve tanto el filtro como el orden-, pero se
    devuelve en orden cronológico ascendente: lo que espera un historial de scroll.
    Tope defensivo, no paginación real -no está en el alcance del proyecto-.

    Limitación conocida: Postgres congela `now()` al inicio de la transacción, no por
    sentencia (verificado a mano). Si dos o más mensajes se crean con `create_message`
    dentro de la MISMA transacción, quedan con `created_at` idéntico y el orden entre
    ellos no está garantizado. En el uso real esto no pasa -cada `chat.message` que
    llega por WS es su propia transacción-, pero cualquier script (`scripts/seed.py`,
    tests) que inserte varios mensajes en una sola sesión sin comittear entre uno y
    otro sí lo va a pisar."""
    rows = (
        session.execute(
            select(ChatMessage)
            .where(ChatMessage.room_id == room_slug)
            .order_by(ChatMessage.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return [_to_state(m) for m in reversed(rows)]
