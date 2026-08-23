"""EL CONTRATO entre backend y frontend para `/ws/{room}`.

Espejo manual en `frontend/src/realtime/protocol.ts` (invariante: cambian en el mismo
commit; no hay generación automática de uno a partir del otro).

## Forma del envelope

Cada evento es un modelo plano con su propio `type: Literal[...]`. No hay un `payload`
anidado: el discriminador y los datos viven en el mismo nivel. `handlers.py` valida el
JSON entrante contra la unión discriminada `ClientEvent` y despacha por `type`;
`broker.py` publica instancias de `ServerEvent`.

## Mismo `type`, dos esquemas

Para toda acción sobre un recurso ya existente, el mensaje que manda el cliente
(`*In`) y el que el servidor confirma a la sala (`*Out`) comparten el mismo string de
`type`, pero son clases distintas. El cliente nunca es autoridad sobre `participant_id`
ni `author_id`, ni sobre contadores o timestamps: eso lo agrega el servidor a partir de
la identidad del socket, que se establece una única vez con `room.join`.

Única excepción: `RoomJoinIn.participant_id` sí lo manda el cliente, porque ese mensaje
ES el que establece la identidad al reconectar (decisión de diseño ya tomada:
reidentificación por `participant_id` guardado en `localStorage`). No hay tokens
firmados -quien tiene el link ya tiene acceso a todo-, así que esto no es una
excepción a la regla de autoridad, es la raíz de la que cuelga toda la autoridad
posterior en la conexión.

## Correlación para estado optimista

No hay ids de operación genéricos. Se reusa lo que el dato ya tiene: el `id` generado
en el cliente para `note.create` y `chat.message` (el servidor lo reemite tal cual, el
cliente reconcilia por igualdad de id), y `note_id` para todo lo que actúa sobre una
nota existente, incluidos los rechazos. El cliente ya sabe qué intentó; no hace falta
inventar un identificador de operación aparte.

## Rechazos

`note.claim` y `note.release` son la única concurrencia real del proyecto, y un rechazo
ahí es un resultado esperable del uso normal (dos personas al mismo cupo, doble clic
soltando uno ya liberado). Por eso cada uno tiene su propio evento de rechazo, tipado,
enviado solo al socket que lo pidió, para que la reconciliación optimista sepa
exactamente qué deshacer sin tener que interpretar un string.

La autoría de `note.update` y `note.move` (solo el dueño edita o mueve su nota) en
cambio es una validación de servicio, no de schema -y así debe ser-, pero a diferencia
de los cupos, la UI legítima nunca ofrece editar o mover una nota ajena: si llega, es
por bug o manipulación, no por una carrera esperable. No tiene evento de rechazo propio:
cae en `error` con `code="forbidden"` y `note_id` para correlacionar.

## Eventos efímeros

Cursores, arrastre en curso, composición en curso y "está escribiendo" son alta
frecuencia y no se persisten (invariante 6): el broker los reenvía y ahí mueren. Marcado
dos veces para que no dependa de leer un comentario: heredan de `Ephemeral`, y están
listados en `EPHEMERAL_TYPES`.

`presence.dragging` no tiene un "stop" propio: se limpia cuando llega `note.move`, que
el cliente manda SIEMPRE al soltar -incluso si la posición final y el status quedan
igual que al empezar el arrastre-, porque es la única señal que borra la nota fantasma
en las otras pantallas. Sin ese envío incondicional, soltar en el mismo lugar deja el
fantasma colgado hasta que quien arrastraba se desconecte. Como red de seguridad
adicional, `presence.left` también limpia cualquier fantasma de arrastre o composición
que hubiera quedado a nombre de ese participante.

`presence.drafting` sí tiene `active: bool` explícito: cancelar una composición no deja
ningún evento persistido (como `note.move`) que reemplace al fantasma, así que hace
falta decir explícitamente que terminó. Asunción de alcance: un participante compone
una nota a la vez.
"""

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.constants import Avatar, Background, NoteColor, ParticipantColor, Reaction

NoteKind = Literal["own", "shared"]
NoteStatus = Literal["blocked", "in_progress", "done"]


class Event(BaseModel):
    """Base de todo evento del protocolo: un campo inesperado en el JSON entrante
    (participant_id colado, un nombre viejo tras un refactor) tiene que fallar la
    validación, no desaparecer en silencio."""

    model_config = ConfigDict(extra="forbid")


class Ephemeral:
    """Mixin marcador, sin campos: el broker reenvía estos eventos pero nadie los
    persiste (invariante 6). Ver también `EPHEMERAL_TYPES` al final del módulo."""


# --- Estado compartido -------------------------------------------------------------
# Estos tres modelos son a la vez la forma de un evento puntual (p. ej. la salida de
# `note.create`) y la forma de los elementos de las listas de `room.snapshot`. Una sola
# definición para los dos usos, nada de una versión "completa" y otra "resumida".


class ReactionEntry(Event):
    emoji: Reaction
    participant_id: uuid.UUID


