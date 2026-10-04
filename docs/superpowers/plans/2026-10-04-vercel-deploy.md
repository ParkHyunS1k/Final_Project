# Vercel 팀 내부 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `web/`을 Vercel(서울)에 팀 내부용으로 배포할 수 있게 한다 — 운영에서 DB 주소 누락은 503으로 멈추고, AI 변경안은 '준비 중', 보내지 않는 메일을 약속하는 문구는 없앤다.

**Architecture:** 코드 변경은 작다. `lib/db.ts`가 운영에서 로컬 PGlite로 넘어가지 않게 막고, `lib/ai-extraction.ts`의 `aiAvailable()` 하나로 변경안 생성 API와 화면을 함께 끈다. 배포 설정은 `web/vercel.json` 한 줄, 나머지는 Vercel·Supabase 대시보드에서 사용자가 한다.

**Tech Stack:** Next.js 16, postgres.js / PGlite, node:test + esbuild 번들 테스트, Vercel(Hobby), Supabase(서울).

**Spec:** `docs/superpowers/specs/2026-10-04-vercel-deploy-design.md`

## Global Constraints

- 작업 브랜치 `vercel-deploy`(`postgres-migration` 위). Postgres 브랜치 머지 후 `main` 기준 PR.
- 비밀값(`.env`, `.env.local`, Vercel 환경변수 값)을 출력·커밋하지 않는다. 이름만 다룬다.
- 운영 판단 기준은 `NODE_ENV === 'production'`(Vercel은 미리보기도 production). 개발 전용 스위치는 `'1'`일 때만 켜지고 운영에서는 무시한다(`AUTH_DEV_HEADERS`와 같은 규칙).
- 503 안내 문구: `AI 변경안은 준비 중입니다.` / 화면 표시 `준비 중인 기능`(랜딩 기존 배지와 같은 `className="soon"`).
- 알림 코드(`lib/reminders.ts`, `lib/reminder-*.ts`, `/api/internal/reminders`)는 지우지 않는다.
- 최소 범위로 수정하며 관련 없는 코드·포맷은 건드리지 않는다(포매터 실행 금지).
- 커밋 끝줄: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `next build`(NODE_ENV=production)에서 `DATABASE_URL`이 없을 때 빌드 중 어떤 모듈이 `database()`를 부르면 빌드가 깨진다 → Task 4 Step 2에서 `DATABASE_URL=` 로 빌드해 통과를 확인한다.
2. `NEXT_PUBLIC_*`는 빌드 때 번들에 박힌다. 환경변수를 넣기 전에 첫 배포가 돌면 로그인 화면이 "설정 없음"으로 남는다 → Task 5 순서: 환경변수 먼저, 배포는 그다음(이미 배포됐으면 Redeploy).
3. 미리보기 주소가 Supabase Redirect URLs에 없으면 로그인 뒤 Site URL(운영)로 튕긴다 → Task 5 Step 6에서 미리보기 로그인 후 같은 미리보기 주소로 돌아오는지 확인한다.
4. Vercel 환경변수에 `AI_FAKE_MODEL=1`이나 `AUTH_DEV_HEADERS=1`이 실수로 들어가도 운영에서는 꺼져야 한다 → Task 2 Step 1의 `aiAvailable` 단위 테스트(production + `'1'` → false), Task 5 Step 5의 운영 주소 개발 헤더 401 확인.
5. 비회원이 '준비 중' 상태에서 변경안을 만들려 하면 503이 아니라 기존대로 403이어야 한다(프로젝트 존재 여부를 흘리지 않는다) → Task 2 Step 1 두 번째 테스트에 비회원 403을 넣는다.

---

### Task 1: 운영에서 DB 주소가 없으면 멈춤, 서버리스 유휴 연결 정리

