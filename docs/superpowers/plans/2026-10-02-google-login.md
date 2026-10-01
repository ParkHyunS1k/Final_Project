# Google 로그인(Supabase Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 호스팅 플랫폼 헤더 대신 Supabase Auth(Google) 토큰으로 사용자를 확인해, 직접 배포해도 로그인이 동작하게 한다.

**Architecture:** 화면은 `supabase-js`로 Google 로그인하고 API 호출마다 `Authorization: Bearer <access_token>`을 붙인다. 서버 `identity()`는 `jose`로 Supabase JWKS 서명·iss·aud·만료를 검증한다. 기존 `oai-authenticated-*` 헤더는 `AUTH_DEV_HEADERS=1`(로컬 개발·테스트)일 때만 읽는다. 데이터는 D1 그대로.

**Tech Stack:** vinext(Next 호환, Cloudflare Workers), D1, `jose` 6, `@supabase/supabase-js` 2, node:test + esbuild 번들 테스트.

**Spec:** `docs/superpowers/specs/2026-10-02-google-login-design.md`

## Global Constraints

- 제공자는 Google만. 카카오·GitHub·이메일 OTP 없음.
- 데이터는 D1 유지. 서버는 Supabase 서비스 키를 쓰지 않는다. 서버 변수는 `SUPABASE_URL` 하나.
- 토큰 검증: `issuer = SUPABASE_URL + '/auth/v1'`, `audience = 'authenticated'`, JWKS `SUPABASE_URL + '/auth/v1/.well-known/jwks.json'`.
- 이메일은 `trim().toLowerCase()`. 이름은 `user_metadata.full_name || user_metadata.name || 이메일 앞부분 || '팀원'`, 60자 제한.
- `AUTH_DEV_HEADERS`는 `'1'`일 때만 헤더 경로를 연다. 운영 빌드 산출물에 들어가면 안 된다.
- Bearer 헤더가 있으면 검증 결과만 쓴다. 실패해도 개발 헤더로 넘어가지 않는다.
- 기존 데이터 이전 코드 없음. 별도 로그인 페이지·프로필 편집·SSR 세션 없음.
- 권한·멤버십 로직(`member()`, 초대 이메일 비교 등)은 바꾸지 않는다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. Google 계정 이메일에 대문자가 섞인 경우 → 소문자로 정규화되어 초대 이메일과 일치해야 한다. (Task 1 테스트 5)
2. 잘못된 Bearer와 `oai-authenticated-*` 헤더가 함께 오고 `AUTH_DEV_HEADERS=1`인 경우 → 401. 헤더로 넘어가면 사칭이 된다. (Task 1 테스트 3)
3. Supabase JWKS 요청이 실패하는 경우 → 500이 아니라 401. (Task 1 테스트 0)
4. `npm run build` 산출물(`dist/server/wrangler.json`)에 `AUTH_DEV_HEADERS`가 들어가는 경우 → 배포 시 누구나 사칭 가능. 빌드 후 grep으로 확인. (Task 2 Step 9)
5. 초대 링크(`/workspace?invite=...`)에서 Google 로그인 후 돌아왔을 때 → `invite` 쿼리가 남아 초대 확인 화면이 떠야 한다. (Task 3 수동 확인)

---

## File Structure

