from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from app.routers import health, kv, market
from app.routers.market import close_client
from app.services.kv_store import ensure_kv_dir
from app.adapters.streams import CompositeStream
from app.services.stream_hub import HUB


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_kv_dir()
    # One upstream socket for the whole process, however many tabs listen. It
    # follows nothing until someone asks, so an idle API opens no connection.
    HUB.attach(CompositeStream())
    HUB.start()
    yield
    await HUB.stop()
    # The shared upstream client outlives a request but not the process.
    await close_client()


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
app.include_router(market.router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "edicius-hq-api"}