**Files:**
- Modify: `web/lib/db.ts` (`openPostgres` 옵션, `database()`)
- Test: `web/tests/db.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `database(): Db` — `DATABASE_URL`이 비었고 `NODE_ENV === 'production'`이면 `DatabaseError`(`database error: DATABASE_URL이 설정되지 않았습니다.`)를 던지고 캐시에 아무것도 넣지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/db.test.ts` 맨 위 import를 다음으로 바꾼다:

```ts
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
```
```ts
import { DatabaseError, database, openPglite, toPositional, type Db } from '../lib/db.ts';
```

파일 끝에 추가:

```ts
void test('운영(NODE_ENV=production)에서 DATABASE_URL이 없으면 로컬 PGlite로 넘어가지 않는다', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, url: env.DATABASE_URL, path: env.DATABASE_PATH };
  const shared = globalThis as { projectmateDb?: unknown };
  const cached = shared.projectmateDb;
  delete shared.projectmateDb;
  const path = join(mkdtempSync(join(tmpdir(), 'pm-prod-')), 'pglite');
  try {
    env.NODE_ENV = 'production';
    env.DATABASE_URL = '';
    env.DATABASE_PATH = path;
    assert.throws(
      () => database(),
      (e: unknown) =>
        e instanceof DatabaseError &&
        /DATABASE_URL/.test((e as Error).message) &&
        !(e as Error).message.includes(path),
    );
    assert.equal(shared.projectmateDb, undefined);
    assert.ok(!existsSync(path));
  } finally {
    for (const [k, v] of [['NODE_ENV', saved.node], ['DATABASE_URL', saved.url], ['DATABASE_PATH', saved.path]] as const)
      if (v === undefined) delete env[k];
      else env[k] = v;
    if (cached !== undefined) shared.projectmateDb = cached;
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd web && node --experimental-strip-types --test --test-name-pattern='운영\(NODE_ENV' tests/db.test.ts`
Expected: FAIL — `Missing expected exception`(지금은 PGlite를 열어 버린다).

- [ ] **Step 3: 구현**

`web/lib/db.ts`의 `database()`를 다음으로 바꾼다:

```ts
export function database(): Db {
  if (shared.projectmateDb) return shared.projectmateDb;
  const url = process.env.DATABASE_URL;
  // 운영(Vercel)에서는 로컬 파일 DB로 넘어가지 않는다. 파일 시스템이 읽기 전용이고 데이터가 남지 않는다.
  if (!url && process.env.NODE_ENV === 'production')
    throw new DatabaseError('DATABASE_URL이 설정되지 않았습니다.');
  return (shared.projectmateDb = url
    ? openPostgres(url)
    : openPglite(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || '.data/pglite'));
}
```

같은 파일 `openPostgres`의 `postgres(url, { … })` 옵션에서 `max: 5,` 다음 줄에 추가:

```ts
    // 서버리스 함수가 쉬는 동안 연결을 붙잡지 않는다(초).
    idle_timeout: 20,
```

- [ ] **Step 4: 통과 확인**

Run: `cd web && node --experimental-strip-types --test tests/db.test.ts tests/db-route.test.mjs`
Expected: PASS(db 11개, db-route 2개). db-route는 `database()`가 던진 `DatabaseError`가 라우트에서 503이 되는 기존 경로를 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add web/lib/db.ts web/tests/db.test.ts
git commit -m "feat: 운영에서 DATABASE_URL이 없으면 로컬 DB로 넘어가지 않고 503

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: AI 변경안 사용 가능 판정과 API 차단

**Files:**
- Modify: `web/lib/ai-extraction.ts` (함수 추가)
- Modify: `web/app/api/change-proposals/route.ts` (GET 목록 응답, POST create 첫 줄, import)
- Modify: `web/.env.development`
- Modify: `web/tests/change-proposals.test.mjs`, `web/tests/apply-revert.test.mjs`, `web/tests/save-guards.test.mjs`, `web/tests/reminder-consistency.test.mjs` (맨 위 env 한 줄)
- Test: `web/tests/change-proposals.test.mjs`

