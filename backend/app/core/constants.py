"""Catálogos visuales y de reacciones.

Decisión de diseño ya tomada: sin CHECK en Postgres para color/avatar/background, para
poder sumar una opción durante el pulido del día 3 sin migración. La validación vive
solo acá, contra `Literal`. Excepción: las reacciones también viven acá aunque están
fijas por el alcance (✓, 👀, 🔥) — un cliente manipulado no debe poder mandar cualquier
string, porque la tarjeta las agrupa por emoji y una fila impredecible es basura.

`kind` y `status` de las notas NO están en este módulo: son lógica de negocio y ya son
enum nativo en `app/models/note.py`.

Cada catálogo es una única tupla; el `Literal` se deriva de ella con `Literal[*TUPLA]`
para que no haya dos listas para mantener sincronizadas a mano.
"""

from typing import Final, Literal

# Colores de post-it. Contraste probado contra texto oscuro, nada de paleta arcoíris.
NOTE_COLORS: Final = ("yellow", "pink", "blue", "green", "orange")
NoteColor = Literal[*NOTE_COLORS]

# Colores de participante: cursor, borde de nota fantasma, iniciales del avatar.
# Paleta separada de la de notas -una identifica personas, la otra identifica post-its-
# para que nunca se confundan a simple vista.
PARTICIPANT_COLORS: Final = ("coral", "teal", "violet", "amber", "sky", "rose")
ParticipantColor = Literal[*PARTICIPANT_COLORS]

# Avatares: ícono sobre un color, nunca una foto (subida de fotos de perfil, fuera de
# alcance). El valor es un identificador, no una URL.
AVATARS: Final = ("fox", "penguin", "turtle", "owl", "bee", "whale", "hedgehog", "octopus")
Avatar = Literal[*AVATARS]

# Fondos del lienzo: colores sutiles, no patrones -un color se nota a distancia cuando
# cambia en la otra pantalla, un patrón no-, sin selector libre (fuera de alcance).
# hueso, gris cálido, salvia apagado, azul niebla, y uno oscuro para contraste.
BACKGROUNDS: Final = ("bone", "warm_gray", "sage", "fog_blue", "charcoal")
Background = Literal[*BACKGROUNDS]

# Reacciones: fijas por el alcance. No es un catálogo visual, pero el mismo mecanismo
# de Literal-contra-constante aplica, y por el mismo motivo: predecibilidad de lo que
# puede llegar por el socket.
REACTIONS: Final = ("✓", "👀", "🔥")
Reaction = Literal[*REACTIONS]