| 파일 | 역할 |
|---|---|
| Create `web/lib/auth.ts` | `Identity` 타입, `identity(request)` — 토큰 검증과 개발 헤더 경로 |
| Modify `web/lib/projects.ts:40-63` | 기존 `identity`·`Identity` 제거, `./auth`에서 가져와 다시 내보냄 |
| Modify `web/app/api/{projects,sprint,sources,change-proposals}/route.ts` | `identity(request)` → `await identity(request)` (8곳) |
| Create `web/tests/auth.test.mjs` | 토큰 검증·사칭 차단·계정 분리 테스트 |
| Modify `web/tests/{api,reminder-consistency,reminder-dispatch,change-proposals,apply-revert,save-guards}.test.mjs` | 가짜 `env`에 `AUTH_DEV_HEADERS: '1'` |
| Modify `web/package.json` | `jose`, `@supabase/supabase-js` 의존성, `test` 스크립트에 `tests/auth.test.mjs` |
| Create `web/lib/supabase-browser.ts` | 브라우저 클라이언트, `apiFetch`, `signInWithGoogle`, `signOut` |
| Modify `web/app/workspace/page.tsx` | `fetch` 4곳, 로그인 버튼 |
| Modify `web/components/project-workspace.tsx` | `api()`의 `fetch`, 로그인 버튼, 로그아웃, 초대 문구 |
| Modify `web/components/change-review.tsx` | `call()`의 `fetch` |
| Modify `web/vite.config.ts` | 로컬 vars에 `SUPABASE_URL`, 개발 모드 한정 `AUTH_DEV_HEADERS` |
| Create `web/.env.example`, Modify `web/.gitignore` | 변수 이름 예시, `!.env.example` |
| Modify `docs/dev-team-seed-notes.md`, `CLAUDE.md` | Task 3 |

---

### Task 1: 서버 토큰 검증

**Files:**
- Create: `web/lib/auth.ts`
- Modify: `web/lib/projects.ts:40-63`
- Modify: `web/app/api/projects/route.ts`, `web/app/api/sprint/route.ts`, `web/app/api/sources/route.ts`, `web/app/api/change-proposals/route.ts`
- Modify: 기존 테스트 6개 파일의 가짜 `env`
- Test: `web/tests/auth.test.mjs`

**Interfaces:**
- Produces: `identity(request: Request): Promise<Identity | null>`, `type Identity = { id: string; email: string; name: string }` — `@/lib/auth`에서 정의, `@/lib/projects`에서도 다시 내보낸다(라우트 import는 그대로).
- 서버 환경: `env.SUPABASE_URL`(끝 `/` 없이), `env.AUTH_DEV_HEADERS`.

모든 명령은 `web/`에서 실행한다.

- [ ] **Step 1: `jose`를 직접 의존성으로 추가**

```bash
npm install jose@^6
```

Expected: `package.json` `dependencies`에 `"jose"`가 생긴다(이미 하위 의존성으로 lockfile에 6.x가 있다).

