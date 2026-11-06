"""Checks that catch training leakage and unsupported evidence; no private data."""
from copy import deepcopy
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dataset_tool import DatasetError, render_review, validate, vocabulary

VOCAB = [{"id": "python", "name": "Python"}]
DOCS = {"source_01": {"sha256": "a" * 64, "pdf_pages": 5}}


def example(number=1, split=None):
    return {
        "id": f"E{number}", "title": "Synthetic fixture",
        "source": {"source_id": "source_01", "sha256": "a" * 64, "pdf_page": number, "section": "Fixture"},
        "leakage_group_id": f"person-{number}", "split": split,
        "input": {"resume": f"개인 프로젝트 {number}에서 Python을 사용해 텍스트 정리 프로그램을 구현했다.", "targetPosting": ""},
        "expected": {"summary": "텍스트 정리 프로그램을 구현했다.", "skills": [{
            "skillId": "python", "level": "applied", "quote": "Python을 사용해 텍스트 정리 프로그램을 구현했다."
        }], "requirements": [], "questions": []},
        "review": {"source_checked": True, "labels": "reviewed", "privacy": "reviewed", "identity_groups": "reviewed"},
        "training_eligible": True, "rationale": "Fixture", "editing_notes": "Synthetic",
    }


class DatasetChecks(unittest.TestCase):
    def test_unreviewed_draft_can_be_checked_but_not_exported(self):
        row = example()
        row["review"]["labels"] = "draft"
        row["training_eligible"] = False
        self.assertEqual(validate([row], VOCAB, DOCS)["reviewed_for_training"], 0)
        with self.assertRaisesRegex(DatasetError, "must be reviewed"):
            validate([row], VOCAB, DOCS, for_export=True)

    def test_same_person_cannot_cross_splits(self):
        rows = [example(1, "train"), example(2, "test")]
        rows[1]["leakage_group_id"] = rows[0]["leakage_group_id"]
        with self.assertRaisesRegex(DatasetError, "identity group crosses"):
            validate(rows, VOCAB, DOCS)

    def test_duplicate_input_cannot_hide_behind_another_group(self):
        rows = [example(1, "train"), example(2, "test")]
        rows[1]["input"]["resume"] = rows[0]["input"]["resume"] + "\n "
        with self.assertRaisesRegex(DatasetError, "duplicate input crosses"):
            validate(rows, VOCAB, DOCS)

    def test_invented_quote_is_rejected(self):
        row = example()
        row["expected"]["skills"][0]["quote"] = "모델이 새로 만든 문장"
        with self.assertRaisesRegex(DatasetError, "quote not found"):
            validate([row], VOCAB, DOCS)

    def test_requirement_must_come_from_posting_not_resume(self):
        row = example()
        row["expected"]["requirements"] = [{"skillId": "python", "importance": "required", "quote": "Python을 사용해"}]
        with self.assertRaisesRegex(DatasetError, "quote not found"):
            validate([row], VOCAB, DOCS)

    def test_unknown_skill_is_rejected(self):
        row = example()
        row["expected"]["skills"][0]["skillId"] = "invented-skill"
        with self.assertRaisesRegex(DatasetError, "unknown/duplicate"):
            validate([row], VOCAB, DOCS)

    def test_source_hash_is_verified(self):
        row = example()
        row["source"]["sha256"] = "b" * 64
        with self.assertRaisesRegex(DatasetError, "hash mismatch"):
            validate([row], VOCAB, DOCS)

    def test_export_requires_all_splits_and_privacy_review(self):
        with self.assertRaisesRegex(DatasetError, "nonempty"):
            validate([example(1, "train")], VOCAB, DOCS, for_export=True)
        rows = [example(1, "train"), example(2, "valid"), example(3, "test")]
        self.assertEqual(validate(rows, VOCAB, DOCS, for_export=True)["reviewed_for_training"], 3)
        rows[1]["review"]["privacy"] = "pending"
        with self.assertRaisesRegex(DatasetError, "must be reviewed"):
            validate(rows, VOCAB, DOCS, for_export=True)

    def test_document_markdown_is_escaped(self):
        row = deepcopy(example())
        row["input"]["resume"] += " <script>alert(1)</script> [click](https://example.test)"
        rendered = render_review([row], {"records": 1, "provisional_groups": 1, "reviewed_for_training": 0}, VOCAB)
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("[click](", rendered)

    def test_app_catalog_is_loaded(self):
        ids = {v["id"] for v in vocabulary()}
        self.assertTrue({"python", "sql", "api", "git"}.issubset(ids))

    def test_export_cli_creates_private_chat_files_without_source_metadata(self):
        root = Path(__file__).resolve().parents[1]
        (root / "data").mkdir(exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".synthetic-export-test-", dir=root / "data") as tmp:
            tmp = Path(tmp)
            rows = [example(1, "train"), example(2, "valid"), example(3, "test")]
            annotations, audit, output = tmp / "input.jsonl", tmp / "audit.json", tmp / "output"
            annotations.write_text("".join(json.dumps(row) + "\n" for row in rows))
            audit.write_text(json.dumps({"documents": [{"source_id": "source_01", **DOCS["source_01"]}]}))
            command = [sys.executable, str(root / "scripts/dataset_tool.py"), "export", str(annotations), "--audit", str(audit), "--output", str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for split in ("train", "valid", "test"):
                file = output / f"{split}.jsonl"
                record = json.loads(file.read_text())
                self.assertEqual(set(record), {"messages"})
                self.assertEqual([m["role"] for m in record["messages"]], ["system", "user", "assistant"])
                self.assertNotIn("source", json.loads(record["messages"][1]["content"]))
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            before = (output / "manifest.json").read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual((output / "manifest.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
