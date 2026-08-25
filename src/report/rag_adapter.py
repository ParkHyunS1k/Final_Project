"""탐지 관측 → `rag` 브랜치 파이프라인 입력. **매핑을 표로 관리한다.**

`rag` 브랜치(`산업안전RAG/`)의 계약은 이렇다.

    {"event_id", "timestamp", "zone", "snapshot_path",
     "bbox_coordinates", "detected_hazard", "risk_level"}
      -> {"s2_report", "s3_tbm_report"}

**문제는 `detected_hazard` 다.** 저쪽 `SafetyRAGPipeline` 이 이 문자열을
`store.search_hybrid(hazard, top_k=2)` 로 **법령 검색 쿼리에 그대로 넣는다.**
즉 조항 연결 품질이 우리가 넘기는 산문에 통째로 걸린다.

그래서 **문자열을 모델 출력이나 즉석 문장으로 만들지 않는다.** 아래
`HAZARD_QUERY` 표에서 가져온다. 이유는 두 가지다.

1. **추적 가능해야 한다.** 조항이 틀리게 연결되면 원인이 탐지인지 쿼리 문구인지
   갈려야 한다. 코드 분기 안에 문장이 숨어 있으면 못 가른다.
2. **관측과 판정의 분리를 최대한 지킨다** (`README.md` 4절). 이 문자열 자체가
   이미 법적 색을 띠므로, 우리가 매번 새로 쓰지 않고 **고정된 표현 하나**로
   묶어 두고 그 사실을 리포트에 명시한다.

**남은 어긋남 — 해소하지 못했고 숨기지도 않는다.**

- `event_id` · `timestamp` · `risk_level` 은 **실시간 경보 전제**의 필드다.
  우리는 사진 업로드 제품이라 대응물이 없다. `timestamp` 는 EXIF 가 있으면 쓰고
  없으면 비운다. `risk_level` 은 **탐지기가 낼 수 없는 값이라 고정한다.**
- `zone` 은 사람이 적는 값이다. 사진은 장면을 지정할 뿐 구역명을 모른다.
"""

from __future__ import annotations

from dataclasses import dataclass

# 위반 코드 -> 법령 검색 쿼리. **여기가 유일한 정의다.**
# 조항 연결이 틀리면 먼저 이 표를 의심할 것.
HAZARD_QUERY = {
    "UA-04": "작업자 안전모 미착용 보호구 지급 및 착용 조치 미이행",
    "UA-02": "작업자 안전대 안전벨트 미착용 보호구 지급 및 착용 조치 미이행",
}

# 탐지기는 위험 등급을 낼 수 없다. 고정하고 그 사실을 리포트에 적는다.
FIXED_RISK_LEVEL = "UNSPECIFIED"


@dataclass
class Observation:
    """모델이 실제로 말할 수 있는 것만 담는다."""
    violation_code: str
    box: tuple[float, float, float, float]
    conf: float
    photo: str
    site: str = "미상"
    taken_at: str = ""


def to_event(obs: Observation, *, event_id: str) -> dict:
    """`rag` 파이프라인이 받는 dict 로 바꾼다.

    **표에 없는 코드는 지어내지 않고 예외를 낸다.** 모르는 위반을 그럴듯한
    문장으로 만들어 넘기면 조항 환각의 출발점이 된다.
    """
    if obs.violation_code not in HAZARD_QUERY:
        raise KeyError(
            f"{obs.violation_code} 에 대한 검색 쿼리가 표에 없다. "
            f"`HAZARD_QUERY` 에 먼저 등록할 것 — 문장을 즉석에서 만들지 않는다.")
    x1, y1, x2, y2 = (int(v) for v in obs.box)
    return {
        "event_id": event_id,
        "timestamp": obs.taken_at,          # EXIF 없으면 빈 문자열
        "zone": obs.site,
        "snapshot_path": obs.photo,
        "bbox_coordinates": [x1, y1, x2, y2],
        "detected_hazard": HAZARD_QUERY[obs.violation_code],
        "risk_level": FIXED_RISK_LEVEL,
    }


CAVEAT = """> **RAG 입력에 대한 주석.** `detected_hazard` 는 모델이 만든 문장이 아니라
> `src/report/rag_adapter.py` 의 고정 표에서 온다. 법령 검색은 이 문자열 하나에
> 걸려 있으므로, 조항이 틀리게 연결되면 표를 먼저 의심할 것.
> `risk_level` 은 탐지기가 낼 수 없어 `UNSPECIFIED` 로 고정했고,
> `zone` 과 `timestamp` 는 사람 입력·EXIF 에 의존한다."""


def run_pipeline(rag_root, event: dict) -> dict:
    """`rag` 브랜치의 `SafetyRAGPipeline` 을 **서브프로세스로** 호출한다.

    `rag_root` 는 `산업안전RAG/` 디렉터리다. 병합하지 않고 worktree 로 꺼내
    가리켜도 된다.

    **왜 서브프로세스인가 — 패키지 이름이 충돌한다.**
    저쪽 코드는 `from src.config import config` 처럼 **`src` 를 최상위 패키지로**
    쓴다. 우리도 `src/` 를 쓰므로, 우리 프로세스에서는 `src` 가 이미 우리 것으로
    바인딩돼 저쪽 `src.pipeline` 을 찾지 못한다.
    **`rag` 를 병합해도 이 충돌은 사라지지 않는다** — 한 인터프리터 안에서 두
    `src` 를 동시에 쓸 수 없다. 그래서 분리 실행이 편의가 아니라 필요다.

    덤으로 BGE-M3 GPU 로딩도 우리 프로세스 밖에서 끝난다.

    **주의**: 저쪽은 `GEMINI_API_KEY` 가 있으면 Gemini 를 호출한다. 우리
    `README.md` 8절은 배포 로컬 전용이므로 키 없이 돌려 템플릿 경로를 쓴다.
    """
    import json
    import pathlib
    import subprocess
    import sys
    import tempfile

    root = pathlib.Path(rag_root).resolve()
    driver = (
        "import json, sys\n"
        "sys.path.insert(0, '.')\n"
        "from src.pipeline import SafetyRAGPipeline\n"
        "ev = json.load(open(sys.argv[1], encoding='utf-8'))\n"
        "res = SafetyRAGPipeline().process_event(ev)\n"
        "json.dump(res, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)\n"
    )
    with tempfile.TemporaryDirectory() as td:
        ev_p = pathlib.Path(td) / "event.json"
        out_p = pathlib.Path(td) / "out.json"
        ev_p.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
        r = subprocess.run([sys.executable, "-c", driver, str(ev_p), str(out_p)],
                           cwd=root, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if not out_p.exists():
            raise RuntimeError(
                f"rag 파이프라인 실패 (exit {r.returncode})\n{r.stderr[-2000:]}")
        return json.loads(out_p.read_text(encoding="utf-8"))


def retrieved_articles(s2_report: str) -> list[str]:
    """S2 리포트에서 **검색된 조항 이름만** 뽑는다.

    저쪽 파이프라인은 조문 전문을 통째로 실은 서술형 리포트를 돌려준다.
    사진 한 장에 4,516자가 나오고 그중 28%가 조문 전문이며, **틀린 조항의
    전문까지 실린다** (`train_results.md` 5.1). 우리 리포트는 고정 표 형식이라
    조항 이름만 필요하다.
    """
    import re

    return re.findall(r"^### \[법령 근거 \d+\]\s+(.+?)\s*\[API", s2_report, re.M)
