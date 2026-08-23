import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.chat_message import ChatMessage
    from app.models.note import Note
    from app.models.note_claim import NoteClaim
    from app.models.reaction import Reaction
    from app.models.room import Room


class Participant(Base):
    __tablename__ = "participants"
    __table_args__ = (
        Index(
            "ix_participants_room_active",
            "room_id",
            postgresql_where="disconnected_at IS NULL",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id: Mapped[str] = mapped_column(
        String(12), ForeignKey("rooms.slug", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    avatar: Mapped[str] = mapped_column(String(20), nullable=False)
    color: Mapped[str] = mapped_column(String(20), nullable=False)
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Nunca se borra la fila al desconectar: sostiene notas, cupos, reacciones y
    # mensajes por FK CASCADE, y el mismo id se reactiva al reconectar (invariante 8).
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    room: Mapped["Room"] = relationship(back_populates="participants")
    notes: Mapped[list["Note"]] = relationship(
        back_populates="author", cascade="all, delete-orphan", passive_deletes=True
    )
    note_claims: Mapped[list["NoteClaim"]] = relationship(
        back_populates="participant", cascade="all, delete-orphan", passive_deletes=True
    )
    reactions: Mapped[list["Reaction"]] = relationship(
        back_populates="participant", cascade="all, delete-orphan", passive_deletes=True
    )
    chat_messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="author", cascade="all, delete-orphan", passive_deletes=True
    )
