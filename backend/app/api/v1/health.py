"""GET /health: liveness simple, sin tocar Postgres ni Redis -si el proceso responde,
está vivo. Comprobar dependencias es otra cosa, fuera de alcance de un demo de 3
días."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
