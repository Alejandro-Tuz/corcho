"""Modo teatro (CLAUDE.md, "Comprometido, pendiente" #3): abre conexiones WebSocket
reales contra una sala ya existente para simular actividad de otras personas durante
la demo. Tráfico auténtico por `/ws/{room}` -mismo protocolo que un cliente real,
`realtime/protocol.py`-, nada simulado del lado del frontend.

Cada participante ficticio:
- se une con `room.join` (como cualquier cliente nuevo),
- mueve el cursor con pausas variables (`presence.cursor`),
- crea un par de notas propias y las arrastra entre columnas (`presence.dragging` +
  `note.move`) -solo notas PROPIAS: `services/notes.py` valida autoría, así que
  arrastrar una nota ajena rebotaría con un `error` genérico sin efecto visible,
- toma y suelta cupos de notas compartidas ya sembradas (`note.claim`/`note.release`),
- reacciona a notas de cualquiera (`reaction.toggle`, sin restricción de autoría),
- manda algún mensaje de chat (`chat.message`).

Uso (desde `backend\\`, con el venv activo):
    python scripts\\theater.py <slug>
    python scripts\\theater.py <slug> --participants 2
    python scripts\\theater.py <slug> --url ws://localhost:8000

Ctrl+C corta limpio sin nada especial que escribir para eso: `asyncio.run()` ya
cancela las tareas pendientes antes de cerrar el loop, y esa cancelación atraviesa el
`async with websockets.connect(...)` de cada participante -su `__aexit__` manda el
cierre del socket. Es la misma señal que ya usa cualquier pestaña real al cerrarse
(`realtime/endpoint.py._leave`): el servidor no necesita un mensaje de protocolo
aparte para "me voy", solo que el socket se cierre.
"""

import argparse
import asyncio
import contextlib
import json
import random
import sys
import uuid

import websockets

FAKE_PARTICIPANTS = [
    {"name": "Marce", "avatar": "penguin", "color": "sky"},
    {"name": "Tavo", "avatar": "bee", "color": "rose"},
    {"name": "Male", "avatar": "hedgehog", "color": "violet"},
]

CHAT_LINES = [
    "che, ¿cómo van con esto?",
    "ya casi termino la mía",
    "dale, me anoto",
    "buenísimo",
    "¿alguien se puede sumar acá?",
    "listo, lo dejo marcado",
    "voy a necesitar una mano con esto más tarde",
    "dale dale, vamos bien",
    "un ratito y lo tengo",
]

NOTE_TEXTS = [
    "Revisar los últimos comentarios antes de la entrevista.",
    "Preparar el ambiente para la demo.",
    "Confirmar que todo esté sembrado antes de arrancar.",
    "Avisar cuando esté listo para mostrar.",
]

STATUSES = ["blocked", "in_progress", "done"]
NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange"]
REACTIONS = ["✓", "👀", "🔥"]

MAX_OWN_NOTES = 3


