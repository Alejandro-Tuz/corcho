"""La ruta `/ws/{room}`: todo el ciclo de vida de una conexión, desde `accept()` hasta
que el socket se cae. Acá vive el ciclo de vida -sesión de base de datos por mensaje,
`room.join` como caso especial, limpieza al desconectar-, nunca lógica de negocio:
todo mensaje posterior al join se despacha entero a `realtime/handlers.py`
(invariante 2).

`ConnectionManager` y `RedisBroker` viven en `app.state`, cableados una vez en el
`lifespan` de `main.py` -acá solo se leen.

Tolerancia a mensajes corruptos, igual que `broker.py._listen`: un JSON malformado o
que no valida contra `ClientEvent` no tumba la conexión ni el bucle, salvo el caso
especial de `room.join` contra una sala inexistente (`_join`), donde no hay
recuperación posible y cerrar el socket es lo correcto -el slug no va a empezar a
existir por esperar más mensajes.
"""

import contextlib
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter
from redis.asyncio import Redis
from starlette.websockets import WebSocketState

from app.db.session import SessionLocal
from app.realtime import handlers
from app.realtime.broker import RedisBroker
from app.realtime.manager import ConnectionManager
from app.realtime.protocol import (
    ClientEvent,
    ErrorEvent,
    ParticipantState,
    PresenceJoined,
    PresenceLeft,
    RoomJoinIn,
    RoomSnapshot,
    SummaryState,
)
from app.services import rooms, summary
from app.services.rooms import JoinOutcome

logger = logging.getLogger(__name__)
router = APIRouter()

_client_event: TypeAdapter[ClientEvent] = TypeAdapter(ClientEvent)


def _parse_event(raw: str) -> ClientEvent | None:
    """`None` si `raw` no es JSON válido, o es JSON que no valida contra la unión
    discriminada `ClientEvent` (tipo desconocido, campo faltante, un `extra="forbid"`
    que salta). Mismo criterio de tolerancia que `broker.py._listen`: un mensaje
    corrupto no puede tumbar nada, así que acá se atrapa cualquier excepción -no solo
    `ValidationError`- y se devuelve `None` para que el caller decida qué hacer."""
    try:
        return _client_event.validate_json(raw)
    except Exception:
        return None


@router.websocket("/ws/{room}")
async def websocket_endpoint(websocket: WebSocket, room: str) -> None:
    manager: ConnectionManager = websocket.app.state.manager
    broker: RedisBroker = websocket.app.state.broker
    redis = websocket.app.state.redis

    await websocket.accept()

    join_result = await _join(websocket, room, redis)
    if join_result is None:
        return  # ya resuelto adentro de _join: cierre limpio, o el cliente se fue
    participant, snapshot = join_result

    is_first = manager.connect(room, participant.id, websocket)
    try:
        await manager.send_to_socket(websocket, snapshot)
        if is_first:
            await broker.publish(room, PresenceJoined(**participant.model_dump()))

        await _message_loop(websocket, room, participant.id, manager, broker)
    except WebSocketDisconnect:
        pass
    finally:
        await _leave(websocket, room, participant.id, manager, broker)


async def _join(
    websocket: WebSocket, room: str, redis: Redis
) -> tuple[ParticipantState, RoomSnapshot] | None:
    """Primer mensaje del socket: tiene que ser `room.join`. Devuelve `None` -tras
    mandar el error correspondiente y cerrar el socket, o sin mandar nada si el
    cliente ya se fue- en dos casos bien distintos:

    - El cliente se desconecta antes de mandar nada, o antes de mandar un
      `room.join` válido: no hay nada que limpiar, nunca se llegó a registrar en
      `manager`.
    - `room.join` bien formado, pero contra una sala que no existe
      (`JoinOutcome.ROOM_NOT_FOUND`): a diferencia de un mensaje corrupto -del que sí
      vale la pena esperar un reintento, ver el `continue` más abajo-, un slug
      inexistente no va a empezar a existir. Cerrar acá es lo correcto, no hay nada
      por lo que seguir esperando."""
    while True:
        try:
            raw = await websocket.receive_text()
        except WebSocketDisconnect:
            return None

        event = _parse_event(raw)
        if not isinstance(event, RoomJoinIn):
            # JSON corrupto, o un tipo de evento que no es room.join: se avisa y se
            # sigue esperando -mismo criterio que `broker._listen` con un mensaje
            # corrupto, no tumba nada-. El envío es de mejor esfuerzo: si ya falla,
            # el socket se fue y no hay a quién seguir esperando.
            try:
                await websocket.send_text(
                    ErrorEvent(
                        code="invalid_message",
                        message="el primer mensaje tiene que ser room.join",
                    ).model_dump_json()
                )
            except Exception:
                return None
            continue

        with SessionLocal() as session:
            result = rooms.join_room(
                session,
                room,
                participant_id=event.participant_id,
                name=event.name,
                avatar=event.avatar,
                color=event.color,
            )
            if result.outcome is JoinOutcome.ROOM_NOT_FOUND:
                session.rollback()
                await websocket.send_text(
                    ErrorEvent(code="not_found", message="la sala no existe").model_dump_json()
                )
                await websocket.close(code=4004)
                return None

            assert result.participant is not None  # solo None junto con ROOM_NOT_FOUND
            snapshot = rooms.get_snapshot(session, room, participant_id=result.participant.id)
            session.commit()

        assert snapshot is not None  # la sala existe: se acaba de confirmar arriba

        # `rooms.get_snapshot` siempre deja `summary` en None -no tiene Redis-. Se
        # completa acá, ya con la sesión de Postgres cerrada: el último resumen con
        # IA vive en Redis (`services/summary.py`), no en la base.
        last_summary = await summary.get_last(redis, room)
        if last_summary is not None:
            snapshot = snapshot.model_copy(
                update={
                    "summary": SummaryState(
                        text=last_summary.text, generated_at=last_summary.generated_at
                    )
                }
            )
        return result.participant, snapshot


