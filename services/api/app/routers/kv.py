from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.config import ALLOWED_KV_KEYS
from app.services import kv_store


def _allowed_key_or_not_found(key: str) -> None:
    """Do not disclose retired or unrecognised local document names."""
    if key not in ALLOWED_KV_KEYS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")


router = APIRouter(prefix="/api/kv", tags=["kv"], dependencies=[Depends(_allowed_key_or_not_found)])


class KvPutBody(BaseModel):
    value: Any = Field(..., description="JSON-serializable value to store")


class KvResponse(BaseModel):
    key: str
    value: Any


@router.get("/{key}", response_model=KvResponse)
def get_kv(key: str) -> KvResponse:
    return KvResponse(key=key, value=kv_store.get_value(key))


@router.put("/{key}", response_model=KvResponse)
def put_kv(key: str, body: KvPutBody) -> KvResponse:
    return KvResponse(key=key, value=kv_store.put_value(key, body.value))


@router.delete("/{key}", status_code=204)
def delete_kv(key: str) -> None:
    kv_store.delete_value(key)