class NoteState(Event):
    id: uuid.UUID
    author_id: uuid.UUID
    kind: NoteKind
    status: NoteStatus
    text: str
    color: NoteColor
    position_x: float
    position_y: float
    capacity: int | None
    taken_count: int
    created_at: datetime
    updated_at: datetime
    claims: list[uuid.UUID]
    reactions: list[ReactionEntry]


class ParticipantState(Event):
    id: uuid.UUID
    name: str
    avatar: Avatar
    color: ParticipantColor
    connected_at: datetime
    # NULL = conectado. Incluye participantes ya desconectados: room.snapshot trae a
    # todo el que pasó por la sala, no solo a los presentes ahora mismo, porque un
    # mensaje de chat de alguien offline necesita con qué renderizar nombre y avatar.
    disconnected_at: datetime | None


class ChatMessageState(Event):
    id: uuid.UUID
    note_id: uuid.UUID | None
    author_id: uuid.UUID
    text: str
    created_at: datetime


# --- room.join / room.snapshot ------------------------------------------------------


class RoomJoinIn(Event):
    type: Literal["room.join"] = "room.join"
    # Única excepción a "ningún *In lleva participant_id": ver docstring del módulo.
    # None en la primera visita a la sala.
    participant_id: uuid.UUID | None
    name: str = Field(max_length=40)
    avatar: Avatar
    color: ParticipantColor


class RoomSnapshot(Event):
    """Enviado solo al socket que se unió, nunca a la sala."""

    type: Literal["room.snapshot"] = "room.snapshot"
    slug: str
    name: str | None
    background: Background
    notes: list[NoteState]
    participants: list[ParticipantState]
    chat_messages: list[ChatMessageState]


# --- presencia (por conexión, no por mensaje del cliente) ---------------------------


class PresenceJoined(ParticipantState):
    type: Literal["presence.joined"] = "presence.joined"


class PresenceLeft(Event):
    type: Literal["presence.left"] = "presence.left"
    participant_id: uuid.UUID


# --- notas ---------------------------------------------------------------------------


class NoteCreateIn(Event):
    type: Literal["note.create"] = "note.create"
    id: uuid.UUID
    kind: NoteKind
    status: NoteStatus
    text: str = Field(max_length=500)
    color: NoteColor
    position_x: float
    position_y: float
    capacity: int | None = None

    @model_validator(mode="after")
    def _check_kind_capacity(self) -> "NoteCreateIn":
        # Espeja el CHECK "kind_capacity" de la tabla notes, para rechazar acá y no
        # depender de que la escritura falle en Postgres.
        if self.kind == "own" and self.capacity is not None:
            raise ValueError("una nota 'own' no lleva capacity")
        if self.kind == "shared" and not (self.capacity and self.capacity > 0):
            raise ValueError("una nota 'shared' necesita capacity > 0")
        return self


class NoteCreateOut(NoteState):
    type: Literal["note.create"] = "note.create"


class NoteUpdateIn(Event):
    type: Literal["note.update"] = "note.update"
    id: uuid.UUID
    text: str = Field(max_length=500)
    color: NoteColor


class NoteUpdateOut(Event):
    type: Literal["note.update"] = "note.update"
    id: uuid.UUID
    text: str
    color: NoteColor
    updated_at: datetime


class NoteMoveIn(Event):
    type: Literal["note.move"] = "note.move"
    id: uuid.UUID
    position_x: float
    position_y: float
    status: NoteStatus


class NoteMoveOut(Event):
    type: Literal["note.move"] = "note.move"
    id: uuid.UUID
    position_x: float
    position_y: float
    status: NoteStatus


class NoteDeleteIn(Event):
    type: Literal["note.delete"] = "note.delete"
    id: uuid.UUID


class NoteDeleteOut(Event):
    type: Literal["note.delete"] = "note.delete"
    id: uuid.UUID


# --- cupos: la única concurrencia real (ver tests/test_claims.py) -------------------


class NoteClaimIn(Event):
    type: Literal["note.claim"] = "note.claim"
    note_id: uuid.UUID


class NoteClaimOut(Event):
    type: Literal["note.claim"] = "note.claim"
    note_id: uuid.UUID
    participant_id: uuid.UUID
    taken_count: int


class NoteClaimRejected(Event):
    """Enviado solo al socket que lo pidió."""

    type: Literal["note.claim_rejected"] = "note.claim_rejected"
    note_id: uuid.UUID
    participant_id: uuid.UUID
    reason: Literal["full"]


class NoteReleaseIn(Event):
    type: Literal["note.release"] = "note.release"
    note_id: uuid.UUID


class NoteReleaseOut(Event):
    type: Literal["note.release"] = "note.release"
    note_id: uuid.UUID
    participant_id: uuid.UUID
    taken_count: int


