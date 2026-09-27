"""Apply the frozen baseline checks to the revised output contract."""
import hashlib
import json
import statistics
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parents[2] / "datasets/public-task-extraction-50-v1"
BASELINE = ROOT.parent / "luna-low-2026-09-08"


def validate_schema(value, schema, path="$"):
    kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
    matches = {
        "null": value is None,
        "boolean": type(value) is bool,
        "number": type(value) in (int, float),
        "integer": type(value) is int,
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    assert any(matches[kind] for kind in kinds), f"{path}: type"
    if value is None:
        return
    if "enum" in schema:
        assert value in schema["enum"], f"{path}: enum"
    if "minimum" in schema:
        assert value >= schema["minimum"], f"{path}: minimum"
    if isinstance(value, dict):
        assert set(schema["required"]) <= set(value), f"{path}: required"
        assert not (set(value) - set(schema["properties"])), f"{path}: extra keys"
        for key, child in value.items():
            validate_schema(child, schema["properties"][key], path + "." + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            validate_schema(child, schema["items"], path + f"[{index}]")


def has_no_single_selected_estimate(estimates):
    return len(set(estimates)) != 1


def main():
    rubric_path = BASELINE / "rubric.json"
    rubric = json.loads(rubric_path.read_text())["cases"]
    source = {
        row["id"]: row
        for row in map(json.loads, (DATA / "dataset.jsonl").read_text().splitlines())
    }
    schema = json.loads((ROOT / "schema.json").read_text())
    details, tokens, elapsed = [], Counter(), []
    for cid, expected in rubric.items():
        path = ROOT / "results" / f"{cid}.json"
        if not path.exists():
            details.append({"id": cid, "status": "missing"})
            continue
        run = json.loads(path.read_text())
        response = run.get("response")
        if run["status"] != "success":
            details.append({"id": cid, "status": "execution_failed"})
            continue
        validate_schema(response, schema)
        tokens.update({
            key: value for key, value in (run["usage"] or {}).items()
            if isinstance(value, int)
        })
        elapsed.append(run["elapsed_seconds"])
        items = response["work_items"]
        states = {item["state"] for item in items}
        remaining = [
            mention["minutes"] for mention in response["effort_mentions"]
            if mention["kind"] == "remaining"
        ]
        estimates = [
            mention["minutes"] for mention in response["effort_mentions"]
            if mention["kind"] == "estimated"
        ]
        checks = []

        def check(name, passed, actual):
            checks.append({"check": name, "passed": bool(passed), "actual": actual})

        for key, value in expected.items():
            if key == "completion_not_true":
                check(key, response["whole_thread_completion_reported"] is not True,
                      response["whole_thread_completion_reported"])
            elif key == "completion_is":
                check(key, response["whole_thread_completion_reported"] is value,
                      response["whole_thread_completion_reported"])
            elif key in ("relation", "release_state", "needs_clarification"):
                check(key, response[key] == value, response[key])
            elif key == "target_suffix":
                check(key, (response["relation_target_url"] or "").endswith(value),
                      response["relation_target_url"])
            elif key == "minimum_items":
                check(key, len(items) >= value, len(items))
            elif key == "has_state":
                check(key, set(value) <= states, sorted(states))
            elif key == "has_any_state":
                check(key, bool(set(value) & states), sorted(states))
            elif key == "has_modality":
                actual = {item["modality"] for item in items}
                check(key, set(value) <= actual, sorted(actual))
            elif key == "remaining_minutes":
                check(key, value in remaining, remaining)
            elif key == "remaining_effort_total_once":
                check(key, remaining == [expected["remaining_minutes"]], remaining)
            elif key == "estimated_minutes":
                check(key, value in estimates, estimates)
            elif key == "conflicting_estimate_minutes":
                check(key, sorted(estimates) == value, estimates)
            elif key == "no_single_estimate":
                check(key, has_no_single_selected_estimate(estimates), estimates)
            else:
                raise ValueError(key)
        if cid != "PM-REAL-038":
            check("no_unstated_remaining_effort", not remaining, remaining)
        if cid not in ("PM-REAL-038", "PM-REAL-048", "PM-REAL-049"):
            check("no_unstated_estimated_effort", not estimates, estimates)

        excerpt_count = len(source[cid]["input"]["excerpts"])
        evidence_ok = all(
            item["evidence_excerpt_indices"]
            and all(0 <= index < excerpt_count for index in item["evidence_excerpt_indices"])
            for item in items
        ) and all(
            mention["evidence_excerpt_indices"]
            and all(0 <= index < excerpt_count for index in mention["evidence_excerpt_indices"])
            and all(0 <= index < len(items) for index in mention["work_item_indices"])
            for mention in response["effort_mentions"]
        )
        check("evidence_indices_valid", evidence_ok, {
            "work_items": [item["evidence_excerpt_indices"] for item in items],
            "effort_mentions": response["effort_mentions"],
        })
        details.append({
            "id": cid,
            "status": "checked",
            "all_checks_passed": all(item["passed"] for item in checks),
            "checks": checks,
            "summary_ko": response["summary_ko"],
        })

    evaluated = [row for row in details if row["status"] == "checked"]
    all_checks = [check for row in evaluated for check in row["checks"]]
    summary = {
        "model_requested": "gpt-5.6-luna",
        "reasoning_effort": "low",
        "review_type": "frozen provisional checks, NOT human-validated accuracy",
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "planned_cases": 35,
        "successful_structured_responses": len(evaluated),
        "cases_passing_all_selected_checks": sum(row["all_checks_passed"] for row in evaluated),
        "selected_checks_passed": sum(check["passed"] for check in all_checks),
        "selected_checks_total": len(all_checks),
        "cases_requiring_review": [row["id"] for row in evaluated if not row["all_checks_passed"]],
        "usage_totals": dict(tokens),
        "latency_includes_cli_startup_seconds": {
            "median": statistics.median(elapsed) if elapsed else None,
            "min": min(elapsed) if elapsed else None,
            "max": max(elapsed) if elapsed else None,
        },
        "holdout_cases_executed": 0,
        "rubric_sha256": hashlib.sha256(rubric_path.read_bytes()).hexdigest(),
        "details": details,
    }
    (ROOT / "scores.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in summary.items() if key != "details"},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
