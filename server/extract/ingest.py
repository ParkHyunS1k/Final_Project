"""파일 → 텍스트. 공고문이 이미지·PDF로만 오는 현실을 처리하는 계층.

경로 선택 규칙 (싼 것부터)
    .txt / .md            → 그대로 읽는다 (API 호출 0)
    .pdf (텍스트 레이어)  → pypdf로 뽑는다 (API 호출 0, 오류 없음)
    .pdf (스캔본) / 이미지 → Stage 0 전사기(Gemini)에 넘긴다

PDF에 텍스트 레이어가 있으면 VLM을 부르지 않는다. 정확하고 공짜이고 재현 가능하다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

from .vision import GeminiTranscriber, Transcriber, TranscriptionError

MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".gif": "image/gif",
}
PLAIN_SUFFIXES = {".txt", ".md"}

# 이보다 적게 나오면 텍스트 레이어가 없는 스캔본으로 본다.
MIN_PDF_TEXT_CHARS = 200
# inline_data 요청 크기 상한(대략). 이보다 크면 Files API가 필요하다 — 아직 안 만들었다.
MAX_INLINE_BYTES = 15 * 1024 * 1024


class IngestError(Exception):
    pass


@dataclass
class Ingested:
    text: str
    source_path: str
    method: str                # 'plain' | 'pdf_text_layer' | 'vlm'
    model: str | None = None
    latency_ms: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return len(self.text)


def ingest(path: str | Path, *, transcriber: Transcriber | None = None) -> Ingested:
    file_path = Path(path)
    if not file_path.exists():
        raise IngestError(f"파일이 없다: {file_path}")
    suffix = file_path.suffix.lower()

    if suffix in PLAIN_SUFFIXES:
        return Ingested(
            text=file_path.read_text(encoding="utf-8"),
            source_path=str(file_path),
            method="plain",
        )

    if suffix not in MIME_BY_SUFFIX:
        raise IngestError(
            f"지원하지 않는 형식: {suffix} (가능: {sorted(PLAIN_SUFFIXES | set(MIME_BY_SUFFIX))})"
        )

    warnings: list[str] = []
    if suffix == ".pdf":
        text, warn = _pdf_text_layer(file_path)
        warnings += warn
        if len(text.strip()) >= MIN_PDF_TEXT_CHARS:
            return Ingested(
                text=text, source_path=str(file_path), method="pdf_text_layer", warnings=warnings
            )
        warnings.append("PDF에 쓸 만한 텍스트 레이어가 없다 → 전사기로 넘긴다(스캔본으로 판단).")

    data = file_path.read_bytes()
    if len(data) > MAX_INLINE_BYTES:
        raise IngestError(
            f"파일이 너무 크다({len(data) / 1e6:.1f}MB). {MAX_INLINE_BYTES / 1e6:.0f}MB 이하로 줄여야 한다."
        )

    transcriber = transcriber or GeminiTranscriber()
    try:
        result = transcriber.transcribe(data, MIME_BY_SUFFIX[suffix])
    except TranscriptionError as e:
        raise IngestError(str(e)) from None
    return Ingested(
        text=result.text,
        source_path=str(file_path),
        method="vlm",
        model=result.model,
        latency_ms=result.latency_ms,
        warnings=warnings + result.warnings,
    )


def _pdf_text_layer(file_path: Path) -> tuple[str, list[str]]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "", ["pypdf가 없어 텍스트 레이어를 건너뛴다 (py -3 -m pip install pypdf)"]
    # 깨진 PDF는 전사기로 넘길 것이므로 pypdf의 경고를 콘솔에 뿌리지 않는다.
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    try:
        reader = PdfReader(str(file_path))
        pages = [(page.extract_text() or "") for page in reader.pages]
    except Exception as e:  # 깨진 PDF도 전사기로 넘겨서 살린다
        return "", [f"PDF 파싱 실패({type(e).__name__}) → 전사기로 넘긴다"]
    return "\n".join(pages).strip(), []
