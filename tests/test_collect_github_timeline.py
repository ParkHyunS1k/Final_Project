import importlib.util
import json
import random
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector", ROOT / "scripts/collect_github_timeline.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def issue(number, title, created_at, comments=(), events=()):
    return {"number": number, "title": title, "url": f"https://github.com/o/r/issues/{number}",
            "created_at": created_at, "author": "alice", "author_type": "User",
            "comments": list(comments), "events": list(events)}


def comment(id_, body, created_at, author="bob", author_type="User", edited=False):
    return {"id": id_, "url": f"https://github.com/o/r/issues/1#issuecomment-{id_}", "body": body,
            "created_at": created_at, "edited": edited, "author": author, "author_type": author_type}


REPO = {"name": "o/r", "license": None, "issues": [
    issue(1, "로그인 API 연결", "2026-09-01T00:00:00Z",
          comments=[
              comment(10, "로그인 API 연결 시작합니다", "2026-09-01T02:00:00Z", edited=True),
              comment(11, "CI 결과", "2026-09-01T03:00:00Z", author="ci", author_type="Bot"),
              comment(12, "로그인 API 연결 끝났습니다", "2026-09-02T00:00:00Z"),
          ],
          events=[
              {"type": "assigned", "at": "2026-09-01T01:00:00Z", "actor": "alice", "actor_type": "User", "assignee": "bob"},
              # 댓글과 함께 닫기: 같은 시각의 변경은 입력 상태가 아니라 이후 변경이다.
              {"type": "closed", "at": "2026-09-02T00:00:00Z", "actor": "bob", "actor_type": "User", "reason": "COMPLETED"},
          ]),
    issue(2, "로그인 UI 구현", "2026-09-01T00:30:00Z", events=[
        {"type": "closed", "at": "2026-09-01T05:00:00Z", "actor": "bob", "actor_type": "User", "reason": "COMPLETED"},
        {"type": "renamed", "at": "2026-09-03T00:00:00Z", "actor": "bob", "actor_type": "User",
         "previous_title": "로그인 화면", "current_title": "로그인 UI 구현"},
    ]),
    issue(3, "회원가입 API", "2026-09-02T10:00:00Z"),
    issue(4, "배포", "2026-09-10T00:00:00Z"),
]}


class CollectGithubTimelineTest(unittest.TestCase):
    def test_state_is_reconstructed_before_anchor_and_changes_are_kept_apart(self):
        pairs = collector.build_candidates(REPO, 48, "ko", "2026-09-10T00:00:00+00:00")

        # 수정된 댓글과 봇 댓글은 대상이 아니고, 수정된 댓글이 앞 문맥에 있으면 그 뒤 댓글도 제외한다.
        self.assertEqual([c["id"] for c, _ in pairs], [])

        duplicate = comment(13, "로그인 API 연결 끝났습니다", "2026-09-02T00:00:05Z")
        clean = {**REPO, "issues": [{**REPO["issues"][0], "comments": REPO["issues"][0]["comments"][1:]},
                                    {**REPO["issues"][1], "comments": [duplicate]},
                                    *REPO["issues"][2:]]}
        [(candidate, observed)] = collector.build_candidates(clean, 48, "ko", "2026-09-10T00:00:00+00:00")

        self.assertEqual(candidate["id"], "GH-TL-12")
        self.assertEqual([e["author_account_type"] for e in candidate["input"]["excerpts"]], ["Bot", "User"])
        self.assertEqual(candidate["provenance"]["anchor_excerpt_index"], 1)
        self.assertEqual(candidate["input"]["prior_project_state"]["tasks"], [
            {"task_id": "issue-1", "title": "로그인 API 연결", "state": "open", "closed_reason": None, "assignees": ["bob"]},
            {"task_id": "issue-2", "title": "로그인 화면", "state": "closed", "closed_reason": "COMPLETED", "assignees": []},
        ])
        self.assertEqual(candidate["input"]["member_directory"]["logins"], ["alice", "bob"])
        self.assertEqual([(c["operation"], c["task_id"], c["type"]) for c in observed["changes"]],
                         [("update", "issue-1", "closed"), ("create", "issue-3", "created"),
                          ("update", "issue-2", "renamed")])
        self.assertEqual(observed["shown_tasks_without_change"], [])
        # 창 밖(issue-4)의 변경은 넣지 않는다.
        self.assertEqual(observed["window"]["end"], "2026-09-04T00:00:00Z")
        self.assertFalse(observed["is_gold"])
        self.assertNotIn("changes", candidate["input"])
        # 기준 댓글 필터: 맞지 않으면 후보가 없고, 맞으면 같은 후보가 나온다.
        ts = "2026-09-10T00:00:00+00:00"
        self.assertEqual(collector.build_candidates(clean, 48, "ko", ts, re.compile("분담")), [])
        self.assertEqual(len(collector.build_candidates(clean, 48, "ko", ts, re.compile("끝났"))), 1)

    def test_jsonl_lines_survive_splitlines(self):
        rows = [{"text": "a b c\x85d"}, {"text": "e"}]
        text = collector.jsonl(rows)
        self.assertEqual([json.loads(line) for line in text.splitlines()], rows)

    def test_pick_alternates_changed_and_unchanged(self):
        pairs = [({"id": i}, {"changes": [1] if i < 3 else []}) for i in range(5)]
        picked = collector.pick(pairs, 2, random.Random(0))
        self.assertEqual([bool(o["changes"]) for _, o in picked], [True, False])


if __name__ == "__main__":
    unittest.main()
