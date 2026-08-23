"""Engine y sessionmaker de SQLAlchemy.

Lee `DATABASE_URL` del entorno tal como lo hace `alembic/env.py`. Sin URL por defecto
embebida en el código: si falta la variable, falla ruidoso al importar el módulo en vez
de conectarse silenciosamente a algo que no es la base pensada. Cuando exista
`app/core/config.py` esto se reemplaza por `Settings`; hasta entonces es el único lugar
que sabe leer `DATABASE_URL`.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)
