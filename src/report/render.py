"""탐지 결과 → 위반 리포트. **관측과 법령 판정을 분리해서 쓴다.**

`README.md` 4절이 요구하는 형식이다. 모델은 본 것만 말하고, 조항 연결은
`ppe_law.py` 의 표가 하고, 최종 판단은 사람이 한다.

**신뢰도를 숨기지 않는다.** 탐지 conf 와 "판정 불가" 사유를 리포트에 그대로 쓴다.
`eval_protocol.md` 3.8 은 판정 불가를 위반으로 계상하지 않는다.
"""

from __future__ import annotations

from .ppe_law import Violation


def render(photo: str, detections: list[dict], *, site: str = "미상",
           taken_at: str = "미상", unresolved: list[str] | None = None) -> str:
    """detections: [{"violation": Violation, "conf": float, "box": [x1,y1,x2,y2]}]"""
    lines = [
        "# 안전보건 점검 리포트 (베이스라인)",
        "",
        f"- **사진**: `{photo}`",
        f"- **현장**: {site}",
        f"- **촬영 일시**: {taken_at}",
        f"- **탐지 건수**: {len(detections)}건",
        "",
        "> 이 리포트는 **사진에서 관측된 사실**과 **해당 관측에 연결되는 조항**을",
        "> 분리해 적는다. 위반 성립 여부의 최종 판단은 사람이 한다.",
        "",
    ]

    if not detections:
        lines += ["## 결과", "", "관측된 보호구 미착용이 없다.", "",
                  "> **주의**: 미탐지는 '위반 없음'이 아니다. 탐지기가 놓쳤을 수 있다.", ""]

    for i, d in enumerate(detections, 1):
        v: Violation = d["violation"]
        x1, y1, x2, y2 = (int(t) for t in d["box"])
        lines += [
            f"## {i}. {v.name}  (`{v.code}`)",
            "",
            f"**관측 사실**  {v.observation}",
            f"**위치**  사진 좌표 [{x1}, {y1}, {x2}, {y2}]",
            f"**탐지 신뢰도**  {d['conf']:.2f}",
            "",
            "| 의무 주체 | 의무 | 근거 | 제재 |",
            "|---|---|---|---|",
        ]
        for s in v.sanctions:
            lines.append(f"| {s.subject} | {s.duty} | {s.basis} | {s.penalty} |")
        lines.append("")
        for s in v.sanctions:
            lines.append(f"- **{s.subject}** 조항 위계: {s.chain}")
            if s.note:
                lines.append(f"  - {s.note}")
        lines += [
            "",
            "> **사진만으로는 지급 미이행인지 착용 거부인지 갈리지 않는다.**",
            "> 두 주체를 모두 적는 이유이며, 어느 쪽인지는 현장 확인이 필요하다.",
            "",
        ]

    if unresolved:
        lines += ["## 판정 불가", "",
                  "아래는 **위반으로 계상하지 않는다.** 수동 검토가 필요하다.", ""]
        lines += [f"- {u}" for u in unresolved] + [""]

    lines += [
        "---",
        "",
        "### 이 리포트의 한계",
        "",
        "- **베이스라인이다.** 공개 사전학습 PPE 모델을 그대로 쓴 결과이며 이 현장들로",
        "  학습하지 않았다.",
        "- **길이 기준은 검증하지 않는다.** 단안 사진에서 실측이 불가능하므로 구성",
        "  요소의 존재 여부만 판정한다 (`README.md` 3절).",
        "- **조항 연결은 고정 표다.** 법령 RAG 가 아니라 `src/report/ppe_law.py` 의",
        "  매핑을 쓴다. 조항 실재 검증은 아직 붙이지 않았다.",
    ]
    return "\n".join(lines)
