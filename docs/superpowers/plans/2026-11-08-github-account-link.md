# GitHub 계정 연결 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google 로그인 계정에 GitHub 신원을 연결해 GitHub 아이디 소유를 확인하고, 학습 확인과 팀원 목록이 그 계정을 쓰게 한다.

**Architecture:** 브라우저는 Supabase `linkIdentity`/`unlinkIdentity`만 부른다. 서버의 `syncGithubAccount`가 사용자 토큰으로 Supabase `/auth/v1/user`를 읽어 `github_accounts`를 맞춘다(Supabase가 기준, 브라우저 값은 믿지 않음). `POST /api/github`와 학습 확인 시작이 모두 이 함수를 거친다.

**Tech Stack:** Next.js(web/, AGENTS.md: 코드 쓰기 전에 `node_modules/next/dist/docs/` 해당 가이드 확인), Supabase Auth(`@supabase/supabase-js` 2.117), Postgres(lib/db.ts: 운영 postgres.js, 테스트 PGlite), drizzle-kit, node:test + esbuild 번들 테스트.

**Spec:** `docs/superpowers/specs/2026-11-08-github-account-link-design.md`

## Global Constraints

- 로그인 판정(`lib/auth.ts`의 `app.provider !== 'google'`)은 바꾸지 않는다. GitHub 로그인 버튼을 만들지 않는다.
- GitHub 신원은 서버가 Supabase에서 읽은 값만 쓴다. 요청 본문의 아이디·숫자 id는 무시한다.
- Supabase 조회 실패는 503이고, 이때 저장된 연결을 지우거나 바꾸지 않는다.
- `github_id`(GitHub 숫자 id)가 기준이며 UNIQUE. 아이디(login)는 바뀔 수 있다.
- 다른 사용자의 옛 행과 `github_id`가 겹치면 409가 아니라 한 트랜잭션에서 옛 행을 지우고 새 사용자로 저장하며, 양쪽 기록을 남긴다.
- GitHub를 연결하지 않으면 학습 확인을 시작할 수 없다. 안내 문구: `마이페이지에서 GitHub를 먼저 연결해주세요.` 한도는 차감하지 않는다.
- 파괴적 마이그레이션 금지(`review_links.github_login` 컬럼 유지). 새 테이블은 RLS ON, 정책 없음.
- 팀원 GitHub 아이디는 같은 프로젝트 멤버에게만. 나간 사람이 보는 화면에서는 숨긴다. 공개 팀 목록에는 넣지 않는다.
- OAuth 권한 범위는 기본(공개 프로필)만. 추가 `scopes`를 넘기지 않는다.

## Review Focus

1. Supabase가 401/5xx/시간 초과를 돌려줄 때 → 연결이 지워지지 않고 503. (Task 2 테스트)
2. Supabase 응답에 GitHub 신원은 있는데 아이디가 비었거나 형식이 틀림 → 저장하지 않고 503, 기존 행 유지. (Task 2 테스트)
3. 같은 GitHub 숫자 id로 아이디만 바뀜(GitHub 이름 변경) → 같은 사용자 행의 login만 갱신, 넘기기 기록 없음. (Task 2 테스트)
4. Supabase에서 해제했지만 sync 없이 학습 확인 시작 → 시작 시 sync가 행을 지우고 거절. (Task 3 테스트)
5. 나간 멤버가 프로젝트 상태를 볼 때 → 팀원 `github_login`이 모두 null. (Task 4 테스트)

---

### Task 1: 저장 테이블

**Files:**
- Modify: `web/db/schema.ts` (reviewQuota 뒤에 추가)
- Create: `web/db/migrations/0010_github_accounts.sql` + `meta/0010_snapshot.json`, `meta/_journal.json` 갱신 (생성기로)
- Modify: `web/tests/db.test.ts:108` (테이블 수)

**Interfaces:**
- Produces: 테이블 `github_accounts(user_id text PK, github_id text NOT NULL UNIQUE, login text NOT NULL, linked_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`, `github_link_events(id text PK, user_id text NOT NULL, github_id text NOT NULL, login text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL, index on user_id)`. `action` ∈ `'link' | 'unlink' | 'transfer_out'`. 둘 다 `.enableRLS()`.

