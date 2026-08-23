# Corcho

Espacio de trabajo colaborativo en tiempo real. Un lienzo con notas tipo post-it donde un
equipo publica pendientes y updates, y todos ven los cambios al instante sin recargar.
Se entra por link o QR, sin registro: nombre + avatar y adentro.

Proyecto de 3 días con demo en vivo. **El pulido no es el acabado del proyecto, es el
proyecto.** Ante la duda entre agregar una función o terminar bien una existente, terminar
bien la existente.

## Estado del proyecto

**Hecho:**

- Estructura del repo, entorno Python, Postgres y Redis verificados de punta a punta.
- CI en GitHub Actions (ruff + pytest en backend, ESLint + build en frontend), en verde.
- `app/db/base.py` con `naming_convention` explícita en el `MetaData`.
- Los 6 modelos SQLAlchemy en `app/models/`, con sus CHECK, enums nativos e índices.
- Alembic configurado (`alembic.ini`, `env.py`, `script.py.mako`) y migración inicial
  aplicada. El ciclo `downgrade base` → `upgrade head` corre limpio: el `downgrade()`
  incluye el `DROP TYPE` explícito de `note_kind` y `note_status`, que Alembic no genera
  solo.
- `app/core/ids.py`: slug de sala de 10 caracteres, alfabeto de 32 símbolos sin 0/O ni
  1/I, generado con `secrets`.
- `app/core/constants.py`: catálogos de `color`/`avatar`/`background`/`reaction`, un
  `Literal` derivado de una única tupla por catálogo (`Literal[*TUPLA]`). Fondos son
  colores sutiles (hueso, gris cálido, salvia apagado, azul niebla, uno oscuro), no
  patrones: un color se nota a distancia en la otra pantalla, un patrón no.
- `realtime/protocol.py` + `frontend/src/realtime/protocol.ts`: el contrato completo.
  Envelope plano, mismo `type` para el mensaje del cliente y la confirmación del
  servidor pero modelos distintos (`*In` nunca lleva `participant_id`/`author_id`,
  salvo `room.join` que es quien establece esa identidad). Rechazos tipados para
  `note.claim`/`note.release` (carrera esperable); autoría de `note.update`/`note.move`
  cae en `error` genérico (solo alcanzable por bug o manipulación, no por la UI). Cuatro
  eventos efímeros (`presence.cursor`, `presence.dragging`, `presence.drafting`,
  `chat.typing`) marcados con el mixin `Ephemeral` + `EPHEMERAL_TYPES`, no se persisten.
  `Event` base con `extra="forbid"`.
- `app/db/session.py`: engine + `SessionLocal`, lee `DATABASE_URL` sin fallback (falla
  ruidoso si falta la variable).
- `services/claims.py` + `tests/test_claims.py`: tomar y soltar cupos, la única
  concurrencia real del proyecto. `take`/`release` no controlan el ciclo de vida de la
  sesión (sin `commit`/`rollback` de la transacción externa) y usan SAVEPOINT
  (`begin_nested`) para deshacer solo su propia escritura cuando hace falta. Devuelven
  un resultado tipado (`ClaimOutcome`/`ReleaseOutcome`) que distingue "tomó un cupo
  nuevo" de "ya lo tenía" (idempotente, no hay que difundir `note.claim`) y "nota
  inexistente" de "sin cupo". Bug real encontrado y corregido en el camino: con
  psycopg3, `rowcount` de un `INSERT ... ON CONFLICT DO NOTHING` da `-1` siempre, no
  sirve para detectar el conflicto — hay que usar `RETURNING`. 8 tests en verde contra
  Postgres real, incluida la carrera con dos conexiones y `threading.Barrier(2)`.
- CI corregido: `alembic/env.py` tenía el mismo fallback de `DATABASE_URL` que ya se
  había quitado de `session.py`, y el job de backend no migraba antes de `pytest`. Paso
  `Migraciones` (`alembic upgrade head`) agregado al workflow. Verificado en local
  simulando el runner: `.env` apartado, `DATABASE_URL` solo como variable de sesión,
  contra una base vacía.
- `core/config.py`: `Settings` (pydantic-settings) con `database_url`/`redis_url`
  obligatorios, sin default — revienta al arrancar si falta cualquiera de las dos.
  `db/session.py` migrado para leer de acá en vez de `os.environ` directo, tal como
  anticipaba su propio docstring.
