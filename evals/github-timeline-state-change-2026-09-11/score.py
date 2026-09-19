"""모델 응답을 블라인드 라벨과 비교해 점수를 낸다. 표준 Python만 사용한다.

라벨은 AI가 쓴 기준선이다. 여기 점수는 '라벨 기준 준수도'이지 사람 검증 정확도가 아니다.
"""
import json
import statistics
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parents[1] / "datasets/github-timeline-candidates-v1"
# USD / 1M tokens (입력, 캐시 입력, 출력). 2026-09-11 developers.openai.com 모델 문서 기준.
# Responses API의 output_tokens는 추론 토큰을 포함하므로 추론을 따로 더하지 않는다.
PRICES = {"gpt-5.6-luna": (0.2, 0.02, 1.2), "gpt-5.6-terra": (2, 0.2, 12), "gpt-5.6-sol": (4, 0.4, 20)}


def score_case(label, response, task_ids):
    expected, predicted = label["expected_changes"], response["changes"]
    exp_keys = Counter((c["kind"], c["task_id"]) for c in expected)
    pred_keys = Counter((c["kind"], c["task_id"]) for c in predicted)
    exp_complete = {c["task_id"] for c in expected if c["kind"] == "complete"}
    pred_complete = {c["task_id"] for c in predicted if c["kind"] == "complete"}
    return {
        "label_decision": label["expected_decision"],
        "pred_decision": response["decision"],
        "decision_match": response["decision"] == label["expected_decision"],
        "expected": sum(exp_keys.values()),
        "predicted": sum(pred_keys.values()),
        "matched": sum((exp_keys & pred_keys).values()),
        "complete_tp": len(exp_complete & pred_complete),
        "complete_fp": len(pred_complete - exp_complete),
        "complete_fn": len(exp_complete - pred_complete),
        # 무작업·확인 필요 라벨에 변경을 낸 경우. 서비스에서 불필요한 변경안이 된다.
        "noop_false_positive": label["expected_decision"] != "propose_changes" and bool(predicted),
        "forbidden_hits": sum(
            1 for f in label["forbidden_changes"]
            if any(c["task_id"] == f["task_id"] and f["kind"] in ("any", c["kind"]) for c in predicted)
        ),
        # 서비스 검증기가 거절할 참조(없는 업무, createTask가 아닌데 task_id 없음).
        "invalid_task_refs": sum(1 for c in predicted if c["kind"] != "createTask" and c["task_id"] not in task_ids),
        "status_value_mismatch": sum(
            1 for c in predicted if c["kind"] == "status" and any(
                e["kind"] == "status" and e["task_id"] == c["task_id"] and e["after"]["status"] != c["status"]
                for e in expected)
        ),
    }


def ratio(a, b):
    return round(a / b, 3) if b else None


def aggregate(cases, records):
    s = Counter()
    for c in cases:
        for k, v in c.items():
            if isinstance(v, (bool, int)) and not isinstance(v, str):
                s[k] += int(v)
    labels = Counter(c["label_decision"] for c in cases)
    usage = [r["usage"] or {} for r in records]
    cost = 0.0
    for r, u in zip(records, usage):
        price_in, price_cached, price_out = PRICES.get(r["model_requested"], (0, 0, 0))
        cached = u.get("cached_input_tokens", 0)
        cost += ((u.get("input_tokens", 0) - cached) * price_in + cached * price_cached
                 + u.get("output_tokens", 0) * price_out) / 1_000_000
    return {
        "cases": len(cases),
        "decision_accuracy": ratio(s["decision_match"], len(cases)),
        "change_recall": ratio(s["matched"], s["expected"]),
        "change_precision": ratio(s["matched"], s["predicted"]),
        "complete_precision": ratio(s["complete_tp"], s["complete_tp"] + s["complete_fp"]),
        "complete_recall": ratio(s["complete_tp"], s["complete_tp"] + s["complete_fn"]),
        "noop_false_positive_rate": ratio(s["noop_false_positive"],
                                          labels["no_change"] + labels["needs_clarification"]),
        "forbidden_hits": s["forbidden_hits"],
        "forbidden_hit_cases": sum(1 for c in cases if c["forbidden_hits"]),
        "invalid_task_refs": s["invalid_task_refs"],
        "status_value_mismatch": s["status_value_mismatch"],
        "confusion": dict(Counter(f"{c['label_decision']} -> {c['pred_decision']}" for c in cases)),
        "median_seconds": statistics.median(r["elapsed_seconds"] for r in records) if records else None,
        "input_tokens": sum(u.get("input_tokens", 0) for u in usage),
        "cached_input_tokens": sum(u.get("cached_input_tokens", 0) for u in usage),
        "output_tokens": sum(u.get("output_tokens", 0) for u in usage),
        "reasoning_output_tokens": sum(u.get("reasoning_output_tokens", 0) for u in usage),
        "estimated_cost_usd": round(cost, 4),
    }


def main():
    labels = {r["id"]: r for r in map(json.loads, (DATA / "labels/claude-blind-v1.jsonl").read_text().splitlines())}
    cases = {r["id"]: r for r in map(json.loads, (DATA / "candidates.jsonl").read_text().splitlines())}
    report = {}
    for variant_dir in sorted(p for p in (ROOT / "results").iterdir() if p.is_dir()):
        records = [json.loads(p.read_text()) for p in sorted(variant_dir.glob("*.json"))]
        ok = [r for r in records if r["status"] == "success"]
        scored = []
        for r in ok:
            task_ids = {t["task_id"] for t in cases[r["id"]]["input"]["prior_project_state"]["tasks"]}
            scored.append(score_case(labels[r["id"]], r["response"], task_ids) | {"id": r["id"]})
        report[variant_dir.name] = aggregate(scored, ok) | {
            "attempted": len(records), "failed": len(records) - len(ok),
            "tool_calls": sum(len(r["tool_calls"]) for r in records),
            "per_case": scored,
        }
    (ROOT / "scores.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for name, m in report.items():
        print(name, {k: v for k, v in m.items() if k not in ("per_case", "confusion")})


if __name__ == "__main__":
    main()
