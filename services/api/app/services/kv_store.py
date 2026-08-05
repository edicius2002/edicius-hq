import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from app.config import ALLOWED_KV_KEYS, kv_dir


def ensure_kv_dir() -> None:
    kv_dir().mkdir(parents=True, exist_ok=True)


def assert_allowed_key(key: str) -> None:
    if key not in ALLOWED_KV_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Key '{key}' is not allowlisted",
        )


def _path_for(key: str) -> Path:
    return kv_dir() / f"{key}.json"


def get_value(key: str) -> Any:
    assert_allowed_key(key)
    path = _path_for(key)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    return json.loads(path.read_text(encoding="utf-8"))


def put_value(key: str, value: Any) -> Any:
    assert_allowed_key(key)
    ensure_kv_dir()
    path = _path_for(key)
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2), encoding="utf-8")
    return value


def delete_value(key: str) -> None:
    assert_allowed_key(key)
    path = _path_for(key)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    path.unlink()