async def _message_loop(
    websocket: WebSocket,
    room: str,
    participant_id: uuid.UUID,
    manager: ConnectionManager,
    broker: RedisBroker,
) -> None:
    """Cada mensaje entrante es su propia transacción: se abre una `Session`, se
    despacha a `handlers.py`, se commitea, se cierra -nunca una sesión que viva más
    que un solo mensaje. La única salida normal de este bucle es `WebSocketDisconnect`
    desde `receive_text()`, deliberadamente fuera del `try`: cualquier otra excepción
    -de parseo o de `handlers.dispatch`- se atrapa, se logea y el bucle sigue, para
    que un handler roto no tumbe el resto de la conexión (mismo criterio que
    `broker._listen`).

    `broker.publish()` del evento que `handlers.dispatch` devuelve se llama recién acá
    -después de `session.commit()`, con la sesión ya cerrada-, nunca desde adentro de
    `handlers.py`. Bug real encontrado: antes, `dispatch()` publicaba él mismo, así
    que el `commit()` -y el lock de Postgres de esa escritura- esperaba a que
    terminara de repartirse a toda la sala. Un socket lento o medio muerto en esa
    sala dejaba el lock tomado mucho más de lo que la escritura en sí necesitaba, y
    cualquier otra persona reclamando el mismo cupo se quedaba esperando ese lock sin
    saber por qué. Ver también el docstring de `handlers.dispatch`.

    Si `manager.send_to_socket()` (una respuesta solo-para-quien-pidió, adentro de
    `handlers.dispatch`) le falla a ESTE MISMO socket porque ya está desconectado, eso
    también cae acá como una excepción cualquiera -no necesariamente
    `WebSocketDisconnect`, Starlette no siempre usa esa clase para "ya estás
    desconectado"-. Sin el chequeo de `application_state` de abajo, el bucle seguía
    de largo y el próximo `receive_text()` reventaba con un `RuntimeError` distinto
    ("WebSocket is not connected") que no atrapa nada río arriba -tumbaba el proceso
    entero, bug real encontrado y reproducido a propósito con un socket matado a la
    fuerza en medio de una carrera de cupos-. Comprobar el estado real del socket
    después de cualquier excepción, en vez de intentar enumerar cada clase de
    excepción que Starlette podría tirar, es lo que hace que este chequeo no dependa
    de adivinar bien esa lista."""
    while True:
        raw = await websocket.receive_text()

        event = _parse_event(raw)
        if event is None:
            with contextlib.suppress(Exception):
                await manager.send_to_socket(
                    websocket, ErrorEvent(code="invalid_message", message="mensaje inválido")
                )
            continue

        try:
            broadcast_event = None
            with SessionLocal() as session:
                broadcast_event = await handlers.dispatch(
                    session, room, participant_id, event, websocket, manager
                )
                session.commit()
            if broadcast_event is not None:
                await broker.publish(room, broadcast_event)
        except Exception:
            logger.exception(
                "Fallo manejando %s en sala %s (participant=%s)", event.type, room, participant_id
            )
            if websocket.application_state != WebSocketState.CONNECTED:
                # El socket ya no sirve para nada -alguna respuesta a ESTE mensaje
                # falló al mandarse porque ya está desconectado-. Cortar acá en vez
                # de seguir el bucle, tal como si hubiera llegado el disconnect por
                # el camino esperado (ver docstring de arriba).
                raise WebSocketDisconnect(code=1006) from None


async def _leave(
    websocket: WebSocket,
    room: str,
    participant_id: uuid.UUID,
    manager: ConnectionManager,
    broker: RedisBroker,
) -> None:
    """Se ejecuta siempre, salga como salga `_message_loop` -desconexión normal,
    excepción no atrapada, lo que sea-. `manager.disconnect()` decide si esta persona
    se queda sin ningún socket vivo en la sala; si le quedan otras pestañas, no se
    toca la base ni se difunde nada."""
    is_last = manager.disconnect(room, participant_id, websocket)
    if not is_last:
        return
    with SessionLocal() as session:
        rooms.mark_disconnected(session, participant_id)
        session.commit()
    await broker.publish(room, PresenceLeft(participant_id=participant_id))
