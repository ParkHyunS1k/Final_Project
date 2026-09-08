"""환경 설정 로더.

API 키는 코드·저장소에 넣지 않는다. 환경변수 또는 저장소 루트의 .env에서만 읽는다.
.env는 절대 커밋하지 않는다(.gitignore 참조).
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"


def load_env(path: Path | None = None) -> None:
    """.env를 os.environ에 채운다. 이미 설정된 환경변수는 덮어쓰지 않는다."""
    env_path = path or ENV_FILE
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("'\"")
        os.environ.setdefault(key, value)


def get(name: str, default: str | None = None) -> str | None:
    load_env()
    return os.environ.get(name, default)


def require(name: str) -> str:
    value = get(name)
    if not value:
        raise RuntimeError(
            f"{name}가 설정되지 않았다. 저장소 루트에 .env를 만들고 `{name}=...` 를 넣거나 "
            f"환경변수로 설정한다. 키는 코드나 커밋에 넣지 않는다."
        )
    return value