class FakePerson:
    """Una identidad ficticia, una conexión. El estado local de notas
    (`self.notes`) es una copia de trabajo -se llena con `room.snapshot` al unirse
    y se actualiza con lo que el propio broker reenvía-, nunca la fuente de verdad:
    si algo queda desincronizado (p. ej. un cupo que otro participante real toma
    justo antes), la próxima acción sobre esa nota simplemente rebota o no encuentra
    candidatos, no hay nada que reconciliar a mano."""

    def __init__(self, url: str, room: str, spec: dict[str, str]) -> None:
        self.url = url
        self.room = room
        self.spec = spec
        self.ws: websockets.ClientConnection | None = None
        self.participant_id: str | None = None
        # notas creadas por esta identidad, las únicas que puede mover (validación de autoría)
        self.my_notes: list[str] = []
        self.held_claims: set[str] = set()
        self.notes: dict[str, dict] = {}
        self.cursor = (random.uniform(80, 700), random.uniform(80, 500))

    def _log(self, message: str) -> None:
        print(f"[{self.spec['name']}] {message}")

    async def run(self) -> None:
        async with websockets.connect(f"{self.url}/ws/{self.room}") as ws:
            self.ws = ws
            joined = await self._join()
            if not joined:
                return
            listen_task = asyncio.create_task(self._listen())
            try:
                await asyncio.gather(self._cursor_loop(), self._action_loop())
            finally:
                listen_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await listen_task

    async def _send(self, event: dict) -> None:
        assert self.ws is not None
        await self.ws.send(json.dumps(event))

    async def _join(self) -> bool:
        await self._send(
            {
                "type": "room.join",
                "participant_id": None,
                "name": self.spec["name"],
                "avatar": self.spec["avatar"],
                "color": self.spec["color"],
            }
        )
        assert self.ws is not None
        raw = await self.ws.recv()
        event = json.loads(raw)
        if event.get("type") != "room.snapshot":
            self._log(f"no se pudo unir a la sala '{self.room}': {event}")
            return False
        self.participant_id = event["participant_id"]
        for note in event["notes"]:
            self.notes[note["id"]] = note
        self._log(f"conectado ({self.participant_id})")
        return True

    async def _listen(self) -> None:
        assert self.ws is not None
        with contextlib.suppress(websockets.ConnectionClosed):
            async for raw in self.ws:
                self._apply(json.loads(raw))

    def _apply(self, event: dict) -> None:
        """Solo lo que este script necesita para decidir su próxima acción -no un
        espejo completo del store del frontend (`store/roomStore.ts`), que resuelve
        muchos más eventos que acá no importan (reacciones, chat, fondo, resumen)."""
        t = event.get("type")
        if t == "note.create":
            self.notes[event["id"]] = event
        elif t == "note.move":
            note = self.notes.get(event["id"])
            if note is not None:
                note["position_x"] = event["position_x"]
                note["position_y"] = event["position_y"]
                note["status"] = event["status"]
        elif t == "note.delete":
            self.notes.pop(event["id"], None)
            self.my_notes = [nid for nid in self.my_notes if nid != event["id"]]
            self.held_claims.discard(event["id"])
        elif t == "note.claim":
            note = self.notes.get(event["note_id"])
            if note is not None:
                note["taken_count"] = event["taken_count"]
            if event["participant_id"] == self.participant_id:
                self.held_claims.add(event["note_id"])
        elif t == "note.release":
            note = self.notes.get(event["note_id"])
            if note is not None:
                note["taken_count"] = event["taken_count"]
            if event["participant_id"] == self.participant_id:
                self.held_claims.discard(event["note_id"])
        elif t == "note.claim_rejected" and event.get("participant_id") == self.participant_id:
            self.held_claims.discard(event["note_id"])

    # --- cursor: ritmo humano, pausas variables, nunca un intervalo fijo -----------

    async def _cursor_loop(self) -> None:
        while True:
            await asyncio.sleep(random.uniform(0.4, 1.2))
            dx = random.uniform(-50, 50)
            dy = random.uniform(-40, 40)
            x = min(max(self.cursor[0] + dx, 20), 1100)
            y = min(max(self.cursor[1] + dy, 20), 800)
            self.cursor = (x, y)
            await self._send({"type": "presence.cursor", "x": x, "y": y})

    # --- acciones "grandes": pausas bastante más largas y variables -----------------

    async def _action_loop(self) -> None:
        await asyncio.sleep(random.uniform(1.0, 3.0))
        await self._create_note()

        actions = [
            (self._drag_own_note, 3),
            (self._claim_note, 2),
            (self._release_note, 2),
            (self._react, 2),
            (self._chat, 2),
            (self._create_note, 1),
        ]
        weighted = [action for action, weight in actions for _ in range(weight)]

        while True:
            await asyncio.sleep(random.uniform(3.0, 9.0))
            action = random.choice(weighted)
            try:
                await action()
            except websockets.ConnectionClosed:
                raise
            except Exception as exc:  # una acción fallida no puede tumbar la sesión
                self._log(f"acción {action.__name__} falló: {exc}")

    async def _create_note(self) -> None:
        if len(self.my_notes) >= MAX_OWN_NOTES:
            return
        note_id = str(uuid.uuid4())
        text = random.choice(NOTE_TEXTS)
        await self._send(
            {
                "type": "note.create",
                "id": note_id,
                "kind": "own",
                "status": random.choice(STATUSES),
                "text": text,
                "color": random.choice(NOTE_COLORS),
                "position_x": random.uniform(20, 260),
                "position_y": random.uniform(20, 700),
                "capacity": None,
            }
        )
        self.my_notes.append(note_id)
        self._log(f"crea una nota: “{text[:40]}…”")

    async def _drag_own_note(self) -> None:
        candidates = [nid for nid in self.my_notes if nid in self.notes]
        if not candidates:
            return
        note_id = random.choice(candidates)
        note = self.notes[note_id]
        start_x, start_y = note["position_x"], note["position_y"]
        target_x = random.uniform(20, 260)
        target_y = random.uniform(20, 700)
        target_status = random.choice(STATUSES) if random.random() < 0.4 else note["status"]

        steps = random.randint(3, 6)
        for i in range(1, steps + 1):
            ix = start_x + (target_x - start_x) * i / steps
            iy = start_y + (target_y - start_y) * i / steps
            await self._send(
                {
                    "type": "presence.dragging",
                    "note_id": note_id,
                    "position_x": ix,
                    "position_y": iy,
                }
            )
            await asyncio.sleep(random.uniform(0.08, 0.2))

        await self._send(
            {
                "type": "note.move",
                "id": note_id,
                "position_x": target_x,
                "position_y": target_y,
                "status": target_status,
            }
        )
        note["position_x"], note["position_y"], note["status"] = target_x, target_y, target_status
        self._log(f"arrastra una nota a '{target_status}'")

    async def _claim_note(self) -> None:
        candidates = [
            nid
            for nid, note in self.notes.items()
            if note.get("kind") == "shared"
            and note.get("capacity") is not None
            and note.get("taken_count", 0) < note["capacity"]
            and nid not in self.held_claims
        ]
        if not candidates:
            return
        note_id = random.choice(candidates)
        await self._send({"type": "note.claim", "note_id": note_id})
        self._log("toma un cupo")

    async def _release_note(self) -> None:
        if not self.held_claims:
            return
        note_id = random.choice(list(self.held_claims))
        await self._send({"type": "note.release", "note_id": note_id})
        self._log("suelta un cupo")

    async def _react(self) -> None:
        if not self.notes:
            return
        note_id = random.choice(list(self.notes.keys()))
        emoji = random.choice(REACTIONS)
        await self._send({"type": "reaction.toggle", "note_id": note_id, "emoji": emoji})
        self._log(f"reacciona con {emoji}")

    async def _chat(self) -> None:
        note_id = None
        if self.notes and random.random() < 0.4:
            note_id = random.choice(list(self.notes.keys()))
        text = random.choice(CHAT_LINES)
        await self._send(
            {
                "type": "chat.message",
                "id": str(uuid.uuid4()),
                "note_id": note_id,
                "text": text,
            }
        )
        self._log(f"manda un mensaje: “{text}”")


