"""Puente Redis pub/sub <-> ConnectionManager.

Un canal por sala (`room:{slug}`) del lado de publicación. Del lado de suscripción, una
sola tarea de fondo con un único `PSUBSCRIBE room:*` -no una suscripción por sala que
haya que abrir y cerrar según qué salas están activas en cada momento-.

`publish()` es el único camino desde `handlers.py` hacia los sockets: nadie debe llamar
`ConnectionManager.broadcast()` directamente. Cada mensaje publicado lleva el id de
este worker; la tarea de fondo descarta los que llevan su propio id, porque esos ya se
entregaron en el `publish()` que los originó. Sin ese filtro, los clientes de este
worker verían cada evento dos veces.
"""

import asyncio
import contextlib
import json
import logging
import uuid

from pydantic import TypeAdapter
from redis.asyncio import Redis

from app.realtime.manager import ConnectionManager
from app.realtime.protocol import ServerEvent

logger = logging.getLogger(__name__)

_CHANNEL_PATTERN = "room:*"
_server_event = TypeAdapter(ServerEvent)


def _channel(room: str) -> str:
    return f"room:{room}"


class RedisBroker:
    def __init__(self, manager: ConnectionManager, redis: Redis) -> None:
        self._manager = manager
        self._redis = redis
        # Un id por proceso worker, no por sala ni por mensaje: es lo que la tarea de
        # fondo compara contra cada mensaje entrante para saber si lo publicó este
        # mismo worker.
        self._instance_id = uuid.uuid4().hex
        self._pubsub = None
        self._task: asyncio.Task[None] | None = None

    async def publish(self, room: str, event: ServerEvent) -> None:
        """Entrega local primero, Redis después -en ese orden, no son atómicas entre
        sí-. Si el `publish` a Redis falla después de que la entrega local ya
        funcionó, los sockets de este worker ya vieron el evento, pero los de otros
        workers nunca lo verán: con una sola instancia en Render esto no muerde
        -no hay "otros workers" a quienes avisar-, pero queda escrito para no
        descubrirlo recién al escalar."""
        await self._manager.broadcast(room, event)

        envelope = {"origin": self._instance_id, "event": event.model_dump(mode="json")}
        await self._redis.publish(_channel(room), json.dumps(envelope))

    async def start(self) -> None:
        self._pubsub = self._redis.pubsub()
        await self._pubsub.psubscribe(_CHANNEL_PATTERN)
        self._task = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._pubsub is not None:
            await self._pubsub.punsubscribe(_CHANNEL_PATTERN)
            await self._pubsub.aclose()
            self._pubsub = None

    async def _listen(self) -> None:
        assert self._pubsub is not None
        async for message in self._pubsub.listen():
            if message["type"] != "pmessage":
                continue
            try:
                envelope = json.loads(message["data"])
                if envelope["origin"] == self._instance_id:
                    continue
                room = message["channel"].removeprefix("room:")
                event = _server_event.validate_python(envelope["event"])
            except Exception:
                # Un mensaje corrupto (JSON malformado, un evento que no valida contra
                # ServerEvent) no puede tumbar la tarea entera: si se deja escapar acá,
                # asyncio no lo propaga a ningún lado -la app sigue viva, pero el
                # pub/sub de todas las salas queda muerto en silencio-. Se registra y
                # se sigue con el próximo mensaje.
                logger.exception("Mensaje inválido en %s, se descarta", message.get("channel"))
                continue

            await self._manager.broadcast(room, event)
