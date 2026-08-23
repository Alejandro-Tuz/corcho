"""Punto de entrada de FastAPI. El `lifespan` cablea lo que vive más que un solo
request: el cliente de Redis, el `ConnectionManager` (sockets locales de este worker,
en memoria) y el `RedisBroker` (puente pub/sub) -ver `realtime/manager.py` y
`realtime/broker.py`. Los dos cuelgan de `app.state` porque tanto `api/v1/` como
`realtime/endpoint.py` los necesitan, y un framework de DI más pesado no se justifica
para un proyecto de 3 días."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from app.api.v1.router import router as api_v1_router
from app.core.redis import redis_pool
from app.realtime.broker import RedisBroker
from app.realtime.endpoint import router as realtime_router
from app.realtime.manager import ConnectionManager


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    manager = ConnectionManager()
    redis = Redis(connection_pool=redis_pool)
    broker = RedisBroker(manager, redis)
    await broker.start()

    app.state.manager = manager
    app.state.broker = broker

    try:
        yield
    finally:
        await broker.stop()
        await redis.aclose()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Un único origen: el dev server de Vite. Nota: esto gobierna las peticiones REST
    # (/api/v1/*); el handshake de /ws/{room} no pasa por CORSMiddleware -los
    # navegadores no aplican CORS a WebSockets- así que no es lo que protege esa ruta.
    # No hace falta que lo sea: sin tokens firmados, quien tiene el link ya tiene
    # acceso a todo (decisión ya tomada, CLAUDE.md).
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_v1_router)
app.include_router(realtime_router)
