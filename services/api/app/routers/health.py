from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/health")
def get_health() -> dict[str, str]:
    return {"status": "ok"}