- [ ] **Step 2: 실패하는 테스트 작성 — `web/tests/auth.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// --- D1 대역(tests/api.test.mjs와 같은 방식, 쓰기 직전 훅은 필요 없어 뺐다) ---
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const name of readdirSync('drizzle')
  .filter((n) => n.endsWith('.sql'))
  .sort())
  db.exec(readFileSync('drizzle/' + name, 'utf8'));
class Prepared {
  constructor(sql, args = []) {
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Prepared(this.sql, args);
  }
  async first() {
    return db.prepare(this.sql).get(...this.args) ?? null;
  }
  async run() {
    return this.execute();
  }
  async all() {
    return this.execute();
  }
  execute() {
    const st = db.prepare(this.sql);
    if (/^\s*SELECT/.test(this.sql))
      return { results: st.all(...this.args), meta: { changes: 0 }, success: true };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes) }, success: true };
  }
}
globalThis.__TEST_DB = {
  prepare: (sql) => new Prepared(sql),
  async batch(statements) {
    db.exec('BEGIN');
    try {
      const rows = statements.map((s) => s.execute());
      db.exec('COMMIT');
      return rows;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

// --- Supabase 대역: 키 쌍과 JWKS 응답 ---
const SUPABASE = 'https://ref.supabase.test';
const JWKS_URL = SUPABASE + '/auth/v1/.well-known/jwks.json';
globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };
const { privateKey, publicKey } = await generateKeyPair('ES256');
const stranger = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
let jwksDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === JWKS_URL) {
    if (jwksDown) throw new TypeError('network down');
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};
async function token(
  { sub = 'user-a', ...claims } = {},
  { key = privateKey, iss = SUPABASE + '/auth/v1', aud = 'authenticated', exp = '1h' } = {},
) {
  return new SignJWT({
    email: 'a@test.local',
    user_metadata: { full_name: '에이' },
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(sub)
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

// --- 라우트 번들 ---
const dir = mkdtempSync(join(tmpdir(), 'projectmate-auth-test-'));
const outfile = join(dir, 'route.mjs');
await build({
  stdin: {
    contents:
      "export { GET as sprintGET } from './app/api/sprint/route'; export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'test-d1',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'd1', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export const env=new Proxy({},{get:(_,k)=>k==="DB"?globalThis.__TEST_DB:globalThis.__TEST_ENV?.[k]});',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);

const bearer = (t) => ({
  authorization: 'Bearer ' + t,
  'content-type': 'application/json',
  origin: 'https://test.local',
});
const me = (headers) =>
  api.projectsGET(new Request('https://test.local/api/projects', { headers }));
const projectPost = (headers, body) =>
  api.projectsPOST(
    new Request('https://test.local/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
const sprint = (headers, id) =>
  api.sprintGET(
    new Request('https://test.local/api/sprint?project=' + encodeURIComponent(id), { headers }),
  );
const goal = {
  action: 'create',
  title: '로그인 테스트',
  goal: '토큰으로 만든 프로젝트',
  scope: '생성',
  completionCriteria: '조회된다',
  deliverables: '서비스',
  duration: 7,
  agreed: true,
};
async function createProject(t) {
  const r = await projectPost(bearer(t), goal);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).projectId;
}

// JWKS를 처음 받기 전에 실행해야 한다(jose가 받은 키를 캐시한다).
test('JWKS를 못 받으면 500이 아니라 401', async () => {
  jwksDown = true;
  try {
    assert.equal((await me(bearer(await token()))).status, 401);
  } finally {
    jwksDown = false;
  }
});

test('올바른 토큰이면 토큰의 사용자로 저장하고 다시 조회된다', async () => {
  const t = await token();
  const r = await me(bearer(t));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).me, { name: '에이', email: 'a@test.local' });
  const id = await createProject(t);
  const s = await sprint(bearer(t), id);
  assert.equal(s.status, 200, await s.clone().text());
  const list = await (await me(bearer(t))).json();
  assert.ok(list.projects.some((p) => p.id === id));
});

test('검증에 실패한 토큰은 모두 401', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const bad = {
    expired: await token({}, { exp: past }),
    wrongIssuer: await token({}, { iss: 'https://evil.test/auth/v1' }),
    wrongAudience: await token({}, { aud: 'anon' }),
    strangerKey: await token({}, { key: stranger.privateKey }),
    noEmail: await token({ email: undefined }),
    garbage: 'not-a-jwt',
  };
  for (const [name, t] of Object.entries(bad))
    assert.equal((await me(bearer(t))).status, 401, name);
});

test('개발 헤더는 AUTH_DEV_HEADERS=1일 때만, Bearer가 있으면 쓰지 않는다', async () => {
  const dev = {
    'oai-authenticated-user-id': 'mallory',
    'oai-authenticated-user-email': 'a@test.local',
  };
  assert.equal((await me(dev)).status, 401);
  globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE, AUTH_DEV_HEADERS: '1' };
  try {
    assert.equal((await me(dev)).status, 200);
    assert.equal((await me({ ...dev, authorization: 'Bearer not-a-jwt' })).status, 401);
  } finally {
    globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };
  }
});

test('다른 계정의 프로젝트는 볼 수 없다', async () => {
  const id = await createProject(await token({ sub: 'owner-x', email: 'x@test.local' }));
  const other = await token({ sub: 'user-y', email: 'y@test.local' });
  assert.equal((await sprint(bearer(other), id)).status, 403);
});

test('대문자가 섞인 Google 이메일도 초대와 일치한다', async () => {
  const owner = await token({ sub: 'owner-z', email: 'z@test.local' });
  const id = await createProject(owner);
  const state = await (await sprint(bearer(owner), id)).json();
  const invite = await projectPost(bearer(owner), {
    action: 'invite',
    projectId: id,
    revision: state.sprint.revision,
    email: 'mate@test.local',
  });
  assert.equal(invite.status, 201, await invite.clone().text());
  const mate = await token({ sub: 'mate-1', email: 'Mate@Test.Local' });
  const accepted = await projectPost(bearer(mate), {
    action: 'accept',
    token: (await invite.json()).token,
    agreed: true,
    goalVersion: state.policy.goalVersion,
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --experimental-strip-types --test tests/auth.test.mjs`
Expected: FAIL — 지금 `identity()`는 Bearer를 읽지 않으므로 "올바른 토큰" 테스트가 401로 실패하고, 개발 헤더 테스트도 첫 단언(플래그 없이 401)에서 실패한다.

