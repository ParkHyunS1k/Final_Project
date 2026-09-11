"""테스트·데모용 시드 데이터.

가짜 시계 기준일: 2026-09-08 (화). 지연 업무 판정이 이 날짜에 맞춰져 있다.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
FIXED_NOW = datetime(2026, 9, 8, 9, 0, tzinfo=KST)

PROJECT_ID = "p_demo"
OTHER_PROJECT_ID = "p_other"


def seed_demo(conn: sqlite3.Connection) -> str:
    """데모 프로젝트 + 범위 검사용 별도 프로젝트를 만든다."""
    conn.executescript(
        """
        INSERT INTO project (id, title, created_at) VALUES
          ('p_demo',  'ProjectMate 캡스톤', '2026-09-01T00:00:00+09:00'),
          ('p_other', '남의 팀 프로젝트',   '2026-09-01T00:00:00+09:00');

        INSERT INTO member (id, project_id, name, role, skills, weekly_hours) VALUES
          ('m_hm', 'p_demo',  '김현민', 'backend',  '["fastapi","sqlite"]', 12.0),
          ('m_sk', 'p_demo',  '이성경', 'ml',       '["qlora","vllm"]',     10.0),
          ('m_jw', 'p_demo',  '박지원', 'frontend', '["nextjs"]',            8.0),
          ('m_jw2','p_demo',  '최지원', 'pm',       '["docs"]',              6.0),
          ('m_out','p_other', '남현민', 'backend',  '[]',                   10.0);

        INSERT INTO milestone (id, project_id, title, date, kind, event_type, locked) VALUES
          ('ms_sub', 'p_demo', '기획안 제출', '2026-09-25', 'anchor',  'submission', 1),
          ('ms_dev', 'p_demo', '1차 개발 완료', '2026-09-18', 'derived', 'checkpoint', 0),
          ('ms_out', 'p_other','남의 마일스톤', '2026-09-30', 'anchor',  'submission', 1);

        INSERT INTO task (id, project_id, milestone_id, title, assignee_id, status, deadline, effort_hours, created_from) VALUES
          ('t_api',  'p_demo', 'ms_dev', 'API 서버 구현',   'm_hm', 'in_progress', '2026-09-12', 15.0, 'user'),
          ('t_db',   'p_demo', 'ms_dev', 'DB 스키마 작성',  'm_hm', 'done',        '2026-09-05',  6.0, 'user'),
          ('t_eval', 'p_demo', 'ms_dev', '평가 하네스 작성','m_sk', 'todo',        '2026-09-04', 10.0, 'user'),
          ('t_ui',   'p_demo', NULL,     '확인 카드 UI',    'm_jw', 'todo',        NULL,          8.0, 'user'),
          ('t_doc',  'p_demo', 'ms_sub', '기획안 작성',     NULL,   'todo',        '2026-09-24',  4.0, 'user'),
          ('t_out',  'p_other','ms_out', '남의 업무',       'm_out','todo',        '2026-09-20',  3.0, 'user');

        INSERT INTO task_dependency (task_id, depends_on_id) VALUES
          ('t_api', 't_db'),
          ('t_ui',  't_api');
        """
    )
    conn.execute(
        "INSERT INTO project_meta (project_id, deliverables, constraints, criteria) VALUES (?, ?, ?, ?)",
        (
            PROJECT_ID,
            json.dumps(["PT 자료", "코딩 산출물"], ensure_ascii=False),
            json.dumps({"team_size_max": 4}, ensure_ascii=False),
            json.dumps(["창의성", "기술성"], ensure_ascii=False),
        ),
    )
    conn.commit()
    return PROJECT_ID
