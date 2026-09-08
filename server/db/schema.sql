-- ProjectMate SQLite 스키마 (docs/tools.md 기준)
-- 연결마다 PRAGMA foreign_keys = ON 을 실행해야 한다. connection.connect()가 담당한다.

PRAGMA foreign_keys = ON;

CREATE TABLE project (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE document (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  doc_type       TEXT NOT NULL,              -- notice | plan | minutes | feedback
  title          TEXT,
  content        TEXT NOT NULL,              -- 항상 '텍스트'. 이미지/PDF는 전사 결과가 여기 들어간다
  uploaded_at    TEXT NOT NULL,
  -- 원본이 이미지·PDF였을 때 재현에 필요한 정보. 어떤 경로로 텍스트가 됐는지 남긴다.
  source_path    TEXT,
  extract_method TEXT,                       -- plain | pdf_text_layer | vlm
  extract_model  TEXT                        -- 'gemini:gemini-2.5-flash' 등
);

CREATE TABLE member (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  name                TEXT NOT NULL,
  role                TEXT,
  skills              TEXT,                  -- JSON array
  weekly_hours        REAL DEFAULT 10.0,
  UNIQUE(project_id, name)
);

CREATE TABLE milestone (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  title         TEXT NOT NULL,
  -- 일(日)까지 확정된 경우만 채운다. "2026년 10월 예정"처럼 미확정이면 NULL이고 원문은 date_hint에 남는다.
  -- 스케줄러는 date IS NULL인 마일스톤을 제약으로 쓰지 않는다.
  date          TEXT,                        -- ISO date | NULL
  date_hint     TEXT,                        -- 미확정 시 원문 조각 ('2026년 10월 예정')
  kind          TEXT NOT NULL,               -- 'anchor' | 'derived'
  event_type    TEXT,                        -- 'submission' | 'presentation' | 'checkpoint'
  locked        INTEGER NOT NULL DEFAULT 0,
  source_doc_id TEXT REFERENCES document(id)
);

CREATE TABLE project_meta (
  project_id    TEXT PRIMARY KEY REFERENCES project(id),
  deliverables  TEXT,                        -- JSON array
  constraints   TEXT,                        -- JSON object
  criteria      TEXT,                        -- JSON array
  source_doc_id TEXT REFERENCES document(id)
);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  milestone_id  TEXT REFERENCES milestone(id),
  title         TEXT NOT NULL,
  assignee_id   TEXT REFERENCES member(id),
  status        TEXT NOT NULL DEFAULT 'todo',  -- todo | in_progress | blocked | done
  deadline      TEXT,                          -- ISO date
  effort_hours  REAL,
  created_from  TEXT,                          -- 'user' | 'bootstrap' | 'minutes' | 'feedback'
  source_doc_id TEXT REFERENCES document(id)
);

