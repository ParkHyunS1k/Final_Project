"""SQLite 연결 · 스키마 초기화.

주의: SQLite는 외래키 검사가 **연결마다** 기본 비활성이다.
connect()가 항상 PRAGMA foreign_keys = ON 을 실행한다. 커넥션을 직접 만들지 말 것.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connect(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # 트랜잭션 안에서는 이 PRAGMA가 무시되므로 연결 직후에 실행한다.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()


def fresh_db(path: str = ":memory:") -> sqlite3.Connection:
    """에피소드 격리용 — 매번 빈 DB를 만든다 (docs/eval.md)."""
    conn = connect(path)
    init_db(conn)
    return conn
