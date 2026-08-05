from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from app.routers import health, kv
from app.services.kv_store import ensure_kv_dir


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_kv_dir()
    yield


app = FastAPI(title="Edicius HQ API", version="0.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health.router)
app.include_router(kv.router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "edicius-hq-api"}
