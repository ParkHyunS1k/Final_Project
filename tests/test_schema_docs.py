"""docs/tools.md의 DB 스키마와 server/db/schema.sql이 일치하는지 검사한다.

문서-코드 불일치가 두 번 났다(document 3컬럼, milestone.date nullable). 스키마를 고치면서
문서를 안 고치면 여기서 깨진다. 문서가 곧 설계 근거이므로 코드만 고치고 넘어가지 않는다.

비교 대상은 CREATE TABLE의 컬럼 정의뿐이다. CREATE INDEX는 문서에 산문으로만 있어서 뺐다.
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SCHEMA_SQL = ROOT / "server" / "db" / "schema.sql"
TOOLS_DOC = ROOT / "docs" / "tools.md"

_CREATE_TABLE = re.compile(r"CREATE TABLE (\w+) \((.*?)\n\);", re.S)
_SQL_BLOCK = re.compile(r"```sql\n(.*?)```", re.S)


def parse_tables(sql: str) -> dict[str, dict[str, str]]:
    """{테이블: {컬럼: 정규화된 정의}}. 주석과 공백 차이는 무시한다."""
    tables: dict[str, dict[str, str]] = {}
    for match in _CREATE_TABLE.finditer(sql):
        columns: dict[str, str] = {}
        for raw in match.group(2).splitlines():
            line = raw.strip()
            if not line or line.startswith("--"):
                continue
            definition = " ".join(line.split("--")[0].strip().rstrip(",").split())
            if not definition:
                continue
            columns[definition.split()[0]] = definition
        tables[match.group(1)] = columns
    return tables


class TestSchemaMatchesDocs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.code = parse_tables(SCHEMA_SQL.read_text(encoding="utf-8"))
        doc_sql = "\n".join(_SQL_BLOCK.findall(TOOLS_DOC.read_text(encoding="utf-8")))
        cls.doc = parse_tables(doc_sql)

    def test_parsed_something(self):
        # 정규식이 조용히 0개를 반환하면 이 테스트 전체가 무의미해진다
        self.assertGreaterEqual(len(self.code), 10, "schema.sql 파싱 실패")
        self.assertGreaterEqual(len(self.doc), 10, "docs/tools.md의 SQL 블록 파싱 실패")

    def test_same_tables(self):
        only_code = sorted(set(self.code) - set(self.doc))
        only_doc = sorted(set(self.doc) - set(self.code))
        self.assertEqual(only_code, [], f"문서에 없는 테이블: {only_code} → docs/tools.md에 추가")
        self.assertEqual(only_doc, [], f"코드에 없는 테이블: {only_doc} → schema.sql에 추가")

    def test_same_columns(self):
        problems: list[str] = []
        for table in sorted(set(self.code) & set(self.doc)):
            code_cols, doc_cols = self.code[table], self.doc[table]
            for column in sorted(set(code_cols) | set(doc_cols)):
                in_code, in_doc = code_cols.get(column), doc_cols.get(column)
                if in_code == in_doc:
                    continue
                if in_doc is None:
                    problems.append(f"{table}.{column}: 문서에 없음 (코드: {in_code})")
                elif in_code is None:
                    problems.append(f"{table}.{column}: 코드에 없음 (문서: {in_doc})")
                else:
                    problems.append(f"{table}.{column}:\n    코드: {in_code}\n    문서: {in_doc}")
        self.assertEqual(problems, [], "docs/tools.md와 schema.sql 불일치:\n" + "\n".join(problems))

    def test_schema_actually_runs(self):
        from server.db.connection import fresh_db

        conn = fresh_db()
        try:
            names = {
                r["name"]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            self.assertEqual(set(self.code) - names, set(), "schema.sql에 있는데 생성되지 않은 테이블")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
