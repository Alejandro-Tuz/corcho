"""Entrada/salida REST de `/rooms`. Invariante 5: lo que sale por la API pasa por acá,
nunca el modelo ORM directo."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.core.constants import Background


class RoomCreateIn(BaseModel):
    name: str | None = Field(default=None, max_length=80)


class RoomCreateOut(BaseModel):
    slug: str
    name: str | None
    background: Background
    created_at: datetime
