"""Engine y sessionmaker de SQLAlchemy.

Lee la URL de `core/config.py`. Sin default embebido en el código en ningún punto de la
cadena: `Settings` revienta al arrancar si falta `DATABASE_URL`, en vez de conectarse
silenciosamente a una base que no es (convención en CLAUDE.md).
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine)
