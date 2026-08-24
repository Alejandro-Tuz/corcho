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
  `Literal` derivado de una única tupla por catálogo (`Literal[*TUPLA]`). Fondos
  arrancaron como cinco colores sutiles (hueso, gris cálido, salvia apagado, azul
  niebla, uno oscuro), sin patrones -la idea original era que un color se nota a
  distancia en la otra pantalla y un patrón no-. Catálogo ampliado en el pulido del
  día 3: ver el bullet correspondiente más abajo, revierte esto parcialmente.
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
- `services/notes.py`, `services/chat.py`, `services/rooms.py`. Mismo criterio que
  `claims.py`: reciben la `Session`, no la abren, no controlan su ciclo de vida.
  Desenlaces multi-vía como enums locales (`NoteOutcome`, `JoinOutcome`, etc.); las
  formas de dato completas (`NoteState`, `ParticipantState`, `ChatMessageState`) se
  importan de `protocol.py` en vez de duplicarse. `update_note`/`move_note`/
  `delete_note` validan autoría (solo el autor); sin rechazo propio en el protocolo
  para eso -cae en `error` genérico, la UI legítima nunca ofrece estos controles sobre
  una nota ajena-. `notes.toggle_reaction` repitió y resolvió la misma trampa de
  `rowcount == -1` de `claims.take` (`INSERT ... ON CONFLICT DO NOTHING` + `RETURNING`,
  documentado en ambos sitios). Bug encontrado y corregido: `rooms.get_snapshot` con
  `session.get(Room, slug, options=[selectinload...])` no aplicaba bien un
  `selectinload` encadenado dos niveles (notes -> claims/reactions) y hacía una
  consulta de claims y otra de reactions *por nota* -N+1 real, verificado con
  `event.listen` contra Postgres: 14 consultas para 5 notas-. `select(Room).where(...)`
  sí lo resuelve: 7 consultas fijas, no crecen con el número de notas (verificado con
  5 y con 15). Bug encontrado y corregido en el modelo: `Room.background` tenía
  `default="grid"`, valor que ya no es válido desde que `BACKGROUNDS` pasó a colores;
  corregido a `"bone"` (cambio de código, sin migración). Todo verificado con smoke
  tests funcionales contra Postgres real -no hay tests permanentes para estos tres
  servicios todavía, quedan para cuando exista `tests/conftest.py` compartido-.
- `api/v1/` (`router.py`, `rooms.py` -crear sala y devolver el `slug`-, `health.py`,
  `deps.py` con `get_db`), `main.py` (el `lifespan` cablea el cliente de Redis, el
  `ConnectionManager` y el `RedisBroker` en `app.state` -tanto `api/v1/` como
  `realtime/endpoint.py` los necesitan, y un framework de DI más pesado no se
  justifica para tres días), `realtime/endpoint.py` (la ruta `/ws/{room}`) y
  `realtime/handlers.py` (despacho tipo de mensaje -> servicio, invariante 2).
  Cierra el círculo de `protocol.py`: de acá en más un mensaje entra por el socket,
  `handlers.py` lo valida y llama al servicio que corresponde, y `endpoint.py` es
  quien hace `session.commit()` y recién después `broker.publish()` -pieza exacta
  donde aparecieron los dos bugs de concurrencia de abajo.
