"""보호구 미착용 → 조항·제재 매핑. **표로 관리하고 코드로 숨기지 않는다.**

조·항·호와 벌칙 조항은 `산업안전RAG/data/processed/safety_laws_total_chunks.json`
원문에서 확인했다. 조항 연결이 틀렸을 때 어디서 틀렸는지 추적하려면 매핑이
코드 분기가 아니라 데이터로 남아야 한다.

**의무 주체가 둘로 갈리고 제재 종류가 다르다. 이것이 이 모듈의 존재 이유다.**

    사업주  지급 의무  규칙 제32조 제1항 → 법 제38조 제3항 → 제168조 제1호
                       **형사처벌** (5년 이하 징역 또는 5천만원 이하 벌금)
    근로자  착용 의무  법 제40조 (규칙 제32조 제2항) → 제175조 제6항 제3호
                       **과태료** (300만원 이하)

**한 줄로 합치면 틀린다.** `README.md` 3절·13절이 못박았다 — 사업주 안전조치
의무 위반은 과태료가 아니라 형사처벌이고, 리포트에 "과태료" 라고 쓰면 안 된다.
과태료가 명확한 것은 **근로자 보호구 미착용(제40조) 하나**다. 그래서 출력에서
주체를 열로 두고 행을 나눈다.

**사진으로는 지급 미이행인지 착용 거부인지 갈리지 않는다.** 둘 다 내보내고
판단은 사람이 한다 (`README.md` 4절 — 관측과 판정의 분리).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Sanction:
    subject: str          # 의무 주체
    article: str          # 위반 조항 (조·항·호까지)
    penalty_article: str  # 벌칙·과태료 조항
    penalty: str          # 제재 내용
    amount: str = ""      # 정액이 정해진 경우만. 없으면 빈칸
    note: str = ""
    # 검색 결과와 대조할 기계 판독용 키. `<계열>-<조번호>`.
    # 산문을 파싱하지 않는다 — "법 제40조 (규칙 제32조 ...)" 처럼 계열이 섞인다.
    keys: tuple[str, ...] = ()


@dataclass(frozen=True)
class Violation:
    code: str             # 507 클래스 코드
    name: str             # 위반 사항 (출력 1열)
    observation: str      # 모델이 말할 수 있는 것
    sanctions: list[Sanction] = field(default_factory=list)


def _employer(item_no: int, gear: str) -> Sanction:
    return Sanction(
        subject="사업주",
        article=f"산업안전보건기준에 관한 규칙 제32조 제1항 제{item_no}호 ({gear} 지급)",
        penalty_article="산업안전보건법 제168조 제1호 (제38조 제3항 위반)",
        penalty="5년 이하 징역 또는 5천만원 이하 벌금",
        note="근로자 사망 시 7년 이하 징역 또는 1억원 이하 벌금. 과태료가 아니다.",
        keys=("규칙-32",),
    )


WORKER = Sanction(
    subject="근로자",
    article="산업안전보건법 제40조 (규칙 제32조 제2항 착용 의무)",
    penalty_article="산업안전보건법 제175조 제6항 제3호",
    penalty="300만원 이하 과태료",
    amount="50,000원",
    note="정액은 시행령 별표 35 의 1차 위반 기준이다. 2·3차는 가중된다.",
    keys=("법-40", "규칙-32"),
)

VIOLATIONS = {
    "UA-04": Violation(
        code="UA-04",
        name="안전모 미착용",
        observation="작업자의 머리에서 안전모가 확인되지 않음",
        sanctions=[_employer(1, "안전모"), WORKER],
    ),
    "UA-02": Violation(
        code="UA-02",
        name="안전대(안전벨트) 미착용",
        observation="작업자에게서 안전대가 확인되지 않음",
        sanctions=[_employer(2, "안전대"), WORKER],
    ),
}

# 탐지 클래스 이름 → 507 위반 코드. 사전학습 모델마다 이름이 다르다.
CLASS_TO_VIOLATION = {
    "no-helmet": "UA-04",
    "no_helmet": "UA-04",
    "head": "UA-04",
}


def lookup(model_class: str) -> Violation | None:
    """탐지 클래스 이름으로 위반을 찾는다. 모르면 None — 지어내지 않는다."""
    return VIOLATIONS.get(CLASS_TO_VIOLATION.get(model_class.lower().strip()))
