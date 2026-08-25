"""Resumen del tablero generado por IA (CLAUDE.md, "Nuevo, aprobado" #5).

Primer service async del proyecto: a diferencia de `claims.py`/`notes.py`/`rooms.py`/
`chat.py`, no solo lee o escribe Postgres con una `Session` síncrona -necesita `await`
tanto al cliente Redis (ya async en el proyecto, `realtime/broker.py`) como a la
llamada de red a la API de Anthropic. `_build_prompt` es la única parte que toca la
base, y lo hace síncrono con una `Session` efímera propia, igual que cualquier otro
consumo puntual de `SessionLocal` (p. ej. `endpoint.py._leave`).

## Por qué esto no bloquea el loop del socket

`realtime/handlers.py` solo llama a `start()` desde `_dispatch` -dos operaciones de
Redis, milisegundos, nada que espere a la IA-. Si acepta, `handlers.py` lanza
`generate_and_publish()` con `asyncio.create_task(...)` y sigue de largo sin esperarla:
la llamada lenta corre desatada del mensaje que la disparó, en su propia tarea, con su
propia `Session`. Para cuando `generate_and_publish` termina, el turno del socket que
la disparó ya cerró hace rato.

## Por qué `generate_and_publish` publica ella misma

La regla de `handlers.py` (nunca publicar antes de que `endpoint.py` haga
`session.commit()`, para no dejar un lock de Postgres esperando al broadcast) no aplica
acá: no hay ninguna fila bloqueada mientras se espera a la IA -la `Session` que lee el
tablero ya se cerró antes de esa llamada-, y esta función ni siquiera corre dentro del
ciclo del mensaje que la disparó. Es la única función del proyecto que llama
`broker.publish()` por su cuenta, y es justo por correr suelta y fuera de turno.

## Límite de uso: dos claves de Redis, no una

`corcho:summary:lock:{room}` es el gate atómico contra pedidos concurrentes (`SET NX`,
TTL corto: red de seguridad si la tarea revienta sin liberarlo, no el tiempo esperado
real). `corcho:summary:cooldown:{room}` es el límite de uso real (`SET` con TTL de
minutos). El lock se toma primero: es el único punto de carrera real, y solo quien se
queda con el lock llega a mirar el cooldown -así no hace falta una operación atómica
combinada. El cooldown se cobra al ACEPTAR el pedido, no al terminar: así una IA lenta
o caída no habilita un reintento inmediato en loop (decisión de producto ya tomada).

## Persistencia del último resumen

`corcho:summary:last:{room}` guarda el último resultado EXITOSO -nunca uno fallido-,
para que `room.snapshot` se lo muestre a quien se une después (persistencia B, ver el
diseño: Redis, no Postgres -no es una fuente de verdad de negocio, invariante 1-. Un
reinicio de Redis lo pierde, igual que el resto de lo que vive ahí.
"""

import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from enum import Enum, auto
from typing import NamedTuple

import anthropic
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.note import Note
from app.models.room import Room
from app.realtime.broker import RedisBroker
from app.realtime.protocol import RoomSummary

logger = logging.getLogger(__name__)

_COOLDOWN_SECONDS = 300  # un resumen por sala cada 5 minutos
_LOCK_TTL_SECONDS = 60  # red de seguridad, no el tiempo esperado real
_AI_TIMEOUT_SECONDS = 20
_MODEL = "claude-haiku-4-5"
_MAX_TOKENS = 300

# Duplica a propósito las etiquetas de `features/canvas/columns.ts` /
# `store/activity.ts` -tres strings fijos, no un catálogo que vaya a cambiar de un
# lado sin el otro, y el backend no depende del frontend (mismo criterio que ya
# documenta activity.ts para su propia duplicación).
_STATUS_LABELS = {"blocked": "Bloqueado", "in_progress": "En curso", "done": "Listo"}
_STATUS_ORDER = ("blocked", "in_progress", "done")

