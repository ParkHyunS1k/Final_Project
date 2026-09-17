> 기존 Python 엔진 참조 문서입니다. 2026-09-08부터 배포 웹 서비스의 API·저장 구조는 web/README.md 및 web/db/schema.ts를 기준으로 합니다. 아래 Core 12개 전체가 현재 서비스의 필수 구현 범위는 아닙니다.

# Tool 스키마 & DB 스키마

## 3-Tier 구조

| Tier | 개수 | 구현 | 용도 |
|---|---|---|---|
| **Tier 1 Core** | 12 | 실제 구현 + DB 조작 | 서비스 기능 전부 |
| **Tier 2 Confusion** | 8 | 구현하되 정답에 거의 안 쓰임 | 소형 모델의 Tool 혼동 측정 |
| **Tier 3 Distractor** | (선택) | 스키마만 | Retrieval 난이도 knob. MVP에서는 생략 |

> `assign_task` / `set_task_deadline` 같은 것은 **별도 Tool로 만들지 않는다.**
> `create_task` / `update_task`의 인자로 흡수한다. Tool을 쪼개면 모델만 어려워지고 측정되는 건 없다.

---

## Tier 1 — Core 12개

모든 날짜 인자는 **ISO 8601 (`YYYY-MM-DD`)**. 상대 표현("다음 주 금요일")은 프롬프트의 오늘 날짜 기준으로
모델이 정규화해서 넣는다. 정규화 실패는 Argument 오답으로 집계한다.

### 인자 규약 (모든 Tool 공통)

- **이름 → ID 변환은 Tool 실행 계층이 한다.** Tool은 `assignee`를 사람 이름 문자열로 받지만
  DB는 `assignee_id`를 저장한다. 변환 규칙:
  1. **현재 `project_id` 안에서만** 이름을 조회한다.
  2. 정확히 1명이면 ID로 변환한다.
  3. 0명이면 `NOT_FOUND` 반환 후 사용자에게 되묻는다. 임의로 생성하지 않는다.
  4. 2명 이상이면 `AMBIGUOUS` 반환 후 되묻는다.
- **`default`는 자동으로 채워지지 않는다.** JSON schema의 `default`는 문서용 annotation이다.
  `duration_min`, `top_k`, `include_done` 기본값은 Tool 실행 계층에서 명시적으로 적용한다.
- 모든 Tool schema에 `additionalProperties: false`를 넣는다. 숫자에는 `minimum`, 문자열·배열에는 길이 제한.
- 공통 오류 코드: `NOT_FOUND` / `AMBIGUOUS` / `INVALID_STATE` / `FORBIDDEN`.
- **전달받은 ID를 그대로 믿지 않는다.** 모든 조회·변경은 현재 `project_id` 범위로 제한한다.
  다른 프로젝트의 팀원·마일스톤·문서를 참조하면 `FORBIDDEN`.

### 업무 (5)

```json
{
  "name": "create_task",
  "description": "새 업무를 생성한다. 담당자와 마감일을 함께 지정할 수 있다. 일정(회의)이 아니라 '해야 할 일'을 만들 때 사용한다.",
  "parameters": {
    "type": "object",
    "properties": {
      "title":        {"type": "string", "description": "업무 이름"},
      "assignee":     {"type": "string", "description": "담당자 이름. 미정이면 생략"},
      "deadline":     {"type": "string", "format": "date", "description": "YYYY-MM-DD. 모르면 생략하고 사용자에게 되묻는다"},
      "effort_hours": {"type": "number", "description": "예상 소요 시간(시간 단위)"},
      "depends_on":   {"type": "array", "items": {"type": "string"}, "description": "선행 업무 id 목록"},
      "milestone_id": {"type": "string"}
    },
    "required": ["title"]
  }
}
```

```json
{
  "name": "update_task",
  "description": "기존 업무의 제목, 담당자, 마감일, 상태, 예상 공수를 수정한다. 업무를 '완료' 처리할 때는 complete_task를 쓴다.",
  "parameters": {
    "type": "object",
    "properties": {
      "task_id":      {"type": "string"},
      "title":        {"type": "string"},
      "assignee":     {"type": "string"},
      "deadline":     {"type": "string", "format": "date"},
      "status":       {"type": "string", "enum": ["todo", "in_progress", "blocked"]},
      "effort_hours": {"type": "number"}
    },
    "required": ["task_id"]
  }
}
```

```json
{
  "name": "complete_task",
  "description": "업무를 완료 상태로 바꾼다. 완료 외의 상태 변경은 update_task를 쓴다.",
  "parameters": {
    "type": "object",
    "properties": {"task_id": {"type": "string"}},
    "required": ["task_id"]
  }
}
```

