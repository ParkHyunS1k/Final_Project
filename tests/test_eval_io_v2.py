import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "evals/public-task-extraction/luna-low-io-v2-2026-09-10"


def load(name):
    spec = importlib.util.spec_from_file_location(name, EVAL / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EvalIOV2Test(unittest.TestCase):
    def test_model_input_makes_evidence_context_explicit(self):
        run = load("run")
        row = {
        "id": "PM-REAL-999",
        "input": {
            "thread_url": "https://example.test/issues/1",
            "thread_title_at_collection": "Example",
            "excerpts": [{
                "text": "done",
                "source_kind": "issue_comment",
                "author_login": "octocat",
                "created_at": "2026-09-10T00:00:00Z",
                "updated_at": "2026-09-10T00:00:00Z",
            }],
            "prior_project_state": None,
            "member_directory": None,
        },
        }

        self.assertEqual(run.build_model_input(row), {
        "id": "PM-REAL-999",
        "thread": {
            "url": "https://example.test/issues/1",
            "title_at_collection": "Example",
        },
        "excerpts": [{
            "index": 0,
            "source_kind": "issue_comment",
            "author_login": "octocat",
            "created_at": "2026-09-10T00:00:00Z",
            "updated_at": "2026-09-10T00:00:00Z",
            "context_before": None,
            "text": "done",
        }],
        "known_context": {
            "prior_project_state": None,
            "member_directory": None,
        },
        })


    def test_schema_represents_shared_effort_once(self):
        score = load("score")
        schema = json.loads((EVAL / "schema.json").read_text())
        response = {
        "id": "PM-REAL-038",
        "summary_ko": "세 작업에 총 280분이 남았다.",
        "work_items": [
            {
                "description_ko": "마스크 제작",
                "target": "subtask",
                "referenced_issue_url": None,
                "state": "in_progress",
                "modality": "asserted",
                "condition_ko": None,
                "assignee_login": None,
                "evidence_excerpt_indices": [0],
            },
            {
                "description_ko": "본 리깅과 텍스처링",
                "target": "subtask",
                "referenced_issue_url": None,
                "state": "in_progress",
                "modality": "asserted",
                "condition_ko": None,
                "assignee_login": None,
                "evidence_excerpt_indices": [0],
            },
        ],
        "effort_mentions": [{
            "kind": "remaining",
            "minutes": 280,
            "scope": "work_item_group",
            "work_item_indices": [0, 1],
            "evidence_excerpt_indices": [0],
        }],
        "whole_thread_completion_reported": False,
        "release_state": "unknown",
        "relation": "none",
        "relation_target_url": None,
        "needs_clarification": False,
        "clarification_reason_ko": None,
        }

        score.validate_schema(response, schema)


    def test_schema_rejects_effort_on_each_work_item(self):
        score = load("score")
        schema = json.loads((EVAL / "schema.json").read_text())
        response = {
        "id": "PM-REAL-038",
        "summary_ko": "세 작업에 총 280분이 남았다.",
        "work_items": [{
            "description_ko": "마스크 제작",
            "target": "subtask",
            "referenced_issue_url": None,
            "state": "in_progress",
            "modality": "asserted",
            "condition_ko": None,
            "assignee_login": None,
            "remaining_minutes": 280,
            "evidence_excerpt_indices": [0],
        }],
        "effort_mentions": [],
        "whole_thread_completion_reported": False,
        "release_state": "unknown",
        "relation": "none",
        "relation_target_url": None,
        "needs_clarification": False,
        "clarification_reason_ko": None,
        }

        with self.assertRaisesRegex(AssertionError, "extra keys"):
            score.validate_schema(response, schema)

    def test_conflicting_efforts_are_not_a_single_selected_estimate(self):
        score = load("score")

        self.assertTrue(score.has_no_single_selected_estimate([180, 60]))
        self.assertTrue(score.has_no_single_selected_estimate([]))
        self.assertFalse(score.has_no_single_selected_estimate([60]))


if __name__ == "__main__":
    unittest.main()