- [ ] **Step 4: `web/lib/auth.ts` 작성**

```ts
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Identity = { id: string; email: string; name: string };

type AuthEnv = { SUPABASE_URL?: string; AUTH_DEV_HEADERS?: string };
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function displayName(name: string, email: string) {
  return (name || email.split('@')[0] || '팀원').slice(0, 60);
}

/** Supabase가 발급한 access token만 받는다. 검증 실패·키 조회 실패는 모두 null. */
async function fromToken(token: string): Promise<Identity | null> {
  const base = ((env as unknown as AuthEnv).SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  jwks ??= createRemoteJWKSet(new URL(base + '/auth/v1/.well-known/jwks.json'));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: base + '/auth/v1',
      audience: 'authenticated',
    });
    const email =
      typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!payload.sub || !email) return null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.full_name === 'string'
        ? meta.full_name
        : typeof meta.name === 'string'
          ? meta.name
          : '';
    return { id: payload.sub, email, name: displayName(name, email) };
  } catch {
    return null;
  }
}

/** 로컬 개발·테스트 전용. 호스팅 플랫폼 형식의 헤더를 그대로 믿는다. */
function fromDevHeaders(request: Request): Identity | null {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) return null;
  const email = (request.headers.get('oai-authenticated-user-email') ?? '')
    .trim()
    .toLowerCase();
  let name = request.headers.get('oai-authenticated-user-full-name') ?? '';
  if (
    request.headers.get('oai-authenticated-user-full-name-encoding') ===
    'percent-encoded-utf-8'
  ) {
    try {
      name = decodeURIComponent(name);
    } catch {
      name = '';
    }
  }
  return { id, email, name: displayName(name, email) };
}

export async function identity(request: Request): Promise<Identity | null> {
  const auth = request.headers.get('authorization') ?? '';
  // Bearer가 있으면 그 결과만 쓴다. 실패해도 개발 헤더로 넘어가지 않는다.
  if (auth.startsWith('Bearer ')) return fromToken(auth.slice(7).trim());
  // 운영에서 켜지면 누구나 헤더로 사칭할 수 있다. 로컬 개발(vite dev)과 테스트에만 둔다.
  if ((env as unknown as AuthEnv).AUTH_DEV_HEADERS === '1')
    return fromDevHeaders(request);
  return null;
}
```

- [ ] **Step 5: `web/lib/projects.ts`에서 기존 구현을 걷어내고 다시 내보내기**

`lib/projects.ts:40-63`(`export type Identity = ...`부터 `identity()` 함수 끝 `}`까지)을 지우고, 같은 자리에 다음 두 줄을 넣는다.

```ts
import type { Identity } from './auth';
export { identity, type Identity } from './auth';
```

(파일 맨 위 import 묶음으로 옮겨도 된다. 파일 안의 나머지 `Identity` 사용처는 그대로 둔다.)

- [ ] **Step 6: 라우트 8곳에 `await` 추가**

```bash
sed -i '' 's/const user = identity(request);/const user = await identity(request);/' app/api/projects/route.ts app/api/sprint/route.ts app/api/sources/route.ts app/api/change-proposals/route.ts
grep -n "identity(request)" app/api/*/route.ts
```

Expected: 8줄 모두 `await identity(request)`. 각 줄이 `export async function` 안에 있는지 확인한다(아니면 타입 검사에서 걸린다).

- [ ] **Step 7: 기존 테스트의 가짜 `env`에 개발 헤더 플래그 추가**

`tests/api.test.mjs` 93행:

```js
          contents: 'export const env={DB:globalThis.__TEST_DB,AUTH_DEV_HEADERS:"1"};',
```

