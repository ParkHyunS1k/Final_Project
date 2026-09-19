import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "state_change_score", ROOT / "evals/github-timeline-state-change-2026-09-11/score.py")
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)


def change(kind, task_id, status=None):
    return {"kind": kind, "task_id": task_id, "status": status, "person": None, "remaining_hours": None,
            "due_at": None, "title": None, "basis": "fact", "evidence_excerpt_indices": [0]}


class StateChangeScoreTest(unittest.TestCase):
    def test_counts_matches_forbidden_hits_and_invalid_refs(self):
        label = {
            "expected_decision": "propose_changes",
            "expected_changes": [{"kind": "status", "task_id": "issue-7", "after": {"status": "in_progress"}}],
            "forbidden_changes": [{"task_id": "issue-7", "kind": "complete"}, {"task_id": "issue-6", "kind": "any"}],
        }
        response = {"decision": "propose_changes", "changes": [
            change("status", "issue-7", "todo"),
            change("complete", "issue-7"),
            change("assignee", "issue-99"),
        ]}
        result = score.score_case(label, response, {"issue-6", "issue-7"})
        self.assertTrue(result["decision_match"])
        self.assertEqual((result["expected"], result["predicted"], result["matched"]), (1, 3, 1))
        self.assertEqual(result["forbidden_hits"], 1)
        self.assertEqual(result["invalid_task_refs"], 1)
        self.assertEqual(result["status_value_mismatch"], 1)
        self.assertEqual((result["complete_tp"], result["complete_fp"], result["complete_fn"]), (0, 1, 0))
        self.assertFalse(result["noop_false_positive"])

    def test_change_on_no_change_label_is_false_positive(self):
        label = {"expected_decision": "no_change", "expected_changes": [], "forbidden_changes": []}
        response = {"decision": "propose_changes", "changes": [change("createTask", None)]}
        result = score.score_case(label, response, set())
        self.assertTrue(result["noop_false_positive"])
        self.assertEqual(result["invalid_task_refs"], 0)


if __name__ == "__main__":
    unittest.main()