**Interfaces:**
- Consumes: `Model`(`lib/ai-extraction.ts`, `live: boolean` 포함)
- Produces: `aiAvailable(model: Pick<Model, 'live'>, env?: Record<string, string | undefined>): boolean`. GET `/api/change-proposals?project=…`(목록) 응답에 `aiAvailable: boolean`. POST `create`는 사용 불가일 때 503 `{ error: 'AI 변경안은 준비 중입니다.' }`.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/change-proposals.test.mjs` 2행 `process.env.AUTH_DEV_HEADERS = '1';` 다음 줄에 추가:

```js
process.env.AI_FAKE_MODEL = '1';
```

같은 파일 번들 `stdin.contents`의 `export { fakeModel,validateChanges } from './lib/ai-extraction';`를 `export { fakeModel,validateChanges,aiAvailable } from './lib/ai-extraction';`로 바꾼다.

파일 끝에 추가:

```js
test('AI 변경안은 실제 모델이거나 개발에서 가짜 모델을 명시적으로 켰을 때만 쓸 수 있다', () => {
  assert.equal(api.aiAvailable({ live: true }, {}), true);
  assert.equal(api.aiAvailable({ live: false }, {}), false);
  assert.equal(api.aiAvailable({ live: false }, { AI_FAKE_MODEL: '1' }), true);
  assert.equal(api.aiAvailable({ live: false }, { AI_FAKE_MODEL: '1', NODE_ENV: 'production' }), false);
  assert.equal(api.aiAvailable({ live: false }, { AI_FAKE_MODEL: 'true' }), false);
});

