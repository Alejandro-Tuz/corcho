# Corcho

Espacio de trabajo colaborativo en tiempo real. Un lienzo con notas tipo post-it donde un
equipo publica pendientes y updates, y todos ven los cambios al instante sin recargar.
Se entra por link o QR, sin registro: nombre + avatar y adentro.

Proyecto de 3 días con demo en vivo. **El pulido no es el acabado del proyecto, es el
proyecto.** Ante la duda entre agregar una función o terminar bien una existente, terminar
bien la existente.

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
Windows, así que el backend conecta a `localhost:5432` y `localhost:6379` con normalidad.

El daemon no arranca solo: tras reiniciar Windows hay que ejecutar
`wsl -e sudo service docker start`.

Los volúmenes del compose son **volúmenes nombrados**, nunca rutas montadas desde `C:\`.
Montar el sistema de archivos de Windows en un contenedor de WSL es lento y Postgres se
arrastra.

Al sugerir comandos: PowerShell, no bash. Si un comando es de Unix, traducirlo o avisar.

## Estructura

```
corcho/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   │   ├── config.py        Settings con pydantic-settings
│   │   │   ├── redis.py         pool de conexión, nada más
│   │   │   └── ids.py           slugs de sala, ids cortos para el QR
│   │   ├── api/
│   │   │   ├── deps.py
│   │   │   └── v1/
│   │   │       ├── router.py
│   │   │       ├── rooms.py     crear sala, unirse, snapshot inicial
│   │   │       └── health.py
│   │   ├── realtime/
│   │   │   ├── protocol.py      EL CONTRATO: envelope + tipos de evento
│   │   │   ├── endpoint.py      la ruta /ws/{room}
│   │   │   ├── manager.py       ConnectionManager por sala (sockets locales)
│   │   │   ├── broker.py        puente Redis pub/sub <-> manager
│   │   │   └── handlers.py      despacho: tipo de mensaje -> servicio
│   │   ├── db/
│   │   │   ├── base.py
│   │   │   └── session.py
│   │   ├── models/              SQLAlchemy
│   │   ├── schemas/             Pydantic, solo entrada/salida REST
│   │   └── services/
│   │       ├── rooms.py
│   │       ├── notes.py
│   │       ├── claims.py        cupos: tomar y soltar
│   │       └── chat.py
│   ├── scripts/
│   │   ├── seed.py              sala precargada del demo
│   │   └── theater.py           clientes WS falsos (modo teatro)
│   ├── alembic/versions/
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_claims.py
│   │   ├── test_protocol.py
│   │   └── integration/
│   ├── pyproject.toml
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── app/                 providers, router, layout
│   │   ├── realtime/
│   │   │   ├── protocol.ts      espejo manual de protocol.py
│   │   │   ├── socket.ts        conexión, backoff, ping, cola de reenvío
│   │   │   ├── dispatch.ts      evento entrante -> store
│   │   │   └── throttle.ts      cursores y nota fantasma
│   │   ├── store/               estado de la sala, en un solo sitio
│   │   ├── features/
│   │   │   ├── onboarding/      nombre + avatar + color
│   │   │   ├── canvas/          lienzo, fondo, columnas
│   │   │   ├── notes/           post-it, drag, cupos, reacciones
│   │   │   ├── presence/        cursores, conectados, notas fantasma
│   │   │   ├── chat/
│   │   │   └── activity/        franja de eventos recientes
│   │   ├── components/          UI tonta y reutilizable
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── styles/
│   └── public/
├── .github/workflows/
├── docker-compose.yml
├── .env.example
└── CLAUDE.md
```

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

## Convenciones

- Código, nombres de archivo, variables e identificadores del protocolo **en inglés**.
  Texto visible al usuario, comentarios y commits **en español**.
- Tipos de evento en `snake_case` con namespace: `note.claim`, `note.release`,
  `presence.cursor`, `chat.message`, `room.background`.
- Migraciones de Alembic siempre revisadas a mano después del autogenerate.
- Nada de `console.log` ni `print` en el código que se commitea.
- Formato automático: `ruff format` en el backend, Prettier en el frontend. No discutir
  comillas ni comas.
- Respetar los avisos de `react-hooks/exhaustive-deps`. Con WebSockets y `useEffect`, una
  dependencia faltante es una suscripción duplicada o un socket que no se cierra.
- Un commit por unidad de trabajo coherente. `pytest` y `ruff check` en verde antes de
  cada commit.

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

## Fuera de alcance

Decidido y cerrado. No proponer, no implementar:

canales de chat privados por tarea, menciones, toque de atención, historial completo de
actividad, edición de texto simultánea (necesitaría CRDTs), subida de fotos de perfil,
login con contraseña, audio o video, selector de color libre para el fondo.


Postgres está publicado en el puerto **5433** del host (no el 5432), porque hay otro
PostgreSQL ocupando el estándar en esta máquina. Dentro del contenedor sigue siendo 5432.
Redis sí usa el 6379 estándar.

## Pulido previsto (día 3)

- Al borrar una nota: animación de caída, como si se le quitara el pin. Ocurre en todas
  las pantallas al llegar `note.deleted`. Se elimina del store al terminar la animación,
  no al recibir el evento. `pointer-events: none` mientras cae.