class NoteReleaseRejected(Event):
    """Enviado solo al socket que lo pidió: intentó soltar un cupo que no tenía
    (doble clic, o estado desincronizado con el servidor)."""

    type: Literal["note.release_rejected"] = "note.release_rejected"
    note_id: uuid.UUID
    participant_id: uuid.UUID
    reason: Literal["not_held"]


# --- reacciones ------------------------------------------------------------------


class ReactionToggleIn(Event):
    type: Literal["reaction.toggle"] = "reaction.toggle"
    note_id: uuid.UUID
    emoji: Reaction


class ReactionToggleOut(Event):
    type: Literal["reaction.toggle"] = "reaction.toggle"
    note_id: uuid.UUID
    participant_id: uuid.UUID
    emoji: Reaction
    active: bool


# --- chat --------------------------------------------------------------------------


class ChatMessageIn(Event):
    type: Literal["chat.message"] = "chat.message"
    id: uuid.UUID
    note_id: uuid.UUID | None
    text: str = Field(min_length=1, max_length=1000)


class ChatMessageOut(ChatMessageState):
    type: Literal["chat.message"] = "chat.message"


# --- sala ----------------------------------------------------------------------------


class RoomBackgroundIn(Event):
    type: Literal["room.background"] = "room.background"
    background: Background


class RoomBackgroundOut(Event):
    type: Literal["room.background"] = "room.background"
    background: Background


# --- error genérico (enviado solo al socket que lo disparó) -------------------------


class ErrorEvent(Event):
    type: Literal["error"] = "error"
    code: Literal["forbidden", "invalid_message", "not_found"]
    message: str
    # Presente cuando el error se puede atribuir a una nota puntual (p. ej. el
    # "forbidden" de note.update/note.move sobre una nota ajena), para que el cliente
    # sepa qué edición optimista revertir.
    note_id: uuid.UUID | None = None


# --- keepalive -------------------------------------------------------------------


class Ping(Event):
    type: Literal["ping"] = "ping"


class Pong(Event):
    type: Literal["pong"] = "pong"


# --- efímeros: no se persisten (invariante 6) ---------------------------------------


class PresenceCursorIn(Ephemeral, Event):
    type: Literal["presence.cursor"] = "presence.cursor"
    x: float
    y: float


class PresenceCursorOut(Ephemeral, Event):
    type: Literal["presence.cursor"] = "presence.cursor"
    participant_id: uuid.UUID
    x: float
    y: float


class PresenceDraggingIn(Ephemeral, Event):
    type: Literal["presence.dragging"] = "presence.dragging"
    note_id: uuid.UUID
    position_x: float
    position_y: float


class PresenceDraggingOut(Ephemeral, Event):
    type: Literal["presence.dragging"] = "presence.dragging"
    participant_id: uuid.UUID
    note_id: uuid.UUID
    position_x: float
    position_y: float


class PresenceDraftingIn(Ephemeral, Event):
    type: Literal["presence.drafting"] = "presence.drafting"
    kind: NoteKind
    position_x: float
    position_y: float
    active: bool


class PresenceDraftingOut(Ephemeral, Event):
    type: Literal["presence.drafting"] = "presence.drafting"
    participant_id: uuid.UUID
    kind: NoteKind
    position_x: float
    position_y: float
    active: bool


class ChatTypingIn(Ephemeral, Event):
    type: Literal["chat.typing"] = "chat.typing"
    note_id: uuid.UUID | None
    active: bool


class ChatTypingOut(Ephemeral, Event):
    type: Literal["chat.typing"] = "chat.typing"
    participant_id: uuid.UUID
    note_id: uuid.UUID | None
    active: bool


EPHEMERAL_TYPES: Final[frozenset[str]] = frozenset(
    {"presence.cursor", "presence.dragging", "presence.drafting", "chat.typing"}
)


# --- uniones discriminadas ---------------------------------------------------------

_ClientEvent = (
    RoomJoinIn
    | NoteCreateIn
    | NoteUpdateIn
    | NoteMoveIn
    | NoteDeleteIn
    | NoteClaimIn
    | NoteReleaseIn
    | ReactionToggleIn
    | ChatMessageIn
    | RoomBackgroundIn
    | Ping
    | PresenceCursorIn
    | PresenceDraggingIn
    | PresenceDraftingIn
    | ChatTypingIn
)
ClientEvent = Annotated[_ClientEvent, Field(discriminator="type")]

_ServerEvent = (
    RoomSnapshot
    | PresenceJoined
    | PresenceLeft
    | NoteCreateOut
    | NoteUpdateOut
    | NoteMoveOut
    | NoteDeleteOut
    | NoteClaimOut
    | NoteClaimRejected
    | NoteReleaseOut
    | NoteReleaseRejected
    | ReactionToggleOut
    | ChatMessageOut
    | RoomBackgroundOut
    | ErrorEvent
    | Pong
    | PresenceCursorOut
    | PresenceDraggingOut
    | PresenceDraftingOut
    | ChatTypingOut
)
ServerEvent = Annotated[_ServerEvent, Field(discriminator="type")]
