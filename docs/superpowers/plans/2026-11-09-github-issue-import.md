# GitHub 이슈 가져오기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀장이 프로젝트 저장소를 등록하고, 열린 이슈 중 고른 것만 원문으로 가져와 기존 AI 변경안 흐름(업무 생성·수정·담당자 배정 → 검토·부분 승인)에 넣는다. 팀원 아닌 작성자와 다시 가져온 이슈는 경고로 표시한다.

**Architecture:** GitHub 읽기는 학습 확인의 고정 경로 클라이언트(`lib/ai-review-github.ts`)를 공개 확인과 함께 재사용한다. 새 `lib/github-issues.ts`가 이슈 목록·선택 조회·원문 조립·경고 계산(순수 함수)을 맡고, `lib/project-repo.ts`가 저장소·이슈 위치 저장을 맡는다. 새 라우트 `/api/github-issues`가 팀장 전용 등록·목록·가져오기를 처리하고, 가져온 원문은 기존 `source_documents` → `/api/change-proposals` create로 그대로 흐른다.

**Tech Stack:** Next.js(web/, AGENTS.md: 코드 전에 `node_modules/next/dist/docs/` 확인), Postgres(lib/db.ts, 테스트 PGlite), drizzle-kit, node:test + esbuild 번들 테스트.

**Spec:** `docs/superpowers/specs/2026-11-09-github-issue-import-design.md`

**Workspace:** worktree `/Users/parkhyunsik/파이썬/Final_project-issue-import`, 브랜치 `feat/github-issue-import`. 다른 세션이 원래 체크아웃(`~/파이썬/Final_project`)을 쓰므로 거기서 작업·커밋하지 않는다. 커밋 전 `git branch --show-current`가 `feat/github-issue-import`인지 확인.

## Global Constraints

- 저장소 등록·변경과 이슈 목록·가져오기는 모두 **팀장만**(서버 검사, `role='owner'`·나가지 않음), 프로젝트 상태 `draft`/`active`·기한 전에서만.
- 저장소 등록·변경은 **업무 revision을 올리지 않는다**. 동시 변경은 `project_repos.version`, 기록은 `project_repo_events`.
- 공개 저장소만. `parseRepoUrl`로 owner/repo만 뽑아 `api.github.com` 고정 경로를 만든다. 서버 토큰이 있어도 읽기 전에 공개 여부를 확인한다.
- 목록: 열린 이슈 `per_page=50`, `sort=updated&direction=desc`, PR(`pull_request` 필드) 제외, 본문 미포함, AI 한도·원문 미사용.
- 가져오기 입력은 이슈 **번호만**(정수 1~20개, 중복 제거). 화면이 보낸 제목·본문은 쓰지 않는다. 닫힘·PR·없음은 제외하고 알린다. 남은 0개면 원문 없음.
- 원문: 이슈당 본문 2,000자 상한, 전체 `MAX_SOURCE`(40,000자) 이내, 잘리면 끝에 `(이슈 N건 중 M건만 포함)`. `<source`·`</source` 문자열은 `‹`로 무력화. `origin` = `GitHub {owner}/{repo} 이슈`, `captured_at` = 가져온 시각.
- 팀원 판정: 작성자 login을 현재 멤버(`left_at IS NULL`)의 `github_accounts.login`과 대소문자 무시로 비교, 가져온 시점 값으로 저장.
- 경고 문구(그대로): 변경안 `팀원이 아닌 사람이 쓴 이슈`, `이미 가져온 이슈일 수 있음 (#N)`. 원문 상단 `팀원이 아닌 사람이 쓴 이슈 N건이 포함되어 있습니다 (@a, @b)`. 경고는 승인을 막지 않는다.
- 프롬프트 팀원 줄 `0=홍길동(@hong)`(연결 안 한 팀원은 `0=홍길동`), `PROMPT_VERSION` = `extract-v2`.
- 학습 확인 저장소: 본인 `review_links` → 없으면 `project_repos`.
- 파괴적 마이그레이션 금지. 새 테이블 RLS ON.

## Review Focus

