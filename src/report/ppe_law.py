"""보호구 미착용 → 법령·제재 매핑. **표로 관리하고 코드로 숨기지 않는다.**

`README.md` 3절에서 그대로 가져왔다. 조항 연결이 틀렸을 때 어디서 틀렸는지
추적하려면 매핑이 코드 분기가 아니라 데이터로 남아야 한다.

**의무 주체가 둘로 갈린다. 이것이 이 모듈의 존재 이유다.**

    사업주  보호구 지급   안전보건규칙 제32조 → 법 제38조 → 제168조   형사처벌
    근로자  착용         법 제40조                                    과태료

사진으로 알 수 있는 것은 **"쓰고 있지 않다"** 는 관측뿐이고, 그것이 지급
미이행인지 착용 거부인지는 갈리지 않는다. **그래서 둘 다 병기하고 판단은
사람에게 넘긴다** (`README.md` 4절 — 관측 사실과 위반 조항의 분리).

**"예상 과태료" 를 함부로 쓰지 않는다.** 사업주 안전조치 의무 위반은 과태료가
아니라 형사처벌이다. 과태료가 명확한 것은 **근로자 보호구 미착용(제40조) 하나**다.
그래서 이 베이스라인이 보호구를 대상으로 삼았을 때만 제재 출력이 성립한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Sanction:
    subject: str          # 의무 주체
    duty: str             # 어떤 의무인가
    basis: str            # 근거 조항
    chain: str            # 조항 위계
    penalty: str          # 법정형 또는 과태료
    note: str = ""


@dataclass(frozen=True)
class Violation:
    code: str             # 507 클래스 코드
    name: str             # 위반 이름
    observation: str      # 모델이 말할 수 있는 것 (관측)
    sanctions: list[Sanction] = field(default_factory=list)


EMPLOYER_38 = Sanction(
    subject="사업주",
    duty="보호구 지급 의무",
    basis="산업안전보건기준에 관한 규칙 제32조",
    chain="규칙 제32조 → 산업안전보건법 제38조(안전조치) → 제168조(벌칙)",
    penalty="5년 이하 징역 또는 5천만원 이하 벌금",
    note="근로자 사망 시 7년 이하 징역 또는 1억원 이하 벌금. **과태료가 아니라 형사처벌이다.**",
)

WORKER_40 = Sanction(
    subject="근로자",
    duty="보호구 착용 의무",
    basis="산업안전보건법 제40조",
    chain="법 제40조 → 제175조(과태료)",
    penalty="300만원 이하 과태료",
    note="시행령 별표 35 기준 1차 5만원. 보호구 미착용은 과태료가 명확한 드문 경우다.",
)

VIOLATIONS = {
    "UA-04": Violation(
        code="UA-04",
        name="안전모 미착용",
        observation="작업자의 머리에서 안전모가 확인되지 않음",
        sanctions=[EMPLOYER_38, WORKER_40],
    ),
    "UA-02": Violation(
        code="UA-02",
        name="안전벨트 미착용",
        observation="작업자에게서 안전대(안전벨트)가 확인되지 않음",
        sanctions=[EMPLOYER_38, WORKER_40],
    ),
}

# 모델 클래스 → 507 위반 코드. 사전학습 모델마다 이름이 다르다.
CLASS_TO_VIOLATION = {
    "no-helmet": "UA-04",
    "no_helmet": "UA-04",
    "head": "UA-04",
}


def lookup(model_class: str) -> Violation | None:
    """탐지 클래스 이름으로 위반을 찾는다. 모르면 None — 지어내지 않는다."""
    return VIOLATIONS.get(CLASS_TO_VIOLATION.get(model_class.lower().strip()))
