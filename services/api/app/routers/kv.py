from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import kv_store

router = APIRouter(prefix="/api/kv", tags=["kv"])


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
