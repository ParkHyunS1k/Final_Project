"""문서 → 프로젝트 부트스트랩.

    Stage 0: 이미지·PDF → 텍스트   (ingest.py — 필요할 때만 Gemini 전사)
    Stage 1: 텍스트 → 앵커·메타    (notice.py — 규칙 baseline, 나중에 로컬 LLM)

추출 결과를 DB에 쓰는 곳은 여기 한 군데다. 추출기(규칙/LLM)는 순수 함수로 두고,
DB 쓰기는 project_id 범위 안에서만 한다.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..tools.registry import ToolContext
from .ingest import ingest
from .notice import NoticeExtraction, NoticeExtractor, RuleNoticeExtractor


def add_document(
    ctx: ToolContext,
    doc_type: str,
    content: str,
    title: str | None = None,
    *,
    source_path: str | None = None,
    extract_method: str = "plain",
    extract_model: str | None = None,
) -> str:
    doc_id = ctx.new_id("d")
    ctx.conn.execute(
        "INSERT INTO document"
        " (id, project_id, doc_type, title, content, uploaded_at, source_path, extract_method, extract_model)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            doc_id,
            ctx.project_id,
            doc_type,
            title,
            content,
            ctx.now.isoformat(),
            source_path,
            extract_method,
            extract_model,
        ),
    )
    return doc_id


def bootstrap_from_file(
    ctx: ToolContext,
    path: str,
    *,
    title: str | None = None,
    extractor: NoticeExtractor | None = None,
    transcriber=None,
) -> dict:
    """이미지·PDF·텍스트 파일 → 앵커. Stage 0(전사) → Stage 1(추출) 순서로 간다.

    전사 결과 텍스트는 document.content에 그대로 남는다. 추출이 틀리면 사용자가
    그 텍스트를 고쳐 다시 돌릴 수 있어야 하기 때문이다.
    """
    ingested = ingest(path, transcriber=transcriber)
    result = bootstrap_from_notice(
        ctx,
        ingested.text,
        title=title or Path(path).name,
        extractor=extractor,
        source_path=ingested.source_path,
        extract_method=ingested.method,
        extract_model=ingested.model,
    )
    result["ingest"] = {
        "method": ingested.method,
        "model": ingested.model,
        "chars": ingested.chars,
        "latency_ms": ingested.latency_ms,
        "warnings": ingested.warnings,
    }
    return result


def bootstrap_from_notice(
    ctx: ToolContext,
    text: str,
    *,
    title: str | None = None,
    extractor: NoticeExtractor | None = None,
    source_path: str | None = None,
    extract_method: str = "plain",
    extract_model: str | None = None,
) -> dict:
    """공고문 텍스트 → document + 앵커 마일스톤 + project_meta.

    앵커는 locked=1로 저장한다. 이후 스케줄러가 절대 옮기지 않는다.
    """
    extractor = extractor or RuleNoticeExtractor()
    doc_id = add_document(
        ctx,
        "notice",
        text,
        title,
        source_path=source_path,
        extract_method=extract_method,
        extract_model=extract_model,
    )
    extraction: NoticeExtraction = extractor.extract(text, ctx.now.date())

    existing = {
        (r["title"], r["date"])
        for r in ctx.conn.execute(
            "SELECT title, date FROM milestone WHERE project_id = ?", (ctx.project_id,)
        )
    }
    created = []
    for anchor in extraction.anchors:
        if (anchor.title, anchor.date) in existing:
            continue
        ms_id = ctx.new_id("ms")
        ctx.conn.execute(
            "INSERT INTO milestone"
            " (id, project_id, title, date, date_hint, kind, event_type, locked, source_doc_id)"
            " VALUES (?, ?, ?, ?, ?, 'anchor', ?, 1, ?)",
            (
                ms_id,
                ctx.project_id,
                anchor.title,
                anchor.date,      # 날짜 미확정이면 NULL
                anchor.date_hint,
                anchor.event_type,
                doc_id,
            ),
        )
        created.append({"id": ms_id, **anchor.to_dict()})

    _upsert_meta(ctx, extraction, doc_id)
    ctx.conn.commit()
    return {
        "document_id": doc_id,
        "extractor": getattr(extractor, "name", "unknown"),
        "anchors": created,
        "deliverables": extraction.deliverables,
        "constraints": extraction.constraints,
        "criteria": extraction.criteria,
    }


def _upsert_meta(ctx: ToolContext, extraction: NoticeExtraction, doc_id: str) -> None:
    dumps = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731
    ctx.conn.execute(
        "INSERT INTO project_meta (project_id, deliverables, constraints, criteria, source_doc_id)"
        " VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT(project_id) DO UPDATE SET"
        "   deliverables = excluded.deliverables,"
        "   constraints  = excluded.constraints,"
        "   criteria     = excluded.criteria,"
        "   source_doc_id = excluded.source_doc_id",
        (
            ctx.project_id,
            dumps(extraction.deliverables),
            dumps(extraction.constraints),
            dumps(extraction.criteria),
            doc_id,
        ),
    )
