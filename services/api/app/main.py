import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.adapters.fares import sky_airline
from app.adapters.streams import CompositeStream
from app.config import CORS_ORIGINS, kv_dir, sky_official_lookup_enabled
from app.routers import fares, geography, health, kv, market, tweets
from app.routers.fares import close_client as close_fares_client
from app.routers.market import close_client
from app.services.calendar_job import CALENDAR_RUNNER
from app.services.collection_job import RUNNER
from app.services.kv_store import ensure_kv_dir
from app.services.pass_stream import CALENDAR_STREAM, COLLECTION_STREAM
from app.services.stream_hub import HUB

# Two lines against the day this runs somewhere nobody can attach a debugger.
# Today a Yahoo rate-limit block, a read-only data volume, a stream reconnecting
# in a loop and a cache that never hits all present identically: prices stop and
# the page says nothing.
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
)

logger = logging.getLogger(__name__)


async def start_official_sky_session() -> sky_airline.PlaywrightSkySession | None:
    """Start the optional browser only after explicit configuration opt-in."""
    if not sky_official_lookup_enabled():
        sky_airline.set_session(None)
        return None
    browser_session = sky_airline.PlaywrightSkySession()
    try:
        await browser_session.start()
    except Exception:
        sky_airline.set_session(None)
        logger.warning(
            "official SKY lookup unavailable; retaining Google null prices", exc_info=True
        )
        return None
    sky_airline.set_session(browser_session)
    return browser_session


async def close_official_sky_session(session: sky_airline.PlaywrightSkySession | None) -> None:
    """Close an optional browser and always remove it from the container."""
    try:
        if session is not None:
            await session.close()
    finally:
        sky_airline.set_session(None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_kv_dir()
    sky_session = await start_official_sky_session()
    # One upstream socket for the whole process, however many tabs listen. It
    # follows nothing until someone asks, so an idle API opens no connection.
    HUB.attach(CompositeStream())
    HUB.start()
    logger.info("api started; kv=%s", kv_dir())
    yield
    logger.info("api stopping")
    await HUB.stop()
    # Before the clients, not after: a collection pass runs on the shared fares
    # client, and closing that first would have the pass die on a socket that
    # vanished rather than on being asked to stop — 12.210. The calendar pass
    # runs in its own slot on the same client and is stopped here for the same
    # reason; both are cancelled before either client goes away, because
    # stopping one and then closing the socket the other is still using would
    # reintroduce the confusing failure for the half that was left running.
    await RUNNER.aclose()
    await CALENDAR_RUNNER.aclose()
    # After the runners, because cancelling a pass is itself something the
    # watchers are owed — a row holding a `running` document for a pass that
    # will never move again is the spinner-forever failure 8.8 names. Closing
    # the broadcasts first would swallow that last frame.
    COLLECTION_STREAM.close()
    CALENDAR_STREAM.close()
    # The shared upstream clients outlive a request but not the process.
    await close_client()
    await close_fares_client()
    await close_official_sky_session(sky_session)


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
app.include_router(fares.router)
app.include_router(geography.router)
app.include_router(tweets.router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "edicius-hq-api"}