test('AI를 쓸 수 없으면 변경안 생성은 503이고 모델·DB를 건드리지 않으며 목록은 aiAvailable=false를 알린다', async () => {
  const { projectId } = await startedTeam('aioff', 'aioffmate');
  const sourceId = await paste('aioff', projectId, '추출 화면 연결 완료했습니다.');
  let called = 0;
  api.useModel({
    name: 'spy',
    live: false,
    async run() {
      called++;
      return { changes: [] };
    },
  });
  delete process.env.AI_FAKE_MODEL;
  try {
    const r = await proposalRequest('aioff', { action: 'create', projectId, sourceId });
    assert.equal(r.status, 503, await r.clone().text());
    assert.match((await r.json()).error, /준비 중/);
    assert.equal(called, 0);
    assert.equal((await rows('SELECT id FROM ai_change_proposals WHERE project_id=?', projectId)).length, 0);
    const off = await proposalGet('aioff', 'project=' + encodeURIComponent(projectId));
    assert.equal((await off.json()).aiAvailable, false);
    // 비회원은 준비 중 여부보다 먼저 권한에서 막힌다.
    const outsider = await proposalRequest('aioff-stranger', { action: 'create', projectId, sourceId });
    assert.equal(outsider.status, 403);
  } finally {
    process.env.AI_FAKE_MODEL = '1';
  }
  const on = await proposalGet('aioff', 'project=' + encodeURIComponent(projectId));
  assert.equal((await on.json()).aiAvailable, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd web && node --experimental-strip-types --test --test-name-pattern='AI 변경안은 실제|AI를 쓸 수 없으면' tests/change-proposals.test.mjs`
Expected: FAIL — `api.aiAvailable is not a function`, 두 번째는 status 201(503 기대).

- [ ] **Step 3: 구현**

`web/lib/ai-extraction.ts`의 `export function fakeModel(): Model {` 바로 위에 추가:

```ts
/**
 * 변경안을 만들 수 있는가. 운영 모델이 연결됐거나, 개발에서 가짜 모델을 명시적으로 켰을 때만.
 * 운영(NODE_ENV=production)에서는 AI_FAKE_MODEL을 무시해 가짜 결과가 사용자에게 보이지 않게 한다.
 */
export function aiAvailable(
  model: Pick<Model, 'live'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return model.live || (env.AI_FAKE_MODEL === '1' && env.NODE_ENV !== 'production');
}
```

`web/app/api/change-proposals/route.ts`:
- `@/lib/ai-extraction`에서 가져오는 import 목록에 `aiAvailable`을 더한다(같은 import 문 안에 이름만 추가).
- GET 목록 응답을 다음으로 바꾼다:

```ts
      return reply({
        proposals: await listProposals(projectId),
        applications: await listApplications(projectId),
        replayCases: replayCases(),
        aiAvailable: aiAvailable(model),
      });
```

- POST의 `if (action === 'create') {` 바로 다음 줄에 추가:

```ts
      // 운영 모델이 없으면 가짜 결과를 만들지 않는다. 멤버·정책 검사는 위에서 이미 끝났다.
      if (!aiAvailable(model)) return reply({ error: 'AI 변경안은 준비 중입니다.' }, 503);
```

`web/.env.development` 끝에 추가:

```
# 개발에서만 가짜 모델로 AI 변경안을 만든다. 운영에서는 lib/ai-extraction.ts aiAvailable()이 무시한다.
AI_FAKE_MODEL=1
```

`web/tests/apply-revert.test.mjs`, `web/tests/save-guards.test.mjs`, `web/tests/reminder-consistency.test.mjs` 각각 `process.env.AUTH_DEV_HEADERS = '1';` 다음 줄에 추가:

```js
process.env.AI_FAKE_MODEL = '1';
```

- [ ] **Step 4: 통과 확인**

Run: `cd web && node --experimental-strip-types --test tests/change-proposals.test.mjs tests/apply-revert.test.mjs tests/save-guards.test.mjs tests/reminder-consistency.test.mjs tests/dev-live-model.test.mjs`
Expected: PASS, 실패 0(새 테스트 2개 포함).

- [ ] **Step 5: 커밋**

```bash
git add web/lib/ai-extraction.ts web/app/api/change-proposals/route.ts web/.env.development web/tests/change-proposals.test.mjs web/tests/apply-revert.test.mjs web/tests/save-guards.test.mjs web/tests/reminder-consistency.test.mjs
git commit -m "feat: 운영 모델이 없으면 AI 변경안 생성을 503 '준비 중'으로 막는다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 화면 — AI '준비 중' 안내, 메일·AI 약속 문구 정리

**Files:**
- Modify: `web/components/change-review.tsx` (상태 1개, `refresh`, 프로젝트 모드 분기)
- Modify: `web/components/task-editor.tsx:62-65, 139`
- Modify: `web/components/task-collection.tsx:457`
- Modify: `web/components/landing-page.tsx:462, 854`
- Modify: `.claude/launch.json` (확인용 서버 설정 1개)
- Test: `web/tests/landing-race.test.mjs`

**Interfaces:**
- Consumes: Task 2의 GET 목록 응답 `aiAvailable: boolean`
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/landing-race.test.mjs`의 `test('구현되지 않은 진단·팀 매칭·증명 장면은 준비 중이라고 밝힌다'` 테스트를 다음으로 바꾼다:

```js
test('구현되지 않은 출발 전 설계(AI)·진단·팀 매칭·증명 장면은 준비 중이라고 밝힌다', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync('components/landing-page.tsx', 'utf8');
  for (const id of ['setup', 'diagnose', 'match', 'proof']) {
    const start = page.indexOf(`id="${id}"`);
    assert.ok(start > 0, id);
    const head = page.slice(start, page.indexOf('</h2>', start));
    assert.match(head, /준비 중/, id);
  }
  assert.doesNotMatch(page, /AI 변경안은 파일럿 단계/);
});

test('화면 문구는 보내지 않는 알림 메일을 약속하지 않는다', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['components/task-editor.tsx', 'components/task-collection.tsx']) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /독촉 이메일|이메일을 보냅니다/, f);
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd web && node --experimental-strip-types --test tests/landing-race.test.mjs`
Expected: FAIL 2개 — `setup`에 준비 중 없음, task-editor에 `이메일을 보냅니다`.

- [ ] **Step 3: 문구 구현**

`web/components/landing-page.tsx` 462행:

```tsx
              <p className="kicker">출발 전 설계</p>
```
→
```tsx
              <p className="kicker">
                출발 전 설계 <span className="soon">준비 중인 기능</span>
              </p>
```

854행 `화면 속 팀·업무·시간은 예시입니다. AI 변경안은 파일럿 단계입니다.` → `화면 속 팀·업무·시간은 예시입니다. AI 변경안은 준비 중입니다.`

`web/components/task-editor.tsx` 62-65행의 설명을 다음으로 바꾼다:

```tsx
          담당자와 남은 시간을 정하면 전원 하루 8시간 가정으로 실행 순서를
          계산합니다. 승인된 마감은 이 예상 종료와 별개입니다.
```

139행 `'비워두면 마감 미정으로 저장되고 독촉 이메일이 예약되지 않습니다. 프로젝트 최종 기한을 넘길 수 없습니다.'` → `'비워두면 마감 미정으로 저장됩니다. 프로젝트 최종 기한을 넘길 수 없습니다.'`

`web/components/task-collection.tsx` 457행 `: '미정 · 독촉 이메일 예약 없음'}` → `: '미정'}`

- [ ] **Step 4: 통과 확인**

Run: `cd web && node --experimental-strip-types --test tests/landing-race.test.mjs`
Expected: PASS, 실패 0.

- [ ] **Step 5: 변경안 화면 '준비 중' 구현**

`web/components/change-review.tsx`:
- `const [replayError, setReplayError] = useState('');` 다음 줄에 추가:

```tsx
  // 서버가 운영 모델이 없다고 알리면(false) 붙여넣기·변경안 만들기 대신 준비 중 안내를 보여준다.
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
```

- `refresh` 안의 목록 조회를 다음으로 바꾼다:

```tsx
    const history = (await call(
      '/api/change-proposals?project=' + encodeURIComponent(projectId),
    )) as { applications: Application[]; replayCases?: ReplayListItem[]; aiAvailable?: boolean };
    setApplications(history.applications);
    setReplayCases(history.replayCases ?? []);
    setAiAvailable(history.aiAvailable === true);
```

- 재생 모드 분기 끝의 `      ) : (\n        <>\n          <div className="content-grid">`(551-553행)를 다음으로 바꾼다(앞에 분기 하나를 끼운다):

```tsx
      ) : aiAvailable === false ? (
        <p className="empty-copy" role="note">
          AI 변경안은 준비 중입니다. 계획서를 붙여넣어 업무 변경안을 받는 기능은 아직
          열리지 않았습니다. 저장된 실제 AI 응답은 위 보기 모드에서 재생할 수 있습니다.
        </p>
      ) : (
        <>
          <div className="content-grid">
```

- [ ] **Step 6: 타입·린트**

Run: `cd web && npx tsc --noEmit && npx oxlint components/change-review.tsx components/task-editor.tsx components/task-collection.tsx components/landing-page.tsx`
Expected: tsc 출력 없음, oxlint 새 오류 0(기존 경고는 이전과 같은 수).

- [ ] **Step 7: 화면 확인(AI 꺼짐)**

`.claude/launch.json`의 `configurations`에 추가:

```json
    {
      "name": "projectmate-ai-off",
      "runtimeExecutable": "env",
      "runtimeArgs": ["AI_FAKE_MODEL=0", "npm", "--prefix", "web", "run", "dev", "--", "--port", "3101"],
      "port": 3101
    }
```

`preview_start {name: "projectmate-ai-off"}`로 띄운다. 개발 헤더로 시드 프로젝트를 조회해 변경안 목록 응답의 `aiAvailable`이 false인지 확인한다:

```bash
curl -s 'http://localhost:3101/api/projects' -H 'oai-authenticated-user-id: dev-seed-lead-pm-qa' -H 'oai-authenticated-user-email: dev-seed-lead@projectmate.local' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).projects.map(p=>p.id).join('\n')))"
curl -s "http://localhost:3101/api/change-proposals?project=<위 ID>" -H 'oai-authenticated-user-id: dev-seed-lead-pm-qa' -H 'oai-authenticated-user-email: dev-seed-lead@projectmate.local' | grep -o '"aiAvailable":[a-z]*'
```

Expected: `"aiAvailable":false`. 브라우저(로그인은 사용자가 이미 해 둔 Supabase 세션, 같은 DB)에서 AI 변경안 탭에 준비 중 안내가 보이고 붙여넣기 입력이 없는지 스크린샷으로 확인한다. 3100 서버(`AI_FAKE_MODEL=1`)에서는 붙여넣기 입력이 그대로 보인다. 확인 후 `preview_stop`.

- [ ] **Step 8: 커밋**

```bash
git add web/components/change-review.tsx web/components/task-editor.tsx web/components/task-collection.tsx web/components/landing-page.tsx web/tests/landing-race.test.mjs .claude/launch.json
git commit -m "feat: AI 변경안 '준비 중' 화면, 보내지 않는 메일 문구 정리

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Vercel 설정과 문서

