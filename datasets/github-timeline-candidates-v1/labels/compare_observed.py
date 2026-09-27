"""잠근 블라인드 라벨과 GitHub 이후 기록을 비교한다. 표준 Python만 사용한다.

라벨 파일 해시가 LOCK.json과 다르면 비교하지 않는다(기록을 본 뒤 라벨을 고치지 못하게).
기록 변경은 서비스 종류로 대응시킨다: 닫힘(COMPLETED)→complete, 담당자 지정→assignee, 새 이슈→createTask.
그 밖의 기록(다른 이유의 닫힘, 다시 열림, 담당자 해제, 제목 변경)은 서비스에 대응 종류가 없다.
"""
import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

LABELS = Path(__file__).resolve().parent
ROOT = LABELS.parent


def jsonl(path):
    return [json.loads(x) for x in path.read_text().splitlines()]


def observed_events(obs):
    events = set()
    for c in obs["changes"]:
        if c["operation"] == "create":
            events.add(("createTask", None))
        elif c["type"] == "closed":
            events.add(("complete" if c.get("reason") == "COMPLETED" else "closed_other", c["task_id"]))
        elif c["type"] == "assigned":
            events.add(("assignee", c["task_id"]))
        else:
            events.add((c["type"], c["task_id"]))
    return events


def main():
    lock = json.loads((LABELS / "LOCK.json").read_text())
    raw = (LABELS / lock["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == lock["sha256"], "라벨 파일이 잠근 뒤 바뀌었다"
    labels = {r["id"]: r for r in map(json.loads, raw.decode().splitlines())}
    cases = {r["id"]: r for r in jsonl(ROOT / "candidates.jsonl")}
    observed = {r["id"]: r for r in jsonl(ROOT / "observed.jsonl")}
    assert labels.keys() == cases.keys() == observed.keys()

    t = Counter()
    examples = {k: [] for k in ("closed_but_label_not_complete", "label_complete_not_closed",
                                "forbidden_hit", "creates_without_label", "discarded_with_change")}
    decision_by_record = Counter()
    for case_id, label in labels.items():
        case, obs = cases[case_id], observed[case_id]
        target = "issue-" + case["input"]["thread_url"].rsplit("/", 1)[1]
        events = observed_events(obs)
        record = ("target_changed" if any(task == target for _, task in events)
                  else "other_changed" if events else "no_change")
        decision = label["expected_decision"] or "discarded"
        decision_by_record[(decision, record)] += 1
        anchor = case["input"]["excerpts"][case["provenance"]["anchor_excerpt_index"]]["text"]
        brief = {"id": case_id, "anchor": " ".join(anchor.split())[:90], "decision": decision,
                 "label_note": label["notes"] or label["discard_reason"],
                 "observed": sorted(f"{k}:{v}" for k, v in events)[:6]}
        if decision == "discarded":
            t["discarded"] += 1
            if events:
                t["discarded_with_change"] += 1
                examples["discarded_with_change"].append(brief)
            continue
        t["cases"] += 1
        expected = {(c["kind"], c["task_id"]) for c in label["expected_changes"]}
        label_complete = {task for kind, task in expected if kind == "complete"}
        obs_complete = {task for kind, task in events if kind == "complete"}
        t["label_complete"] += len(label_complete)
        t["observed_complete"] += len(obs_complete)
        t["complete_both"] += len(label_complete & obs_complete)
        for task in obs_complete - label_complete:
            t["closed_but_label_not_complete"] += 1
            examples["closed_but_label_not_complete"].append(brief)
        for task in label_complete - obs_complete:
            t["label_complete_not_closed"] += 1
            examples["label_complete_not_closed"].append(brief)
        # 댓글이 달린 이슈만 따로 본다. 닫힌 시각이 댓글과 1분 안이면 '댓글과 함께 닫기'로 본다.
        if target in obs_complete:
            close_at = min(c["at"] for c in obs["changes"]
                           if c.get("type") == "closed" and c["task_id"] == target and c.get("reason") == "COMPLETED")
            lag = (datetime.fromisoformat(close_at) - datetime.fromisoformat(case["input"]["as_of"])).total_seconds()
            timing = "within_1m" if lag < 60 else "within_24h" if lag < 86400 else "after_24h"
            t[f"target_closed/{decision}/label_complete={target in label_complete}/{timing}"] += 1
        elif target in label_complete:
            t[f"target_not_closed/{decision}/label_complete=True"] += 1
        label_assign = {task for kind, task in expected if kind == "assignee"}
        obs_assign = {task for kind, task in events if kind == "assignee"}
        t["label_assignee"] += len(label_assign)
        t["observed_assignee"] += len(obs_assign)
        t["assignee_both"] += len(label_assign & obs_assign)
        t["label_status_or_due"] += sum(1 for kind, _ in expected if kind in ("status", "dueAt"))
        label_creates = sum(1 for c in label["expected_changes"] if c["kind"] == "createTask")  # 집합은 생성 여러 건을 합친다
        obs_creates = sum(1 for c in obs["changes"] if c["operation"] == "create")
        t["label_creates"] += label_creates
        t["observed_creates"] += obs_creates
        if obs_creates and not label_creates:
            t["cases_creates_without_label"] += 1
            examples["creates_without_label"].append(brief | {"observed_creates": obs_creates})
        if label_creates and obs_creates:
            t["cases_creates_both"] += 1
        for f in label["forbidden_changes"]:
            hit = any(task == f["task_id"] and (f["kind"] == "any" or f["kind"] == kind)
                      for kind, task in events)
            if hit:
                t["forbidden_hit"] += 1
                examples["forbidden_hit"].append(brief | {"forbidden": f})
        t["forbidden_total"] += len(label["forbidden_changes"])
        t["unmapped_observed"] += sum(1 for kind, _ in events if kind in ("closed_other", "reopened",
                                                                             "unassigned", "renamed"))

    result = {"lock_sha256": lock["sha256"], "totals": dict(t),
              "decision_by_record": {f"{d} / {r}": n for (d, r), n in sorted(decision_by_record.items())},
              "examples": {k: list({e["id"]: e for e in v}.values())[:5] for k, v in examples.items()}}
    (LABELS / "comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