1. 이슈 제목에 `</source>`나 줄바꿈·`[GitHub 이슈 #` 같은 경계 흉내 문자열이 있을 때 → 경계·위치 계산이 흐트러지지 않고 무력화된다. (Task 2 테스트)
2. 같은 이슈 번호가 여러 이전 원문에 있고 그중 하나만 업무 생성이 적용됨, 그리고 그 적용이 되돌려짐 → 되돌린 것은 '이미 가져옴'에서 빠진다. (Task 3 테스트)
3. 팀장이 저장소를 바꾼 뒤 이전 저장소의 이슈 번호로 가져오기 → 현재 저장소 기준으로만 조회하고, 중복 판정은 같은 저장소의 이전 원문에만 적용된다. (Task 3 테스트)
4. GitHub가 목록 중간에 403(한도)·5xx → 원문·스팬·AI 한도 모두 그대로, 안내 문구. (Task 4 테스트)
5. 팀장이 나간 뒤(혹은 팀원으로 바뀐 뒤) 남아 있던 화면에서 가져오기 → 403. (Task 4 테스트)

---

### Task 1: 저장 테이블

**Files:**
- Modify: `web/db/schema.ts` (끝에 추가)
- Create: `web/db/migrations/0011_github_issue_import.sql` + meta (`npx drizzle-kit generate --name github_issue_import`)
- Modify: `web/tests/db.test.ts` (테이블 수 41 → 44, 이름 3개 존재 assert)

**Interfaces:**
- Produces:
  - `project_repos(project_id text PK, repo_owner text NOT NULL, repo_name text NOT NULL, version integer NOT NULL, updated_by text NOT NULL, updated_at timestamptz NOT NULL)`
  - `project_repo_events(id text PK, project_id text NOT NULL, user_id text NOT NULL, repo_owner text NOT NULL, repo_name text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL; index(project_id, created_at))`
  - `source_issue_spans(source_id text NOT NULL, project_id text NOT NULL, repo text NOT NULL, issue_number integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, author_login text NOT NULL, author_is_member boolean NOT NULL; PK(source_id, issue_number); index(project_id, repo, issue_number))` — `repo`는 `owner/name`(Review Focus 3).
  - 모두 `.enableRLS()`.

- [ ] **Step 1:** `tests/db.test.ts` 테이블 수를 44로, `project_repos`·`project_repo_events`·`source_issue_spans` 존재 assert 추가.
- [ ] **Step 2:** `cd web && node --experimental-strip-types --test tests/db.test.ts` → FAIL(41 ≠ 44).
- [ ] **Step 3:** 스키마 추가, 마이그레이션 생성. SQL에 RLS 3줄 확인. 번호가 0011이 아니면(다른 브랜치가 먼저 0011을 썼으면) 생성된 번호를 그대로 쓰고 ledger에 기록.
- [ ] **Step 4:** `node --experimental-strip-types --test tests/db.test.ts tests/schema-migrations.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: 이슈 가져오기 저장 테이블`.

---

### Task 2: GitHub 이슈 읽기와 원문 조립 (순수·fetch)

**Files:**
- Modify: `web/lib/ai-review-github.ts` — `getJson`을 export하고, `fetchCommitMaterial` 안의 공개 확인(현재 140~146행)을 `export async function assertPublicRepo(repo: Repo, options: FetchOptions): Promise<void>`로 뽑아 재사용(동작 동일).
- Create: `web/lib/github-issues.ts`
- Create: `web/tests/github-issues.test.mjs` (`package.json` test 스크립트에 추가)