**Files:**
- Create: `web/vercel.json`
- Modify: `CLAUDE.md:19, 24, 39`
- Modify: `web/README.md:111-113` (소스와 배포), 로컬 실행 DB 문단
- Modify: `docs/features.md:4-6, 72-73`
- Modify: `docs/reminders-operations.md:4-5`

**Interfaces:**
- Consumes: Task 1~3 동작
- Produces: 없음

- [ ] **Step 1: `web/vercel.json` 생성**

```json
{ "regions": ["icn1"] }
```

- [ ] **Step 2: DB 주소 없이 운영 빌드**

Run: `cd web && DATABASE_URL= npx next build > ../.superpowers/build.log 2>&1; echo exit=$?; tail -15 ../.superpowers/build.log`
Expected: `exit=0`. 빌드 중 `database()`를 부르는 모듈이 없음을 확인한다(Review Focus 1). 실패하면 해당 페이지가 빌드 때 DB를 읽는 원인을 찾는다(systematic-debugging).

- [ ] **Step 3: 문서 수정**

`CLAUDE.md` 19행을 다음으로 바꾼다:

```
아직 구현·검증하지 않은 것: 운영 AI 모델 호출(가짜 모델까지만 검증, 배포 환경에서는 '준비 중'), 배포 환경의 로그인(Supabase Auth Google 로그인과 두 계정 초대·수락은 로컬 개발 서버에서만 검증), 자동 모집·매칭, 실제 결제·환급. 메일 알림은 제품에서 뺐다(사용자 결정 2026-10-04, 마감 임박은 화면으로 표현할 예정). 알림 코드는 남아 있으나 운영에서 실행하지 않는다. 구현되지 않은 것을 서비스 기능으로 설명하지 않는다.
```

