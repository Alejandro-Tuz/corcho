from fastapi import APIRouter

from app.api.v1 import health, rooms

router = APIRouter(prefix="/api/v1")
router.include_router(rooms.router, tags=["rooms"])
router.include_router(health.router, tags=["health"])