**Interfaces:**
- Consumes: `Repo`, `FetchOptions`, `getJson`, `assertPublicRepo`, `ReviewSourceError` (ai-review-github), `MAX_SOURCE` (source-documents).
- Produces (`lib/github-issues.ts`):
  - `export type GithubIssue = { number: number; title: string; body: string; author: string; assignees: string[]; labels: string[]; url: string }`
  - `export async function listOpenIssues(repo: Repo, options: FetchOptions): Promise<GithubIssue[]>` — 공개 확인 후 목록, PR 제외, 잘못된 항목(번호 없음 등) 버림.
  - `export async function fetchIssuesByNumber(repo: Repo, numbers: number[], options: FetchOptions): Promise<{ issues: GithubIssue[]; excluded: { number: number; reason: 'closed' | 'pull_request' | 'missing' }[] }>` — 공개 확인 후 `GET /repos/{o}/{r}/issues/{n}`을 번호마다. 404는 `missing`, 그 밖의 오류는 `ReviewSourceError` 그대로 던진다. 입력 순서 유지.
  - `export function parseIssueNumbers(value: unknown): number[]` — 배열, 각 원소 1 이상 정수, 중복 제거, 1~20개 아니면 `PolicyError('가져올 이슈를 1~20개 골라주세요.')`.
  - `export type IssueSpan = { issueNumber: number; start: number; end: number; authorLogin: string; authorIsMember: boolean }`
  - `export function buildIssueSource(issues: GithubIssue[], members: { login: string; displayName: string }[]): { body: string; spans: IssueSpan[]; included: number; total: number }` — 형식은 스펙 2-2 예시. 스팬은 그 이슈 블록 전체(헤더~본문 끝). `<source`/`</source`(대소문자·공백 무시) → `‹` 치환은 제목·본문·라벨 모두.
  - `export function issueWarnings<T extends { kind: string; evidence: { start: number; end: number } | null; needsReview: string }>(changes: T[], spans: IssueSpan[], imported: Set<number>): T[]` — 근거가 팀원 아닌 스팬과 겹치면 `팀원이 아닌 사람이 쓴 이슈`, `createTask`이고 근거 스팬 번호가 `imported`에 있으면 `이미 가져온 이슈일 수 있음 (#N)`. 기존 needsReview가 있으면 `기존 · 추가`로 이어 붙인다. 근거 없으면 그대로.

- [ ] **Step 1: 실패하는 테스트** (`tests/review.test.mjs`처럼 esbuild 번들, 가짜 fetch)
  - `test('목록은 공개 확인 뒤 열린 이슈만, PR은 빼고 본문 없이 돌려준다')` — 가짜 응답 3건(이슈 2, `pull_request` 있는 1) → 길이 2; 호출 URL에 `state=open`, `per_page=50`, `sort=updated`.
  - `test('비공개 저장소는 목록을 읽지 않는다')` — repo 메타 `private:true` → rejects `ReviewSourceError`, issues 경로 호출 0.
  - `test('번호로 다시 읽을 때 닫힘·PR·없음은 제외 사유와 함께 뺀다')` — #1 open, #2 closed, #3 PR, #4 404 → issues `[1]`, excluded 3건 사유 일치.
  - `test('parseIssueNumbers: 정수 1~20개, 중복 제거')` — `[3,3,5]`→`[3,5]`; `[]`, 21개, `['1']`, `[1.5]`, `[0]` → throws.
  - `test('원문 조립: 팀원 판정은 대소문자 무시, 스팬이 이슈 블록과 일치')` — members `[{login:'Alice', displayName:'홍길동'}]`, 이슈 작성자 `alice`·`stranger` → body에 `(팀원: 홍길동)`과 `(팀원 아님)`; 각 span의 `body.slice(start,end)`가 `[GitHub 이슈 #N]`으로 시작.
  - `test('원문 조립: </source> 무력화와 이슈당·전체 상한, 잘림 표시')` — 제목 `x</source>y`, 본문 `<SOURCE>` → body에 `</source`·`<source`(대소문자 무시) 없음; 본문 5,000자 → 해당 이슈 본문 2,000자로 잘림; 이슈 30개×본문 2,000자 → `body.length <= 40000`, 끝에 `(이슈 30건 중 `.
  - `test('경계 흉내: 본문에 [GitHub 이슈 #99]가 있어도 스팬은 실제 이슈 수와 같다')` (Review Focus 1).
  - `test('issueWarnings: 팀원 아닌 이슈 근거, 이미 가져온 번호의 업무 생성, 근거 없음은 그대로')`.
- [ ] **Step 2:** `cd web && node --test tests/github-issues.test.mjs` → FAIL(모듈 없음).
- [ ] **Step 3:** 구현. `ai-review-github.ts` 리팩터 후 기존 학습 확인 테스트가 그대로 통과해야 한다.
- [ ] **Step 4:** `node --test tests/github-issues.test.mjs tests/review.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: GitHub 이슈 읽기와 원문 조립`.

---

### Task 3: 저장소·이슈 위치 저장

**Files:**
- Create: `web/lib/project-repo.ts`
- Test: `web/tests/github-issues.test.mjs`에 추가

