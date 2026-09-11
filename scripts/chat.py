"""자연어 → Tool 호출 → 확인 카드 → 실행. 실제 모델을 부른다.

    py -3 scripts/chat.py                       # 대화형
    py -3 scripts/chat.py --smoke               # 미리 정한 요청들을 연달아 실행(승인 자동)
    py -3 scripts/chat.py --dry "성경이한테 ..."  # 제안까지만 보고 실행 안 함

GEMINI_API_KEY가 필요하다(.env). DB는 매 실행마다 새 :memory: — 데모 시드로 시작한다.
"""
from __future__ import annotations

import json
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.agent import Agent, GeminiAgentClient  # noqa: E402
from server.agent.prompt import PROMPT_VERSION  # noqa: E402
from server.db.connection import fresh_db  # noqa: E402
from server.db.fixtures import FIXED_NOW, seed_demo  # noqa: E402
from server.tools import ToolContext  # noqa: E402

DELAY = 14.0  # 무료 티어 5 RPM. 조회는 2-step이라 요청당 API 2회를 쓴다.
PILOT = ROOT / "eval" / "valset" / "agent_pilot.jsonl"


def load_pilot() -> list[dict]:
    return [json.loads(line) for line in PILOT.read_text(encoding="utf-8").splitlines() if line.strip()]


def card(proposal) -> str:
    args = json.dumps(proposal.arguments, ensure_ascii=False, indent=2)
    return (
        f"┌─ 확인 카드 ─────────────────────────────\n"
        f"│ {proposal.tool_name}\n"
        f"│ {args.replace(chr(10), chr(10) + '│ ')}\n"
        f"└─────────────────────────────────────────"
    )


def show(turn) -> None:
    print(f"\n[decision] {turn.decision}")
    if turn.raw_outputs:
        print(f"[raw] {turn.raw_outputs[-1][:200]}")
    if turn.decision == "clarify":
        print(f"[되묻기] {turn.question}   (missing: {turn.missing_fields})")
    if turn.decision == "no_tool":
        print(f"[답변] {turn.answer}")
    if turn.decision == "parse_error":
        print(f"[파싱 실패] {turn.error}")
    if turn.decision == "error":
        print(f"[서빙 실패] {turn.error}")
    for name, result in turn.executed:
        status = "ok" if result.ok else f"FAIL {result.error_type}"
        payload = json.dumps(result.result if result.ok else result.message, ensure_ascii=False)
        print(f"[실행] {name} → {status}  {payload[:300]}")
    for proposal in turn.proposals:
        print(card(proposal))


def observed(turn) -> tuple[str, str | None]:
    """(decision, 첫 Tool 이름). 파일럿 라벨과 맞춰보기 위한 것이다 — 정식 채점기가 아니다."""
    if turn.decision == "awaiting_approval":
        return "tool_calls", turn.proposals[0].tool_name if turn.proposals else None
    if turn.executed:
        return "tool_calls", turn.executed[0][0]
    return turn.decision, None


def compare(item: dict, turn) -> bool:
    got_decision, got_tool = observed(turn)
    want = item["expect"]
    ok = got_decision == want["decision"] and (want["tool"] is None or got_tool == want["tool"])
    mark = "PASS" if ok else "FAIL"
    print(
        f"[{mark}] {item['id']}  기대={want['decision']}/{want['tool'] or '-'}"
        f"  실제={got_decision}/{got_tool or '-'}"
    )
    return ok


def run_one(agent: Agent, request: str, *, auto_approve: bool, dry: bool):
    print(f"\n{'=' * 70}\n> {request}")
    turn = agent.run(request)
    show(turn)
    if not turn.awaiting_approval or dry:
        return turn
    for proposal in turn.proposals:
        if auto_approve:
            answer = "y"
        else:
            answer = input("승인? [y=승인 / n=거절 / e=수정] ").strip().lower() or "n"
        if answer == "e":
            raw = input("수정할 arguments(JSON): ").strip()
            done = agent.resume(proposal.proposal_id, "edited", edited_arguments=json.loads(raw))
        elif answer == "y":
            done = agent.resume(proposal.proposal_id, "approved")
        else:
            done = agent.resume(proposal.proposal_id, "rejected")
        show(done)
    return turn


def summary(conn) -> None:
    print(f"\n{'=' * 70}\n[model_invocation]")
    for r in conn.execute(
        "SELECT step_index, decision, finish_reason, input_tokens, output_tokens, latency_ms,"
        " served_model, toolset_version FROM model_invocation ORDER BY created_at, rowid"
    ):
        print(
            f"  step{r['step_index']} {r['decision']:<12} {r['finish_reason'] or '-':<10}"
            f" in={r['input_tokens']} out={r['output_tokens']} {r['latency_ms']}ms"
            f" {r['served_model']} / {r['toolset_version']}"
        )
    print("\n[action_proposal]")
    for r in conn.execute("SELECT proposed_tool_name, decision FROM action_proposal"):
        print(f"  {r['proposed_tool_name']:<20} {r['decision']}")
    print("\n[tool_call_log]")
    for r in conn.execute("SELECT tool_name, ok, error_type, latency_ms FROM tool_call_log"):
        print(f"  {r['tool_name']:<20} ok={r['ok']} {r['error_type'] or ''} {r['latency_ms']}ms")


def main() -> None:
    conn = fresh_db()
    seed_demo(conn)
    ctx = ToolContext(conn=conn, project_id="p_demo", now=FIXED_NOW)
    agent = Agent(ctx, GeminiAgentClient(), session_id="cli", assigned_group="api")

    dry = "--dry" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    print(f"오늘(가짜 시계): {ctx.now.isoformat()}  모델: {agent.client.name}")

    if "--smoke" in sys.argv:
        items = load_pilot()
        print(f"파일럿 {len(items)}건 (eval/valset/agent_pilot.jsonl) — 프롬프트 {PROMPT_VERSION}")
        verdicts = []
        for i, item in enumerate(items):
            # 에피소드 격리: 항목마다 DB를 리셋한다. 공유하면 앞 요청이 뒤 요청의 정답을 바꾼다
            # (p-05가 t_eval을 완료시키면 p-02의 '지연 업무'가 사라진다).
            conn.close()
            conn = fresh_db()
            seed_demo(conn)
            ctx = ToolContext(conn=conn, project_id="p_demo", now=FIXED_NOW)
            agent = Agent(ctx, agent.client, session_id="cli", assigned_group="api")

            turn = run_one(agent, item["utterance"], auto_approve=True, dry=dry)
            verdicts.append(compare(item, turn))
            if i < len(items) - 1:
                time.sleep(DELAY)  # 무료 티어 요청 한도
        print(f"\n{'=' * 70}\n파일럿: {sum(verdicts)}/{len(verdicts)} 일치")
        print("※ 12건은 통계적으로 무의미하다. 지표로 인용하지 마라.")
        for item, ok in zip(items, verdicts):
            if not ok:
                print(f"  불일치 {item['id']}: {item['utterance']}  ({', '.join(item['tags'])})")
    elif args:
        run_one(agent, " ".join(args), auto_approve=False, dry=dry)
    else:
        while True:
            try:
                request = input("\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not request or request in ("quit", "exit"):
                break
            run_one(agent, request, auto_approve=False, dry=dry)

    summary(conn)
    conn.close()


if __name__ == "__main__":
    main()
