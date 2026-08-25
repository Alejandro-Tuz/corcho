"""Configuración de la app.

Solo lo que hace falta para `db/session.py`, `core/redis.py` y `realtime/broker.py` por
ahora -no repuebla `CORS_ORIGINS`, `ENVIRONMENT` ni `PUBLIC_BASE_URL` del `.env`, eso es
de otra pasada-.

`database_url` y `redis_url` no llevan default: son configuración de infraestructura, y
un fallback las convertiría en "conectado a lo equivocado" en vez de "falla en el
arranque" (convención en CLAUDE.md). Si falta cualquiera de las dos en el entorno o en
`.env`, `Settings()` revienta con un `ValidationError` al importar el módulo.

`ai_api_key` es la única excepción a propósito a esa regla: sin ella, el resumen con IA
(`services/summary.py`) no es infraestructura de la que dependa el resto de la app -sin
la clave, notas, cupos y chat siguen funcionando igual, solo esa función puntual queda
apagada (`summary.start()` devuelve `UNAVAILABLE` antes de tocar Redis). Obligarla sin
default dejaría sin arrancar a cualquiera que levante el proyecto sin configurar IA, que
es la situación por default hasta que se configure para el deploy.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    database_url: str
    redis_url: str
    ai_api_key: str | None = None


settings = Settings()
