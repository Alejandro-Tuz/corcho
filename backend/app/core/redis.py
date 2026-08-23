"""Pool de conexión a Redis. Nada más -el pub/sub vive en `realtime/broker.py`-.

`decode_responses=True`: todo lo que circula por Redis en este proyecto es texto
(JSON de `realtime/broker.py`), así que no tiene sentido andar decodificando bytes a
mano en cada lugar que lo consuma.
"""

from redis.asyncio import ConnectionPool

from app.core.config import settings

redis_pool = ConnectionPool.from_url(settings.redis_url, decode_responses=True)
