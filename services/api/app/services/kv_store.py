import json
import os
import tempfile
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


def _write_atomically(path: Path, text: str) -> None:
    """
    Beside, then flushed, then moved into place.

    This used to be `path.write_text`, which truncates the file and then writes
    into it: anything that went wrong in between — a crash, a full disk, a
    container stopped mid-request — left the document empty or half written,
    with no other copy. The bar cache forty lines away already did this
    correctly, with a comment about readers never seeing half a file. The
    disposable cache had the durable write and the ledger did not.

    `os.replace` is atomic on POSIX and on Windows, but only within one
    filesystem, so the temporary is made in the destination's own directory.
    The flush and `fsync` are what make the bytes real before the rename claims
    they are; without them a rename can land while the contents are still in a
    buffer nobody wrote out.
    """
    directory = path.parent
    descriptor, temporary_name = tempfile.mkstemp(dir=directory, prefix=path.name, suffix=".tmp")
    temporary = Path(temporary_name)

    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        # The original is still whole — that is the entire point — so the only
        # thing to clean up is the half-written temporary.
        temporary.unlink(missing_ok=True)
        raise


def put_value(key: str, value: Any) -> Any:
    assert_allowed_key(key)
    ensure_kv_dir()
    _write_atomically(_path_for(key), json.dumps(value, ensure_ascii=True, indent=2))
    return value


def delete_value(key: str) -> None:
    assert_allowed_key(key)
    path = _path_for(key)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    path.unlink()