- `core/redis.py`: pool de conexión (`ConnectionPool`, `decode_responses=True`), nada
  más.
- `realtime/manager.py`: `ConnectionManager`, sockets locales de este worker en
  memoria (`dict[room, dict[participant_id, set[WebSocket]]]`). `connect`/`disconnect`
  devuelven si hubo transición real (primer/último socket de esa persona en esa sala,
  decisión de multi-pestaña); `broadcast` descarta oportunistamente un socket que
  falla al enviar, sin interrumpir el envío a los demás.
- `realtime/broker.py`: `RedisBroker`, puente pub/sub. `publish()` es el único camino
  desde `handlers.py` hacia los sockets: entrega local inmediata más publicación en
  Redis (en ese orden, documentado en el docstring). Una sola tarea de fondo con
  `PSUBSCRIBE room:*`, filtra por id de instancia de origen para no duplicar entregas
  locales, y no muere ante un mensaje corrupto (`try/except` por iteración del bucle,
  con log). Verificado con un smoke test de dos workers contra Redis real: entrega
  local, entrega vía Redis, y un mensaje corrupto de por medio que no tumbó la tarea.

**Siguiente:**

1. `services/notes.py`, `services/chat.py`, `services/rooms.py`.
2. `api/v1/`, `main.py` (wiring de `ConnectionManager`/`RedisBroker`/`Settings` en el
   lifespan), `realtime/handlers.py`, `realtime/endpoint.py`.

El día 1 cierra con dos pestañas sincronizadas, aunque el HTML sea feo.

**Si el tiempo aprieta, lo primero que sale es el chat.** Es la pieza más cara de lo que
queda (persistencia, scroll, no leídos, filtro por tarea, typing) y la que menos aporta al
momento central del demo: una nota moviéndose en dos pantallas a la vez.

## Stack

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, PostgreSQL 16, Redis 7
- **Frontend:** React 18 + TypeScript, Vite, ESLint + Prettier, sin framework de UI
- **Infra local:** docker-compose (Postgres + Redis). El backend y el frontend corren fuera
  de Docker en desarrollo, para tener recarga en caliente.
- **CI:** GitHub Actions con ruff y pytest desde el primer commit
- **Deploy:** Render

## Entorno de desarrollo

**Windows con PowerShell 5.1** (terminal Warp). Esto condiciona todo lo que sigue:

- No existe `&&` como separador. Un comando por línea.
- No existen `touch`, `find`, ni la expansión de llaves `{a,b,c}`.
- Los archivos se crean con codificación **UTF-8 sin BOM**. `Set-Content -Encoding utf8`
  añade BOM en esta versión y eso rompe `.gitignore`, TOML y YAML. Usar VS Code o
  `[System.IO.File]::WriteAllText` con `UTF8Encoding($false)`.
- El venv vive en `backend\.venv`. Si la política de ejecución impide activarlo, se llama a
  los ejecutables por ruta: `.\.venv\Scripts\python.exe`.

**Docker corre dentro de WSL2**, no en Windows. El comando `docker` no existe en
PowerShell; todo va prefijado con `wsl -e`. WSL2 reenvía los puertos a `localhost` de
Windows.

El daemon no arranca solo: tras reiniciar Windows hay que ejecutar
`wsl -e sudo service docker start`.

**Puertos:** Postgres está publicado en el **5433** del host, no el 5432, porque hay otro
PostgreSQL ocupando el estándar en esta máquina. Dentro del contenedor sigue siendo 5432.
Redis sí usa el 6379 estándar.

```
DATABASE_URL=postgresql+psycopg://corcho:corcho_dev@localhost:5433/corcho
REDIS_URL=redis://localhost:6379/0
```

