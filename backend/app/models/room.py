from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.chat_message import ChatMessage
    from app.models.note import Note
    from app.models.participant import Participant


class Room(Base):
    __tablename__ = "rooms"

    slug: Mapped[str] = mapped_column(String(12), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(80))
    background: Mapped[str] = mapped_column(String(20), nullable=False, default="grid")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    participants: Mapped[list["Participant"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", passive_deletes=True
    )
    notes: Mapped[list["Note"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", passive_deletes=True
    )
    chat_messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", passive_deletes=True
    )