CREATE TABLE task_dependency (
  task_id       TEXT NOT NULL REFERENCES task(id),
  depends_on_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE meeting (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  title         TEXT NOT NULL,
  start         TEXT NOT NULL,               -- ISO datetime
  duration_min  INTEGER NOT NULL DEFAULT 60,
  agenda        TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  created_from  TEXT                         -- 'user' | 'proactive'
);

CREATE TABLE meeting_attendee (
  meeting_id TEXT NOT NULL REFERENCES meeting(id),
  member_id  TEXT NOT NULL REFERENCES member(id),
  PRIMARY KEY (meeting_id, member_id)
);

CREATE TABLE busy_slot (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES member(id),
  weekday    INTEGER NOT NULL,               -- 0=월 ... 6=일
  start_min  INTEGER NOT NULL,               -- 자정 기준 분
  end_min    INTEGER NOT NULL,
  label      TEXT
);

-- 모델 호출 1회 = 1행. Tool을 부르지 않은 턴(clarify / no_tool / 파싱 실패)도 여기 남는다.
-- tool_call_log에는 '실행된 Tool'만 남으므로, 이 테이블이 없으면 No-Tool Accuracy와
-- Clarification P/R을 아예 복원할 수 없다(docs/eval.md 주 지표 4개 중 2개).
CREATE TABLE model_invocation (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  trace_id          TEXT NOT NULL,
  session_id        TEXT,
  step_index        INTEGER NOT NULL,
  mode              TEXT NOT NULL,           -- 'service' | 'eval'
  user_request      TEXT,
  raw_output        TEXT,                    -- 모델 원문. 재채점의 근거
  decision          TEXT,                    -- tool_calls | clarify | no_tool | parse_error
  parsed            TEXT,                    -- JSON envelope
  parse_error       TEXT,
  requested_model   TEXT,
  served_model      TEXT,                    -- 실제로 응답한 모델. 폴백이면 요청과 다르다
  model_revision    TEXT,
  prompt_version    TEXT,
  prompt_hash       TEXT,                    -- 프롬프트가 조용히 바뀌는 것을 잡는다
  toolset_version   TEXT,                    -- 'core5-dev-v1' 등. 노출한 Tool 집합
  generation_config TEXT,                    -- JSON (temperature, max_tokens, structured on/off)
  route             TEXT,                    -- local | api | fallback
  assigned_group    TEXT,
  finish_reason     TEXT,                    -- 잘린 출력(MAX_TOKENS)을 오답과 구분한다
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  latency_ms        INTEGER,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE action_proposal (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  invocation_id       TEXT REFERENCES model_invocation(id),
  trace_id            TEXT NOT NULL,
  step_index          INTEGER NOT NULL,
  user_request        TEXT,
  proposed_tool_name  TEXT NOT NULL,
  proposed_arguments  TEXT NOT NULL,         -- JSON — 모델 원본
  approved_arguments  TEXT,                  -- JSON — 사용자 확정본
  -- 'pending'이 없으면 승인 대기 중인 제안을 저장할 수 없다. CLI에서 y/n을 기다리는 동안,
  -- 그리고 웹에서 요청이 끊겼다 이어질 때 이 상태가 필요하다.
  decision            TEXT NOT NULL DEFAULT 'pending',
                                             -- pending | approved | edited | rejected | timeout
  model_id            TEXT,
  model_revision      TEXT,
  prompt_version      TEXT,
  toolset_version     TEXT,
  assigned_group      TEXT,
  route_reason        TEXT,
  created_at          TEXT NOT NULL,
  decided_at          TEXT
);

CREATE TABLE tool_call_log (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  proposal_id    TEXT REFERENCES action_proposal(id),
  invocation_id  TEXT REFERENCES model_invocation(id),
  trace_id       TEXT,
  session_id     TEXT,
  user_request   TEXT,
  tool_name      TEXT,
  arguments      TEXT,                       -- JSON
  result         TEXT,                       -- JSON
  ok             INTEGER,
  error_type     TEXT,
  latency_ms     INTEGER,
  model_id       TEXT,
  assigned_group TEXT,
  route          TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE meeting_suggestion (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id),
  trigger_type    TEXT NOT NULL,
  related_tasks   TEXT,                      -- JSON array
  suggested_start TEXT,
  agenda          TEXT,
  shown_at        TEXT NOT NULL,
  accepted_at     TEXT,
  rescheduled_at  TEXT,
  ignored_at      TEXT,
  rejected_at     TEXT,
  meeting_id      TEXT REFERENCES meeting(id)
);

-- 외래키 child 컬럼 인덱스
CREATE INDEX idx_member_project    ON member(project_id);
CREATE INDEX idx_milestone_project ON milestone(project_id);
CREATE INDEX idx_task_project      ON task(project_id);
CREATE INDEX idx_task_assignee     ON task(assignee_id);
CREATE INDEX idx_task_milestone    ON task(milestone_id);
CREATE INDEX idx_dep_depends_on    ON task_dependency(depends_on_id);
CREATE INDEX idx_meeting_project   ON meeting(project_id);
CREATE INDEX idx_attendee_member   ON meeting_attendee(member_id);
CREATE INDEX idx_busy_member       ON busy_slot(member_id);
CREATE INDEX idx_document_project  ON document(project_id);
CREATE INDEX idx_invocation_project ON model_invocation(project_id);
CREATE INDEX idx_invocation_trace   ON model_invocation(trace_id);
CREATE INDEX idx_proposal_project  ON action_proposal(project_id);
CREATE INDEX idx_proposal_invocation ON action_proposal(invocation_id);
CREATE INDEX idx_log_project       ON tool_call_log(project_id);
CREATE INDEX idx_log_proposal      ON tool_call_log(proposal_id);
CREATE INDEX idx_log_invocation    ON tool_call_log(invocation_id);
CREATE INDEX idx_suggestion_project ON meeting_suggestion(project_id);
CREATE INDEX idx_suggestion_meeting ON meeting_suggestion(meeting_id);
