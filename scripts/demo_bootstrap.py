"""공고문 → 앵커 → 전체 일정 데모.

    py -3 scripts/demo_bootstrap.py

흐름
  1. 공고문 텍스트 → 앵커 마일스톤 + 제출물/제약/평가기준   (server/extract, 규칙 baseline)
  2. 팀원 + 시간표 등록                                       (에브리타임 붙여넣기 자리)
  3. 업무 생성                                                (create_task Tool을 그대로 사용)
     ※ 업무 목록·공수·의존관계는 원래 LLM(Stage 2)이 낸다. 지금은 scripts/sample_plan.json 고정값.
       LLM 출력에 **날짜가 없다는 점**이 핵심이다. 날짜는 아래 4번이 계산한다.
  4. 역산 스케줄러 → 착수일/마감일/slack/크리티컬 패스/OVERRUN
  5. 제약 검증기 → CSR 판정
"""
from __future__ import annotations

import json
import unicodedata
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW  # noqa: E402
from server.extract import bootstrap_from_file, bootstrap_from_notice  # noqa: E402
from server.scheduler import schedule_project, validate  # noqa: E402
from server.scheduler.capacity import daily_capacity  # noqa: E402
from server.tools import ToolContext, call  # noqa: E402

WEEKDAYS = "월화수목금토일"
BAR_WIDTH = 56