_SYSTEM_PROMPT = (
    "Sos quien resume el estado de un tablero kanban colaborativo para un equipo que "
    "ya lo tiene abierto en pantalla. No listes ni describas cada nota: el equipo ya "
    "ve las columnas, los colores y quién escribió qué. Tu valor es señalar lo que no "
    "se nota de un vistazo — priorizá, en este orden si aplica: qué está bloqueado y "
    "no se movió en un buen rato, qué nota lleva mucho tiempo sin tocarse aunque no "
    "esté en 'Bloqueado', y qué notas compartidas todavía tienen cupos libres (falta "
    "gente). Podés nombrar una nota puntual cuando sea justo el hallazgo (un cuello de "
    "botella concreto), pero no enumeres todas: sintetizá un patrón cuando haya más de "
    "una. Si no hay nada que valga la pena señalar en alguna de esas tres categorías, "
    "omitila — no hace falta cubrir las tres siempre. Si el tablero está vacío, o todo "
    "avanza bien y sin huecos, decilo en una frase corta en vez de forzar un hallazgo. "
    "Respondé siempre en español, en un solo párrafo de prosa corrida, sin viñetas, "
    "sin títulos, sin markdown, de no más de 400 caracteres — tiene que leerse de un "
    "vistazo."
)

# Mismo patrón que `lib/checklist.ts` (CHECKLIST_LINE) -duplicado a propósito en
# Python: la línea `text` de una nota vive server-side en `Note.text`, y armar el
# prompt corre acá, no en el navegador.
_CHECKLIST_LINE = re.compile(r"^\s*-\s\[( |x|X)\]\s?(.*)$")

_client: anthropic.AsyncAnthropic | None = (
    anthropic.AsyncAnthropic(api_key=settings.ai_api_key) if settings.ai_api_key else None
)


def _lock_key(room: str) -> str:
    return f"corcho:summary:lock:{room}"


def _cooldown_key(room: str) -> str:
    return f"corcho:summary:cooldown:{room}"


def _last_key(room: str) -> str:
    return f"corcho:summary:last:{room}"


class StartOutcome(Enum):
    STARTED = auto()
    RATE_LIMITED = auto()
    ALREADY_GENERATING = auto()
    UNAVAILABLE = auto()  # sin AI_API_KEY configurada


class StartResult(NamedTuple):
    outcome: StartOutcome
    retry_after_seconds: int | None  # solo con RATE_LIMITED


async def start(redis: Redis, room: str) -> StartResult:
    """Gate atómico: ver el docstring del módulo para el porqué del orden
    lock-primero-cooldown-después."""
    if settings.ai_api_key is None:
        return StartResult(StartOutcome.UNAVAILABLE, None)

    acquired = await redis.set(_lock_key(room), _now_iso(), nx=True, ex=_LOCK_TTL_SECONDS)
    if not acquired:
        return StartResult(StartOutcome.ALREADY_GENERATING, None)

    cooldown_ttl = await redis.ttl(_cooldown_key(room))
    if cooldown_ttl > 0:
        await redis.delete(_lock_key(room))  # no se usó, liberar de inmediato
        return StartResult(StartOutcome.RATE_LIMITED, cooldown_ttl)

    await redis.set(_cooldown_key(room), "1", ex=_COOLDOWN_SECONDS)
    return StartResult(StartOutcome.STARTED, None)


class LastSummary(NamedTuple):
    text: str
    generated_at: datetime


async def get_last(redis: Redis, room: str) -> LastSummary | None:
    """Lo que ve un participante que se une a una sala con un resumen ya generado.
    `None` si nunca se pidió uno, o si Redis se reinició desde el último -no es una
    fuente de verdad de negocio (invariante 1), perderlo no rompe nada."""
    raw = await redis.get(_last_key(room))
    if raw is None:
        return None
    data = json.loads(raw)
    return LastSummary(text=data["text"], generated_at=datetime.fromisoformat(data["generated_at"]))


