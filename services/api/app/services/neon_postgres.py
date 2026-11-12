"""Server-only connection check for the linked Neon Postgres branch."""

import os

import psycopg


def check_connection() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise ValueError("DATABASE_URL is not configured")

    # The pooled URL is for application traffic. No schema or user data is read.
    with (
        psycopg.connect(database_url, connect_timeout=10) as connection,
        connection.cursor() as cursor,
    ):
        cursor.execute("select 1")
        if cursor.fetchone() != (1,):
            raise RuntimeError("Neon connection check returned an unexpected result")
