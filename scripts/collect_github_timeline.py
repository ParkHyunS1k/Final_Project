"""GitHub 이슈 기록에서 상태형 평가 후보를 뽑는다.

댓글 시각 T의 저장소 이슈 목록(제목·열림/닫힘·담당자)을 이슈 기록으로 복원해 입력에 넣고,
T부터 창(window) 안에서 실제로 일어난 변경은 observed.jsonl에 따로 저장한다.
실제 변경은 사람이 확인하기 전의 정답 후보다. 모델에는 candidates.jsonl의 input만 준다.

    python3 scripts/collect_github_timeline.py --search "회의록 is:issue" --out <dir>
    python3 scripts/collect_github_timeline.py --repo owner/name --out <dir>

gh CLI 로그인이 필요하다. 원문은 API 필드를 그대로 복사하며 자르거나 고치지 않는다.
"""
import argparse
import difflib
import hashlib
import json
import random
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V1_DATASET = ROOT / "datasets/public-task-extraction-50-v1/dataset.jsonl"
QUERY_VERSION = "github-timeline-v1"
HANGUL = re.compile(r"[가-힣]")
MIN_ISSUES, MAX_ISSUES = 5, 300  # 작은 팀 저장소만. 큰 저장소의 이슈 목록은 팀 업무 목록이 아니다.
MAX_TASKS = 8  # 대상 이슈 + 제목이 비슷한 기존 이슈
CONTEXT_COMMENTS = 2
MAX_CHARS = 2000  # 넘으면 자르지 않고 제외한다.

REPO_QUERY = """query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    nameWithOwner licenseInfo{spdxId}
    issues(first:50, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{
        number title url createdAt author{login __typename}
        timelineItems(first:100, itemTypes:[ISSUE_COMMENT,CLOSED_EVENT,REOPENED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,RENAMED_TITLE_EVENT]){
          pageInfo{hasNextPage}
          nodes{
            __typename
            ... on IssueComment{databaseId url body createdAt lastEditedAt author{login __typename}}
            ... on ClosedEvent{createdAt stateReason actor{login __typename}}
            ... on ReopenedEvent{createdAt actor{login __typename}}
            ... on AssignedEvent{createdAt actor{login __typename} assignee{... on Actor{login}}}
            ... on UnassignedEvent{createdAt actor{login __typename} assignee{... on Actor{login}}}
            ... on RenamedTitleEvent{createdAt previousTitle currentTitle actor{login __typename}}
          }
        }
      }
    }
  }
}"""

SEARCH_QUERY = """query($q:String!,$cursor:String){
  search(query:$q, type:ISSUE, first:100, after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{... on Issue{repository{nameWithOwner isFork isArchived issues{totalCount}}}}
  }
}"""

EVENT_TYPES = {"ClosedEvent": "closed", "ReopenedEvent": "reopened", "AssignedEvent": "assigned",
               "UnassignedEvent": "unassigned", "RenamedTitleEvent": "renamed"}


def graphql(query, **variables):
    body = json.dumps({"query": query, "variables": variables})
    out = subprocess.run(["gh", "api", "graphql", "--input", "-"], input=body, capture_output=True, text=True)
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        data = {}
    if out.returncode or data.get("errors") or not data.get("data"):
        raise RuntimeError(str(data.get("errors") or out.stderr.strip())[:300])
    return data["data"]


def who(actor):
    actor = actor or {}
    return actor.get("login", "ghost"), actor.get("__typename", "User")