24행의 `운영 배포(Vercel)는 아직 없다(사용자 결정 2026-10-03).`를 다음으로 바꾼다:

```
배포는 Vercel 팀 내부용이다: main=운영, PR=미리보기, 모든 환경이 Supabase 프로젝트 하나를 공유한다(사용자 결정 2026-10-04). 실제 서비스 전에는 운영 DB를 나눈다(docs/superpowers/specs/2026-10-04-vercel-deploy-design.md 8절).
```

39행의 `이메일 운영 절차: docs/reminders-operations.md.`를 `메일 알림(제외됨) 기록: docs/reminders-operations.md.`로 바꾼다.

`web/README.md` 113행(`` `Final_Project` 저장소의 `web/`이 서비스 소스다. 운영 배포는 아직 없다. …``)을 다음으로 바꾼다:

```
`Final_Project` 저장소의 `web/`이 서비스 소스다. 배포는 Vercel 팀 내부용이다(`docs/superpowers/specs/2026-10-04-vercel-deploy-design.md`). `main` 머지는 운영, PR·브랜치 푸시는 미리보기로 배포되며 모든 환경이 같은 Supabase DB를 쓴다.

- Vercel 프로젝트: Root Directory `web`, 지역은 `vercel.json`의 `icn1`(Supabase 서울과 같은 곳). Vercel의 Supabase 연동(Add)은 쓰지 않는다.
- 환경변수(Production·Preview 같은 값): `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL`(트랜잭션 풀러 6543). `AUTH_DEV_HEADERS`·`AI_FAKE_MODEL`은 넣지 않는다(넣어도 운영에서는 무시된다). `NEXT_PUBLIC_*`는 빌드 때 박히므로 바꾸면 다시 배포한다.
- 미리보기 접근: Deployment Protection의 Vercel Authentication을 끈다. 접근 제어는 앱의 Google 로그인과 프로젝트 멤버 확인이다.
- Supabase Auth: Site URL은 운영 주소, Redirect URLs에 `https://<운영주소>/**`, `https://*-<vercel계정>.vercel.app/**`, `http://localhost:*/**`.
- 마이그레이션은 자동으로 돌지 않는다. `db/migrations/`에 새 파일이 생기는 PR은 머지 전에 `.env.local`의 `DATABASE_URL`로 `npm run db:migrate`를 실행한다. 미리보기도 같은 DB를 쓰므로 컬럼 삭제·이름 변경은 하지 않는다.
- AI 변경안은 운영 모델이 연결되지 않아 배포 환경에서 '준비 중'이다(`lib/ai-extraction.ts` `aiAvailable`).
```

같은 파일 로컬 실행 DB 문단(37행, `DB는 Postgres다. ...`) 끝에 한 문장 추가:

```
운영 모드(`next build && next start`, Vercel)에서는 `DATABASE_URL`이 꼭 있어야 한다. 없으면 로컬 파일로 넘어가지 않고 API가 503을 돌려준다.
```

`docs/features.md` 4-6행을 다음으로 바꾼다(줄바꿈 폭은 기존과 같게):

```
현재 파일럿은 여러 프로젝트 생성, 목표 합의와 버전별 재동의, 이메일 지정 초대 링크,
팀장·팀원 권한, 준비/진행/완주/기한 종료 상태, 결과물 기준 완주, 승인된 업무 마감,
원문 붙여넣기와 AI 변경안 검토(배포 환경에서는 '준비 중')를 지원한다. 독촉 이메일은
제품에서 뺐다(사용자 결정 2026-10-04).
```

72-73행을 다음으로 바꾼다:

```
**메일 알림은 제품에서 뺐다(사용자 결정 2026-10-04).** 마감 임박은 화면으로 표현할 예정이다.
아래 예약·발송 코드는 남아 있으나 운영에서 실행하지 않는다(실행 비밀값이 없으면 진입점이 401). 기록: [운영 문서](reminders-operations.md).
```

`docs/reminders-operations.md` 4행 앞에 한 줄을 넣는다:

```
**2026-10-04: 메일 알림은 제품에서 뺐다(사용자 결정).** 이 문서는 남아 있는 코드의 기록용이다.