```json
{
  "name": "search_tasks",
  "description": "조건으로 업무를 검색한다. 특정 팀원의 전체 업무 목록만 필요하면 get_member_tasks가 더 적합하다.",
  "parameters": {
    "type": "object",
    "properties": {
      "keyword":       {"type": "string"},
      "status":        {"type": "string", "enum": ["todo", "in_progress", "blocked", "done"]},
      "assignee":      {"type": "string"},
      "deadline_before": {"type": "string", "format": "date"},
      "delayed_only":  {"type": "boolean", "description": "마감일이 지났고 미완료인 업무만"}
    }
  }
}
```

```json
{
  "name": "get_member_tasks",
  "description": "특정 팀원에게 배정된 업무와 현재 업무량(총 예상 시간)을 반환한다.",
  "parameters": {
    "type": "object",
    "properties": {
      "member": {"type": "string"},
      "include_done": {"type": "boolean", "default": false}
    },
    "required": ["member"]
  }
}
```

### 일정 (4)

```json
{
  "name": "find_common_time",
  "description": "팀원들의 시간표에서 공통으로 비는 시간대를 찾아 후보를 반환한다. 회의를 실제로 생성하지는 않는다.",
  "parameters": {
    "type": "object",
    "properties": {
      "members":      {"type": "array", "items": {"type": "string"}, "description": "생략하면 전체 팀원"},
      "date_from":    {"type": "string", "format": "date"},
      "date_to":      {"type": "string", "format": "date"},
      "duration_min": {"type": "integer", "default": 60},
      "top_k":        {"type": "integer", "default": 3}
    },
    "required": ["date_from", "date_to"]
  }
}
```

```json
{
  "name": "create_meeting",
  "description": "회의를 실제로 생성한다. 시간이 확정된 뒤에만 호출한다. 가능한 시간을 찾기만 할 때는 find_common_time을 쓴다.",
  "parameters": {
    "type": "object",
    "properties": {
      "title":        {"type": "string"},
      "start":        {"type": "string", "format": "date-time"},
      "duration_min": {"type": "integer", "default": 60},
      "attendees":    {"type": "array", "items": {"type": "string"}},
      "agenda":       {"type": "string", "description": "한 줄 주제"}
    },
    "required": ["title", "start"]
  }
}
```

```json
{
  "name": "update_meeting",
  "description": "기존 회의의 시간, 참석자, 아젠다를 수정하거나 취소한다.",
  "parameters": {
    "type": "object",
    "properties": {
      "meeting_id": {"type": "string"},
      "start":      {"type": "string", "format": "date-time"},
      "attendees":  {"type": "array", "items": {"type": "string"}},
      "agenda":     {"type": "string"},
      "cancelled":  {"type": "boolean"}
    },
    "required": ["meeting_id"]
  }
}
```

```json
{
  "name": "get_member_schedule",
  "description": "팀원의 강의 시간표와 이미 잡힌 일정을 반환한다. 공통 가능 시간 계산은 find_common_time이 한다.",
  "parameters": {
    "type": "object",
    "properties": {
      "member":    {"type": "string"},
      "date_from": {"type": "string", "format": "date"},
      "date_to":   {"type": "string", "format": "date"}
    },
    "required": ["member"]
  }
}
```

### 프로젝트·팀·문서 (3)

```json
{
  "name": "get_team_members",
  "description": "팀원 목록과 각자의 역할, 기술 태그, 주간 가용시간을 반환한다.",
  "parameters": {"type": "object", "properties": {}}
}
```

```json
{
  "name": "get_project_status",
  "description": "프로젝트의 마일스톤(앵커/파생), 진행률, 지연 업무, 크리티컬 패스 요약을 반환한다.",
  "parameters": {
    "type": "object",
    "properties": {"include_critical_path": {"type": "boolean", "default": true}}
  }
}
```

```json
{
  "name": "search_documents",
  "description": "회의록, 교수 피드백, 계획서 등 업로드된 문서에서 의미 검색을 한다. 업무나 일정은 여기서 찾지 않는다.",
  "parameters": {
    "type": "object",
    "properties": {
      "query":    {"type": "string"},
      "doc_type": {"type": "string", "enum": ["notice", "plan", "minutes", "feedback"]},
      "top_k":    {"type": "integer", "default": 5}
    },
    "required": ["query"]
  }
}
```

---

## Tier 2 — Confusion Set 8개

