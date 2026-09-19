"""runs/*의 후보 풀에서 첫 검토용 300건을 고른다. 표준 Python만 사용한다.

- 유형: A 대상 이슈가 이후 바뀜 120 / B 다른 이슈만 바뀜 80 / C 기간 안 변경 없음 100.
- 저장소당 1건을 먼저 채우고, 모자랄 때만 2건째를 허용한다.
- 각 유형 안에서 2025년 이전과 이후 사례를 번갈아 고른다(에이전트 작성 글 비중을 낮추기 위함).
- 발췌에 AI 도구 서명 문자열이 있으면 고르지 않는다. 풀에는 남아 있어 교체용으로 쓸 수 있다.
"""
import importlib.util
import json
import random
import re
from collections import Counter
from itertools import zip_longest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("collector", ROOT.parents[1] / "scripts/collect_github_timeline.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)
TARGETS = {"A_anchor_changed": 120, "B_other_changed": 80, "C_no_change": 100}
SEED = "github-timeline-v1-select"
TOOL_SIGNATURE = re.compile(r"Generated with|Co-Authored-By:|Claude Code|🤖")


def bucket(candidate, observed):
    target = "issue-" + candidate["input"]["thread_url"].rsplit("/", 1)[1]
    if any(change["task_id"] == target for change in observed["changes"]):
        return "A_anchor_changed"
    return "B_other_changed" if observed["changes"] else "C_no_change"


def load_pool():
    pool = {}
    for run in sorted(p for p in (ROOT / "runs").iterdir() if p.is_dir()):
        candidates = [json.loads(x) for x in (run / "candidates.jsonl").read_text().splitlines()]
        observed = [json.loads(x) for x in (run / "observed.jsonl").read_text().splitlines()]
        for candidate, label in zip(candidates, observed, strict=True):
            assert candidate["id"] == label["id"]
            pool.setdefault(candidate["id"], (candidate, label, run.name))
    return list(pool.values())


def main():
    pool = load_pool()
    usable = [p for p in pool if not any(TOOL_SIGNATURE.search(e["text"]) for e in p[0]["input"]["excerpts"])]
    random.Random(SEED).shuffle(usable)
    taken, repos, selected = Counter(), Counter(), []
    for max_per_repo in (1, 2):
        for name, target in TARGETS.items():
            group = [p for p in usable if bucket(p[0], p[1]) == name]
            old = [p for p in group if p[0]["input"]["as_of"] < "2025"]
            new = [p for p in group if p[0]["input"]["as_of"] >= "2025"]
            for item in (p for pair in zip_longest(old, new) for p in pair if p):
                repo = item[0]["provenance"]["repository"]
                if taken[name] == target:
                    break
                if repos[repo] < max_per_repo and item not in selected:
                    selected.append(item)
                    taken[name] += 1
                    repos[repo] += 1

    selected.sort(key=lambda p: p[0]["id"])
    assert len({p[0]["id"] for p in selected}) == len(selected)
    assert max(repos.values()) <= 2
    for filename, index in (("candidates.jsonl", 0), ("observed.jsonl", 1)):
        (ROOT / filename).write_text(collector.jsonl(p[index] for p in selected))
    summary = {
        "method": __doc__.strip(), "seed": SEED, "targets": TARGETS,
        "pool_candidates": len(pool), "excluded_tool_signature": len(pool) - len(usable),
        "selected": len(selected), "by_bucket": dict(Counter(bucket(p[0], p[1]) for p in selected)),
        "by_era": dict(Counter("before_2025" if p[0]["input"]["as_of"] < "2025" else "2025_or_later" for p in selected)),
        "by_run": dict(Counter(p[2] for p in selected)), "repositories": len(repos),
        "repositories_with_two": sum(1 for n in repos.values() if n == 2),
        "cases": [{"id": p[0]["id"], "bucket": bucket(p[0], p[1]), "run": p[2]} for p in selected],
    }
    (ROOT / "selection.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("method", "cases")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
