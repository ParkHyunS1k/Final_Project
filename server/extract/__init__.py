"""문서 추출 계층.

    Stage 0  ingest.py / vision.py — 이미지·PDF → 텍스트 (Gemini 전사, 필요할 때만)
    Stage 1  notice.py             — 텍스트 → 앵커·제출물·제약·평가기준
    저장     bootstrap.py          — DB 쓰기는 여기 한 곳에서만

추출기는 순수 함수, DB 쓰기는 bootstrap 한 곳에서만.
"""
from .bootstrap import add_document, bootstrap_from_file, bootstrap_from_notice
from .dates import DateMatch, find_dates, parse_one
from .ingest import IngestError, Ingested, ingest
from .notice import Anchor, NoticeExtraction, NoticeExtractor, RuleNoticeExtractor
from .vision import GeminiTranscriber, Transcriber, Transcript, TranscriptionError

__all__ = [
    "add_document",
    "bootstrap_from_file",
    "bootstrap_from_notice",
    "DateMatch",
    "find_dates",
    "parse_one",
    "ingest",
    "Ingested",
    "IngestError",
    "Anchor",
    "NoticeExtraction",
    "NoticeExtractor",
    "RuleNoticeExtractor",
    "GeminiTranscriber",
    "Transcriber",
    "Transcript",
    "TranscriptionError",
]