def width(text: str) -> int:
    """한글·한자는 터미널에서 두 칸을 차지한다. len()으로 맞추면 표가 어긋난다."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def pad(text: str, cells: int) -> str:
    trimmed = text
    while width(trimmed) > cells - 1:  # 잘릴 때도 다음 칸과 한 칸은 띄운다
        trimmed = trimmed[:-1]
    return trimmed + " " * (cells - width(trimmed))


def rule(title: str = "") -> None:
    print(f"\n{'─' * 78}")
    if title:
        print(title)
        print("─" * 78)


def setup(conn) -> ToolContext:
    conn.execute(
        "INSERT INTO project (id, title, created_at) VALUES (?, ?, ?)",
        ("p_demo", "AI 서비스 아이디어 공모전", FIXED_NOW.isoformat()),
    )
    conn.commit()
    return ToolContext(conn=conn, project_id="p_demo", now=FIXED_NOW)


def add_team(ctx, members: list[dict]) -> None:
    for m in members:
        member_id = ctx.new_id("m")
        ctx.conn.execute(
            "INSERT INTO member (id, project_id, name, role, skills, weekly_hours)"
            " VALUES (?, ?, ?, ?, '[]', ?)",
            (member_id, ctx.project_id, m["name"], m["role"], m["weekly_hours"]),
        )
        for weekday, start_min, end_min, label in m["busy"]:
            ctx.conn.execute(
                "INSERT INTO busy_slot (id, member_id, weekday, start_min, end_min, label)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (ctx.new_id("bs"), member_id, WEEKDAYS.index(weekday), start_min, end_min, label),
            )
    ctx.conn.commit()


def add_tasks(ctx, tasks: list[dict]) -> dict[str, str]:
    """create_task Tool로 업무를 만든다(도구 계층 dogfooding). ref → 실제 task_id."""
    milestones = ctx.conn.execute(
        "SELECT id, title FROM milestone WHERE project_id = ?", (ctx.project_id,)
    ).fetchall()
    ref_to_id: dict[str, str] = {}
    for t in tasks:
        ms_id = next((m["id"] for m in milestones if t["anchor"] in m["title"]), None)
        if ms_id is None:
            # 조용히 넘어가면 업무가 최종 앵커로 밀려 일정이 통째로 틀어진다.
            raise SystemExit(
                f"앵커 매칭 실패: '{t['anchor']}' — 추출된 마일스톤: {[m['title'] for m in milestones]}"
            )
        res = call(
            "create_task",
            ctx,
            {
                "title": t["title"],
                "assignee": t["assignee"],
                "effort_hours": t["effort_hours"],
                "depends_on": [ref_to_id[r] for r in t["depends_on"]],
                "milestone_id": ms_id,
            },
        )
        if not res.ok:
            raise SystemExit(f"업무 생성 실패: {t['title']} — {res.error_type} {res.message}")
        ref_to_id[t["ref"]] = res.result["id"]
    return ref_to_id


def print_extraction(result: dict) -> None:
    rule(f"1. 공고문 추출  (추출기: {result['extractor']})")
    print("앵커 마일스톤 (locked, 절대 이동 불가)")
    for a in result["anchors"]:
        when = f"{a['date']}" + (f" {a['time']}" if a.get("time") else "")
        print(f"  · {when:<18} [{a['event_type']:<12}] {a['title']}")
    print(f"\n제출물   : {', '.join(result['deliverables']) or '(없음)'}")
    print(f"제약     : {json.dumps(result['constraints'], ensure_ascii=False)}")
    print(f"평가기준 : {', '.join(result['criteria']) or '(없음)'}")


def print_capacity(ctx) -> None:
    rule("2. 시간표 → 요일별 가용시간  (주간 총합만 쓰면 공강 0인 날이 무시된다)")
    print(pad("팀원", 10) + pad("주간", 7) + "  ".join(f"{d:>3}" for d in WEEKDAYS))
    for m in ctx.conn.execute(
        "SELECT id, name, weekly_hours FROM member WHERE project_id = ? ORDER BY name",
        (ctx.project_id,),
    ):
        cap = daily_capacity(ctx.conn, m["id"], m["weekly_hours"])
        cells = "  ".join(f"{h:>4.1f}" for h in cap)
        print(pad(m["name"], 10) + pad(f"{m['weekly_hours']:.0f}h", 7) + cells)


def print_schedule(schedule) -> None:
    rule("3. 역산 스케줄  (앵커에서 거꾸로, 담당자 가용시간을 차감해 착수일 계산)")
    print(
        pad("  업무", 30) + pad("담당", 9) + pad("공수", 7)
        + pad("착수(최늦)", 14) + pad("마감(최늦)", 14) + "여유"
    )
    print("-" * 78)
    for t in schedule.tasks:
        mark = "! " if t.critical else "  "
        print(
            pad(mark + t.title, 30)
            + pad(t.assignee or "미배정", 9)
            + pad(f"{t.effort_hours:.0f}h", 7)
            + pad(t.latest_start, 14)
            + pad(t.latest_finish, 14)
            + f"{t.slack_days:>3}d"
        )
    print("\n! = 크리티컬 (여유 0일 이하)")


def print_gantt(schedule) -> None:
    rule("4. 타임라인")
    start = date.fromisoformat(schedule.project_start)
    end = max(date.fromisoformat(a["date"]) for a in schedule.anchors)
    span = max((end - start).days, 1)

    def col(d: date) -> int:
        return min(BAR_WIDTH - 1, max(0, round((d - start).days / span * (BAR_WIDTH - 1))))

    axis = [" "] * BAR_WIDTH
    for a in schedule.anchors:
        axis[col(date.fromisoformat(a["date"]))] = "▼"
    print(" " * 30 + "".join(axis))
    print(" " * 30 + start.strftime("%m/%d") + " " * (BAR_WIDTH - 10) + end.strftime("%m/%d"))

    for t in schedule.tasks:
        bar = [" "] * BAR_WIDTH
        s, f = col(date.fromisoformat(t.latest_start)), col(date.fromisoformat(t.latest_finish))
        for i in range(min(s, f), max(s, f) + 1):
            bar[i] = "█" if t.critical else "▒"
        print(pad(t.title, 23) + pad(t.assignee or "미배정", 7) + "".join(bar))
    print("\n▼ = 앵커(마감)   █ = 크리티컬 업무   ▒ = 여유 있는 업무")


def print_validation(ctx, schedule) -> None:
    rule("5. 제약 검증  (CSR: 위반 0이면 통과)")
    violations = validate(ctx, schedule)
    if not violations:
        print("위반 없음 — CSR 통과")
    else:
        for v in violations:
            print(f"  [{v.code}] {v.message}")
        print(f"\n총 {len(violations)}건 위반 — CSR 실패")
    if schedule.overruns:
        print("\n가용량 초과 상세:")
        for o in schedule.overruns:
            print(f"  {o.member}: {o.milestone_date}까지 {o.excess_hours:.1f}h 부족")


def notice_path_arg() -> str | None:
    """--notice <파일>: 실제 공고문 파일(이미지·PDF·텍스트)로 돌린다."""
    if "--notice" not in sys.argv:
        return None
    idx = sys.argv.index("--notice")
    if idx + 1 >= len(sys.argv):
        raise SystemExit("--notice 뒤에 파일 경로가 필요하다")
    return sys.argv[idx + 1]


def main() -> None:
    plan = json.loads((ROOT / "scripts" / "sample_plan.json").read_text(encoding="utf-8"))

    # --tight: 공수를 2배로 부풀려 OVERRUN·제약 위반 리포트를 확인한다.
    if "--tight" in sys.argv:
        for t in plan["tasks"]:
            t["effort_hours"] *= 2
        print("[--tight] 모든 업무 공수 ×2")

    conn = fresh_db()
    ctx = setup(conn)
    print(f"오늘(가짜 시계): {ctx.now.isoformat()}")

    path = notice_path_arg()
    if path:
        result = bootstrap_from_file(ctx, path)
        ing = result["ingest"]
        print(f"\n[Stage 0] {path} → {ing['method']}"
              + (f" ({ing['model']}, {ing['latency_ms']}ms)" if ing["model"] else " (API 호출 없음)"))
        for w in ing["warnings"]:
            print(f"  경고: {w}")
    else:
        notice = (ROOT / "scripts" / "sample_notice.txt").read_text(encoding="utf-8")
        result = bootstrap_from_notice(ctx, notice, title="AI 서비스 아이디어 공모전 요강")
    print_extraction(result)

    add_team(ctx, plan["members"])
    print_capacity(ctx)

    add_tasks(ctx, plan["tasks"])
    schedule = schedule_project(ctx)
    print_schedule(schedule)
    print_gantt(schedule)
    print_validation(ctx, schedule)
    conn.close()


if __name__ == "__main__":
    main()
