"""POST /rooms: crear una sala. Nada de unirse ni de snapshot -eso es `room.join` por
WebSocket, no REST (CLAUDE.md: "api/v1/ -- solo lo imprescindible: crear sala y
health. Nada más; el resto va por WebSocket")."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.rooms import RoomCreateIn, RoomCreateOut
from app.services import rooms

router = APIRouter()


@router.post("/rooms", response_model=RoomCreateOut, status_code=201)
def create_room(payload: RoomCreateIn, session: Session = Depends(get_db)) -> RoomCreateOut:
    room = rooms.create_room(session, name=payload.name)
    session.commit()
    return RoomCreateOut(
        slug=room.slug, name=room.name, background=room.background, created_at=room.created_at
    )
