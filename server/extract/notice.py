"""공고문(notice) → 앵커 마일스톤 + 제출물 · 제약 · 평가기준.

**추출기는 교체 가능한 부품이다.** 지금 구현된 것은 규칙 기반 baseline(RuleNoticeExtractor)이고,
5주차에 LLM 추출기를 같은 인터페이스로 붙여 필드 추출 F1을 비교한다.
LLM이 붙어도 아래 dates.py의 정규화는 그대로 쓴다(모델에게 날짜 산술을 시키지 않는다).

업로드 문서는 신뢰할 수 없는 데이터다. 이 모듈은 텍스트에서 **값만 읽는다.**
문서 안의 문장을 지시로 해석하는 경로가 존재하지 않는다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from .dates import find_dates, find_month_only

# event_type 판정 키워드. 위에서부터 먼저 맞는 것을 쓴다.
_RESULT_ANNOUNCE = ("결과 발표", "결과발표", "합격자", "선정 결과", "심사 결과", "발표 예정")
_SUBMISSION = ("접수마감", "접수 마감", "제출마감", "제출 마감", "마감", "제출", "접수", "신청", "등록", "원서")
_PRESENTATION = ("본선", "결선", "최종발표", "최종 발표", "시상", "프레젠테이션", "발표회", "발표")
_CHECKPOINT = ("중간점검", "중간 점검", "예선", "서류심사", "서류 심사", "심사", "설명회", "오리엔테이션", "멘토링", "간담회")

_DELIVERABLE_HEADS = ("제출물", "산출물", "제출 서류", "제출서류", "제출 자료", "출품물")
_CRITERIA_HEADS = ("평가기준", "평가 기준", "심사기준", "심사 기준", "평가항목", "평가 항목", "심사항목")

_BULLET = re.compile(r"^[\s\-•·▪◦*■▶●○▷□◆※\d]+[.)]?\s*")
_SPLIT_ITEMS = re.compile(r"\s*(?:[,·/]|및|그리고)\s*")
_WEIGHT = re.compile(r"\s*[(（]\s*\d+\s*%?\s*[)）]|\s*\d+\s*%")
_COUNT_UNIT = re.compile(r"\d\s*[명인]")
_TEAM_MAX = re.compile(r"(?:팀\s*당?\s*)?(\d+)\s*[명인]\s*(?:이내|이하|까지|미만)")
_TEAM_MIN = re.compile(r"(\d+)\s*[명인]\s*이상")
_TEAM_RANGE = re.compile(r"(\d+)\s*[~\-]\s*(\d+)\s*[명인]")

# 헤더 문맥을 몇 줄까지 물려줄지. 너무 길면 엉뚱한 날짜가 헤더에 붙는다.
_PENDING_MAX_LINES = 3


@dataclass
class Anchor:
    title: str
    date: str | None                # 일(日)까지 확정된 경우만. "10월 예정"이면 None
    time: str | None = None
    kind: str = "anchor"           # 공고문에서 온 날짜는 전부 앵커다 (외부에서 주어진 절대 날짜)
    event_type: str | None = None  # submission | presentation | checkpoint
    date_hint: str | None = None   # 날짜 미확정일 때 원문 조각 ("2026년 10월 예정")

    def to_dict(self) -> dict:
        d = {"title": self.title, "date": self.date, "kind": self.kind, "event_type": self.event_type}
        if self.time:
            d["time"] = self.time
        if self.date_hint:
            d["date_hint"] = self.date_hint
        return d


@dataclass
class NoticeExtraction:
    anchors: list[Anchor] = field(default_factory=list)
    deliverables: list[str] = field(default_factory=list)
    constraints: dict = field(default_factory=dict)
    criteria: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "anchors": [a.to_dict() for a in self.anchors],
            "deliverables": self.deliverables,
            "constraints": self.constraints,
            "criteria": self.criteria,
        }


class NoticeExtractor(Protocol):
    """공고문 추출기 인터페이스. LLM 추출기도 이 시그니처를 따른다."""

    name: str

    def extract(self, text: str, base_date: date) -> NoticeExtraction: ...


def _clean(line: str) -> str:
    return _BULLET.sub("", line).strip()


def _classify(line: str) -> str | None:
    if any(k in line for k in _RESULT_ANNOUNCE):
        return "checkpoint"
    if any(k in line for k in _SUBMISSION):
        return "submission"
    if any(k in line for k in _PRESENTATION):
        return "presentation"
    if any(k in line for k in _CHECKPOINT):
        return "checkpoint"
    return None


def _label(line: str, date_texts: list[str]) -> str:
    """줄에서 날짜를 **전부** 걷어내고 남은 말을 제목으로 쓴다.

    기간 표기에서 끝 날짜만 지우면 시작 날짜가 제목에 남는다("접수 마감 2026. 8. 12").
    """
    head = re.split(r"[:：|]", line, maxsplit=1)[0]
    if head != line and 1 <= len(head.strip()) <= 40 and not any(c.isdigit() for c in head):
        return head.strip()
    rest = line
    for text in sorted(date_texts, key=len, reverse=True):
        rest = rest.replace(text, " ")
    rest = re.sub(r"[(（][^)）]*[)）]", " ", rest)          # (수), (30%) 같은 괄호
    rest = re.sub(r"\d{1,2}\s*[:시]\s*\d{0,2}\s*분?", " ", rest)  # 남은 시각 표기
    rest = re.sub(r"[~\-–—:：|]+", " ", rest)
    rest = re.sub(r"\s+", " ", rest).strip(" .,")
    return rest[:40] or "일정"


def _items_from(value: str) -> list[str]:
    items = []
    for raw in _SPLIT_ITEMS.split(value):
        item = _WEIGHT.sub("", _clean(raw)).strip(" .,:")
        if item and len(item) <= 40:
            items.append(item)
    return items


class RuleNoticeExtractor:
    """규칙 기반 baseline. LLM 추출기와 같은 인터페이스."""

    name = "rule-v1"

    def extract(self, text: str, base_date: date) -> NoticeExtraction:
        out = NoticeExtraction()
        lines = text.splitlines()
        pending_head: str | None = None       # '제출물:' 처럼 값이 다음 줄에 오는 경우
        pending_event: tuple[str, str] | None = None  # (event_type, 제목) — 헤더와 날짜가 다른 줄일 때
        pending_age = 0

        for raw in lines:
            line = _clean(raw)
            if not line:
                pending_head, pending_event, pending_age = None, None, 0
                continue

            self._collect_meta(line, out)
            pending_head = self._collect_listed(raw, line, pending_head, out)
            pending_event, pending_age = self._collect_anchor(
                line, base_date, out, pending_event, pending_age
            )

        # 같은 날짜·제목이 여러 번 잡히면 하나만 남긴다
        seen: set[tuple[str | None, str]] = set()
        unique: list[Anchor] = []
        # 날짜 미확정(None)은 맨 뒤로 보낸다
        for a in sorted(out.anchors, key=lambda a: (a.date or "9999-12-31", a.title)):
            key = (a.date, a.title)
            if key not in seen:
                seen.add(key)
                unique.append(a)
        out.anchors = unique
        return out

    # ── 앵커 ─────────────────────────────────────────────
    def _collect_anchor(
        self,
        line: str,
        base_date: date,
        out: NoticeExtraction,
        pending_event: tuple[str, str] | None,
        pending_age: int,
    ) -> tuple[tuple[str, str] | None, int]:
        """한 줄에서 앵커를 뽑는다. 반환값은 다음 줄로 넘길 (헤더 문맥, 나이).

        포스터는 `접수기간` / `2026. 08. 24 ~ 09. 17` 처럼 헤더와 날짜가 다른 줄에 있는 경우가 흔하다.
        키워드가 있는데 날짜가 없는 줄은 **헤더로 기억**했다가, 뒤따르는 날짜 줄에 적용한다.
        """
        matches = find_dates(line, base_date)
        own_event = _classify(line)

        if not matches:
            month = find_month_only(line, base_date) if own_event else None
            if month and own_event:
                # 일(日)이 없어 날짜 미확정. 버리지 않고 date=None으로 남긴다.
                out.anchors.append(
                    Anchor(
                        title=_label(line, [month.text]),
                        date=None,
                        event_type=own_event,
                        date_hint=month.text,
                    )
                )
                return None, 0
            if own_event:
                return (own_event, _label(line, [])), 0  # 헤더로 기억
            return (pending_event, pending_age + 1) if pending_age < _PENDING_MAX_LINES else (None, 0)

        event_type, title_source = own_event, None
        if event_type is None:
            if pending_event is None or pending_age >= _PENDING_MAX_LINES:
                return None, 0
            event_type, title_source = pending_event  # 앞 줄 헤더를 물려받는다

        # 기간 표기("9.1 ~ 9.25")는 끝 날짜가 마감이다. 제목도 '기간'이 아니라 '마감'이 된다.
        match = matches[-1]
        title = title_source or _label(line, [m.text for m in matches])
        if len(matches) > 1 and "기간" in title:
            title = title.replace("기간", "마감")
        out.anchors.append(
            Anchor(title=title, date=match.date, time=match.time, event_type=event_type)
        )
        return None, 0

    # ── 제출물 / 평가기준 ────────────────────────────────
    def _collect_listed(
        self, raw: str, line: str, pending_head: str | None, out: NoticeExtraction
    ) -> str | None:
        for heads, bucket in ((_DELIVERABLE_HEADS, out.deliverables), (_CRITERIA_HEADS, out.criteria)):
            if any(h in line for h in heads):
                value = re.split(r"[:：]", line, maxsplit=1)
                if len(value) == 2 and value[1].strip():
                    bucket.extend(i for i in _items_from(value[1]) if i not in bucket)
                    return None
                return "deliverables" if bucket is out.deliverables else "criteria"

        if pending_head and raw[:1] in " \t-•·*■▶●○":  # 헤더 다음의 들여쓴/불릿 줄
            bucket = out.deliverables if pending_head == "deliverables" else out.criteria
            bucket.extend(i for i in _items_from(line) if i not in bucket)
            return pending_head
        return None

    # ── 제약 ─────────────────────────────────────────────
    def _collect_meta(self, line: str, out: NoticeExtraction) -> None:
        # "4명까지" 뿐 아니라 "3인 이내"도 잡는다. 숫자가 앞에 붙어야 하므로 '인공지능'에는 걸리지 않는다.
        if not _COUNT_UNIT.search(line):
            return
        rng = _TEAM_RANGE.search(line)
        if rng:
            out.constraints.setdefault("team_size_min", int(rng.group(1)))
            out.constraints.setdefault("team_size_max", int(rng.group(2)))
            return
        mx = _TEAM_MAX.search(line)
        if mx:
            out.constraints.setdefault("team_size_max", int(mx.group(1)))
        mn = _TEAM_MIN.search(line)
        if mn:
            out.constraints.setdefault("team_size_min", int(mn.group(1)))
