from fastapi import FastAPI

from app.routers import health

app = FastAPI(title="Edicius HQ API", version="0.0.0")
app.include_router(health.router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "edicius-hq-api"}