```

- [ ] **Step 4: 전체 검증**

Run: `cd web && npm test > ../.superpowers/full-test.log 2>&1; echo test=$?; grep -E '^ℹ (tests|pass|fail)' ../.superpowers/full-test.log; npx tsc --noEmit; echo tsc=$?`
Expected: `test=0`, fail 0(이전 186 + 이번 4 = 190), `tsc=0`.

- [ ] **Step 5: 커밋**

```bash
git add web/vercel.json CLAUDE.md web/README.md docs/features.md docs/reminders-operations.md
git commit -m "docs: Vercel 팀 내부 배포 설정·절차, 메일 알림 제외 반영

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 배포와 배포 후 검증 (Postgres 브랜치·이 브랜치 머지 후)

이 Task는 외부 시스템(Vercel·Supabase 대시보드, 운영 주소)을 다룬다. 사용자 작업과 Claude 확인을 번갈아 한다. 비밀값은 사용자가 대시보드에 직접 넣고 Claude는 이름만 확인한다.

**Files:**
- Modify(검증 후): `CLAUDE.md:19` 배포 로그인 검증 문구, `docs/current-sprint.md`(결과 기록)

- [ ] **Step 1: (Claude) PR**

Postgres 브랜치가 `main`에 머지된 뒤 `vercel-deploy`를 `main`에 맞추고(`git rebase origin/main` 또는 merge), Codex 리뷰 후 PR을 만든다. 본문에 Task 5 사용자 단계를 체크리스트로 적는다.