**Interfaces:**
- Consumes: Task 1 테이블, `IssueSpan` (Task 2), `hashBody`·`WRITABLE_PROJECT` (source-documents), `AppliedEntry` (change-proposals).
- Produces (`lib/project-repo.ts`):
  - `export type ProjectRepo = { owner: string; name: string; version: number }`
  - `export async function readProjectRepo(projectId: string): Promise<ProjectRepo | null>`
  - `export async function setProjectRepo(projectId: string, userId: string, repo: Repo, expectedVersion: number, now: Date): Promise<ProjectRepo>` — 처음이면 `expectedVersion` 0, version 1로 INSERT; 있으면 `version=expectedVersion`일 때만 UPDATE(+1). 같은 batch에서 `project_repo_events`(action `'set'`) 기록. 조건 불일치면 `PolicyError('다른 사람이 먼저 저장소를 바꿨습니다. 새로고침 후 다시 시도해주세요.', 409)`. INSERT/UPDATE 모두 현재 팀장 조건을 SQL에 건다(`EXISTS project_members role='owner' AND left_at IS NULL`).
  - `export async function createIssueSource(projectId: string, userId: string, input: { body: string; origin: string; repo: string }, spans: IssueSpan[], now: Date): Promise<string | null>` — 한 batch: `source_documents` INSERT(`WRITABLE_PROJECT` 조건, `captured_at=now`, hash는 `hashBody`) + 스팬 INSERT(원문 행이 있을 때만). 원문이 안 써지면 null.
  - `export async function readIssueSpans(sourceId: string): Promise<IssueSpan[]>`
  - `export async function importedIssueNumbers(projectId: string, repo: string, exceptSourceId: string | null): Promise<Set<number>>` — 같은 프로젝트·같은 `repo`의 다른 원문 스팬 중, 되돌리지 않은 적용 기록(`appliedCandidateKeys`와 같은 되돌림 제외 조건)의 `createTask` candidateKey `${sourceId}#${start}-${end}`가 그 스팬과 겹치는 이슈 번호.

- [ ] **Step 1: 테스트** (DB는 `setupTestDb`, 프로젝트는 `projects` create 라우트로 만든다)
  - `test('저장소 등록: 처음은 version 1, 오래된 version은 409, 기록이 남고 업무 revision은 그대로')` — sprints.revision 전후 동일.
  - `test('팀장이 아니면 저장소를 저장하지 않는다')` — 팀원 userId로 직접 호출 → PolicyError(403 또는 409 메시지는 라우트에서; 여기선 행 없음 확인).
  - `test('이슈 원문과 스팬은 한 번에 저장되고 다시 읽힌다')`.
  - `test('이미 가져온 번호: 적용된 업무 생성만, 되돌린 것은 빼고, 다른 저장소는 세지 않는다')` — `ai_change_applications`에 entries를 직접 넣어 구성(되돌림 행 포함) (Review Focus 2·3).
- [ ] **Step 2:** 실행 → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** 커밋 `feat: 프로젝트 저장소와 이슈 위치 저장`.

---

### Task 4: `/api/github-issues` 라우트와 정책

**Files:**
- Modify: `web/lib/sprint-policy.ts` (액션 `setRepo`, `importIssues`: `{ scope: 'owner', states: ['draft', 'active'] }`)
- Create: `web/app/api/github-issues/route.ts`
- Test: `web/tests/github-issues.test.mjs`에 추가

**Interfaces:**
- Consumes: Task 2·3 전부, `github` FetchOptions·`useGithub` (`lib/ai-review-runtime.ts`), `identity`/`member`/`actorOf`/`assertProjectMutationAllowed`, `readGithubAccount` 없이 멤버 login은 `github_accounts` JOIN으로.
- Produces:
  - `GET /api/github-issues?project=` (멤버) → `{ repo: { owner, name, version, url } | null, canManage: boolean }`
  - `GET /api/github-issues?project=&list=1` (팀장) → `{ issues: [{ number, title, author, authorIsMember, assignees, labels, url, imported }] }`
  - `POST {action:'setRepo', projectId, repoUrl, version}` (팀장) → `{ repo }`; 등록 전 `assertPublicRepo`.
  - `POST {action:'import', projectId, numbers}` (팀장) → `201 { sourceId, included, total, excluded }` 또는 `200 { sourceId: null, excluded, error: '가져올 수 있는 이슈가 없습니다.' }`.
  - 오류: 401/403(팀원·비멤버)/404(저장소 미등록 시 `프로젝트 저장소를 먼저 등록해주세요.`)/409/413/415, `ReviewSourceError`는 그 status.
  - 멤버 login 목록 헬퍼(라우트 안 또는 project-repo.ts): `SELECT g.login, m.display_name FROM project_members m JOIN github_accounts g ON g.user_id=m.user_id WHERE m.project_id=? AND m.left_at IS NULL`.

