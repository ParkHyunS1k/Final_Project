# DB 이전: 로컬 SQLite → Postgres(Supabase·PGlite) 설계

작성일: 2026-10-03. 사용자와 대화로 합의했다. 이 문서는 **구현 전 설계 검토본**이며, 아래 기능이 이미 구현되었다는 뜻이 아니다.

기준 코드: `phs`, `4c5e74e`. 작업 브랜치 `postgres-migration`(PR #2와 섞지 않는다).

## 1. 배경과 범위

Vercel + Supabase 이전의 2단계다(1단계 Next.js 이전은 `2026-10-03-nextjs-migration-design.md`, 3단계는 Vercel 배포). 이유는 CareerFlow(Python)와 같은 사용자·데이터를 공유할 DB, 같은 로그인 권한의 파일 저장소다.

결정 사항:

- 운영 DB는 지금 로그인에 쓰는 Supabase 프로젝트의 Postgres. 로컬 개발·테스트는 **PGlite**(프로세스 안 Postgres).
- **Postgres 네이티브 타입**(timestamptz·boolean·jsonb)을 쓰고, **앱 코드도 `Date`·`boolean`·객체로 전환**한다(사용자 선택: 연결부에서 문자열로 되돌리는 방식이 아님).
- SQL은 Drizzle 쿼리 빌더로 다시 쓰지 않는다. 기존 문장을 유지하고 SQLite 전용 문법만 고친다.
- 기존 로컬 데이터는 이어받지 않는다(테스트 데이터).

범위 밖: Vercel 배포·Cron(3단계), Supabase Storage·CareerFlow 결합(이후), 쿼리 빌더 전환.

## 2. 스키마·마이그레이션·보안

- `db/schema.ts`: `sqliteTable` → `pgTable`(`drizzle-orm/pg-core`). 컬럼 이름은 그대로 둔다.
  - 시각 컬럼 전부(쓰지 않는 `sprint_proposals` 제외 31개) → `timestamp('…', { withTimezone: true, mode: 'date' })`(timestamptz).
  - 날짜 2개(`sprints.start_date`, `sprint_capacity.date`) → `date('…', { mode: 'string' })`. 앱에는 `'YYYY-MM-DD'` 문자열로 넘긴다. 드라이버가 date를 로컬 자정 `Date`로 바꾸면 하루가 밀린다. 두 컬럼 모두 이전 규칙 프로젝트에서만 쓰인다.
  - 참·거짓 7개(`sprints.joined`, `sprints.finished`, `sprint_tasks.optional`, `sprint_tasks.deferred`, `sprint_tasks.done`, `project_details.legacy`, `project_deliverables.confirmed`) → `boolean`, 기본값 `false`.
  - JSON 4개(`project_details.deliverables`, `ai_proposal_changes.before`, `ai_proposal_changes.after`, `ai_change_applications.entries`) → `jsonb`.
  - 실수 4개(`sprint_tasks.remaining`, `sprint_capacity.hours`, `sprint_checkins.remaining`, `project_policy.daily_hours`) → `double precision`.
  - 나머지 정수 → `integer`, 글자 → `text`. `bigint`·`numeric`은 쓰지 않는다(드라이버가 문자열로 돌려준다).
  - `''`를 날짜로 쓰던 `sprints.start_date`, `sprints.deadline`, `project_agreement.fixed_at`은 NULL 허용으로 바꾸고 NULL을 쓴다.
  - 읽거나 쓰는 코드가 없는 `sprint_proposals` 테이블은 만들지 않는다.
- `drizzle.config.ts`: `dialect: 'postgresql'`, 출력 디렉터리 `drizzle/`.
- 마이그레이션: SQLite `drizzle/0000~0009.sql`을 지우고 `drizzle-kit generate`로 Postgres 기준 파일 하나를 만든다. 그 파일 끝(같은 파일)에 모든 테이블의 `ALTER TABLE … ENABLE ROW LEVEL SECURITY;`를 붙인다. 정책은 만들지 않는다.
  - Supabase는 `public` 테이블을 anon 키(화면 번들에 공개)로 REST에 노출한다. RLS를 켜고 정책이 없으면 anon·authenticated 역할은 아무 행도 읽고 쓰지 못한다. 서버는 테이블 소유자(`postgres`) 역할로 접속하므로 RLS 영향을 받지 않고, 권한 검사는 지금처럼 서버 코드가 한다.
- `scripts/migrate.mjs`: `DATABASE_URL`이 있으면 postgres.js로 그 DB에, 없으면 PGlite `web/.data/pglite`에 적용한다. `_migrations(name text primary key, applied_at timestamptz not null)`로 파일마다 한 번만, 파일 하나를 트랜잭션 하나로. PGlite 파일이 이미 열려 있으면(개발 서버 실행 중) "개발 서버를 끄고 다시 실행" 안내와 함께 실패한다.
- SQLite 연결(`node:sqlite`)과 SQLite 대역은 모두 제거한다.

## 3. DB 연결(`lib/db.ts`)

- 포트 모양 유지: `prepare(sql).bind(...).first<T>()/all<T>()/run()`, `batch(statements)`. 돌려주는 값만 Postgres 값.
  - `run()` → `{ meta: { changes: 영향받은 행 수 } }`. `batch` 결과는 문장마다 `{ results, meta: { changes } }`.
- 드라이버
  - `DATABASE_URL` 있음 → `postgres`(postgres.js) `^3`. Supabase 연결 풀러(트랜잭션 모드)를 전제로 `prepare: false`, `max: 5`.
  - 없음 → `@electric-sql/pglite` `^0.5`. 개발 서버는 `DATABASE_PATH`(기본 `.data/pglite`) 파일, 테스트는 메모리.
  - 연결은 `globalThis`에 하나만 둔다(개발 서버 HMR).
- 자리 표시 변환: `?` → `$1, $2…`. 작은따옴표 문자열 안의 `?`는 바꾸지 않는다.
- 트랜잭션: `batch`는 한 트랜잭션(postgres.js `sql.begin`, PGlite `transaction`)에서 순서대로 실행한다. 실패하면 되돌리고 `DatabaseError`로 감싸 던진다. 모든 DB 오류(연결·초기화 포함)를 `DatabaseError('database error: …', { cause })`로 감싸 라우트가 503으로 숨기는 지금 계약을 유지한다.
- 돌려주는 값(두 드라이버를 같게 설정): timestamptz → `Date`, boolean → `boolean`, jsonb → 파싱된 값, date → `'YYYY-MM-DD'` 문자열, int8(`count(*)` 등) → `number`.
- 넘기는 값: `Date`·`boolean`·`number`·`string`·`null`은 그대로. **일반 객체와 배열은 연결부가 `JSON.stringify`해서 넘긴다**(배열이 Postgres 배열 값으로 가는 것을 막는다. 앱은 Postgres 배열 값을 쓰지 않는다).
- 동시성: READ COMMITTED에서 지금 CAS 방식(`UPDATE sprints SET revision=revision+1,mutation=? WHERE owner=? AND revision=?` → `changes` 확인 → 뒤따르는 쓰기는 `EXISTS(… mutation=?)` 조건)이 행 잠금으로 같은 결과를 낸다. 리마인더 `claimDue`는 트랜잭션 밖 SELECT 후 사용자별 UPDATE라 두 실행기가 한 수신자의 항목을 나눠 가질 수 있다(이중 확보는 없음). 지금 실행기는 하나라 이번에 바꾸지 않는다.

## 4. 앱 코드 전환

- 타입: 시각 필드(`Policy.startedAt/deadlineAt/completedAt`, `Task.dueAt`, `Member.agreedAt/joinedAt/leftAt`, 초대 `expiresAt`, 결과물 `fixedAt/evidenceAt/confirmedAt`, 리마인더 `dueAt/scheduledAt`, 문서 `capturedAt/createdAt`, 변경안 `createdAt/approvedAt` 등)를 `Date | null`(필수면 `Date`)로.
- 같은 시각 비교: `lib/time.ts`의 `sameInstant(a, b)`(Date·ISO 문자열·null을 밀리초로 비교)로 통일한다. 대상: `reminder-dispatch.ts`의 마감·업무 마감 비교, `route sprint`의 업무 마감 변경 판정, `change-proposals route`의 `dueChanged`, `change-proposals.ts`의 변경 전·후 값 비교(JSON 안 값은 ISO 문자열).
- `String(시각)`을 쓰던 곳은 `toISOString()` 또는 `Date` 그대로. 알림 `idempotencyKey`는 ISO 문자열로 만든다. 초대 만료 판정은 `getTime() <= Date.now()`.
- JSON: 읽을 때 `JSON.parse` 5곳 제거(이미 객체). 쓸 때 객체를 그대로 넘긴다.
- 참·거짓: 바인딩은 `true/false`, SQL 안 `0/1` 리터럴 4곳은 `true/false`.
- SQLite 전용 문법: `INSERT OR IGNORE` 6곳 → `INSERT … ON CONFLICT DO NOTHING`. 리마인더 `ON CONFLICT DO UPDATE`에 충돌 대상 `(project_id,kind,task_id,user_id,deadline_version,stage_minutes)`. `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 2곳 → `now()`.
- 이전 규칙 일정(`lib/sprint.ts`의 `start_date`·`deadline.slice`·`capacity.date`)은 날짜 문자열을 유지한다. `deadline`은 timestamptz이므로 읽은 뒤 이전과 같은 문자열 형태로 바꿔 넘긴다.
- 화면이 받는 응답: 시각은 JSON 직렬화로 ISO 문자열 그대로. 바뀌는 것은 `details.legacy`(1/0 → true/false), `details.deliverables`(문자열 → 배열). `components/project-workspace.tsx`의 `JSON.parse`와 타입을 고친다. 내보내기 JSON도 같은 모양으로 바뀐다.

## 5. 테스트

- 공용 헬퍼 `tests/helpers/pg-db.mjs`: 실제 `lib/db.ts`로 메모리 PGlite를 열고 마이그레이션을 적용한 뒤 `__BEFORE_WRITE` 훅(쓰기 직전 끼어들기)을 덧씌운 `Db`를 `globalThis.__TEST_DB`로 둔다. 원시 행 조회 `rows(sql, ...args)`도 제공한다. 7개 파일(api, apply-revert, auth, change-proposals, reminder-dispatch, reminder-consistency, save-guards)의 SQLite 대역을 이 헬퍼로 바꾼다. esbuild 플러그인의 `./db` 바꿔치기는 유지한다.
- SQLite 트리거(`RAISE(ABORT,'SQLITE …')`)로 503을 재현하던 2곳(api, save-guards)은 Postgres 트리거 함수(`RAISE EXCEPTION`)로 바꾼다.
- 원시 값 단언 6곳(시각 문자열 비교 4, `done: 1`·JSON 문자열 2)을 새 타입에 맞춘다. `count(*)` 단언은 int8→number 변환으로 그대로 둔다.
- `schema-migrations.test.mjs`: Postgres 기준으로 다시 쓴다(스키마와 마이그레이션 파일 일치, 이전 규칙 데이터 조회).
- `db.test.ts`(PGlite): 결과 모양, `?` 변환(따옴표 안 유지), batch 되돌림, batch 안 RETURNING, 외래키 위반, 배열 → jsonb 배열(Postgres 배열 아님), Date·boolean·int8·date 왕복, **모든 테이블 RLS 켜짐**, 마이그레이션 두 번 실행 시 한 번만 적용.
- `db-route.test.mjs`: 마이그레이션 없는 DB → 503, 로그에 `does not exist`. 열 수 없는 경로 → 503.

## 6. 검증

- 자동: `npm test`, `npx tsc --noEmit`, `npx oxlint`(새 오류 0), `npm run build`.
- 로컬(PGlite): `npm run db:migrate` → `npm run dev` → 시드 스크립트, Google 로그인 → 프로젝트 생성 → 새로고침, 초대 → 수락.
- Supabase(실제 Postgres): 사용자가 `web/.env.local`에 `DATABASE_URL`(연결 풀러, 트랜잭션 모드)을 넣는다 → `npm run db:migrate` → `npm run dev`로 시드·로그인·생성.
  - 동시성: 같은 프로젝트에 "시작" 요청 두 개를 동시에 → 하나 200, 하나 409(PGlite는 연결이 하나라 여기서만 확인).
  - REST 차단: anon 키로 `GET https://<ref>.supabase.co/rest/v1/sprints?select=*` 등 → 행이 나오지 않는다.
- 문서: `web/README.md`, `CLAUDE.md`(DB는 Postgres, 로컬은 PGlite), `docs/dev-team-seed-notes.md`, `web/.env.example`(`DATABASE_URL`, `DATABASE_PATH`).