def discover(queries, limit):
    """검색식마다 저장소 수를 균등하게 나눠, 첫 검색식이 후보를 독점하지 않게 한다."""
    repos = {}
    per_query = -(-limit // max(len(queries), 1))
    for q in queries:
        cursor, start = None, len(repos)
        while len(repos) - start < per_query:
            page = graphql(SEARCH_QUERY, q=q, cursor=cursor)["search"]
            for node in page["nodes"]:
                repo = node.get("repository")
                if repo and not repo["isFork"] and not repo["isArchived"] \
                        and MIN_ISSUES <= repo["issues"]["totalCount"] <= MAX_ISSUES:
                    repos.setdefault(repo["nameWithOwner"], None)
            if not page["pageInfo"]["hasNextPage"]:
                break
            cursor = page["pageInfo"]["endCursor"]
    return list(repos)[:limit]


def fetch_repo(name_with_owner):
    owner, name = name_with_owner.split("/")
    issues, cursor = [], None
    while True:
        repo = graphql(REPO_QUERY, owner=owner, name=name, cursor=cursor)["repository"]
        page = repo["issues"]
        if not MIN_ISSUES <= page["totalCount"] <= MAX_ISSUES:
            raise ValueError(f"issue_count_{page['totalCount']}")
        for node in page["nodes"]:
            if node["timelineItems"]["pageInfo"]["hasNextPage"]:
                # 기록 일부만 있으면 T 시점 상태를 복원할 수 없다.
                raise ValueError(f"timeline_truncated_issue_{node['number']}")
            issues.append(normalize_issue(node))
        if not page["pageInfo"]["hasNextPage"]:
            return {"name": repo["nameWithOwner"], "license": (repo["licenseInfo"] or {}).get("spdxId"),
                    "issues": issues}
        cursor = page["pageInfo"]["endCursor"]


def normalize_issue(node):
    author, author_type = who(node["author"])
    issue = {"number": node["number"], "title": node["title"], "url": node["url"],
             "created_at": node["createdAt"], "author": author, "author_type": author_type,
             "comments": [], "events": []}
    for item in node["timelineItems"]["nodes"]:
        kind = item["__typename"]
        if kind == "IssueComment":
            login, account_type = who(item["author"])
            issue["comments"].append({"id": item["databaseId"], "url": item["url"], "body": item["body"],
                                      "created_at": item["createdAt"], "edited": item["lastEditedAt"] is not None,
                                      "author": login, "author_type": account_type})
        elif kind in EVENT_TYPES:
            login, account_type = who(item["actor"])
            event = {"type": EVENT_TYPES[kind], "at": item["createdAt"], "actor": login, "actor_type": account_type}
            if kind == "ClosedEvent":
                event["reason"] = item["stateReason"]
            elif kind in ("AssignedEvent", "UnassignedEvent"):
                event["assignee"] = (item["assignee"] or {}).get("login", "ghost")
            elif kind == "RenamedTitleEvent":
                event.update(previous_title=item["previousTitle"], current_title=item["currentTitle"])
            issue["events"].append(event)
    return issue


def title_at(issue, t):
    later = [e for e in issue["events"] if e["type"] == "renamed" and e["at"] >= t]
    return min(later, key=lambda e: e["at"])["previous_title"] if later else issue["title"]


def task_at(issue, t):
    """t 직전까지의 기록만 반영한다. t와 같은 시각의 변경(댓글과 함께 닫기)은 이후 변경으로 본다."""
    state, reason, assignees = "open", None, set()
    for e in sorted(issue["events"], key=lambda e: e["at"]):
        if e["at"] >= t:
            break
        if e["type"] == "closed":
            state, reason = "closed", e["reason"]
        elif e["type"] == "reopened":
            state, reason = "open", None
        elif e["type"] == "assigned":
            assignees.add(e["assignee"])
        elif e["type"] == "unassigned":
            assignees.discard(e["assignee"])
    return {"task_id": f"issue-{issue['number']}", "title": title_at(issue, t), "state": state,
            "closed_reason": reason, "assignees": sorted(assignees)}


def changes_between(issues, shown, start, end):
    changes = []
    for issue in issues:
        task_id = f"issue-{issue['number']}"
        if start <= issue["created_at"] <= end:
            changes.append({"operation": "create", "task_id": task_id, "type": "created", "at": issue["created_at"],
                            "actor": issue["author"], "actor_type": issue["author_type"],
                            "title": title_at(issue, issue["created_at"])})
        if task_id in shown:
            changes += [{"operation": "update", "task_id": task_id, **e}
                        for e in issue["events"] if start <= e["at"] <= end]
    return sorted(changes, key=lambda c: (c["at"], c["task_id"]))


def excerpt(comment):
    digest = hashlib.sha256(comment["body"].encode("utf-8")).hexdigest()
    return {"text": comment["body"], "source_url": comment["url"], "source_kind": "issue_comment",
            "source_object_id": comment["id"], "author_login": comment["author"],
            "author_account_type": comment["author_type"], "created_at": comment["created_at"],
            "selection": "complete_field", "text_edits": [], "source_field_sha256": digest}


def build_candidates(repo, window_hours, lang, collected_at, anchor_pattern=None):
    issues = repo["issues"]
    pairs, seen_bodies = [], set()
    for issue in issues:
        for i, comment in enumerate(issue["comments"]):
            context = issue["comments"][max(0, i - CONTEXT_COMMENTS):i]
            body = comment["body"]
            if comment["author_type"] != "User" or not body.strip() or len(body) > MAX_CHARS \
                    or (lang == "ko" and not HANGUL.search(body)) \
                    or (anchor_pattern and not anchor_pattern.search(body)):
                continue
            # 수정된 글은 T 시점 내용을 알 수 없으므로 대상·앞 문맥 모두 제외한다.
            if any(c["edited"] or len(c["body"]) > MAX_CHARS for c in [*context, comment]):
                continue
            # 같은 댓글을 여러 이슈에 붙인 경우는 한 번만 쓴다.
            if body in seen_bodies:
                continue
            seen_bodies.add(body)
            t = comment["created_at"]
            prior = [x for x in issues if x["created_at"] < t and x is not issue]
            if not prior:
                continue
            target_title = title_at(issue, t)
            prior.sort(key=lambda x: -difflib.SequenceMatcher(None, target_title, title_at(x, t)).ratio())
            tasks = sorted((task_at(x, t) for x in [issue, *prior[:MAX_TASKS - 1]]),
                           key=lambda task: int(task["task_id"].split("-")[1]))  # 대상 위치로 정답이 드러나지 않게
            shown = {task["task_id"] for task in tasks}
            end = (datetime.fromisoformat(t) + timedelta(hours=window_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
            changes = changes_between(issues, shown, t, end)
            members = {x["author"] for x in issues if x["created_at"] < t and x["author_type"] == "User"}
            members |= {c["author"] for x in issues for c in x["comments"]
                        if c["created_at"] < t and c["author_type"] == "User"}
            members |= {a for task in tasks for a in task["assignees"]}
            case_id = f"GH-TL-{comment['id']}"
            candidate = {
                "id": case_id, "data_origin": "public_source", "synthetic": False,
                "language": "ko" if HANGUL.search(body) else "other",
                "input": {
                    "thread_url": issue["url"], "thread_title_as_of": target_title, "as_of": t,
                    "excerpts": [excerpt(c) for c in [*context, comment]],
                    "prior_project_state": {"reconstructed_from": "github_issue_timeline", "as_of": t, "tasks": tasks},
                    "member_directory": {"basis": "repository_participants_before_as_of", "logins": sorted(members)},
                },
                "provenance": {"repository": repo["name"], "repository_license_spdx": repo["license"],
                               "anchor_comment_url": comment["url"], "anchor_excerpt_index": len(context),
                               "query_version": QUERY_VERSION, "collected_at": collected_at},
            }
            observed = {
                "id": case_id, "label_origin": "github_timeline", "review_status": "not_human_reviewed",
                "is_gold": False, "window": {"start": t, "end": end, "hours": window_hours},
                "changes": changes,
                "shown_tasks_without_change": sorted(shown - {c["task_id"] for c in changes}),
            }
            pairs.append((candidate, observed))
    return pairs


def jsonl(rows):
    """U+2028 등은 json.dumps가 이스케이프하지 않지만 str.splitlines()는 줄바꿈으로 본다."""
    lines = (json.dumps(r, ensure_ascii=False) for r in rows)
    return "".join(line.replace("\x85", "\\u0085").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + "\n"
                   for line in lines)


def pick(pairs, per_repo, rng):
    """변경이 있었던 사례와 없었던 사례를 번갈아 고른다. 무작업 판단도 평가 대상이다."""
    pairs = list(pairs)
    rng.shuffle(pairs)
    changed = [p for p in pairs if p[1]["changes"]]
    unchanged = [p for p in pairs if not p[1]["changes"]]
    order = [p for pair in zip(changed, unchanged) for p in pair]
    order += changed[len(unchanged):] + unchanged[len(changed):]
    return order[:per_repo]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", action="append", default=[], help="owner/name, 여러 번 지정 가능")
    parser.add_argument("--search", action="append", default=[], help='GitHub 검색식, 예: "회의록 is:issue"')
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-repos", type=int, default=30)
    parser.add_argument("--per-repo", type=int, default=2)
    parser.add_argument("--window-hours", type=int, default=48)
    parser.add_argument("--lang", choices=["ko", "any"], default="ko")
    parser.add_argument("--seed", default="github-timeline-v1")
    parser.add_argument("--anchor-regex", help="기준 댓글이 이 정규식(대소문자 무시)에 맞을 때만 후보로 쓴다")
    args = parser.parse_args()
    anchor_pattern = re.compile(args.anchor_regex, re.I) if args.anchor_regex else None
    if not args.repo and not args.search:
        parser.error("--repo 또는 --search가 필요하다")

    # v1 데이터셋 저장소는 제외해 저장소 단위 개발/보류 분할이 섞이지 않게 한다.
    v1_repos = {json.loads(line)["provenance"]["repository"] for line in V1_DATASET.read_text().splitlines()}
    repos = list(dict.fromkeys(args.repo + discover(args.search, args.max_repos)))
    collected_at = datetime.now(timezone.utc).isoformat()
    candidates, observed, skipped, collected = [], [], {}, []
    for name in repos:
        if name in v1_repos:
            skipped[name] = "in_v1_dataset"
            continue
        try:
            repo = fetch_repo(name)
        except (RuntimeError, ValueError) as error:
            skipped[name] = str(error)
            continue
        pairs = build_candidates(repo, args.window_hours, args.lang, collected_at, anchor_pattern)
        chosen = pick(pairs, args.per_repo, random.Random(f"{args.seed}:{name}"))
        collected.append({"repository": name, "issues": len(repo["issues"]), "eligible_anchors": len(pairs),
                          "picked": len(chosen)})
        for candidate, label in chosen:
            candidates.append(candidate)
            observed.append(label)

    args.out.mkdir(parents=True, exist_ok=True)
    for filename, rows in (("candidates.jsonl", candidates), ("observed.jsonl", observed)):
        (args.out / filename).write_text(jsonl(rows))
    run = {"query_version": QUERY_VERSION, "collected_at": collected_at, "args": {**vars(args), "out": str(args.out)},
           "candidates": len(candidates), "with_observed_change": sum(1 for o in observed if o["changes"]),
           "repositories": collected, "skipped_repositories": skipped}
    (args.out / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: run[k] for k in ("candidates", "with_observed_change")} |
                     {"repositories": len(collected), "skipped": len(skipped)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