async def generate_and_publish(room: str, broker: RedisBroker, redis: Redis) -> None:
    """Corre desatada del mensaje que la disparó -ver el docstring del módulo para
    por qué es seguro que publique ella misma. Nunca deja el lock tomado, pase lo
    que pase."""
    try:
        with SessionLocal() as session:
            prompt = _build_prompt(session, room)
        if prompt is None:
            # La sala se borró entre el pedido y esto -no hay borrado de salas hoy,
            # pero no cuesta nada cubrirlo en vez de asumir que siempre existe.
            event = RoomSummary(text=None, error="failed", generated_at=_now())
        else:
            text = await asyncio.wait_for(_call_ai(prompt), timeout=_AI_TIMEOUT_SECONDS)
            event = RoomSummary(text=text, error=None, generated_at=_now())
    except Exception:
        logger.exception("Fallo generando el resumen de la sala %s", room)
        event = RoomSummary(text=None, error="failed", generated_at=_now())
    finally:
        await redis.delete(_lock_key(room))

    if event.text is not None:
        await redis.set(
            _last_key(room),
            json.dumps({"text": event.text, "generated_at": event.generated_at.isoformat()}),
        )
    await broker.publish(room, event)


async def _call_ai(prompt: str) -> str:
    assert _client is not None  # start() ya devolvió UNAVAILABLE si no hay clave
    response = await _client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    for block in response.content:
        if block.type == "text":
            return block.text.strip()
    raise ValueError("la respuesta de la IA no tuvo un bloque de texto")


def _build_prompt(session: Session, room: str) -> str | None:
    """`None` si la sala ya no existe. Lee directo -no vía `rooms.get_snapshot`-:
    esta tarea corre en su propia `Session`, y solo necesita notas + autor, no
    participantes ni chat."""
    room_row = session.execute(
        select(Room)
        .where(Room.slug == room)
        .options(selectinload(Room.notes).selectinload(Note.author))
    ).scalar_one_or_none()
    if room_row is None:
        return None

    now = datetime.now(UTC)
    by_status: dict[str, list[Note]] = {status: [] for status in _STATUS_ORDER}
    for note in room_row.notes:
        by_status[note.status].append(note)

    lines = [f"Estado actual del tablero de la sala «{room_row.name or room_row.slug}»:", ""]
    for status in _STATUS_ORDER:
        lines.append(f"{_STATUS_LABELS[status]}:")
        notes = by_status[status]
        if not notes:
            lines.append("(vacío)")
        else:
            lines.extend(f"- {_note_line(note, now)}" for note in notes)
        lines.append("")

    lines.append("Resumí lo importante siguiendo las instrucciones.")
    return "\n".join(lines)


def _note_line(note: Note, now: datetime) -> str:
    parts = [
        _note_title(note.text),
        f"autor: {note.author.name}",
        f"última actividad hace {_time_ago(note.updated_at, now)}",
    ]
    items = _parse_checklist(note.text)
    if items:
        done = sum(1 for checked, _ in items if checked)
        parts.append(f"checklist {done}/{len(items)}")
    if note.capacity is not None:
        parts.append(f"cupo {note.taken_count}/{note.capacity} tomado")
    return " — ".join(parts)


def _note_title(text: str) -> str:
    """Primera línea de la prosa, o el primer ítem del checklist si la nota es
    100% checklist -mismo respaldo que ya usa la tarjeta (`checklistPreviewText`,
    `Note.tsx`), reescrito en Python: ver el docstring del módulo sobre esta
    duplicación."""
    prose = _prose_only(text)
    if prose:
        return prose.splitlines()[0]
    items = _parse_checklist(text)
    if items:
        return items[0][1]
    return "(sin título)"


def _parse_checklist(text: str) -> list[tuple[bool, str]]:
    items = []
    for line in text.splitlines():
        match = _CHECKLIST_LINE.match(line)
        if match is not None:
            items.append((match.group(1).strip() != "", match.group(2)))
    return items


def _prose_only(text: str) -> str:
    lines = [line for line in text.splitlines() if not _CHECKLIST_LINE.match(line)]
    return "\n".join(lines).strip()


def _time_ago(dt: datetime, now: datetime) -> str:
    seconds = (now - dt).total_seconds()
    if seconds < 60:
        return "un momento"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} minuto{'s' if minutes != 1 else ''}"
    hours = int(minutes // 60)
    if hours < 24:
        return f"{hours} hora{'s' if hours != 1 else ''}"
    days = int(hours // 24)
    return f"{days} día{'s' if days != 1 else ''}"


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat()