Los volúmenes del compose son **volúmenes nombrados**, nunca rutas montadas desde `C:\`.
Montar el sistema de archivos de Windows en un contenedor de WSL es lento y Postgres se
arrastra.

Al sugerir comandos: PowerShell, no bash. Si un comando es de Unix, traducirlo o avisar.

## Estructura

Los archivos marcados con `[x]` ya existen. El resto está pendiente.

```
corcho/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   │   ├── config.py          Settings con pydantic-settings
│   │   │   ├── redis.py           pool de conexión, nada más
│   │   │   └── ids.py       [x]   slug de sala para URL/QR
│   │   ├── api/
│   │   │   ├── deps.py
│   │   │   └── v1/
│   │   │       ├── router.py
│   │   │       ├── rooms.py       crear sala, unirse, snapshot inicial
│   │   │       └── health.py
│   │   ├── realtime/
│   │   │   ├── protocol.py        EL CONTRATO: envelope + tipos de evento
│   │   │   ├── endpoint.py        la ruta /ws/{room}
│   │   │   ├── manager.py         ConnectionManager por sala (sockets locales)
│   │   │   ├── broker.py          puente Redis pub/sub <-> manager
│   │   │   └── handlers.py        despacho: tipo de mensaje -> servicio
│   │   ├── db/
│   │   │   ├── base.py      [x]   Base declarativa + naming_convention
│   │   │   └── session.py         engine, sessionmaker
│   │   ├── models/          [x]   los 6 modelos
│   │   ├── schemas/               Pydantic, solo entrada/salida REST
│   │   └── services/
│   │       ├── rooms.py
│   │       ├── notes.py
│   │       ├── claims.py          cupos: tomar y soltar
│   │       └── chat.py
│   ├── scripts/
│   │   ├── seed.py                sala precargada del demo
│   │   └── theater.py             clientes WS falsos (modo teatro)
│   ├── alembic/             [x]   configurado, migración inicial aplicada
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_claims.py
│   │   ├── test_protocol.py
│   │   └── integration/
│   ├── pyproject.toml       [x]
│   └── Dockerfile
├── frontend/                [x]   andamiaje de Vite, sin código propio aún
│   ├── src/
│   │   ├── main.tsx
│   │   ├── app/                   providers, router, layout
│   │   ├── realtime/
│   │   │   ├── protocol.ts        espejo manual de protocol.py
│   │   │   ├── socket.ts          conexión, backoff, ping, cola de reenvío
│   │   │   ├── dispatch.ts        evento entrante -> store
│   │   │   └── throttle.ts        cursores y nota fantasma
│   │   ├── store/                 estado de la sala, en un solo sitio
│   │   ├── features/
│   │   │   ├── onboarding/        nombre + avatar + color
│   │   │   ├── canvas/            lienzo, fondo, columnas
│   │   │   ├── notes/             post-it, drag, cupos, reacciones
│   │   │   ├── presence/          cursores, conectados, notas fantasma
│   │   │   ├── chat/
│   │   │   └── activity/          franja de eventos recientes
│   │   ├── components/            UI tonta y reutilizable
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── styles/
│   └── public/
├── .github/workflows/ci.yml [x]
├── docker-compose.yml       [x]
├── .env.example             [x]
└── CLAUDE.md                [x]
```

## Modelo de datos

Seis tablas, ya migradas. Cualquier cambio exige una migración nueva.

- **`rooms`** — `slug` (String, PK, generado por `core/ids.py`), `name` nullable,
  `background`, `created_at`. Sin `updated_at`, sin soft-delete.
- **`participants`** — `id` (UUID, PK), `room_id`, `name`, `avatar`, `color`,
  `connected_at`, `disconnected_at` nullable (NULL = conectado). Índice parcial
  `ix_participants_room_active` sobre `room_id` WHERE `disconnected_at IS NULL`.
- **`notes`** — `id` (UUID, PK, generado en cliente para creación optimista), `room_id`,
  `author_id`, `kind` (enum `own`/`shared`), `status` (enum
  `blocked`/`in_progress`/`done`), `text`, `color`, `position_x`, `position_y`,
  `capacity` nullable, `taken_count`, `created_at`, `updated_at` (con `onupdate`).
- **`note_claims`** — PK compuesta `(note_id, participant_id)`, `claimed_at`. Sin
  contador propio: es solo la proyección de "quién".
- **`chat_messages`** — `id`, `room_id` (CASCADE), `note_id` nullable (SET NULL),
  `author_id`, `text`, `created_at`. Append-only.
- **`reactions`** — PK compuesta `(note_id, participant_id, emoji)`, `created_at`.

**CHECKs de `notes`:** `kind='own'` implica `capacity IS NULL`; `kind='shared'` implica
`capacity NOT NULL AND capacity > 0`; `taken_count >= 0`; `taken_count <= capacity`.

Efecto colateral aprovechado: en una nota `own`, `capacity` es NULL, así que
`taken_count < capacity` nunca es verdadero en Postgres. Una nota propia es
estructuralmente imposible de reclamar, sin rama de código aparte.

## Decisiones de diseño ya tomadas

No reabrir sin motivo nuevo.

- **Columnas del Kanban:** tres fijas (Bloqueado / En curso / Listo), enum en el código, no
  tabla. Lo que se persiste es `status` de cada nota.
- **Posición y columna son independientes.** La nota guarda `status`, `x` e `y`. La columna
  NO se deriva de la `x`: el ancho depende del tamaño de la ventana y la misma nota
  aparecería en columnas distintas en cada pantalla. Un arrastre que cruza de columna
  actualiza posición y status en el mismo evento.
- **Reacciones:** varias distintas por participante y nota, una por emoji. Repetir el mismo
  emoji la retira (toggle). En la tarjeta se agrupan por emoji, con contador y quiénes.
- **Catálogos visuales** (avatar, color, presets de fondo): validados solo con `Literal` en
  Pydantic, contra un módulo de constantes único. Sin CHECK en Postgres, para poder añadir
  un color durante el pulido sin migración. Excepción: `kind` y `status` sí son enums
  nativos, porque son lógica de negocio.
- **Borrado de notas:** físico, sin `deleted_at`. Cascadean `note_claims` y `reactions`.
  Los `chat_messages` sobreviven con `note_id = NULL`: un mensaje es una intervención
  independiente, no un atributo de la nota, y borrar historial en mitad de una
  conversación es peor que perder una etiqueta.
- **Reidentificación al reconectar:** el servidor devuelve `participant_id` al unirse, el
  cliente lo guarda en `localStorage` por sala y lo envía al abrir el socket. Si el id
  existe y pertenece a esa sala, se reactiva la fila (`disconnected_at` a NULL) en vez de
  crear un participante nuevo. Sin esto, cada reconexión huerfaniza los cupos y las notas
  de esa persona. No hay tokens firmados: quien tiene el link ya tiene acceso a todo.
- **Multi-pestaña:** `disconnected_at` solo se marca cuando se cierra el **último** socket
  de ese participante. El conteo de sockets vivos va en memoria en `manager.py`. Con más
  de un worker ese contador tendría que vivir en Redis; con una instancia de Render, no.

## Comandos

Todo comando de backend se ejecuta desde `backend\` con el venv activo. Sin activar,
anteponer `.\.venv\Scripts\` al ejecutable.

```powershell
# servicios locales, desde la raíz del repo
wsl -e sudo service docker start   # una vez tras reiniciar Windows
wsl -e docker compose up -d        # Postgres + Redis
wsl -e docker compose ps
wsl -e docker compose logs -f postgres
wsl -e docker compose down