- **Frontend, día 2: bloques 1 a 3.** `realtime/socket.ts` (conexión, backoff
  exponencial, heartbeat con watchdog que fuerza el cierre si el servidor queda en
  silencio, cola de reenvío que solo encola lo que nunca llegó a salir) +
  `store/roomStore.ts` (estado optimista con reconciliación, invariante 7) +
  `lib/identity.ts` (reidentificación por sala en `localStorage`). Onboarding
  (nombre + avatar + color), lienzo con las tres columnas fijas, notas arrastrables
  entre columnas -`Note.tsx` usa `document.elementFromPoint()` sobre
  `data-column-status` para decidir dónde cayó un arrastre, en vez de medir anchos
  de columna a mano-, cupos con rebote (la única acción sobre una nota que a
  propósito NO es optimista, ver esa decisión en "Decisiones de diseño ya
  tomadas"), cursores remotos y nota fantasma
  (`presence.cursor`/`presence.dragging`), reacciones, y fondo de sala compartido
  (`room.background`).
- **Día 2, dos bugs de backend encontrados en pleno desarrollo de frontend** (el
  primero tumbó el proceso entero durante una prueba real de dos pestañas en carrera
  por un cupo; el segundo salió a la luz recién al perseguir al primero):
  - `handlers.dispatch()` publicaba el evento a difundir él mismo (`broker.publish`)
    **antes** de que `endpoint.py` hiciera `session.commit()`. El lock de Postgres de
    esa escritura quedaba tomado mientras se esperaba a que el broadcast terminara de
    repartirse a toda la sala; un socket lento o medio muerto ahí adentro dejaba el
    lock tomado mucho más de lo que la escritura en sí necesitaba, y cualquier otra
    persona reclamando el mismo cupo se quedaba esperando ese lock sin saber por qué
    -verificado a mano contra Postgres real: una fila de `notes` con `UPDATE ...
    taken_count` bloqueada, la conexión que la sostenía "idle in transaction" un
    minuto entero-. Corregido: `handlers.dispatch()` ahora **devuelve** el
    `ServerEvent` a difundir (o `None`) en vez de publicarlo, y ya no importa
    `RedisBroker` en absoluto; `endpoint.py` es quien llama a `broker.publish()`,
    recién después de `session.commit()`.
  - Con lo anterior aislado, un socket que moría en el momento exacto en que
    `handlers.dispatch` intentaba responderle (un `Pong`, un rechazo) tumbaba **todo
    el proceso**: `_message_loop` atrapa cualquier excepción de un mensaje y sigue el
    bucle, pero eso incluía sin querer una desconexión detectada del lado del envío
    -no siempre `WebSocketDisconnect`, Starlette no usa siempre esa clase para "ya
    estás desconectado"-, así que el bucle volvía a `receive_text()` sobre una
    conexión ya muerta, y ahí Starlette tira un `RuntimeError` distinto
    ("WebSocket is not connected") que no atrapaba nada río arriba. Corregido:
    después de cualquier excepción en el bucle, se comprueba
    `websocket.application_state` -si ya no está `CONNECTED`, se sintetiza un
    `WebSocketDisconnect` para forzar la limpieza normal (`disconnected_at`,
    `presence.left`) en vez de reintentar sobre un socket muerto. Se prefirió
    comprobar el estado real de la conexión a enumerar clases de excepción -no
    depende de adivinar bien esa lista-. Verificado reproduciendo el escenario
    original (dos pestañas en carrera real, un socket matado a la fuerza a mitad de
    camino) ocho veces seguidas sin que el proceso se cayera ni una vez, y sin
    conexiones `idle in transaction` acumuladas después.
- **Frontend, día 3, bloque 4: franja de actividad.** `store/activity.ts` +
  `state.activity` en el store: ventana acotada (40 renglones) de los últimos
  eventos ya confirmados, formateados en español, con el color del participante que
  los disparó. No todos los eventos dejan renglón a propósito -`note.update` no,
  por ruido; los rechazos de cupo no, son privados; `note.move` solo si CAMBIA de
  columna, no en cada reacomodo dentro de la misma-. `features/activity/Activity.tsx`
  la pinta como una tira horizontal que se autodesplaza al último evento. Bug real
  encontrado: `applyNoteMove` comparaba `current.status !== event.status` para
  decidir si hubo cambio de columna, pero en la pantalla de quien arrastra
  `moveNote` ya había pisado `status` de forma optimista antes de que esa
  confirmación llegara -daba "no cambió" siempre para el propio autor del
  arrastre, aunque sí hubiera cambiado (en las demás pantallas funcionaba bien,
  nunca tocaron la nota de forma optimista). Corregido comparando contra
  `pendingNoteOps[id].restore.status` cuando existe.
- **Frontend, día 3: pulido visual completo.** Dirección aprobada antes de
  aplicarla -paleta, tipografía y un post-it de muestra en un artifact, dos vueltas
  de ajuste sobre el post-it y el pin antes del visto bueno- y recién entonces
  llevada a todos los componentes. Paleta: corcho cálido + salvia fría como acento
  de interfaz (nuevo, reemplaza los `#999`/`#666` sueltos por todo el CSS inline).
  Tres roles tipográficos que nunca se mezclan: Patrick Hand SOLO para el texto que
  alguien escribe en una nota, IBM Plex Sans para todo lo que la interfaz rotula,
  IBM Plex Mono para datos (cupos, hora, código de sala). Tokens en `index.css`
  (`:root`), fuentes por Google Fonts en `index.html`.
  - **Post-it** (`features/notes/Note.css`): color sólido real por `NoteColor`
    -bug encontrado: hasta acá `Note.tsx` pintaba toda nota con `background:
    '#ddd'` fijo sin importar el color elegido al crearla, el mapeo color->hex
    nunca se había escrito-, esquina doblada plana (dos tonos lisos, sin sombra
    propia -una vuelta con sombra y con `filter: drop-shadow` leía a interfaz
    vieja), radio de esquina bajo (3px: una vuelta intermedia con radio grande y
    sin esquina doblada leía a card genérica de app, no a post-it), rotación fija
    por nota (`lib/noteRotation.ts`, hash determinista del id, nunca al azar en
    cada render). Chip de autor: avatar en `grayscale(1) contrast(1.15)` sobre el
    color de participante -una primera vuelta usaba `brightness(0) invert(1)`
    (silueta blanca pura) y el animal dejaba de reconocerse, grayscale conserva el
    contraste interno del dibujo-, más el nombre como chip con fondo propio junto
    al pin -una primera vuelta lo puso como texto suelto a media opacidad y pasaba
    desapercibido sobre el color de la nota-.
  - **Animaciones**, a pedido explícito: al borrar, la nota cae y gira en vez de
    desaparecer de golpe -`state.fallingNotes` guarda una foto de la nota ya
    borrada de `notes`, `NoteFalling.tsx` (componente puramente presentacional,
    sin los hooks de arrastre de `Note.tsx`) la anima, un `setTimeout` en el store
    la limpia sola. Al cambiar de columna (arrastre propio o ajeno), un pulso de
    escala breve para que se note el cambio -`Note.tsx` compara el `status` contra
    el de la nota en el render anterior, el patrón de React para "ajustar estado
    cuando algo cambió" sin `useEffect`, y solo entonces aplica la clase.
  - **Columnas** (`features/canvas/Column.css`): paneles translúcidos -dejan ver
    el fondo de sala por debajo, si no la función "fondo compartido" no tendría
    casi superficie donde mostrarse- y con alto dinámico: `columnMinHeightPx`
    (`store/selectors.ts`) crece según la nota más baja de cada columna, en vez de
    quedar fijo con las últimas notas desbordando sin scroll.
  - `NoteComposer.tsx` reemplaza los `window.prompt()` del día 2: modal con
    `<dialog>` nativo (foco atrapado, `Esc` cierra, `::backdrop` gratis, sin
    librería), tipo propia/compartida, color, cupos.
  - Onboarding y Landing con la misma paleta; avatar y color como selectores
    visuales -antes, botones de puro texto a propósito, ver bloque de día 2 arriba.
- **Fondos: catálogo ampliado con patrones**, a pedido directo tras ver la primera
  versión de la paleta ("la diferencia de tono es casi mínima"). Revierte
  PARCIALMENTE la decisión original de `core/constants.py` ("colores sutiles, no
  patrones" -ver bullet más arriba-): los cinco sólidos se separaron más en
  tono/saturación (mismos identificadores, ninguna sala ya creada queda inválida) y
  se sumaron tres variantes con lunares de alto contraste (`dots_sage`,
  `dots_blue`, `dots_dark`) -exactamente la vía que la propia decisión de "sin
  CHECK en Postgres para este catálogo" dejó abierta: se sumaron al `Literal` de
  `core/constants.py` sin ninguna migración, y a los espejos correspondientes
  (`protocol.ts`, `lib/constants.ts`, `features/canvas/backgroundColor.ts`,
  `store/activity.ts`).
- **Nota expandible** (pulido día 3 extendido, a pedido tras ver el pulido visual
  completo): botón "expandir" en la esquina libre del post-it (abajo-izquierda; pin,
  esquina doblada y borrar ya ocupaban las otras tres) abre `NoteDetail.tsx`, un
  `<dialog>` nativo con la descripción larga y un checklist. Legible por cualquiera,
  editable solo por el autor (`isMine`) -misma autoridad que ya regía
  `update_note`, esto no la duplica, solo la refleja en la UI-.
  - **Sin tabla, sin migración de esquema, sin eventos de protocolo nuevos, a
    propósito**: el checklist vive DENTRO de `notes.text` como markdown
    (`- [ ] algo` / `- [x] algo`, `lib/checklist.ts`), reutilizando `note.update`
    tal cual ya existía. Alternativa descartada explícitamente: una tabla
    `note_checklist_items` con eventos propios de tildado por ítem -se acerca
    demasiado a edición de texto simultánea con estructura propia, que
    "Fuera de alcance" ya excluye por necesitar CRDTs.
  - **Una sola superficie de texto, no dos regiones ocultas**: el textarea de
    `NoteDetail.tsx` muestra el texto crudo tal cual, líneas de checklist
    incluidas -escribir `- [ ] algo` a mano ahí lo vuelve un ítem tildable de
    inmediato, sin conversión oculta que ocurra recién al guardar. La lista de
    checkboxes debajo es una vista derivada EN VIVO de ese mismo texto. El
    post-it, en cambio, nunca muestra las líneas de checklist crudas: solo la
    prosa (o el primer ítem, si no hay prosa) más un chip de progreso ("2/5").
  - Tildar/agregar/borrar un ítem guarda de inmediato (un `note.update` por
    click); la prosa se guarda al perder foco del textarea o al cerrar el modal,
    nunca tecla por tecla. Ver la limitación de multi-pestaña más abajo, mismo
    nivel de detalle que `move_note`.
  - Límite de `notes.text` subido de 500 a 2000 caracteres -500 alcanzaba para un
    título, no para descripción + checklist-: `Field(max_length=2000)` en
    `NoteCreateIn`/`NoteUpdateIn` (`protocol.py`) y CHECK `text_length` de la
    tabla notes, migración `0594aa52662a` (escrita a mano: un cambio de solo el
    cuerpo de un CHECK no siempre lo detecta `--autogenerate`).
  - Íconos del botón de expandir y del chip de progreso: SVG inline, no
    caracteres de fuente (`⛶`, `☑`) -mismo riesgo de tofu en algunas plataformas
    que ya corren los emoji de avatar, evitable a mano sin costo.
  - `<dialog>` sacado con `createPortal` a `document.body`: `.note-card` tiene
    `transform: rotate(...)` siempre puesto (rotación fija por nota), y un
    ancestro con `transform` pasa a ser el "containing block" de la capa
    superior -sin el portal, `showModal()` centraba el modal relativo a la nota
    rotada, no a la pantalla.
  - Tres bugs reales encontrados probando el botón a mano: (1) el padding
    inferior original de `.note-card` (10px) era menor que la franja de 20px+4px
    que ocupan los dos botones de esquina -el último contenido en flujo
    (`.note-reacts`) los tapaba por completo en notas con reacciones; subido a
    26px. (2) `handlePointerDown` distinguía "el click empezó en un botón" con
    `e.target instanceof HTMLElement`, que da `false` para un `<svg>`/`<path>`
    -un `SVGElement` no es `HTMLElement`-, así que el primer botón de una nota
    con ícono SVG en vez de texto plano armaba un arrastre y se comía el click
    antes de que llegara a React. Corregido a `instanceof Element`, ancestro
    común de HTML y SVG. (3) Encontrado por el usuario probando la función:
    tildar un checkbox del modal arrastraba la nota de fondo. Causa distinta a
    (2) -esta vez el target SÍ era un elemento HTML (un `<input>`, no un botón,
    así que la guarda de `handlePointerDown` no aplicaba de entrada)-: un
    portal (`createPortal`, ver más arriba) saca al `<dialog>` del DOM de la
    nota, pero React sigue burbujeando sus eventos sintéticos por el árbol de
    REACT, no por el DOM real -comportamiento documentado de los portales, no
    un bug de React-, y `NoteDetail` sigue siendo hijo de `Note` en ese árbol.
    Cualquier `pointerdown` adentro del modal, sin importar sobre qué elemento,
    le llegaba igual al handler de arrastre de la tarjeta de abajo. Corregido
    cortando la propagación en la raíz del `<dialog>`
    (`onPointerDown={(e) => e.stopPropagation()}`) en vez de seguir
    parchando la guarda de `Note.tsx` elemento por elemento -la lista de qué
    puede vivir adentro del modal (checkbox, textarea, inputs) puede crecer, y
    esta solución no depende de enumerarla.

**Limitación conocida, documentada, no blindada (no compensa en tres días):**

- **`notes.move_note`** tiene la segunda concurrencia real del proyecto, además de los
  cupos: dos `note.move` para la misma nota -misma persona con dos pestañas, o
  paquetes reordenados por la red durante un arrastre a alta frecuencia
  (`presence.dragging`)- pueden aplicarse fuera de orden. Gana el que llega después,
  aunque corresponda a un instante anterior del arrastre. Sin control de versión de
  por medio. Peor caso: la nota "salta" un instante a una posición vieja antes de
  asentarse en la correcta, no pérdida de datos ni estado inconsistente en la base.
- **`NoteDetail.tsx`** (nota expandible) tiene una limitación de la misma familia que
  `move_note`, encontrada por diseño y no blindada por el mismo motivo -el costo no
  compensa en tres días-: `notes.text` sigue siendo un campo entero, last-write-wins.
  El modal reduce la ventana de choque (cada tildado de ítem lee y escribe el texto
  más fresco posible, sin pasar por una copia vieja; ver el docstring del componente
  para el mecanismo exacto), pero no la cierra del todo. Mientras el autor tiene
  tecleada prosa sin guardar en una pestaña (`dirty === true`), esa copia local no se
  resincroniza con el servidor -no hay forma de mezclar tecleo en curso con un cambio
  remoto sin edición colaborativa de verdad (CRDTs, fuera de alcance). Si la MISMA
  persona edita la prosa en dos pestañas casi al mismo tiempo, o tilda un ítem en una
  mientras la otra todavía no guardó lo que estaba escribiendo, gana quien guarda
  último: pisa el campo entero, sin mezclar. Solo puede pasar entre pestañas del
  propio autor -es el único que edita- y se autocorrige con la próxima actualización
  real que llegue, igual que `move_note`.
- **`chat.list_messages`** (y por lo tanto `room.snapshot`): Postgres congela `now()`
  al inicio de la transacción, no por sentencia. Mensajes creados en la misma
  transacción quedan con `created_at` idéntico y su orden relativo no está
  garantizado. No pasa en el uso real (cada `chat.message` por WS es su propia
  transacción), pero sí en scripts que inserten varios mensajes sin commitear entre
  medio -`scripts/seed.py` tiene que tenerlo presente-.

**Siguiente, en este orden (día 3, el último):**

1. Contenido sembrado (`scripts/seed.py`) -cuidado con el `now()` congelado por
   transacción, ya documentado más abajo en `chat.list_messages`.
2. QR y responsive en celular.
3. Deploy en Render.
4. Modo teatro (`scripts/theater.py`) y README con diagrama.
5. Chat, solo si sobra tiempo.

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

**WSL2 apaga su máquina virtual cuando no queda ninguna sesión abierta**, y se lleva los
contenedores con ella (los logs muestran `received fast shutdown request` y un ciclo de
reinicios). Dejar una pestaña con `wsl` abierta durante toda la sesión de trabajo.
Síntoma: `pytest` se cuelga sesenta segundos en la primera conexión en vez de fallar
rápido.

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
│   │   ├── main.py          [x]   wiring de ConnectionManager/RedisBroker/Settings
│   │   ├── core/
│   │   │   ├── config.py    [x]   Settings con pydantic-settings
│   │   │   ├── redis.py     [x]   pool de conexión, nada más
│   │   │   ├── ids.py       [x]   slug de sala para URL/QR
│   │   │   └── constants.py [x]   catálogos visuales, un Literal por tupla
│   │   ├── api/
│   │   │   ├── deps.py      [x]   get_db, una Session por request
│   │   │   └── v1/
│   │   │       ├── router.py [x]
│   │   │       ├── rooms.py  [x]  crear sala, devolver el slug
│   │   │       └── health.py [x]
│   │   ├── realtime/
│   │   │   ├── protocol.py  [x]   EL CONTRATO: envelope + tipos de evento
│   │   │   ├── endpoint.py  [x]   la ruta /ws/{room}
│   │   │   ├── manager.py   [x]   ConnectionManager por sala (sockets locales)
│   │   │   ├── broker.py    [x]   puente Redis pub/sub <-> manager
│   │   │   └── handlers.py  [x]   despacho: tipo de mensaje -> servicio
│   │   ├── db/
│   │   │   ├── base.py      [x]   Base declarativa + naming_convention
│   │   │   └── session.py   [x]   engine, sessionmaker
│   │   ├── models/          [x]   los 6 modelos
│   │   ├── schemas/         [x]   Pydantic, solo entrada/salida REST
│   │   └── services/        [x]
│   │       ├── rooms.py     [x]
│   │       ├── notes.py     [x]
│   │       ├── claims.py    [x]   cupos: tomar y soltar
│   │       └── chat.py      [x]
│   ├── scripts/                   solo .gitkeep todavía -próximo en la lista-
│   │   ├── seed.py                sala precargada del demo
│   │   └── theater.py             clientes WS falsos (modo teatro)
│   ├── alembic/             [x]   configurado, migración inicial aplicada
│   ├── tests/
│   │   ├── conftest.py            existe, vacío -pendiente para cuando haya
│   │   │                          tests de rooms/notes/chat services
│   │   ├── test_claims.py   [x]   el que importa: la concurrencia real
│   │   ├── test_protocol.py       placeholder, sin contenido real todavía
│   │   └── integration/           solo .gitkeep
│   ├── pyproject.toml       [x]
│   └── Dockerfile                 no existe todavía -hace falta para el deploy
├── frontend/                [x]   sala completa y funcional; falta seed/QR/responsive
│   ├── src/
│   │   ├── main.tsx         [x]
│   │   ├── App.tsx          [x]   ruteo mínimo por path, sin librería
│   │   ├── app/              [x]  Landing, RoomPage, RoomStoreProvider/Context
│   │   ├── realtime/         [x]
│   │   │   ├── protocol.ts        espejo manual de protocol.py
│   │   │   ├── socket.ts          conexión, backoff, heartbeat, cola de reenvío
│   │   │   ├── dispatch.ts        evento entrante -> store
│   │   │   └── throttle.ts        cursores y nota fantasma
│   │   ├── store/             [x] estado de la sala, en un solo sitio
│   │   │   ├── roomStore.ts       RoomCommands + RoomApplyActions
│   │   │   ├── types.ts           RoomState, PendingNoteOp
│   │   │   ├── selectors.ts       orden de notas, columnas, alto dinámico
│   │   │   └── activity.ts        formateo de la franja de actividad
│   │   ├── features/
│   │   │   ├── onboarding/   [x]  nombre + avatar + color
│   │   │   ├── canvas/       [x]  lienzo, fondo (con patrones), columnas
│   │   │   ├── notes/        [x]  post-it, drag, cupos, reacciones, composer,
│   │   │   │                      animación de caída y de aterrizaje, detalle
│   │   │   │                      expandible con checklist (NoteDetail.tsx)
│   │   │   ├── presence/     [x]  cursores remotos
│   │   │   ├── activity/     [x]  franja de eventos recientes
│   │   │   └── chat/               no empezado -último en la lista, a propósito
│   │   ├── components/            sin uso todavía -cada feature trae su propio CSS
│   │   ├── hooks/                 sin uso todavía
│   │   └── lib/               [x] constantes, identity, colores, avatares, ids,
│   │                               checklist en markdown (checklist.ts)
│   └── public/
├── .github/workflows/ci.yml [x]
├── docker-compose.yml       [x]
├── .env.example             [x]
└── CLAUDE.md                [x]
```

Nota sobre `styles/`: en el plan original iba a ser una carpeta compartida de CSS;
en la práctica cada componente de `features/` trae su propio `.css` al lado (`Note.css`,
`Column.css`, etc.) y los tokens compartidos (paleta, tipografía) viven en
`src/index.css`. La carpeta nunca se creó -no hace falta, y no vale la pena moverlo
todo ahora solo para que coincida con el plan original.

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
- **Tomar/soltar un cupo NO es optimista en el frontend, a propósito -única excepción
  entre las acciones sobre una nota (crear, editar, mover y reaccionar sí lo son).**
  `taken_count` es un contador compartido que cualquier participante puede mover al
  mismo tiempo; mezclar mi incremento optimista con la confirmación de otra persona
  llegando en el medio de mi propia espera no tiene una forma robusta de deshacerse
  -bug real encontrado con dos pestañas en carrera de verdad por el mismo cupo,
  documentado en el docstring de `PendingNoteOp` en `frontend/src/store/types.ts`-.
  El botón se deshabilita al instante al clickear (sin doble clic mientras se espera),
  pero el número solo se mueve cuando confirma el servidor. En localhost esa espera es
  imperceptible; con latencia real de producción (Render) puede no serlo, y esto toca
  justo el momento central de la demo. **Revisar esta decisión después del primer
  deploy real:** si se siente lento, un intermedio a explorar es mostrar el pending
  como un estado visual propio (ej. el botón en "..." en vez de deshabilitado sin más)
  sin llegar a mover el contador -entre "no cambia nada" y "lo mueve y lo puede tener
  que revertir" hay margen que no se exploró todavía.
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
- **`RoomSnapshot.participant_id`:** el servidor le dice al cliente cuál es su propio
  `participant_id` en el único evento que ya viaja en exclusiva al socket que se unió.
  Encontrado en el diseño del store del frontend (día 2): el protocolo original no tenía
  este campo porque se diseñó pensando en la sala y en las acciones sobre ella, no en qué
  necesita saber un cliente sobre sí mismo. `PresenceJoined` no lo resolvía -no se difunde
  en una reconexión, y en el primer join correlacionarlo por orden de llegada o por
  nombre/avatar/color es frágil (joins simultáneos, catálogo chico de valores repetibles).
  Si aparece otro dato de este tipo ("qué necesita saber el cliente sobre sí mismo", no
  sobre la sala), este es el precedente: agregarlo al evento que ya es solo-para-mí, no
  inventar una heurística de correlación del lado del cliente.

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
- Para pulido visual (paleta, tipografía, un componente de muestra): mostrar la
  dirección y esperar aprobación antes de aplicarla a todos los componentes -evita
  rehacer diez archivos porque el primero no convenció (así se hizo el pulido del
  día 3: post-it y pin pasaron por dos vueltas de ajuste antes del visto bueno,
  sobre un solo componente de muestra, no sobre la app entera).
- **Nunca ejecutar comandos de git.** Ni `add`, ni `commit`, ni `push`, ni
  `checkout`. El control de versiones lo lleva el usuario a mano. Cuando una tarea
  esté lista, decirlo y parar.

## Fuera de alcance

Decidido y cerrado. No proponer, no implementar:

canales de chat privados por tarea, menciones, toque de atención, historial completo de
actividad, edición de texto simultánea (necesitaría CRDTs), subida de fotos de perfil,
login con contraseña, audio o video, selector de color libre para el fondo.