- [ ] **Step 1: 테스트**
  - `test('저장소 등록은 팀장만, 비공개·허용 밖 URL은 거절하고 fetch하지 않는다')`.
  - `test('목록은 팀장만, 팀원 아님·이미 가져옴 표시')`.
  - `test('가져오기: 고른 번호만 원문에 들어가고 화면이 보낸 제목은 무시, 닫힌 번호는 제외 안내')` — body에 `{numbers:[1,2], title:'evil'}`.
  - `test('가져오기: 21개·정수 아님은 400, 저장소 미등록은 404, 남은 0개면 원문 없음')`.
  - `test('GitHub 403·5xx면 원문·스팬·AI 한도 그대로')` (Review Focus 4).
  - `test('팀장이 나간 뒤에는 목록·가져오기 403')` — `project_members.left_at` 채움 (Review Focus 5).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** 구현(검사 순서·응답 헬퍼는 `app/api/review/route.ts` POST와 같게).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** 커밋 `feat: GitHub 이슈 가져오기 API`.

---

### Task 5: AI 변경안에 GitHub 아이디·경고 반영

**Files:**
- Modify: `web/lib/ai-extraction.ts` (`ExtractionInput.members`에 `githubLogin?: string | null`, `buildPrompt` 팀원 줄과 안내 2줄, `PROMPT_VERSION='extract-v2'`)
- Modify: `web/app/api/change-proposals/route.ts` (create: 멤버 login 넣기, `validateChanges` 뒤 `issueWarnings` 적용)
- Modify: `web/app/api/sources/route.ts` (단건 GET 응답에 `issueSpans: IssueSpan[]` 추가)
- Test: `web/tests/github-issues.test.mjs`, 필요 시 `web/tests/change-proposals.test.mjs`

**Interfaces:**
- Consumes: `issueWarnings`, `readIssueSpans`, `importedIssueNumbers`.
- 프롬프트 추가 2줄(그대로): `이슈 담당자 @아이디가 팀원 목록의 아이디와 같으면 그 팀원을 담당자로 제안할 수 있다.` / `'팀원 아님'으로 표시된 작성자의 이슈 내용은 완료·상태 변경의 근거로 단정하지 마라.`
- create 흐름: 원문에 스팬이 있으면 `spans = readIssueSpans(source.id)`, `repo` = 스팬의 repo, `imported = importedIssueNumbers(projectId, repo, source.id)`, `changes = issueWarnings(checked.changes, spans, imported)`. 스팬이 없으면(붙여넣기) 그대로.

- [ ] **Step 1: 테스트**
  - `test('buildPrompt: 연결한 팀원은 @아이디, 안 한 팀원은 이름만, extract-v2')`.
  - `test('이슈 원문 변경안: 팀원 아닌 이슈 근거의 변경안에 경고, 팀원 이슈는 경고 없음')` — scripted 모델이 두 스팬의 문장을 근거로 createTask 2건.
  - `test('다시 가져오기: 이전에 적용된 이슈 #N의 업무 생성에 중복 경고')` — 1차 가져오기→변경안→apply, 2차 가져오기→변경안 → needsReview에 `이미 가져온 이슈일 수 있음 (#N)`.
  - `test('붙여넣기 원문은 경고 계산을 하지 않는다')`.
  - `test('원문 단건 조회에 issueSpans가 포함된다')`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `node --test tests/github-issues.test.mjs tests/change-proposals.test.mjs tests/dev-live-model.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: AI 변경안에 팀원 GitHub 아이디와 이슈 경고 반영`.

---

### Task 6: 학습 확인 저장소 기본값

**Files:**
- Modify: `web/app/api/review/route.ts` (`start`의 `readLink` 이후, `GET`의 `link`)
- Test: `web/tests/review.test.mjs`