- [ ] **Step 2: (사용자) Vercel 설정 — 배포 전에**

Vercel 프로젝트 Settings: 이름 정리(선택) → Environment Variables에 4개를 Production·Preview로 → Deployment Protection에서 Vercel Authentication 끄기. Review Focus 2: 환경변수를 넣기 전에 배포가 돌았으면 Redeploy.

- [ ] **Step 3: (사용자) PR 머지 → 첫 운영 배포**

- [ ] **Step 4: (사용자) Supabase Auth URL**

Authentication → URL Configuration: Site URL = 운영 주소. Redirect URLs에 `https://<운영주소>/**`, `https://*-<vercel계정>.vercel.app/**` 추가(`http://localhost:*/**` 유지).

- [ ] **Step 5: (Claude) 운영 주소 확인**

```bash
U=https://<운영주소>
for p in / /workspace; do printf "%s %s\n" $p "$(curl -s -o /dev/null -w '%{http_code}' $U$p)"; done
curl -s -o /dev/null -w 'api no-auth %{http_code}\n' $U/api/projects
curl -s -o /dev/null -w 'api dev-header %{http_code}\n' -H 'oai-authenticated-user-id: probe' -H 'oai-authenticated-user-email: probe@test.local' $U/api/projects
curl -sI $U/api/projects | grep -i '^x-vercel-id'
```

Expected: `/ 200`, `/workspace 200`, `api no-auth 401`, `api dev-header 401`, `x-vercel-id`에 `icn1`. 10분 이상 지난 뒤 `curl -s -o /dev/null -w '%{http_code}' $U/api/projects`가 401(503이 아님, ⑤ 유휴 연결).

- [ ] **Step 6: (사용자 + 팀원 1명) 실제 사용**

운영 주소: Google 로그인 → 프로젝트 생성 → 새로고침 후 유지 → 팀원 초대 → 팀원 계정으로 수락 → AI 변경안 탭 '준비 중'. 미리보기: 아무 PR의 미리보기 주소에서 Google 로그인 후 **같은 미리보기 주소로 돌아오는지**(Review Focus 3). 협업자 커밋이 미리보기로 배포되는지.

Claude는 Supabase에서 실제 사용자 멤버 행이 늘었는지 이름·값 없이 개수만 확인한다.

- [ ] **Step 7: (Claude) 기록**

`CLAUDE.md` 19행의 `배포 환경의 로그인(… 로컬 개발 서버에서만 검증)`을 검증 결과에 맞게 고치고, `docs/current-sprint.md`에 2026-10-04 배포 결과(주소, 확인 항목, 남은 제한: 협업자 커밋 배포 여부·미리보기 DB 공유)를 적는다. 실패한 항목은 그대로 실패로 적는다.

```bash
git add CLAUDE.md docs/current-sprint.md
git commit -m "docs: Vercel 팀 내부 배포 검증 결과

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
