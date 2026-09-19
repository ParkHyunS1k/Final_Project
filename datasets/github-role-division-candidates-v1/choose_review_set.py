"""runs/*의 역할 분담·회의록형 후보에서 검토용 50건을 고른다. 표준 Python만 사용한다.

- 기존 상태형 데이터셋(github-timeline-candidates-v1) 풀에 있던 저장소는 뺀다. 두 평가셋이 섞이지 않게.
- 보여준 업무가 3개 미만이거나, 절반 이상이 회의록·스크럼·일지·스터디 게시물이면 뺀다. 담당자 매칭 대상이 없다.
- AI 도구 서명 문자열이 있는 발췌는 뺀다.
- 저장소당 1건. 기준 댓글에 역할 분담 표현이 많은 사례를 먼저, 같은 수준에서는 2025년 이전·이후를 번갈아 고른다.
"""
import importlib.util
import json
import random
import re
from collections import Counter
from itertools import zip_longest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[1]
_spec = importlib.util.spec_from_file_location("collector", PROJECT / "scripts/collect_github_timeline.py")
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)

TARGET = 50
SEED = "github-role-division-v1-select"
ROLE = re.compile(r"역할\s*분담|업무\s*분담|분담|담당자|담당(하|할|합|해|은|는|으로|:)|맡(아|기|을|겠|습|으|는)"
                  r"|R&R|액션\s*아이템|action item|배정|어사인", re.I)
LOG_TITLE = re.compile(r"회의|스크럼|scrum|meeting|일지|TIL|KPT|회고|스터디|study|daily|weekly|주간|일일|업무\s*보고", re.I)
TOOL_SIGNATURE = re.compile(r"Generated with|Co-Authored-By:|Claude Code|🤖")


def load(path):
    return [json.loads(x) for x in path.read_text().splitlines()]


def main():
    timeline = PROJECT / "datasets/github-timeline-candidates-v1/runs"
    used_repos = {c["provenance"]["repository"] for run in timeline.iterdir() if run.is_dir()
                  for c in load(run / "candidates.jsonl")}
    pool, excluded = {}, Counter()
    for run in sorted(p for p in (ROOT / "runs").iterdir() if p.is_dir()):
        for candidate, observed in zip(load(run / "candidates.jsonl"), load(run / "observed.jsonl"), strict=True):
            tasks = candidate["input"]["prior_project_state"]["tasks"]
            texts = [e["text"] for e in candidate["input"]["excerpts"]]
            reason = ("repo_in_timeline_v1" if candidate["provenance"]["repository"] in used_repos
                      else "fewer_than_3_tasks" if len(tasks) < 3
                      else "log_style_task_list" if sum(bool(LOG_TITLE.search(t["title"])) for t in tasks) * 2 >= len(tasks)
                      else "tool_signature" if any(TOOL_SIGNATURE.search(t) for t in texts) else None)
            if reason:
                excluded[reason] += 1
            else:
                pool.setdefault(candidate["id"], (candidate, observed, run.name))

    rng = random.Random(SEED)
    items = list(pool.values())
    rng.shuffle(items)
    strength = lambda item: min(3, len(ROLE.findall(item[0]["input"]["excerpts"][item[0]["provenance"]["anchor_excerpt_index"]]["text"])))
    selected, repos = [], set()
    for level in (3, 2, 1):
        group = [p for p in items if strength(p) == level]
        old = [p for p in group if p[0]["input"]["as_of"] < "2025"]
        new = [p for p in group if p[0]["input"]["as_of"] >= "2025"]
        for item in (p for pair in zip_longest(old, new) for p in pair if p):
            repo = item[0]["provenance"]["repository"]
            if len(selected) < TARGET and repo not in repos:
                selected.append(item)
                repos.add(repo)

    selected.sort(key=lambda p: p[0]["id"])
    for filename, index in (("candidates.jsonl", 0), ("observed.jsonl", 1)):
        (ROOT / filename).write_text(collector.jsonl(p[index] for p in selected))
    summary = {
        "method": __doc__.strip(), "seed": SEED, "target": TARGET,
        "pool_after_exclusion": len(pool), "excluded": dict(excluded), "selected": len(selected),
        "by_role_term_count": dict(Counter(strength(p) for p in selected)),
        "by_era": dict(Counter("before_2025" if p[0]["input"]["as_of"] < "2025" else "2025_or_later" for p in selected)),
        "repositories": len(repos), "ids": [p[0]["id"] for p in selected],
    }
    (ROOT / "selection.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("method", "ids")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
