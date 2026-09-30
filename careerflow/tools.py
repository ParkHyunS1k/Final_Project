from __future__ import annotations

from datetime import date
from typing import Any, Callable

from .db import Database


READ_TOOLS = {
    "get_job_posting",
    "get_candidate_profile",
    "get_job_requirements",
    "get_application_tasks",
}


def _function(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
        "strict": True,
    }


REQUIREMENT_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "normalized_name": {"type": "string"},
        "category": {
            "type": "string",
            "enum": [
                "technical_skill", "tool_platform", "job_experience",
                "domain_knowledge", "soft_skill", "qualification", "language",
            ],
        },
        "importance": {
            "type": "string",
            "enum": ["required", "preferred", "responsibility", "unknown"],
        },
        "evidence": {"type": "string"},
    },
    "required": ["name", "normalized_name", "category", "importance", "evidence"],
    "additionalProperties": False,
}


TOOL_DEFINITIONS = [
    _function("save_job_posting_analysis", "새 채용공고와 원문에서 추출한 요구 역량을 한 번에 저장한다. 중복 공고는 기존 ID를 재사용한다.", {
        "company": {"type": "string"}, "position": {"type": "string"},
        "posting_text": {"type": "string"},
        "deadline": {"type": ["string", "null"], "description": "YYYY-MM-DD 또는 null"},
        "requirements": {"type": "array", "items": REQUIREMENT_ITEM_SCHEMA},
    }, ["company", "position", "posting_text", "deadline", "requirements"]),
    _function("update_job_posting", "기존 채용공고를 전체 값으로 수정하고 요구 역량을 교체한다. 먼저 get_job_posting으로 조회해야 한다.", {
        "job_id": {"type": "integer"},
        "company": {"type": "string"}, "position": {"type": "string"},
        "posting_text": {"type": "string"},
        "deadline": {"type": ["string", "null"], "description": "YYYY-MM-DD 또는 null"},
        "requirements": {"type": "array", "items": REQUIREMENT_ITEM_SCHEMA},
    }, ["job_id", "company", "position", "posting_text", "deadline", "requirements"]),
    _function("get_job_posting", "저장된 채용공고를 조회한다.", {
        "job_id": {"type": "integer"},
    }, ["job_id"]),
    _function("save_candidate_profile", "사용자 이름과 이력서 원문을 저장한다.", {
        "name": {"type": "string"}, "resume_text": {"type": "string"},
    }, ["name", "resume_text"]),
    _function("get_candidate_profile", "저장된 이력서를 조회한다.", {
        "candidate_id": {"type": "integer"},
    }, ["candidate_id"]),
    _function("get_job_requirements", "공고에서 추출해 저장한 요구 역량을 조회한다.", {
        "job_id": {"type": "integer"},
    }, ["job_id"]),
    _function("save_match_result", "모델이 이력서와 공고를 비교한 근거 기반 결과를 저장한다.", {
        "job_id": {"type": "integer"}, "candidate_id": {"type": "integer"},
        "matches": {"type": "array", "items": {"type": "object", "properties": {
            "requirement": {"type": "string"},
            "status": {"type": "string", "enum": ["matched", "partial", "not_found", "needs_clarification"]},
            "job_evidence": {"type": "string"}, "resume_evidence": {"type": ["string", "null"]},
            "explanation": {"type": "string"},
        }, "required": ["requirement", "status", "job_evidence", "resume_evidence", "explanation"], "additionalProperties": False}},
    }, ["job_id", "candidate_id", "matches"]),
    _function("create_application_tasks", "사용자가 승인한 지원 준비 작업들을 등록한다.", {
        "job_id": {"type": "integer"},
        "tasks": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "due_date": {"type": "string", "description": "YYYY-MM-DD"},
            "priority": {"type": "string", "enum": ["high", "medium", "low"]}, "reason": {"type": "string"},
        }, "required": ["title", "due_date", "priority", "reason"], "additionalProperties": False}},
    }, ["job_id", "tasks"]),
    _function("get_application_tasks", "공고에 등록된 지원 준비 작업을 조회한다.", {
        "job_id": {"type": "integer"},
    }, ["job_id"]),
]