- [ ] **Step 1:** `tests/db.test.ts`의 `assert.equal(tables.results.length, 39)`를 `41`로 바꾸고, `github_accounts`·`github_link_events`가 목록에 있는지 assert 한 줄 추가.
- [ ] **Step 2:** `cd web && node --experimental-strip-types --test tests/db.test.ts` → FAIL(39 ≠ 41).
- [ ] **Step 3:** `schema.ts`에 두 테이블 추가(`pgTable`, `tz` 상수 재사용). `cd web && npx drizzle-kit generate --name github_accounts` → `0010_github_accounts.sql` 생성 확인. SQL에 `ENABLE ROW LEVEL SECURITY` 두 줄이 있는지 확인.
- [ ] **Step 4:** `node --experimental-strip-types --test tests/db.test.ts tests/schema-migrations.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: GitHub 계정 연결 저장 테이블(0010)`.

---

### Task 2: 서버 동기화와 `POST /api/github`

**Files:**
- Create: `web/lib/github-account.ts`
- Create: `web/app/api/github/route.ts`
- Create: `web/tests/github-account.test.mjs` (`package.json`의 `test` 스크립트 끝에 추가)

**Interfaces:**
- Consumes: Task 1 테이블. `identity`, `AuthUnavailable`(`lib/auth.ts` / `lib/projects.ts` 재수출), `database()`(`lib/sprint-store`의 것과 같은 포트).
- Produces (`lib/github-account.ts`):
  - `export type GithubIdentity = { githubId: string; login: string }`
  - `export type GithubAccount = { githubId: string; login: string; linkedAt: Date }`
  - `export function githubFromSupabaseUser(user: unknown): GithubIdentity | null` — `identities[]`에서 `provider === 'github'`을 찾는다. 없으면 null. 있으면 `githubId = identity_data.provider_id ?? identity_data.sub ?? identity.id`(문자열), `login = identity_data.user_name ?? identity_data.preferred_username`. login이 `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/`에 안 맞거나 githubId가 비면 `throw new AuthUnavailable()`.
  - `export type GithubIdentitySource = (request: Request) => Promise<GithubIdentity | null>` (실패는 `AuthUnavailable` throw)
  - `export let githubIdentitySource: GithubIdentitySource` — 기본값: `Authorization: Bearer`가 없으면 null. 있으면 `GET {SUPABASE_URL}/auth/v1/user`(헤더 `Authorization`, `apikey: NEXT_PUBLIC_SUPABASE_ANON_KEY`, 10초 타임아웃, `redirect: 'manual'`). 200이 아니거나 네트워크 오류·설정 없음이면 `throw new AuthUnavailable()`. 200이면 `githubFromSupabaseUser(json)`.
  - `export function useGithubIdentitySource(next: GithubIdentitySource): void` (테스트 대역)
  - `export async function readGithubAccount(userId: string): Promise<GithubAccount | null>`
  - `export async function syncGithubAccount(request: Request, userId: string, now: Date): Promise<GithubAccount | null>`
- Produces (route): `POST /api/github` body `{ action: 'sync' }` → `200 { github: { login, linkedAt } | null }`. 인증 실패 401, `AuthUnavailable` 503, 다른 origin 403, JSON 아님 415, 알 수 없는 action 400. (검사 순서·응답 헬퍼는 `app/api/review/route.ts`의 POST와 같게.)