# backend, desde backend\
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
alembic revision --autogenerate -m "mensaje"
alembic upgrade head
pytest
pytest tests\test_claims.py -v     # el test que importa
ruff check .
ruff format .

# inspeccionar la base
wsl -e docker compose exec postgres psql -U corcho -d corcho -c "\dt"

# demo
python scripts\seed.py             # sala precargada
python scripts\theater.py          # clientes falsos

# frontend, desde frontend\
npm run dev
npm run build
npm run lint
```

## Invariantes

No negociables. Si un cambio los rompe, el cambio está mal.

1. **Los cupos se decrementan en PostgreSQL, no en Redis.** La operación es un
   `UPDATE ... WHERE taken_count < capacity RETURNING`, en una sola sentencia. Redis
   **solo** hace pub/sub. Nunca debe haber dos fuentes de verdad para un contador.

2. **`handlers.py` despacha, no implementa.** Valida contra `protocol.py`, llama a un
   servicio, publica el resultado por el broker. Toda lógica de negocio testeable vive en
   `services/`, para poder probarla sin levantar un WebSocket.

3. **`api/` no importa de `models/`.** Siempre a través de `services/`.

4. **`protocol.py` y `protocol.ts` cambian en el mismo commit.** Se mantienen a mano; no
   hay generación automática. Un cambio en uno sin el otro es un bug esperando.

5. **Los modelos no se serializan directamente.** Lo que sale por la API o por el socket
   pasa por un schema. El modelo puede tener campos que el cliente no debe ver.

6. **Los eventos de alta frecuencia no se persisten.** Cursores y posición durante el
   arrastre se transmiten y se descartan. Solo se guarda la posición final.

7. **Estado optimista con reconciliación.** El cliente pinta la acción al instante y la
   corrige cuando llega la confirmación del servidor. El caso de cupo lleno mientras se
   arrastra tiene que rebotar, no quedar en estado inconsistente.

8. **Los participantes nunca se borran.** Al desconectar solo se marca
   `disconnected_at`. Su fila sostiene notas, cupos, reacciones y mensajes por FK con
   CASCADE: borrarla se lleva por delante el trabajo de esa persona.

## Concurrencia de los cupos

Es la única parte del proyecto con concurrencia real, y donde `tests/test_claims.py` tiene
que apretar:

- **Tomar:** el `INSERT` en `note_claims` va **antes** del `UPDATE` del contador. Si va
  después, el doble clic depende de que el rollback deshaga el incremento. Insertando
  primero, la PK compuesta rechaza el duplicado rápido y limpio.
- **Soltar:** el decremento debe ser condicional a que el `DELETE` haya afectado a una
  fila. Dos peticiones seguidas de soltar borran una fila y cero filas; si decrementas sin
  comprobarlo, `taken_count` baja dos veces y queda por debajo de la realidad.
- Ambas escrituras van en la misma transacción.

## Convenciones

- Código, nombres de archivo, variables e identificadores del protocolo **en inglés**.
  Texto visible al usuario, comentarios y commits **en español**.
- Tipos de evento en `snake_case` con namespace: `note.claim`, `note.release`,
  `presence.cursor`, `chat.message`, `room.background`.
- Migraciones de Alembic siempre revisadas a mano después del autogenerate. Comprobar que
  los CHECK y los índices parciales aparecen en el archivo generado: Alembic a veces omite
  constraints declarados en `__table_args__`.
- Los nombres de constraint en los modelos van **sin** prefijo (`name="kind_capacity"`, no
  `name="ck_notes_kind_capacity"`): la `naming_convention` de `db/base.py` lo antepone, y
  si se escribe a mano sale duplicado.
- Nada de `console.log` ni `print` en el código que se commitea.
- Formato automático: `ruff format` en el backend, Prettier en el frontend. No discutir
  comillas ni comas.
- Respetar los avisos de `react-hooks/exhaustive-deps`. Con WebSockets y `useEffect`, una
  dependencia faltante es una suscripción duplicada o un socket que no se cierra.
- Antes de dar por terminada una tarea: `ruff check .` y `ruff format --check .` sobre
  **todo** `backend/`, no solo sobre los archivos modificados. Incluye `alembic/`.
- Un commit por unidad de trabajo coherente. `pytest` y `ruff check` en verde antes de
  cada commit.
- Nada de valores por defecto para configuración de infraestructura. `DATABASE_URL`,
  `REDIS_URL` y similares se leen con `os.environ[...]`, no con `.get(..., fallback)`. Un
  fallback convierte "falta configuración" en "conectado a la base equivocada", que es un
  fallo mucho más caro de diagnosticar. (Encontrado en CI: un fallback en `alembic/env.py`
  conectó silenciosamente contra una base que no existía en el runner, en vez de fallar en
  el momento en que faltaba `DATABASE_URL`.)

## Flujo de trabajo con Claude

- Antes de escribir código nuevo, leer `app/realtime/protocol.py`. Es el contrato del que
  cuelga todo lo demás.
- Cambios que toquen cupos: escribir o actualizar el test en `tests/test_claims.py`
  primero.
- No agregar dependencias sin decirlo explícitamente y justificar por qué no alcanza con
  lo que ya hay.
- No refactorizar a organización por feature en el backend. Con seis entidades, no paga.
- Si algo del alcance parece que no va a caber en el tiempo, decirlo en vez de entregar
  una versión a medias.
- Para piezas de diseño (protocolo, servicios con concurrencia): mostrar el diseño y
  esperar revisión antes de escribir código.

## Fuera de alcance

Decidido y cerrado. No proponer, no implementar:

canales de chat privados por tarea, menciones, toque de atención, historial completo de
actividad, edición de texto simultánea (necesitaría CRDTs), subida de fotos de perfil,
login con contraseña, audio o video, selector de color libre para el fondo.

## Pulido previsto (día 3)

- Al borrar una nota: animación de caída, como si se le quitara el pin. Ocurre en todas
  las pantallas al llegar `note.deleted`. Se elimina del store al terminar la animación,
  no al recibir el evento. `pointer-events: none` mientras cae.

  - **Nunca ejecutar comandos de git.** Ni `add`, ni `commit`, ni `push`, ni `checkout`.
  El control de versiones lo lleva el usuario a mano. Cuando una tarea esté lista, decirlo
  y parar.