**설계 원칙: 이름이 비슷한 게 아니라 "설명은 거의 같은데 전제조건 하나만 다른" 쌍을 만든다.**
`create_task` vs `create_schedule` 같은 건 너무 쉬워서 아무것도 측정하지 못한다.

| Tool | 혼동 대상 | 구분 기준 |
|---|---|---|
| `create_schedule` | `create_task` | 개인 일정(수업·알바) vs 프로젝트 업무 |
| `set_task_status` | `update_task`, `complete_task` | 상태만 바꾸는 하위 케이스 |
| `list_all_tasks` | `search_tasks` | 필터 없이 전체 |
| `get_task_detail` | `search_tasks` | id로 단건 조회 |
| `suggest_meeting_time` | `find_common_time` | 제안만, 시간표 미참조 |
| `send_notification` | `send_deadline_reminder` | 사람이 보냄 vs 시스템 자동 |
| `send_deadline_reminder` | `send_notification` | 마감 임박 전용 |
| `get_document` | `search_documents` | id로 원문 조회 vs 의미 검색 |

**측정 산출물: 쌍별 혼동 행렬(confusion matrix).** 이게 이 프로젝트에서 가장 인용 가치가 높은 그림이다.

### 정답이 둘인 문제 — canonical Tool 정책

`set_task_status`와 `update_task`, `list_all_tasks`와 `search_tasks`는 **둘 다 실제로 동작한다.**
이 상태로 Full Call Accuracy를 재면 "제품이 성공했는가"가 아니라 "우리가 문서에 적은 선호를 따랐는가"를
재게 된다. 혼동을 측정하려면 실제로 헷갈릴 만해야 하므로 쌍 자체는 유지하되, 다음을 지킨다.

1. **시스템 프롬프트에 canonical Tool 규칙을 명시한다.** 예: "상태만 바꿀 때도 `update_task`를 쓴다.
   `set_task_status`는 쓰지 않는다." 규칙이 프롬프트에 있어야 정답이 정의된다.
2. 보고를 두 줄로 나눈다.
   - **Policy Adherence** — canonical Tool을 골랐는가 (혼동 행렬의 근거)
   - **Functional Success** — 기능적으로 동치인 호출을 정답으로 허용했을 때의 성공률
3. 발표에서 두 수치를 섞지 않는다. 낮은 쪽만 인용해도 안 되고, 높은 쪽만 인용해도 안 된다.

---

## DB 스키마 (SQLite)

