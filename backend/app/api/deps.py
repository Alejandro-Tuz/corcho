"""Dependencias de FastAPI para `api/v1/`. Solo `get_db`: una `Session` por request,
cerrada al final -el endpoint sigue siendo quien decide el `commit` (mismo criterio que
`realtime/endpoint.py` con una sesión por mensaje)."""

from collections.abc import Iterator

from sqlalchemy.orm import Session

from app.db.session import SessionLocal


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
