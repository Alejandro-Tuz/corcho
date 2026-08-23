"""Configuración de la app.

Solo lo que hace falta para `db/session.py`, `core/redis.py` y `realtime/broker.py` por
ahora -no repuebla `CORS_ORIGINS`, `ENVIRONMENT` ni `PUBLIC_BASE_URL` del `.env`, eso es
de otra pasada-.

`database_url` y `redis_url` no llevan default: son configuración de infraestructura, y
un fallback las convertiría en "conectado a lo equivocado" en vez de "falla en el
arranque" (convención en CLAUDE.md). Si falta cualquiera de las dos en el entorno o en
`.env`, `Settings()` revienta con un `ValidationError` al importar el módulo.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    database_url: str
    redis_url: str


settings = Settings()