`syncGithubAccount` 동작(한 `db.batch` 트랜잭션):
- source가 null → 내 행이 있으면 삭제 + `unlink` 기록.
- source가 값 → 다른 `user_id`가 같은 `github_id`를 가지면 그 행 삭제 + 그 사용자에게 `transfer_out` 기록. 내 행 upsert: 새 행이거나 `github_id`가 바뀌면 `linked_at=now` + `link` 기록, `github_id`가 같고 login만 다르면 login·`updated_at`만 갱신(기록 없음).

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/review.test.mjs` 머리말처럼 esbuild로 `./app/api/github/route`의 `POST`, `./lib/github-account`의 `useGithubIdentitySource, githubFromSupabaseUser, readGithubAccount, githubIdentitySource`를 번들. `AUTH_DEV_HEADERS=1`, `setupTestDb()`.)
  - `test('연결 → sync → 재조회: Supabase 신원의 아이디가 저장되고 본문의 아이디는 무시한다')`: source가 `{githubId:'101', login:'alice-gh'}`; `POST {action:'sync', login:'evil', githubId:'999'}` → 200, `github.login === 'alice-gh'`; `readGithubAccount('alice').githubId === '101'`; `github_link_events`에 `('alice','link')` 1건.
  - `test('Supabase에서 해제되면 sync가 행을 지우고 unlink를 남긴다')`: 위 뒤 source null → `github === null`, 행 없음, `unlink` 1건.
  - `test('다른 사용자의 옛 행과 같은 GitHub면 새 사용자에게 넘긴다')`: alice 행(101) 상태에서 bob의 source가 `{githubId:'101', login:'alice-gh'}` → bob 200, alice 행 없음, bob 행 있음, alice `transfer_out` 1건 + bob `link` 1건.
  - `test('GitHub 신원이 없는 사용자의 sync는 남의 연결을 건드리지 않는다')`: bob source null → alice 행 그대로.
  - `test('아이디만 바뀌면 같은 행의 login만 갱신하고 기록을 남기지 않는다')`: 101 / `alice-new` → login 갱신, `linked_at` 그대로, 이벤트 수 그대로.
  - `test('Supabase 조회 실패는 503이고 기존 연결을 유지한다')`: source가 `throw new AuthUnavailable()`(번들에서 함께 export) → 503, alice 행 그대로.
  - `test('githubFromSupabaseUser: GitHub 신원이 없으면 null, 아이디가 비거나 틀리면 실패')`: `{identities:[{provider:'google'}]}` → null; `{identities:[{provider:'github', id:'x', identity_data:{provider_id:'5', user_name:'octo-cat'}}]}` → `{githubId:'5', login:'octo-cat'}`; `user_name: ''`·`'bad name'` → throws.
  - `test('기본 source: Bearer가 없으면 null, Supabase가 401이면 AuthUnavailable')`: 기본 `githubIdentitySource`를 따로 보관해 두고 `globalThis.fetch`를 401 응답으로 바꾼 뒤 `SUPABASE_URL`·`NEXT_PUBLIC_SUPABASE_ANON_KEY`를 설정하고 Bearer 요청 → rejects `AuthUnavailable`; Bearer 없는 요청 → null. 끝나면 fetch 복원.
  - `test('다른 origin·JSON 아님·모르는 action은 거절한다')`: 403 / 415 / 400.
- [ ] **Step 2:** `cd web && node --test tests/github-account.test.mjs` → FAIL(모듈 없음).
- [ ] **Step 3:** `lib/github-account.ts`와 `app/api/github/route.ts` 구현(위 Interfaces). 조건부 기록은 `INSERT ... SELECT ... WHERE EXISTS/NOT EXISTS`로 같은 batch 안에서 만든다. 이벤트 id는 `'gle_' + crypto.randomUUID()`.
- [ ] **Step 4:** `node --test tests/github-account.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: GitHub 계정 연결 동기화 API`.

---

### Task 3: 학습 확인이 연결된 계정을 쓰게

**Files:**
- Modify: `web/app/api/review/route.ts` (`linkInput`, `link` 액션, `start`, `GET`의 `link`)
- Modify: `web/lib/ai-review-store.ts` (`ReviewLink`, `readLink`, `saveLink`)
- Modify: `web/tests/review.test.mjs` (등록을 연결 방식으로, 새 테스트)

**Interfaces:**
- Consumes: `syncGithubAccount(request, userId, now)`, `readGithubAccount(userId)`, `useGithubIdentitySource` (Task 2).
- Produces: `ReviewLink = { repoOwner: string; repoName: string }`. `saveLink`는 `review_links.github_login`에 `''`를 쓴다(컬럼 유지, 읽지 않음). `POST /api/review {action:'link'}`는 `repoUrl`(또는 `sourceUrl`)만 읽는다. `GET` 응답 `link`는 `{ repoUrl, githubLogin: string | null }`(githubLogin은 `readGithubAccount`의 login), 저장소가 없으면 `null`. `start`는 `request`를 받아야 하므로 시그니처에 `request: Request` 추가.

`start` 순서: 기간 검사 → (본문에 저장소가 있으면 저장) → 기존 확인 재사용 → `readLink` 없으면 기존 문구를 `공개 GitHub 저장소를 먼저 등록해주세요.`로 → **`syncGithubAccount`; null이면 `PolicyError('마이페이지에서 GitHub를 먼저 연결해주세요.')`** → 모델 가용 → 한도 잡기 → 커밋 조회(`login: account.login`) → `insertReview`에 `githubLogin: account.login`. 기존 확인 재사용(`repeated`)은 sync 전에 돌려준다(이미 만든 질문이므로).

- [ ] **Step 1: 테스트 수정·추가**
  - 파일 상단에서 `useGithubIdentitySource`를 번들 export에 넣고, 사용자별 신원 맵 `ghUsers = new Map()`을 두어 `useGithubIdentitySource(async (r) => ghUsers.get(r.headers.get('oai-authenticated-user-id')) ?? null)`. 기존 테스트의 `githubLogin` 등록을 `ghUsers.set(user, {githubId, login})`로 바꾼다. 기존 기대값(커밋 URL의 `author=`)은 그대로 통과해야 한다.
  - `test('GitHub를 연결하지 않으면 학습 확인을 시작할 수 없고 한도를 쓰지 않는다')`: 저장소만 등록, ghUsers 없음 → `start` 400, 메시지 `마이페이지에서 GitHub를 먼저 연결해주세요.`, `review_quota` 행 없음, GitHub fetch 호출 0.
  - `test('본문의 githubLogin은 쓰지 않고 연결된 계정 아이디로 커밋을 거른다')`: ghUsers login `real-me`, 본문 `githubLogin:'someone-else'` → commits 호출 URL의 `author === 'real-me'`, 저장된 `learning_reviews.github_login === 'real-me'`.
  - `test('Supabase에서 해제한 뒤 sync 없이 시작하면 행을 지우고 거절한다')`: 연결 후 `ghUsers.delete(user)` → start 400, `github_accounts` 행 없음.
  - `test('시작 시 Supabase 조회 실패는 503이고 한도를 쓰지 않는다')`.
  - `test('GET의 link.githubLogin은 연결된 계정 아이디다')`.
- [ ] **Step 2:** `node --test tests/review.test.mjs` → 새 테스트 FAIL.
- [ ] **Step 3:** route·store 수정(위 Interfaces). `parseLogin` import가 쓰이지 않으면 지운다(함수 자체는 남겨도 됨).
- [ ] **Step 4:** `node --test tests/review.test.mjs tests/github-account.test.mjs` → PASS.
- [ ] **Step 5:** 커밋 `feat: 학습 확인은 연결된 GitHub 계정만 쓴다`.

---

### Task 4: 팀원에게 GitHub 아이디 보이기

**Files:**
- Modify: `web/lib/projects.ts:169` (`projectState`의 members 쿼리)
- Modify: `web/components/project-workspace.tsx:158` (members 타입에 `github_login: string | null`)
- Modify: `web/components/project-dashboard.tsx:~760` (팀원 카드)
- Test: `web/tests/github-account.test.mjs`에 추가 (`./app/api/projects/route`의 GET/POST를 번들에 추가)

**Interfaces:**
- Consumes: `github_accounts` (Task 1).
- Produces: `projectState(...).members[i].github_login: string | null`. 쿼리: `LEFT JOIN github_accounts g ON g.user_id = m.user_id`, `CASE WHEN ?::boolean THEN NULL ELSE g.login END AS github_login`(바인드: 보는 사람이 나간 멤버인지). `exportProject`·공개 팀 목록(`lib/hub.ts`)은 바꾸지 않는다.

- [ ] **Step 1: 테스트**
  - `test('같은 프로젝트 팀원은 서로의 GitHub 아이디를 본다')`: 두 사람 프로젝트를 만든다(합류 방법은 `tests/teams.test.mjs`의 참여 신청→승인 도우미를 그대로 옮겨 쓴다). 팀원 B만 sync로 연결 → A의 프로젝트 상태 GET에서 B 멤버의 `github_login === 'bob-gh'`, A 자신은 `null`.
  - `test('나간 멤버가 보는 프로젝트 상태에는 GitHub 아이디가 없다')`: `project_members.left_at`을 직접 SQL로 채운 뒤 그 사람의 GET → 모든 `github_login === null`. 남은 사람의 GET에서는 나간 사람의 아이디가 보인다.
  - `test('공개 팀 목록에는 GitHub 아이디가 없다')`: 공개 목록 응답 JSON 문자열에 `github`가 없다.
- [ ] **Step 2:** 실행 → FAIL.
- [ ] **Step 3:** 쿼리·타입 수정. 대시보드 팀원 카드의 `{m.role === 'owner' ? '팀장' : '팀원'}` 줄 앞이나 이름 옆에 `m.github_login && <a href={'https://github.com/' + m.github_login} target="_blank" rel="noreferrer">@{m.github_login}</a>`.
- [ ] **Step 4:** `node --test tests/github-account.test.mjs` 및 `npx tsc --noEmit` → PASS.
- [ ] **Step 5:** 커밋 `feat: 팀원 목록에 연결된 GitHub 아이디 표시`.

---

### Task 5: 마이페이지 GitHub 연결 카드

**Files:**
- Modify: `web/lib/supabase-browser.ts` (`linkGithub`, `unlinkGithub` 추가)
- Create: `web/components/github-link.tsx`
- Modify: `web/components/unified-app.tsx` (마이페이지 `profile` 탭, `CareerWorkspace` 위)
- Create: `web/tests/github-link-render.test.mjs` (`test` 스크립트에 추가, `tests/team-directory-render.test.mjs`와 같은 방식)

**Interfaces:**
- Consumes: `POST /api/github` (Task 2), `apiFetch`, `returnUrl`.
- Produces:
  - `linkGithub(): Promise<void>` — `supabase.auth.linkIdentity({ provider: 'github', options: { redirectTo: returnUrl(location.href) } })`, error면 throw.
  - `unlinkGithub(): Promise<void>` — `supabase.auth.getUserIdentities()`에서 `provider === 'github'`을 찾아 `unlinkIdentity`.
  - `GithubLinkCard(props: { account: { login: string } | null; busy: boolean; error: string; onLink(): void; onUnlink(): void })` — 표시 전용.
  - `GithubLink()` — 마운트 시 `POST /api/github {action:'sync'}`로 상태를 받는다. 연결 후 돌아온 주소에 `error_code=identity_already_exists`(또는 `error_description`에 already)가 있으면 `이미 다른 계정에 연결된 GitHub입니다.`를 보이고 `history.replaceState`로 파라미터를 지운다. 해제는 `unlinkGithub()` 뒤 다시 sync.
  - 문구: 미연결 `GitHub 연결` 버튼 + `학습 확인은 GitHub를 연결해야 시작할 수 있어요.`; 연결됨 `@{login} 연결됨` + `연결 해제` 버튼. 바꾸기는 해제 후 다시 연결(별도 버튼 없음).

- [ ] **Step 1:** 렌더 테스트: `account:null` → HTML에 `GitHub 연결` 포함·`연결 해제` 없음; `account:{login:'octo'}` → `@octo` 와 `연결 해제` 포함·`GitHub 연결</button>` 없음; `error` 문구가 `role="alert"` 안에 나온다.
- [ ] **Step 2:** 실행 → FAIL.
- [ ] **Step 3:** 구현. `unified-app.tsx`에서 `tab === 'profile'`일 때 `<GithubLink />`를 `CareerWorkspace` 위에 둔다.
- [ ] **Step 4:** 렌더 테스트 PASS, `npm run lint`, `npx tsc --noEmit`.
- [ ] **Step 5:** 로컬 화면 확인(preview): 마이페이지에 카드가 보이고 미연결 상태 문구가 나온다(로컬엔 Supabase GitHub가 없으므로 실제 연결은 Task 6).
- [ ] **Step 6:** 커밋 `feat: 마이페이지 GitHub 연결 카드`.

---

### Task 6: 문서·운영 확인

**Files:**
- Modify: `CLAUDE.md` (학습 확인 문단: "GitHub 아이디 소유는 확인하지 않으며" → "마이페이지에서 연결한 GitHub 계정만 쓴다(2026-11-08)")
- Modify: `docs/superpowers/specs/2026-10-15-learning-review-design.md` '미구현·한계'의 소유 확인 줄에 이 설계 링크
- Modify: `docs/features.md` (해당 기능 줄이 있으면)

- [ ] **Step 1:** 문서 수정, 커밋 `docs: GitHub 계정 연결 반영`.
- [ ] **Step 2:** `cd web && npm test && npm run lint && npx tsc --noEmit && npm run build` 전부 통과(verifier 에이전트로 수치 보고).
- [ ] **Step 3 (사용자와 함께, 코드 밖):** 스펙 '사용자가 할 일' 1~4(OAuth App, Supabase GitHub 공급자, Manual Linking, 운영 DB 0010 적용 — 명령은 memory `prod-db-migrate` 참고).
- [ ] **Step 4 (미리보기 배포에서 사용자와 함께):** 실제 GitHub 연결 1회 → 마이페이지 `@아이디` → 로그아웃 후 Google 재로그인 성공 → 토큰 `app_metadata.provider`가 `google`인지 → 새로 참여한 프로젝트의 `display_name`이 Google 이름인지.
- [ ] **Step 5 (Step 4에서 이름이 GitHub 것으로 바뀐 경우만):** `lib/auth.ts`의 이름 읽기만 고친다(로그인 판정 그대로). 방법은 그때 실제 토큰 내용을 보고 정하고, `tests/auth.test.mjs`에 회귀 테스트 추가. 바뀌지 않았으면 건너뛴다.
