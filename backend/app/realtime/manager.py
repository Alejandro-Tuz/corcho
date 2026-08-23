"""ConnectionManager: sockets locales de este worker, en memoria. No sabe nada de
Redis ni de la base de datos -eso es de `realtime/broker.py` y de `services/`-.

Guarda un `set[WebSocket]` por participante, no un contador: un set da gratis contar
(`len()`), iterar para el broadcast de la sala, y remover un socket puntual sin
recorrer nada. `connect`/`disconnect` devuelven si esta fue la transición real
(primer/último socket de esa persona en esa sala), tal como pide la decisión de
multi-pestaña de CLAUDE.md: `disconnected_at` solo se marca cuando se cierra el último
socket. Esa transición es lo único que le importa al caller para decidir si toca la
base y difunde `presence.joined`/`presence.left`; el resto de las pestañas de la misma
persona no generan ningún evento.
"""

import logging
import uuid

from fastapi import WebSocket

from app.realtime.protocol import ServerEvent

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        # room_slug -> participant_id -> sockets vivos de esa persona en esa sala.
        # Diccionarios planos, no defaultdict: disconnect() no debe crear entradas
        # fantasma al consultar una sala o un participante que nunca existieron.
        self._rooms: dict[str, dict[uuid.UUID, set[WebSocket]]] = {}

    def connect(self, room: str, participant_id: uuid.UUID, websocket: WebSocket) -> bool:
        """Registra el socket. True si es el primer socket de este participante en la
        sala -la transición real a "conectado"-. False si ya tenía otra pestaña
        abierta: el caller no debe tocar disconnected_at ni difundir presence.joined."""
        participants = self._rooms.setdefault(room, {})
        sockets = participants.setdefault(participant_id, set())
        is_first = len(sockets) == 0
        sockets.add(websocket)
        return is_first

    def disconnect(self, room: str, participant_id: uuid.UUID, websocket: WebSocket) -> bool:
        """Da de baja el socket. True si esta llamada deja a la persona sin ningún
        socket vivo en la sala -la transición real a "desconectado"-. False si le
        quedan otras pestañas, o si el participante ya no está en el mapa (llamada
        duplicada, o `broadcast()` ya encontró este mismo socket muerto al intentar
        enviarle -ver esa función-: en ningún caso hay algo más que desconectar).

        A propósito NO se exige que `websocket` siga presente en el set antes de
        descartarlo (`discard` es un no-op si ya no está): el único idempotente real
        es "¿sigue el participante en el mapa?", no "¿seguía este socket puntual?".
        Si se exigiera lo segundo, un socket que `broadcast()` ya limpió oportunistamente
        haría que esta llamada devolviera False por las razones equivocadas, y la
        persona quedaría fantasma -conectada para siempre a los ojos de la sala-."""
        participants = self._rooms.get(room)
        if participants is None or participant_id not in participants:
            return False

        sockets = participants[participant_id]
        sockets.discard(websocket)
        is_last = len(sockets) == 0
        if is_last:
            self._forget_participant(room, participant_id)
        return is_last

    def _forget_participant(self, room: str, participant_id: uuid.UUID) -> None:
        participants = self._rooms.get(room)
        if participants is None:
            return
        participants.pop(participant_id, None)
        if not participants:
            self._rooms.pop(room, None)

    async def send_to_socket(self, websocket: WebSocket, event: ServerEvent) -> None:
        """Un socket puntual: room.snapshot, note.claim_rejected,
        note.release_rejected, error. Eventos que responden a quien pidió algo, no a
        toda la sala."""
        await websocket.send_text(event.model_dump_json())

    async def broadcast(self, room: str, event: ServerEvent) -> None:
        """Todos los sockets de la sala. Itera secuencial -escala de sala de demo, no
        hace falta asyncio.gather-. Un socket que falla al recibir (pestaña cerrada a
        mitad de camino: el caso normal, no una excepción rara) no debe cortar el
        envío a los demás; se descarta de la contabilidad ahí mismo, como limpieza
        oportunista. Esto no dispara disconnected_at ni presence.left -esa decisión
        sigue siendo del endpoint cuando FastAPI le tire WebSocketDisconnect-."""
        participants = self._rooms.get(room)
        if not participants:
            return

        payload = event.model_dump_json()
        for participant_id, sockets in list(participants.items()):
            for websocket in list(sockets):
                try:
                    await websocket.send_text(payload)
                except Exception:
                    logger.debug(
                        "Socket muerto en broadcast, se descarta (room=%s participant=%s)",
                        room,
                        participant_id,
                    )
                    # Solo se saca ESTE socket del set. A propósito no se llama acá a
                    # `_forget_participant` aunque el set quede vacío: decidir la
                    # transición a "desconectado" (disconnected_at, presence.left) es
                    # exclusivo de `disconnect()`, para que no importe qué tarea de
                    # asyncio nota primero que el socket está muerto -la del dueño en
                    # su propio receive_text(), o esta misma en medio de un broadcast
                    # ajeno-. Si acá se "olvidara" al participante, el `disconnect()`
                    # legítimo que llega después ya no lo encontraría en el mapa y la
                    # persona quedaría fantasma: "conectada" para siempre en la sala.
                    sockets.discard(websocket)
