"""notes text length 2000

Revision ID: 0594aa52662a
Revises: 8d9880ff76ea
Create Date: 2026-08-24 10:50:47.425230

Sube el CHECK "text_length" de notas de 500 a 2000 caracteres: la nota expandible
(pulido día 3 extendido) le da a `text` un rol nuevo -descripción larga + checklist en
markdown, no solo el título corto de la creación-, y 500 se queda corto para eso.
Escrita a mano en vez de con `--autogenerate`: un cambio de solo el cuerpo de un CHECK
no siempre lo detecta (mismo aviso que ya deja CLAUDE.md sobre constraints declarados
en `__table_args__`).
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0594aa52662a"
down_revision: str | None = "8d9880ff76ea"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_notes_text_length"), "notes", type_="check")
    op.create_check_constraint("text_length", "notes", "char_length(text) <= 2000")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_notes_text_length"), "notes", type_="check")
    op.create_check_constraint("text_length", "notes", "char_length(text) <= 500")