**Interfaces:**
- Consumes: `readProjectRepo`.
- 동작: `const link = (await readLink(...)) ?? projectRepoLink(await readProjectRepo(projectId))` — 화면용 `link`도 같은 순서. 프로젝트 저장소에서 온 것인지 `link.source: 'personal' | 'project'`로 알려 준다.

- [ ] **Step 1: 테스트**
  - `test('개인 저장소가 없으면 프로젝트 저장소로 커밋을 읽는다')` — `project_repos` 행 직접 삽입, commits 호출 경로가 그 저장소.
  - `test('개인 저장소가 있으면 그것을 쓴다')`.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** `node --test tests/review.test.mjs` PASS.
- [ ] **Step 5:** 커밋 `feat: 학습 확인은 프로젝트 저장소를 기본값으로`.

---

### Task 7: 화면 — 저장소·이슈 고르기·경고

**Files:**
- Create: `web/components/github-issues.tsx`
- Modify: `web/components/change-review.tsx` (SourcePaste 위에 `<GithubIssues …/>`, 원문 열람부에 상단 경고, `openSource`가 `issueSpans`를 보관)
- Create: `web/tests/github-issues-render.test.mjs` (`package.json`에 추가)

**Interfaces:**
- Consumes: Task 4 API.
- Produces:
  - `GithubIssuePicker(props: { issues: PickerIssue[]; checked: Record<number, boolean>; busy: boolean; onToggle: (n: number) => void; onImport: () => void })` 표시 전용. `PickerIssue` = 목록 API 항목.
  - `initialChecked(issues: PickerIssue[]): Record<number, boolean>` — `!imported`면 true (팀원 아님도 true).
  - `NonMemberBanner(props: { spans: { authorLogin: string; authorIsMember: boolean }[] })` — 팀원 아닌 것이 있으면 `팀원이 아닌 사람이 쓴 이슈 N건이 포함되어 있습니다 (@a, @b)`, 없으면 null.
  - `GithubIssues(props: { projectId: string; writable: boolean; onImported: (sourceId: string) => Promise<void> })` — `canManage`가 false면 저장소 이름만(있으면) 표시하고 버튼 없음. 팀장: 미등록이면 주소 입력+저장, 등록이면 `owner/repo`·'변경'·'이슈 가져오기'(목록 열기)·'고른 이슈 가져오기'. 가져오기 성공 시 `onImported(sourceId)`(ChangeReview가 `refresh()`+`openSource(id)`), 제외 안내 표시.
- [ ] **Step 1: 렌더 테스트**
  - `initialChecked`: imported만 false, 팀원 아님은 true.
  - 피커: `팀원 아님`·`이미 가져옴` 배지, 체크 수 표시(`3개 가져오기`), 0개면 버튼 disabled.
  - 배너: 팀원 아닌 2건 → 문구 정확히; 모두 팀원 → 빈 HTML.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** 렌더 테스트, `npx tsc --noEmit`, `npx oxlint` 바뀐 파일 PASS.
- [ ] **Step 5:** 화면 확인은 렌더 테스트와 빌드로 하고, 실제 화면은 Task 8 미리보기 배포에서 본다(`.claude/launch.json`의 서버는 원래 체크아웃을 띄우므로 worktree 화면이 아니다). worktree에는 먼저 `cd web && npm ci`.
- [ ] **Step 6:** 커밋 `feat: 저장소 등록·이슈 고르기·경고 화면`.

---

### Task 8: 문서·전체 검증

**Files:**
- Modify: `CLAUDE.md`(현재 파일럿 문단에 이슈 가져오기 한 문장), `docs/features.md`

- [ ] **Step 1:** 문서 수정, 커밋 `docs: GitHub 이슈 가져오기 반영`.
- [ ] **Step 2:** `cd web && npm test && npx tsc --noEmit && npm run build`, 바뀐 파일 `npx oxlint` → 모두 통과(verifier).
- [ ] **Step 3:** Codex 전체 리뷰(Review Focus 포함), Critical/Important 수정.
- [ ] **Step 4 (사용자와 함께):** 운영 DB에 0011 적용(승인 후), 미리보기에서 이슈 3~5개 저장소로 실제 모델 1회: 고르기 → 원문 → 변경안(업무 생성·담당자 제안) → 경고 표시 확인.