`tests/reminder-consistency.test.mjs`, `tests/reminder-dispatch.test.mjs`, `tests/change-proposals.test.mjs`, `tests/apply-revert.test.mjs`, `tests/save-guards.test.mjs`의 `export const env=new Proxy(...)` 줄(92~94행):

```js
            'export const env=new Proxy({},{get:(_,k)=>k==="DB"?globalThis.__TEST_DB:k==="AUTH_DEV_HEADERS"?"1":globalThis.__TEST_ENV?.[k]});',
```

- [ ] **Step 8: `test` 스크립트에 새 테스트 추가**

`package.json`의 `"test"` 값 끝(`tests/landing-race.test.mjs` 뒤)에 ` tests/auth.test.mjs`를 붙인다.

- [ ] **Step 9: 전체 테스트·타입·린트**

```bash
npm test
npx tsc --noEmit
npm run lint
```

Expected: 테스트 전부 PASS(새 `auth.test.mjs` 6개 포함), 타입 오류 0, 린트 오류 0. 실패하면 출력 그대로 기록하고 원인을 고친다.

- [ ] **Step 10: 커밋**

```bash
git add lib/auth.ts lib/projects.ts app/api tests package.json package-lock.json
git commit -m "feat: Supabase 토큰으로 사용자 확인, 개발 헤더는 AUTH_DEV_HEADERS일 때만

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 화면 로그인·API 호출·설정

**Files:**
- Create: `web/lib/supabase-browser.ts`, `web/.env.example`
- Modify: `web/app/workspace/page.tsx` (165-170, 182-185, 261-264, 312-315, 384-399)
- Modify: `web/components/project-workspace.tsx` (5-31 lucide import, 132-133, 287-293 SidebarFooter, 308-323, 566)
- Modify: `web/components/change-review.tsx:85-86`
- Modify: `web/vite.config.ts:41-50`, `web/.gitignore:30`

**Interfaces:**
- Consumes: 서버는 Task 1의 `Authorization: Bearer` 처리.
- Produces: `supabase: SupabaseClient | null`, `apiFetch(path: string, init?: RequestInit): Promise<Response>`, `signInWithGoogle(): Promise<void>`, `signOut(): Promise<void>` — `@/lib/supabase-browser`.

브라우저 연결 코드라 단위 테스트는 두지 않는다. 검증은 타입·린트·빌드와 Task 3 수동 확인으로 한다.

- [ ] **Step 1: 의존성 추가**

```bash
npm install @supabase/supabase-js@^2
```

- [ ] **Step 2: `web/lib/supabase-browser.ts` 작성**

```ts
/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// 값이 없으면(.env.local 미설정 로컬 개발) 토큰 없이 요청한다. 서버는 AUTH_DEV_HEADERS로만 받는다.
export const supabase =
  url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;

/** getSession()은 Google에서 돌아온 직후 ?code= 교환이 끝날 때까지 기다린다. */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const session = supabase && (await supabase.auth.getSession()).data.session;
  const headers = new Headers(init.headers);
  if (session) headers.set('Authorization', 'Bearer ' + session.access_token);
  return fetch(path, { ...init, headers });
}

/** 지금 주소(?create=1, ?invite= 포함)로 돌아온다. */
export async function signInWithGoogle() {
  if (!supabase) throw new Error('VITE_SUPABASE_URL·VITE_SUPABASE_ANON_KEY가 필요합니다.');
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname + location.search },
  });
}

