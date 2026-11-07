"""Offline PDF intake. Extract existing text; never call a model or network service.

The output is a review queue, NOT a training dataset. Counts and regex flags are
triage signals, not OCR accuracy measurements or complete de-identification.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import re

from pypdf import PdfReader


PII_PATTERNS = {
    "email_candidate": re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
    "phone_candidate": re.compile(r"(?<!\d)(?:\+82[ -]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)"),
    "rrn_candidate": re.compile(r"(?<!\d)\d{6}\s*-\s*[1-4]\d{6}(?!\d)"),
}
IT_TERMS = ("Python", "파이썬", "Java", "개발", "SQL", "데이터", "API", "정보기술", "소프트웨어", "React")


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def audit(paths: list[Path], output: Path) -> dict:
    # Refuse to overwrite a previously reviewed intake.
    os.umask(0o077)
    resolved = [p.expanduser().resolve(strict=True) for p in paths]
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    summaries = []
    fingerprints: dict[str, list[dict]] = defaultdict(list)
    queue = []
    for number, source in enumerate(resolved, 1):
        source_id = f"source_{number:02d}"
        with source.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        reader = PdfReader(source)
        counts = Counter()
        char_count = 0
        with (output / f"{source_id}.pages.jsonl").open("x", encoding="utf-8") as handle:
            for pdf_page, page in enumerate(reader.pages, 1):
                extraction_error = None
                try:
                    text = page.extract_text() or ""
                except Exception as error:
                    # Do not log document contents or parser error payloads.
                    text = ""
                    extraction_error = type(error).__name__
                compact = re.sub(r"\s+", "", text)
                flags = []
                if len(compact) < 80:
                    flags.append("sparse_text_or_nontext_page")
                if "\ufffd" in text:
                    flags.append("replacement_characters")
                if extraction_error:
                    flags.append("extraction_failed")
                pii = {name: len(pattern.findall(text)) for name, pattern in PII_PATTERNS.items()}
                if any(pii.values()):
                    flags.append("possible_contact_or_identifier")
                counts.update(flags)
                char_count += len(text)
                location = {"source_id": source_id, "pdf_page": pdf_page}
                if len(compact) >= 80:
                    fingerprint = hashlib.sha256(compact.encode()).hexdigest()
                    fingerprints[fingerprint].append(location)
                hits = [term for term in IT_TERMS if term.casefold() in text.casefold()]
                if len(hits) >= 3:
                    queue.append({**location, "keyword_hits": hits, "reviewed": False})
                row = {
                    **location,
                    "source_sha256": digest,
                    "text": text,
                    "character_count": len(text),
                    "hangul_count": len(re.findall(r"[가-힣]", text)),
                    "flags": flags,
                    "pii_candidate_counts": pii,
                    "extraction_error": extraction_error,
                    "ocr_reviewed": False,
                    "deidentified": False,
                    "case_id": None,
                    "training_eligible": False,
                }
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        summaries.append({
            "source_id": source_id,
            "path": str(source),
            "sha256": digest,
            "pdf_pages": len(reader.pages),
            "character_count": char_count,
            "flagged_page_counts": dict(counts),
            "content_classification": "needs_review_not_inferred_from_filename",
        })
    report = {
        "stage": "intake_only_not_training_ready",
        "extraction": "existing_pdf_text_layer_pypdf",
        "network_calls": 0,
        "documents": summaries,
        "total_pdf_pages": sum(s["pdf_pages"] for s in summaries),
        "exact_text_duplicate_groups": [v for v in fingerprints.values() if len(v) > 1],
        "limitations": [
            "Character counts do not measure OCR accuracy; compare against page images.",
            "Regex flags miss names, addresses, student IDs, and OCR-damaged identifiers.",
            "PDF page numbers are one-based and may differ from printed page numbers.",
            "Case boundaries and related-person duplicates must be reviewed before splitting.",
        ],
    }
    write_json(output / "audit.json", report)
    write_json(output / "it-review-queue.json", queue)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New, git-ignored local data directory")
    args = parser.parse_args()
    report = audit(args.pdf, args.output)
    print(json.dumps({
        "stage": report["stage"],
        "total_pdf_pages": report["total_pdf_pages"],
        "documents": [
            {k: d[k] for k in ("source_id", "pdf_pages", "character_count", "flagged_page_counts")}
            for d in report["documents"]
        ],
        "exact_duplicate_groups": len(report["exact_text_duplicate_groups"]),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