> **모든 연결 직후 `PRAGMA foreign_keys = ON;`을 실행한다.**
> SQLite는 외래키 검사가 연결마다 기본 비활성이다. 켜지 않으면 위의 `REFERENCES`가 전부 장식이 된다.
> 커넥션 풀을 쓰면 풀에서 커넥션을 꺼낼 때마다 실행해야 한다.
> 외래키 child 컬럼(`project_id`, `member_id`, `milestone_id` 등)에는 인덱스를 추가한다.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE project (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE member (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  name                TEXT NOT NULL,
  role                TEXT,                  -- 'frontend' | 'backend' | 'ml' | 'pm' ...
  skills              TEXT,                  -- JSON array
  weekly_hours        REAL DEFAULT 10.0,     -- 시간표에서 산출된 주간 가용시간
  UNIQUE(project_id, name)
);

CREATE TABLE milestone (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  title         TEXT NOT NULL,
  date          TEXT,                        -- ISO date | NULL (일까지 확정된 경우만)
  date_hint     TEXT,                        -- 미확정 시 원문 조각 ('2026년 10월 예정')
  kind          TEXT NOT NULL,               -- 'anchor' | 'derived'      ← 일정의 성격
  event_type    TEXT,                        -- 'submission' | 'presentation' | 'checkpoint'
  locked        INTEGER NOT NULL DEFAULT 0,  -- anchor는 항상 1
  source_doc_id TEXT REFERENCES document(id) -- 근거 문서
);
-- kind와 event_type은 다른 축이다. 한 필드에 섞으면 features.md와 충돌한다.
-- date는 NULL을 허용한다. 공고문에 "시상식: 2026년 10월 예정"처럼 일(日)이 없는 항목이 흔한데,
-- 버리면 정보가 사라지고 임의의 날짜를 채우면 앵커의 의미가 깨진다. NULL로 남기고 원문을
-- date_hint에 보관한 뒤 나중에 사용자에게 되묻는다.
--   · 스케줄러는 date IS NULL인 마일스톤을 제약으로 쓰지 않는다. 거기 붙은 업무는
--     날짜가 확정된 최종 앵커를 마감으로 대체한다.
--   · 확정 날짜가 하나도 없으면 SchedulerError. 조용히 넘어가지 않는다.

-- 공고문에서 추출했지만 마일스톤이 아닌 것들. 저장 위치가 없으면 추출해도 버려진다.
CREATE TABLE project_meta (
  project_id    TEXT PRIMARY KEY REFERENCES project(id),
  deliverables  TEXT,                        -- JSON array  ["PT 자료", "코딩 산출물"]
  constraints   TEXT,                        -- JSON object {"team_size_max": 4}
  criteria      TEXT,                        -- JSON array  ["창의성", "기술성"]
  source_doc_id TEXT REFERENCES document(id)
);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  milestone_id  TEXT REFERENCES milestone(id),
  title         TEXT NOT NULL,
  assignee_id   TEXT REFERENCES member(id),
  status        TEXT NOT NULL DEFAULT 'todo',  -- todo | in_progress | blocked | done
  deadline      TEXT,                          -- ISO date (파생: 스케줄러가 계산)
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

-- 시간표: 주간 반복 슬롯 (30분 단위 비트마스크로도 가능)
CREATE TABLE busy_slot (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES member(id),
  weekday    INTEGER NOT NULL,               -- 0=월 ... 6=일
  start_min  INTEGER NOT NULL,               -- 자정 기준 분
  end_min    INTEGER NOT NULL,
  label      TEXT                            -- '자료구조', '알바'
);

-- content는 항상 '텍스트'다. 이미지·PDF로 올라온 공고문은 Stage 0 전사 결과가 여기 들어간다.
-- 전사 텍스트를 남겨야 (1) 추출이 틀렸을 때 사용자가 고쳐서 다시 돌릴 수 있고,
-- (2) 평가 때 매번 VLM을 다시 부르지 않고 고정된 입력으로 비교할 수 있다.
CREATE TABLE document (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  doc_type       TEXT NOT NULL,              -- notice | plan | minutes | feedback
  title          TEXT,
  content        TEXT NOT NULL,              -- 텍스트 (이미지·PDF면 전사 결과)
  uploaded_at    TEXT NOT NULL,
  source_path    TEXT,                       -- 원본 파일 경로
  extract_method TEXT,                       -- plain | pdf_text_layer | vlm
  extract_model  TEXT                        -- 'gemini:gemini-2.5-flash' 등. NULL이면 전사 안 함
);

-- 모델 호출 1회 = 1행. **Tool을 부르지 않은 턴도 남는다.**
-- tool_call_log에는 실행된 Tool만, action_proposal에는 변경 Tool만 남는다. 그래서 clarify /
-- no_tool / 파싱 실패 / 잘린 출력 / latency / token은 두 테이블 어디에도 없다.
-- 주 지표 4개 중 No-Tool Accuracy와 Clarification P/R이 그 위에 있으므로 이 테이블이 필요하다.
CREATE TABLE model_invocation (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  trace_id          TEXT NOT NULL,             -- 한 요청의 여러 단계를 묶는 키
  session_id        TEXT,
  step_index        INTEGER NOT NULL,
  mode              TEXT NOT NULL,             -- 'service' | 'eval'
  user_request      TEXT,
  raw_output        TEXT,                      -- 모델 원문. 재채점의 근거
  decision          TEXT,                      -- tool_calls | clarify | no_tool | parse_error
  parsed            TEXT,                      -- JSON envelope
  parse_error       TEXT,
  requested_model   TEXT,
  served_model      TEXT,                      -- 폴백이면 요청과 다르다
  model_revision    TEXT,
  prompt_version    TEXT,
  prompt_hash       TEXT,                      -- 프롬프트가 조용히 바뀌는 것을 잡는다
  toolset_version   TEXT,                      -- 'core5-dev-v1' 등. 노출한 Tool 집합
  generation_config TEXT,                      -- JSON (temperature, max_tokens, structured on/off)
  route             TEXT,                      -- local | api | fallback
  assigned_group    TEXT,
  finish_reason     TEXT,                      -- 잘린 출력(MAX_TOKENS)을 오답과 구분한다
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  latency_ms        INTEGER,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

-- 승인 전 '제안'을 남긴다. 거절된 제안은 실행되지 않으므로 tool_call_log에 행이 생기지 않는다.
-- 원본 인자와 사용자가 고친 인자를 함께 저장해야 "수정 로그 = 재학습 데이터"가 성립한다.
CREATE TABLE action_proposal (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  invocation_id       TEXT REFERENCES model_invocation(id),
  trace_id            TEXT NOT NULL,              -- 한 요청의 여러 단계를 묶는 키
  step_index          INTEGER NOT NULL,
  user_request        TEXT,
  proposed_tool_name  TEXT NOT NULL,
  proposed_arguments  TEXT NOT NULL,              -- JSON — 모델이 낸 원본
  approved_arguments  TEXT,                       -- JSON — 사용자가 확정한 값 (edited면 다름)
  -- 'pending'이 없으면 승인 대기 중인 제안을 저장할 수 없다. CLI가 y/n을 기다리는 동안,
  -- 그리고 웹에서 요청이 끊겼다 이어질 때 이 상태가 필요하다.
  decision            TEXT NOT NULL DEFAULT 'pending',
                                                  -- pending | approved | edited | rejected | timeout
  model_id            TEXT,
  model_revision      TEXT,
  prompt_version      TEXT,
  toolset_version     TEXT,
  assigned_group      TEXT,                       -- A/B. 라우팅 전에 정해진 값
  route_reason        TEXT,                       -- 'local' | 'api_difficulty' | 'api_fallback'
  created_at          TEXT NOT NULL,
  decided_at          TEXT
);

-- 실제로 실행된 호출. 조회 Tool은 승인 없이 바로 여기에 기록된다.
CREATE TABLE tool_call_log (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  proposal_id    TEXT REFERENCES action_proposal(id),  -- 변경 Tool이면 필수, 조회면 NULL
  invocation_id  TEXT REFERENCES model_invocation(id), -- 이 실행을 낳은 모델 호출
  trace_id       TEXT,
  session_id     TEXT,
  user_request   TEXT,
  tool_name      TEXT,
  arguments      TEXT,                       -- JSON — 실제 실행된 인자
  result         TEXT,                       -- JSON
  ok             INTEGER,
  error_type     TEXT,                       -- NOT_FOUND | AMBIGUOUS | INVALID_STATE | FORBIDDEN
  latency_ms     INTEGER,
  model_id       TEXT,                       -- 'qwen3-8b-base' | 'qwen3-8b-sft-v2' | 'api'
  assigned_group TEXT,
  route          TEXT,                       -- 'local' | 'api' | 'fallback'
  created_at     TEXT NOT NULL
);

-- 능동 회의 제안. 이게 없으면 주 1회 상한도, 7일 쿨다운도, 트리거별 수락률도 구현·측정 불가.
CREATE TABLE meeting_suggestion (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  trigger_type   TEXT NOT NULL,              -- milestone_within | blocking_task_delayed | ...
  related_tasks  TEXT,                       -- JSON array of task id
  suggested_start TEXT,                      -- ISO datetime
  agenda         TEXT,
  shown_at       TEXT NOT NULL,              -- 쿨다운·주1회 상한 판정 기준
  accepted_at    TEXT,
  rescheduled_at TEXT,                       -- '다른 시간' 선택
  ignored_at     TEXT,
  rejected_at    TEXT,
  meeting_id     TEXT REFERENCES meeting(id) -- 실제로 생성된 회의
);
```

### 왜 테이블을 셋으로 나눴는가

이전 스키마는 `tool_call_log` 하나에 `user_edited` / `user_rejected` 컬럼을 두었는데, 두 가지가 깨진다.

1. **거절된 제안은 실행되지 않으므로 행 자체가 없다.** 거절 신호를 잃는다.
2. **`arguments` 컬럼이 하나뿐이라 "모델이 낸 값"과 "사용자가 고친 값"을 같이 담을 수 없다.**
   수정 로그를 재학습 데이터로 쓰겠다는 계획의 전제가 무너진다.

`action_proposal.proposed_arguments`와 `approved_arguments`의 **차이**가 재학습 신호다.

### 수정 신호를 정답으로 쓸 때의 주의

사용자가 값을 고쳤다는 사실만으로 원래 출력이 오답인 것은 아니다(마음이 바뀐 경우도 있다).
거절도 오답 라벨이 아니다. 비교적 신뢰할 만한 신호는 다음 조합이다.

- `decision = 'edited'` **이고** 실행이 성공했고 **이후 다시 수정·취소되지 않은** 경우 → `approved_arguments`를 정답으로
- `decision = 'approved'` → 원본을 정답으로
- `decision = 'rejected'` → 정답 라벨이 아니라 **실패 유형 분석용**으로만

**학습에 쓰기 전에 팀원 동의를 받고, 이름·문서 내용을 비식별화하고, 데이터 cutoff를 정한다.**
`shown_at` 기준으로 cutoff 이후 로그는 그 학습 라운드에 넣지 않는다.
