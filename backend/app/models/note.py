import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.chat_message import ChatMessage
    from app.models.note_claim import NoteClaim
    from app.models.participant import Participant
    from app.models.reaction import Reaction
    from app.models.room import Room

NoteKind = Enum("own", "shared", name="note_kind")
NoteStatus = Enum("blocked", "in_progress", "done", name="note_status")


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'own' AND capacity IS NULL) OR "
            "(kind = 'shared' AND capacity IS NOT NULL AND capacity > 0)",
            name="ck_notes_kind_capacity",
        ),
        CheckConstraint("taken_count >= 0", name="ck_notes_taken_count_non_negative"),
        CheckConstraint(
            "capacity IS NULL OR taken_count <= capacity", name="ck_notes_taken_count_le_capacity"
        ),
        CheckConstraint("char_length(text) <= 500", name="ck_notes_text_length"),
        Index("ix_notes_room_id_status", "room_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id: Mapped[str] = mapped_column(
        String(12), ForeignKey("rooms.slug", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("participants.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(NoteKind, nullable=False)
    status: Mapped[str] = mapped_column(NoteStatus, nullable=False, default="in_progress")
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    color: Mapped[str] = mapped_column(String(20), nullable=False)
    position_x: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    position_y: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    capacity: Mapped[int | None] = mapped_column(Integer)
    taken_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    room: Mapped["Room"] = relationship(back_populates="notes")
    author: Mapped["Participant"] = relationship(back_populates="notes")
    claims: Mapped[list["NoteClaim"]] = relationship(
        back_populates="note", cascade="all, delete-orphan", passive_deletes=True
    )
    reactions: Mapped[list["Reaction"]] = relationship(
        back_populates="note", cascade="all, delete-orphan", passive_deletes=True
    )
    chat_messages: Mapped[list["ChatMessage"]] = relationship(back_populates="note")
