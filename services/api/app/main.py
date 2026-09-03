import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.adapters.streams import CompositeStream
from app.auth import require_session_gate
from app.config import (
    CORS_ORIGINS,
    kv_dir,
    tweet_watch_on_start_enabled,
)
from app.routers import auth as auth_router
from app.routers import fares, geography, health, kv, market, tweets
from app.routers.fares import close_client as close_fares_client
from app.routers.market import close_client
from app.routers.tweets import DEFAULT_HANDLE
from app.services.calendar_job import CALENDAR_RUNNER
from app.services.collection_job import RUNNER
from app.services.kv_store import ensure_kv_dir
from app.services.pass_stream import CALENDAR_STREAM, COLLECTION_STREAM
from app.services.stream_hub import HUB
from app.services.tweet_watcher import RUNNER as TWEET_WATCHER

# Two lines against the day this runs somewhere nobody can attach a debugger.
# Today a Yahoo rate-limit block, a read-only data volume, a stream reconnecting
# in a loop and a cache that never hits all present identically: prices stop and
# the page says nothing.
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_kv_dir()
    # One upstream socket for the whole process, however many tabs listen. It
    # follows nothing until someone asks, so an idle API opens no connection.
    HUB.attach(CompositeStream())
    HUB.start()
    if tweet_watch_on_start_enabled():
        # `watch` only schedules its first capture, so startup never waits for X.
        TWEET_WATCHER.watch(DEFAULT_HANDLE)
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
    await TWEET_WATCHER.stop()
    # After the runners, because cancelling a pass is itself something the
    # watchers are owed — a row holding a `running` document for a pass that
    # will never move again is the spinner-forever failure 8.8 names. Closing
    # the broadcasts first would swallow that last frame.
    COLLECTION_STREAM.close()
    CALENDAR_STREAM.close()
    # The shared upstream clients outlive a request but not the process.
    await close_client()
    await close_fares_client()


app = FastAPI(title="Edicius HQ API", version="0.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# The gate, in one place. Every router below is included with it, so a router
# added later is added next to a visible example and cannot arrive unprotected
# — `tests/test_gate.py` walks this route table and insists on it. The four SSE
# routes need the token in the query string and `require_session_gate` is what
# decides that, for the reason its own docstring gives: a route-level
# dependency can only add to a router-level one, never loosen it.
#
# `/api/health` is in here on purpose. Signed out, the status indicator reads
# "API offline"; that is honest, it leaks nothing, and the login screen is what
# an unauthenticated visitor sees anyway.
GATED = [Depends(require_session_gate)]

# The one router mounted open, because it is how a session is obtained in the
# first place. Its own two authenticated routes carry `require_session` at
# their decorators.
app.include_router(auth_router.router)

app.include_router(health.router, dependencies=GATED)
app.include_router(kv.router, dependencies=GATED)
app.include_router(market.router, dependencies=GATED)
app.include_router(fares.router, dependencies=GATED)
app.include_router(geography.router, dependencies=GATED)
app.include_router(tweets.router, dependencies=GATED)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "edicius-hq-api"}
