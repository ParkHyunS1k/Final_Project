"""한국어 날짜·시각 표기 → ISO 8601 정규화 (규칙).

공고문에 나오는 표기는 다양하다. 여기서 커버하는 것:
    2026년 10월 1일 / 10월 1일 / 10.01(수) / 2026.10.01 / 10/1 / 10-01 / 10. 1.
    10월 첫째 주 금요일 / 10월 마지막 주 금요일
    시각: 15시 / 15시 30분 / 오후 3시 / 15:00 / 18:00까지

연도 생략 시 규칙: **base_date 이후로 다가오는 가장 가까운 연도**를 쓴다.
공고문의 날짜는 마감·행사일이라 과거일 수 없다는 가정이다. 가정이 틀리는 경우
(지난 공고 아카이브)를 위해 infer_year=False로 끌 수 있다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta

WEEKDAYS = "월화수목금토일"

_ORDINALS = {
    "첫": 1, "첫째": 1, "둘": 2, "둘째": 2, "두": 2,
    "셋": 3, "셋째": 3, "세": 3, "넷": 4, "넷째": 4, "네": 4,
    "다섯": 5, "다섯째": 5, "마지막": -1,
}

# 2026년 10월 1일 / 10.01 / 10/1 / 10-01 / 10. 1.
_NUMERIC = re.compile(
    r"(?:(?P<y>20\d{2})\s*[.\-/년]\s*)?"
    r"(?P<m>\d{1,2})\s*(?P<sep>[.\-/월])\s*"
    r"(?P<d>\d{1,2})\s*\.?\s*(?:일)?"
)

# 10월 첫째 주 금요일
_NTH_WEEKDAY = re.compile(
    r"(?:(?P<y>20\d{2})\s*년\s*)?(?P<m>\d{1,2})\s*월\s*"
    r"(?P<ord>첫째|첫|둘째|둘|두|셋째|셋|세|넷째|넷|네|다섯째|다섯|마지막)\s*째?\s*주\s*"
    r"(?P<wd>[월화수목금토일])\s*요일"
)

_TIME = re.compile(
    r"(?:(?P<ampm>오전|오후|저녁|아침)\s*)?"
    r"(?P<h>\d{1,2})\s*(?::|시)\s*(?:(?P<mi>\d{1,2})\s*분?)?"
)

# 날짜 뒤에서 시각을 찾을 때 들여다보는 범위. "(수) 15시까지" 정도가 들어간다.
_TIME_WINDOW = 20


@dataclass
class DateMatch:
    date: str           # ISO YYYY-MM-DD
    time: str | None    # HH:MM
    text: str           # 매칭된 원문
    start: int
    end: int


def _resolve_year(month: int, day: int, base: date, infer_year: bool) -> int | None:
    if not infer_year:
        return base.year
    for year in (base.year, base.year + 1):
        try:
            if date(year, month, day) >= base:
                return year
        except ValueError:
            return None
    return None


def _parse_time_after(text: str, pos: int) -> str | None:
    window = text[pos : pos + _TIME_WINDOW]
    # 요일 표기 "(수)"는 건너뛴다
    m = _TIME.search(window)
    if not m:
        return None
    hour = int(m.group("h"))
    minute = int(m.group("mi") or 0)
    ampm = m.group("ampm")
    if ampm in ("오후", "저녁") and hour < 12:
        hour += 12
    if ampm in ("오전", "아침") and hour == 12:
        hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date | None:
    first = date(year, month, 1)
    if nth == -1:  # 마지막 주
        nxt = date(year + (month == 12), (month % 12) + 1, 1)
        last = nxt - timedelta(days=1)
        return last - timedelta(days=(last.weekday() - weekday) % 7)
    offset = (weekday - first.weekday()) % 7
    day = first + timedelta(days=offset + 7 * (nth - 1))
    return day if day.month == month else None


def find_dates(text: str, base_date: date, *, infer_year: bool = True) -> list[DateMatch]:
    """텍스트에서 날짜를 전부 찾아 위치 순으로 반환한다. 겹치는 매칭은 앞선 것을 남긴다."""
    found: list[DateMatch] = []

    for m in _NTH_WEEKDAY.finditer(text):
        month = int(m.group("m"))
        if not 1 <= month <= 12:
            continue
        nth = _ORDINALS[m.group("ord")]
        weekday = WEEKDAYS.index(m.group("wd"))
        year = int(m.group("y")) if m.group("y") else base_date.year
        day = _nth_weekday(year, month, weekday, nth)
        if day is None:
            continue
        if not m.group("y") and infer_year and day < base_date:
            day = _nth_weekday(year + 1, month, weekday, nth)
            if day is None:
                continue
        found.append(
            DateMatch(day.isoformat(), _parse_time_after(text, m.end()), m.group(0), m.start(), m.end())
        )

    for m in _NUMERIC.finditer(text):
        month, day_num = int(m.group("m")), int(m.group("d"))
        if not (1 <= month <= 12 and 1 <= day_num <= 31):
            continue
        year = int(m.group("y")) if m.group("y") else _resolve_year(month, day_num, base_date, infer_year)
        if year is None:
            continue
        try:
            resolved = date(year, month, day_num)
        except ValueError:
            continue
        found.append(
            DateMatch(
                resolved.isoformat(),
                _parse_time_after(text, m.end()),
                m.group(0).strip(),
                m.start(),
                m.end(),
            )
        )

    found.sort(key=lambda d: (d.start, -(d.end - d.start)))
    out: list[DateMatch] = []
    for d in found:
        if out and d.start < out[-1].end:  # 겹치면 앞선 매칭 유지
            continue
        out.append(d)
    return out


def parse_one(text: str, base_date: date, *, infer_year: bool = True) -> DateMatch | None:
    matches = find_dates(text, base_date, infer_year=infer_year)
    return matches[0] if matches else None


# "2026년 10월 예정", "10월 중", "11월 말" — 일(日)이 없어 날짜가 확정되지 않은 표기.
_MONTH_ONLY = re.compile(
    r"(?:(?P<y>20\d{2})\s*년\s*)?(?P<m>\d{1,2})\s*월\s*(?P<mod>초순|중순|하순|초|중|말|예정)?"
)


@dataclass
class MonthOnly:
    year_month: str   # YYYY-MM
    text: str         # 원문 조각 ("2026년 10월 예정")


def find_month_only(text: str, base_date: date, *, infer_year: bool = True) -> MonthOnly | None:
    """일(日) 없는 월 단위 표기를 찾는다.

    **완전한 날짜가 없을 때만 부른다.** "10월 1일"에도 걸리므로 호출 쪽에서 순서를 지켜야 한다.
    """
    m = _MONTH_ONLY.search(text)
    if not m:
        return None
    month = int(m.group("m"))
    if not 1 <= month <= 12:
        return None
    if m.group("y"):
        year = int(m.group("y"))
    else:
        year = base_date.year
        if infer_year and month < base_date.month:
            year += 1
    return MonthOnly(year_month=f"{year:04d}-{month:02d}", text=m.group(0).strip())