export async function signOut() {
  await supabase?.auth.signOut();
  location.assign('/');
}
```

- [ ] **Step 3: `app/workspace/page.tsx` — import와 `fetch` 4곳**

import 묶음에 추가:

```ts
import { apiFetch, signInWithGoogle } from '@/lib/supabase-browser';
```

다음 네 호출의 `fetch(`를 `apiFetch(`로 바꾼다. 인자와 응답 처리는 그대로 둔다.
- 168행 `const res = await fetch(` (load)
- 182행 `fetch('/api/sprint?project=' + ...` (useEffect)
- 261행 `const res = await fetch('/api/sprint', {` (POST)
- 312행 `const res = await fetch(` (export)

```bash
grep -n "fetch(" app/workspace/page.tsx
```

Expected: 남은 줄이 모두 `apiFetch(`.

- [ ] **Step 4: `app/workspace/page.tsx` — 로그인 버튼 (384-399)**

```tsx
            {needsLogin && (
              <a
                className="btn primary"
                ...
                ChatGPT로 로그인
              </a>
            )}
```

블록 전체를 다음으로 바꾼다.

```tsx
            {needsLogin && (
              <button
                className="btn primary"
                onClick={() => void signInWithGoogle()}
              >
                Google로 로그인
              </button>
            )}
```

- [ ] **Step 5: `components/project-workspace.tsx`**

1. lucide import(31행 `} from 'lucide-react';`로 끝나는 묶음)에 `LogOut,`를 추가한다.
2. import 묶음에 `import { apiFetch, signInWithGoogle, signOut } from '@/lib/supabase-browser';` 추가.
3. 133행 `api()` 안의 `const res = await fetch(path, {` → `const res = await apiFetch(path, {`.
4. 308-323행 `{error.includes('로그인') && ( <a ... ChatGPT로 로그인 </a> )}`를 다음으로 바꾼다.

```tsx
            {error.includes('로그인') && (
              <button
                className="btn primary"
                onClick={() => void signInWithGoogle()}
              >
                Google로 로그인
              </button>
            )}
```

5. `<SidebarFooter>` 바로 안, `<p className="sidebar-note">` 앞에 추가:

```tsx
          <WorkspaceButton onClick={() => void signOut()}>
            <LogOut size={16} />
            로그아웃
          </WorkspaceButton>
```

6. 566행 `팀원의 ChatGPT 로그인 이메일` → `팀원의 Google 계정 이메일`.

- [ ] **Step 6: `components/change-review.tsx`**

import 묶음에 `import { apiFetch } from '@/lib/supabase-browser';` 추가, 86행 `call()` 안의 `const res = await fetch(path, {` → `const res = await apiFetch(path, {`.

```bash
grep -rn "fetch(\|ChatGPT\|signin-with-chatgpt" app components lib | grep -v "components/landing" | grep -v "apiFetch(\|lib/supabase-browser.ts"
```

Expected: 출력 없음.

- [ ] **Step 7: `vite.config.ts` 로컬 vars**

41-49행 키 목록 배열에 `'SUPABASE_URL',`을 추가하고, 50행을 다음으로 바꾼다.

```ts
  // AUTH_DEV_HEADERS는 vite dev에서만. build 산출물(dist/server/wrangler.json)에 들어가면 배포 시 헤더 사칭이 열린다.
  const localBindingConfig = {
    ...baseLocalBindingConfig,
    vars: {
      ...liveModelVars,
      ...(mode === 'development' ? { AUTH_DEV_HEADERS: '1' } : {}),
    },
  };
```

- [ ] **Step 8: `.env.example`과 `.gitignore`**

`web/.gitignore` 30행 `.env*` 바로 아래에 `!.env.example` 추가. `web/.env.example`:

```
# Supabase(Google 로그인). Supabase 대시보드 → Project Settings → API.
# 서버(토큰 검증)
SUPABASE_URL=
# 화면(빌드 시 포함, 공개돼도 되는 값)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

- [ ] **Step 9: 타입·린트·테스트·빌드, 산출물에 개발 플래그가 없는지 확인**

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
grep -c AUTH_DEV_HEADERS dist/server/wrangler.json
```

Expected: 타입·린트 오류 0, 테스트 전부 PASS, 빌드 성공, 마지막 grep 결과 `0`. (산출물 경로가 다르면 `grep -rl AUTH_DEV_HEADERS dist`로 찾아 비어 있는지 확인한다.)

- [ ] **Step 10: 커밋**

```bash
git add lib/supabase-browser.ts app/workspace/page.tsx components/project-workspace.tsx components/change-review.tsx vite.config.ts .gitignore .env.example package.json package-lock.json
git commit -m "feat: Google 로그인 버튼, API 호출에 Supabase 토큰 첨부, 로그아웃

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 외부 설정·실제 두 계정 확인·문서

**Files:**
- Modify: `docs/dev-team-seed-notes.md`
- Modify: `CLAUDE.md` (수동 확인 통과 시에만)

- [ ] **Step 1: 사용자가 할 일 (코드 밖, 에이전트가 대신하지 않는다)**

1. Supabase 프로젝트 생성.
2. Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션). 승인된 리디렉션 URI: `https://<ref>.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → Sign In / Providers → Google: 클라이언트 ID·비밀값 입력 후 활성화. **Email 제공자는 끈다**(서버도 `app_metadata.provider !== 'google'` 토큰을 거절하지만, 가입 경로 자체를 닫는다).
   - Supabase → Project Settings → JWT Signing Keys가 비대칭 키(ECC/RSA)인지 확인하고, `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`에 키가 1개 이상 있는지 본다. 레거시 HS256만 있으면 서버 검증이 모두 401이 된다(서버 로그 `auth: token rejected`).
4. Supabase → Authentication → URL Configuration → Redirect URLs: `http://localhost:*/**` 추가(운영 도메인은 배포 때).
5. `web/.env.local`에 `.env.example`의 세 값 입력(`SUPABASE_URL`과 `VITE_SUPABASE_URL`은 같은 값).

- [ ] **Step 2: 로컬에서 실제 두 계정으로 확인**

개발 서버를 띄우고(launch.json 또는 `npm run dev`) 브라우저 두 개(또는 일반·시크릿 창)로 진행한다.

1. A: `/workspace?create=1` → 401 화면에 "Google로 로그인" → Google 로그인 → 같은 주소로 돌아와 프로젝트 생성 화면이 뜬다.
2. A: 프로젝트 생성 → 새로고침해도 로그인 유지·프로젝트 보임.
3. A: B의 Google 이메일로 초대 → 초대 링크 복사.
4. B: 초대 링크 열기 → Google 로그인 → **`?invite=`가 유지되어** 초대 확인 화면 → 수락.
5. B: 같은 프로젝트가 보인다. A 화면 새로고침 시 팀원 B가 보인다.
6. A: 사이드바 "로그아웃" → `/`로 이동, `/workspace` 재진입 시 로그인 버튼.
7. A: "Google로 로그인" → Google 동의 화면에서 취소 → 돌아온 화면에서 다시 "Google로 로그인" → 정상 로그인된다.
8. VITE 값을 넣고 `npm run build` 후 빌드 서버로 `/workspace`를 열어 SSR 오류가 없는지 확인한다.

각 단계 스크린샷을 남긴다. 하나라도 실패하면 Task 3을 멈추고 실패 단계·화면·콘솔/서버 로그를 보고한다.

- [ ] **Step 3: 문서 갱신**

`docs/dev-team-seed-notes.md`의 헤더 목록(85~88행 부근) 바로 앞에 한 줄:

```markdown
> 아래 `oai-authenticated-*` 헤더는 `AUTH_DEV_HEADERS=1`일 때만 서버가 읽는다. `vite dev`에서만 켜지고 빌드 산출물·운영에는 없다. 운영 로그인은 Supabase Auth(Google) 토큰이다.
```

Step 2를 모두 통과했을 때만 `CLAUDE.md`의 "아직 구현·검증하지 않은 것" 문장에서 `실제 두 계정 협업 검증, `을 지운다. 실패했거나 일부만 했으면 `CLAUDE.md`는 바꾸지 않는다.

- [ ] **Step 4: 커밋**

```bash
git add docs/dev-team-seed-notes.md CLAUDE.md
git commit -m "docs: 개발 헤더는 로컬 전용, Google 로그인 두 계정 확인

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 범위 밖 (이번 계획에 없음)

- 운영 `wrangler.jsonc`, 실제 D1 생성, 도메인 연결. `vite.config.ts`가 `@openai/sites-vite-plugin`과 `.openai/hosting.json`을 쓰고 있어, 직접 배포 작업에서 이 플러그인 처리도 함께 정해야 한다.
- 기존 데이터 이전, 별도 로그인 페이지, 프로필 편집, SSR 세션, 다른 소셜 제공자.