class ToolRegistry:
    def __init__(self, database: Database) -> None:
        self.db = database
        self.handlers: dict[str, Callable[..., dict[str, Any]]] = {
            "save_job_posting": self.save_job_posting,
            "save_job_posting_analysis": self.save_job_posting_analysis,
            "update_job_posting": self.update_job_posting,
            "get_job_posting": self.get_job_posting,
            "save_candidate_profile": self.save_candidate_profile,
            "get_candidate_profile": self.get_candidate_profile,
            "save_job_requirements": self.save_job_requirements,
            "get_job_requirements": self.get_job_requirements,
            "save_match_result": self.save_match_result,
            "create_application_tasks": self.create_application_tasks,
            "get_application_tasks": self.get_application_tasks,
        }

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name not in self.handlers:
            return {"ok": False, "error": f"Unknown tool: {name}"}
        try:
            return self.handlers[name](**arguments)
        except (KeyError, ValueError, TypeError) as exc:
            return {"ok": False, "error": str(exc)}

    @staticmethod
    def _required_text(value: str, field: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError(f"{field}은(는) 비어 있을 수 없습니다.")
        return normalized

    @staticmethod
    def _normalized_identity(value: str) -> str:
        return " ".join(value.split()).casefold()

    @staticmethod
    def _normalized_posting(value: str) -> str:
        return " ".join(value.split())

    @staticmethod
    def _validated_deadline(deadline: str | None) -> str | None:
        if deadline is None or not deadline.strip():
            return None
        normalized = deadline.strip()
        date.fromisoformat(normalized)
        return normalized

    def _identity_matches(
        self, company: str, position: str, deadline: str | None, *, exclude_job_id: int | None = None
    ) -> list[dict[str, Any]]:
        candidates = self.db.fetch_all(
            "SELECT * FROM job_postings WHERE ((deadline IS NULL AND ? IS NULL) OR deadline = ?) ORDER BY id",
            (deadline, deadline),
        )
        return [
            item for item in candidates
            if item["id"] != exclude_job_id
            and self._normalized_identity(item["company"]) == self._normalized_identity(company)
            and self._normalized_identity(item["position"]) == self._normalized_identity(position)
        ]

    @staticmethod
    def _validate_requirements(posting_text: str, requirements: list[dict[str, Any]]) -> None:
        required_fields = {"name", "normalized_name", "category", "importance", "evidence"}
        for index, item in enumerate(requirements, start=1):
            missing = required_fields - item.keys()
            if missing:
                raise ValueError(f"{index}번 역량에 필드가 누락됐습니다: {', '.join(sorted(missing))}")
            if not item["evidence"] or item["evidence"] not in posting_text:
                raise ValueError(f"'{item['name']}'의 evidence를 공고 원문에서 찾을 수 없습니다.")

    @staticmethod
    def _insert_requirements(connection: Any, job_id: int, requirements: list[dict[str, Any]]) -> tuple[int, int]:
        saved = deduplicated = 0
        for item in requirements:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO job_requirements(job_id,name,normalized_name,category,importance,evidence) VALUES(?,?,?,?,?,?)",
                (job_id, item["name"].strip(), item["normalized_name"].strip(), item["category"], item["importance"], item["evidence"]),
            )
            if cursor.rowcount:
                saved += 1
            else:
                deduplicated += 1
        return saved, deduplicated

    def save_job_posting(self, company: str, position: str, posting_text: str, deadline: str | None = None) -> dict[str, Any]:
        company = self._required_text(company, "company")
        position = self._required_text(position, "position")
        posting_text = self._required_text(posting_text, "posting_text")
        deadline = self._validated_deadline(deadline)
        matches = self._identity_matches(company, position, deadline)
        for item in matches:
            if self._normalized_posting(item["posting_text"]) == self._normalized_posting(posting_text):
                return {"ok": True, "job_id": item["id"], "deduplicated": True}
        if matches:
            return {
                "ok": False,
                "error": "같은 회사·직무·마감일의 공고가 이미 있지만 내용이 다릅니다. update_job_posting으로 수정하세요.",
                "existing_job_id": matches[0]["id"],
            }
        job_id = self.db.execute(
            "INSERT INTO job_postings(company, position, posting_text, deadline) VALUES (?, ?, ?, ?)",
            (company, position, posting_text, deadline),
        )
        return {"ok": True, "job_id": job_id, "deduplicated": False}

    def save_job_posting_analysis(
        self, company: str, position: str, posting_text: str, deadline: str | None,
        requirements: list[dict[str, Any]],
    ) -> dict[str, Any]:
        posting_text = self._required_text(posting_text, "posting_text")
        self._validate_requirements(posting_text, requirements)
        job = self.save_job_posting(company, position, posting_text, deadline)
        if not job["ok"]:
            return job
        with self.db.session() as connection:
            saved, deduplicated = self._insert_requirements(connection, job["job_id"], requirements)
        return {
            **job,
            "requirements_saved": saved,
            "requirements_deduplicated": deduplicated,
        }

    def update_job_posting(
        self, job_id: int, company: str, position: str, posting_text: str,
        deadline: str | None, requirements: list[dict[str, Any]],
    ) -> dict[str, Any]:
        current = self.get_job_posting(job_id)["job_posting"]
        if not current:
            raise ValueError("존재하지 않는 채용공고입니다.")
        company = self._required_text(company, "company")
        position = self._required_text(position, "position")
        posting_text = self._required_text(posting_text, "posting_text")
        deadline = self._validated_deadline(deadline)
        self._validate_requirements(posting_text, requirements)
        collisions = self._identity_matches(company, position, deadline, exclude_job_id=job_id)
        if collisions:
            return {
                "ok": False,
                "error": "수정하려는 회사·직무·마감일의 다른 공고가 이미 있습니다.",
                "existing_job_id": collisions[0]["id"],
            }
        with self.db.session() as connection:
            connection.execute(
                "UPDATE job_postings SET company = ?, position = ?, posting_text = ?, deadline = ? WHERE id = ?",
                (company, position, posting_text, deadline, job_id),
            )
            requirements_deleted = connection.execute(
                "DELETE FROM job_requirements WHERE job_id = ?", (job_id,)
            ).rowcount
            matches_deleted = connection.execute(
                "DELETE FROM match_results WHERE job_id = ?", (job_id,)
            ).rowcount
            requirements_saved, _ = self._insert_requirements(connection, job_id, requirements)
            tasks_require_review = connection.execute(
                "SELECT COUNT(*) FROM application_tasks WHERE job_id = ?", (job_id,)
            ).fetchone()[0]
        return {
            "ok": True,
            "job_id": job_id,
            "requirements_saved": requirements_saved,
            "requirements_replaced": requirements_deleted,
            "match_results_deleted": matches_deleted,
            "tasks_require_review": tasks_require_review,
        }

    def get_job_posting(self, job_id: int) -> dict[str, Any]:
        item = self.db.fetch_one("SELECT * FROM job_postings WHERE id = ?", (job_id,))
        return {"ok": item is not None, "job_posting": item}

    def save_candidate_profile(self, name: str, resume_text: str) -> dict[str, Any]:
        candidate_id = self.db.execute(
            "INSERT INTO candidate_profiles(name, resume_text) VALUES (?, ?)", (name.strip(), resume_text.strip())
        )
        return {"ok": True, "candidate_id": candidate_id}

    def get_candidate_profile(self, candidate_id: int) -> dict[str, Any]:
        item = self.db.fetch_one("SELECT * FROM candidate_profiles WHERE id = ?", (candidate_id,))
        return {"ok": item is not None, "candidate_profile": item}

    def save_job_requirements(self, job_id: int, requirements: list[dict[str, Any]]) -> dict[str, Any]:
        posting = self.get_job_posting(job_id)["job_posting"]
        if not posting:
            raise ValueError("존재하지 않는 채용공고입니다.")
        saved, deduplicated, rejected = 0, 0, []
        for item in requirements:
            if item["evidence"] not in posting["posting_text"]:
                rejected.append({"name": item["name"], "reason": "원문에서 evidence를 찾을 수 없음"})
                continue
            try:
                existing = self.db.fetch_one(
                    "SELECT id FROM job_requirements WHERE job_id = ? AND normalized_name = ? AND importance = ? AND evidence = ?",
                    (job_id, item["normalized_name"], item["importance"], item["evidence"]),
                )
                if existing:
                    deduplicated += 1
                    continue
                self.db.execute(
                    "INSERT INTO job_requirements(job_id,name,normalized_name,category,importance,evidence) VALUES(?,?,?,?,?,?)",
                    (job_id, item["name"], item["normalized_name"], item["category"], item["importance"], item["evidence"]),
                )
                saved += 1
            except Exception as exc:
                rejected.append({"name": item["name"], "reason": str(exc)})
        return {"ok": not rejected, "saved_count": saved, "deduplicated_count": deduplicated, "rejected": rejected}

    def get_job_requirements(self, job_id: int) -> dict[str, Any]:
        items = self.db.fetch_all("SELECT * FROM job_requirements WHERE job_id = ? ORDER BY id", (job_id,))
        return {"ok": True, "requirements": items}

    def save_match_result(self, job_id: int, candidate_id: int, matches: list[dict[str, Any]]) -> dict[str, Any]:
        if not self.get_job_posting(job_id)["job_posting"]:
            raise ValueError("존재하지 않는 채용공고입니다.")
        if not self.get_candidate_profile(candidate_id)["candidate_profile"]:
            raise ValueError("존재하지 않는 이력서입니다.")
        for item in matches:
            self.db.execute(
                "INSERT INTO match_results(job_id,candidate_id,requirement,status,job_evidence,resume_evidence,explanation) VALUES(?,?,?,?,?,?,?)",
                (job_id, candidate_id, item["requirement"], item["status"], item["job_evidence"], item.get("resume_evidence"), item["explanation"]),
            )
        return {"ok": True, "saved_count": len(matches)}

    def create_application_tasks(self, job_id: int, tasks: list[dict[str, Any]]) -> dict[str, Any]:
        posting = self.get_job_posting(job_id)["job_posting"]
        if not posting:
            raise ValueError("존재하지 않는 채용공고입니다.")
        deadline = date.fromisoformat(posting["deadline"]) if posting["deadline"] else None
        task_ids = []
        for task in tasks:
            due_date = date.fromisoformat(task["due_date"])
            if deadline and due_date > deadline:
                raise ValueError(f"'{task['title']}'의 일정이 지원 마감일보다 늦습니다.")
            task_ids.append(self.db.execute(
                "INSERT INTO application_tasks(job_id,title,due_date,priority,reason) VALUES(?,?,?,?,?)",
                (job_id, task["title"], task["due_date"], task["priority"], task["reason"]),
            ))
        return {"ok": True, "task_ids": task_ids}

    def get_application_tasks(self, job_id: int) -> dict[str, Any]:
        items = self.db.fetch_all("SELECT * FROM application_tasks WHERE job_id = ? ORDER BY due_date, id", (job_id,))
        return {"ok": True, "tasks": items}
