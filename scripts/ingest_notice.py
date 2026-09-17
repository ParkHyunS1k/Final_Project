"""공고문 파일(이미지·PDF·텍스트) 하나를 넣어 Stage 0 → Stage 1을 눈으로 확인한다.

    py -3 scripts/ingest_notice.py <파일경로>
    py -3 scripts/ingest_notice.py <파일경로> --save      # 전사 텍스트를 .txt로 저장

이미지·스캔 PDF는 GEMINI_API_KEY가 필요하다(.env 또는 환경변수).
텍스트 레이어가 있는 PDF와 .txt는 API를 부르지 않는다.
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.db.fixtures import FIXED_NOW  # noqa: E402
from server.extract import IngestError, RuleNoticeExtractor, ingest  # noqa: E402


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        raise SystemExit(2)
    path = Path(args[0])

    try:
        got = ingest(path)
    except IngestError as e:
        raise SystemExit(f"실패: {e}")

    print(f"경로     : {got.source_path}")
    print(f"경로선택 : {got.method}" + (f"  ({got.model})" if got.model else "  (API 호출 없음)"))
    print(f"글자수   : {got.chars}    지연: {got.latency_ms}ms")
    for w in got.warnings:
        print(f"경고     : {w}")

    print("\n───── 전사 텍스트 ─────")
    print(got.text)

    print("\n───── Stage 1 추출 (rule-v1) ─────")
    base: date = FIXED_NOW.date()  # 가짜 시계. 실제 서비스에서는 오늘 날짜.
    out = RuleNoticeExtractor().extract(got.text, base)
    print(json.dumps(out.to_dict(), ensure_ascii=False, indent=2))

    if "--save" in sys.argv:
        target = path.with_suffix(".transcript.txt")
        target.write_text(got.text, encoding="utf-8")
        print(f"\n저장: {target}")


if __name__ == "__main__":
    main()
