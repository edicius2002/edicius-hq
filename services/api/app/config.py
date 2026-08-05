import os
from pathlib import Path

# Path A user-state keys (expand as features land).
ALLOWED_KV_KEYS = frozenset(
    {
        "prefs",
        "watchlist",
        "portfolio",
        "alert-rules",
        "finance",
        "greenlight",
        "drawings",
    }
)

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]


def local_data_dir() -> Path:
    return Path(os.getenv("LOCAL_DATA_DIR", ".local-data")).resolve()


def kv_dir() -> Path:
    return local_data_dir() / "kv"
