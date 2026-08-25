# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 싱글톤 설정 모듈 (src/config.py)
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# 루트 경로 기준 .env 로드
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=BASE_DIR / ".env")


class AppConfig:
    # 1. 디렉토리 경로
    BASE_DIR: Path = BASE_DIR
    DATA_RAW_DIR: Path = BASE_DIR / "data" / "raw"
    DATA_PROCESSED_DIR: Path = BASE_DIR / "data" / "processed"
    PROCESSED_CHUNKS_FILE: Path = DATA_PROCESSED_DIR / "safety_laws_total_chunks.json"
    LOGS_DIR: Path = BASE_DIR / "logs"

    # 2. Qdrant 및 Vector DB 설정
    QDRANT_PATH: str = os.getenv("QDRANT_PATH", str(BASE_DIR / "qdrant_db"))
    COLLECTION_NAME: str = os.getenv("COLLECTION_NAME", "safety_laws")

    # 3. 임베딩 모델 설정
    EMBEDDING_MODEL_NAME: str = os.getenv("EMBEDDING_MODEL_NAME", "BAAI/bge-m3")

    # 4. Open API 및 LLM 설정
    LAW_OPEN_API_OC: str = os.getenv("LAW_OPEN_API_OC", "chikipoki")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    # 5. 수집 대상 법령 파일 목록
    LAW_FILES = [
        "산업안전보건기준에 관한 규칙.json",
        "산업안전보건법.json"
    ]

    # 6. 대표 법령 MST 매핑 (API Fallback)
    MST_MAP = {
        "산업안전보건기준에 관한 규칙": "273603",
        "산업안전보건법": "283449"
    }


config = AppConfig()
