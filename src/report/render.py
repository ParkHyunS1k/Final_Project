"""탐지 결과 → **고정 형식** 위반 리포트. 서술문을 쓰지 않는다.

출력은 위반 1건당 표 한 줄씩이다.

    위반사항 | 의무주체 | 관련조항 | 제재

**주체를 열로 두는 이유**: 보호구 미착용은 사업주(지급)와 근로자(착용) 두
의무가 걸리고 **제재 종류가 다르다**. 사업주는 형사처벌이라 "과태료" 로 쓰면
안 된다 (`README.md` 3절·13절). 한 줄로 합치면 둘 중 하나가 틀린다.

**정액 과태료는 근로자 쪽에만 붙는다.** 사업주 법정형은 구간형이라 금액을
특정할 수 없다 (`ppe_law.py` 참조).

조문 전문은 싣지 않는다. 조·항·호만 적는다 — 사진 한 장 리포트가 4,516자가
되던 원인이 조문 전문이었다 (`train_results.md` 5.1).
"""

from __future__ import annotations

import re

from .ppe_law import Violation


def _keys(s: str) -> set[str]:
    """RAG 가 돌려준 조항 이름에서 `<계열>-<조번호>` 키를 뽑는다.

    조 번호만으로 맞추면 규칙 제32조와 법 제32조가 헷갈리므로 **계열을 함께**
    본다. 우리 표 쪽은 파싱하지 않는다 — `ppe_law.py` 의 `keys` 를 그대로 쓴다.
    """
    fam = "규칙" if "규칙" in s else ("법" if "산업안전보건법" in s else "?")
    return {f"{fam}-{n}" for n in re.findall(r"제(\d+)조", s)}


def _rows(v: Violation) -> list[str]:
    out = []
    for s in v.sanctions:
        pen = f"{s.penalty} ({s.amount})" if s.amount else s.penalty
        out.append(f"| {v.name} | {s.subject} | {s.article} | {pen} |")
    return out


def render(photo: str, detections: list[dict], *, site: str = "미상",
           taken_at: str = "", unresolved: list[str] | None = None,
           rag_articles: list[str] | None = None) -> str:
    """detections: [{"violation": Violation, "conf": float, "box": [x1,y1,x2,y2]}]"""
    lines = [
        "# 안전보건 점검 리포트",
        "",
        f"| 사진 | `{photo}` |",
        "|---|---|",
        f"| 구역 | {site} |",
        f"| 촬영 일시 | {taken_at or '미상'} |",
        f"| 탐지 | {len(detections)}건 |",
        "",
    ]

    if not detections:
        lines += ["**탐지된 보호구 미착용 없음.** 미탐지는 위반 없음이 아니다.", ""]
        return "\n".join(lines)

    lines += ["## 위반 사항", "",
              "| 위반사항 | 의무주체 | 관련조항 | 제재 |",
              "|---|---|---|---|"]
    for d in detections:
        lines += _rows(d["violation"])
    lines.append("")

    lines += ["## 탐지 근거", "",
              "| # | 관측 | 좌표 | 신뢰도 |",
              "|---:|---|---|---:|"]
    for i, d in enumerate(detections, 1):
        x1, y1, x2, y2 = (int(t) for t in d["box"])
        lines.append(f"| {i} | {d['violation'].observation} | "
                     f"[{x1}, {y1}, {x2}, {y2}] | {d['conf']:.2f} |")
    lines.append("")

    if rag_articles:
        lines += ["## 법령 검색 교차 확인 (`rag` 파이프라인)", "",
                  "| 검색된 조항 | 위 표와 일치 |", "|---|---|"]
        ours = set()
        for d in detections:
            for s in d["violation"].sanctions:
                ours |= set(s.keys)
        for a in rag_articles:
            hit = bool(_keys(a) & ours)
            lines.append(f"| {a} | {'예' if hit else '**아니오 — 확인 필요**'} |")
        lines += ["",
                  "> `[API 검증 완료]` 는 **조항이 실재한다**는 뜻이지 "
                  "**적용된다**는 뜻이 아니다 (`docs/eval_protocol.md` 3.9).", ""]

    if unresolved:
        lines += ["## 판정 불가 (위반으로 계상하지 않음)", ""]
        lines += [f"- {u}" for u in unresolved] + [""]

    lines += [
        "---",
        "",
        "| 한계 | |",
        "|---|---|",
        "| 모델 | 공개 사전학습 PPE 모델. 이 현장들로 학습하지 않았다 |",
        "| 정량 기준 | 단안 사진이라 길이 실측 불가. 존재 여부만 판정한다 |",
        "| 주체 판별 | 사진으로는 지급 미이행인지 착용 거부인지 갈리지 않는다 |",
        "| 과태료 정액 | 시행령 별표 35 의 1차 위반 기준이다 |",
    ]
    return "\n".join(lines)