async def main_async(url: str, room: str, participant_count: int) -> None:
    specs = FAKE_PARTICIPANTS[:participant_count]
    people = [FakePerson(url, room, spec) for spec in specs]
    tasks = [
        asyncio.create_task(person.run(), name=spec["name"])
        for person, spec in zip(people, specs, strict=True)
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Modo teatro: actividad falsa contra una sala real."
    )
    parser.add_argument("room", help="slug de la sala ya sembrada (scripts/seed.py la imprime)")
    parser.add_argument(
        "--participants",
        type=int,
        default=3,
        choices=range(1, len(FAKE_PARTICIPANTS) + 1),
        help="cuántas identidades ficticias abrir (1-3, default 3)",
    )
    parser.add_argument(
        "--url",
        default="ws://localhost:8000",
        help="base del backend, sin /ws/{room} (default ws://localhost:8000)",
    )
    args = parser.parse_args()

    # La consola de Windows no siempre arranca en UTF-8 (codepage 1252 por default) -sin
    # esto, el primer emoji que se intenta imprimir (una reacción, un mensaje de chat)
    # revienta con UnicodeEncodeError. Silencioso si la salida ya está en UTF-8 (Linux/
    # mac, o una consola ya reconfigurada).
    with contextlib.suppress(Exception):
        sys.stdout.reconfigure(encoding="utf-8")

    print(
        f"Modo teatro sobre '{args.room}' con {args.participants} participante(s). "
        "Ctrl+C para cortar."
    )
    try:
        asyncio.run(main_async(args.url, args.room, args.participants))
    except KeyboardInterrupt:
        pass
    print("\nCortado. Participantes desconectados.")


if __name__ == "__main__":
    main()
