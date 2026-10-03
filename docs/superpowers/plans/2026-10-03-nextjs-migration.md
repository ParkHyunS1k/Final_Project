# vinext → Next.js 실행 환경 이전 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 vinext(Cloudflare Workers)+D1에서 Next.js+로컬 SQLite 파일로 옮겨, Cloudflare·OpenAI Sites 의존 없이 로컬에서 동작하게 한다.

**Architecture:** D1과 같은 모양의 작은 DB 포트(`Db`/`Statement`)를 `lib/db.ts`에 두고 `node:sqlite`로 구현한다. SQL 100여 개는 그대로 둔다. 서버 환경값은 `cloudflare:workers` 대신 `process.env`에서 읽는다. 그다음 vinext·vite·wrangler를 걷어내고 `next`로 실행한다.

**Tech Stack:** Next.js 16, React 19.2, `node:sqlite`(Node ≥22.16), node:test + esbuild 번들 테스트.

**Spec:** `docs/superpowers/specs/2026-10-03-nextjs-migration-design.md`

## Global Constraints

- 작업 브랜치: `nextjs-migration`(이미 `phs`에서 땄다). `phs`/PR #2에 커밋하지 않는다.
- `next@^16`. `package.json` `"engines": { "node": ">=22.16" }`. 스펙의 22.13 대신 22.16이다: `StatementSync.columns()`가 22.16에 추가됐다.
- DB 경로: `process.env.DATABASE_PATH`, 없으면 `.data/projectmate.sqlite`(web/ 기준). 앱 시작 때 자동 마이그레이션 없음.
- 개발 헤더: `process.env.AUTH_DEV_HEADERS === '1' && process.env.NODE_ENV !== 'production'`일 때만.
- 화면 환경값: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`(코드에서 반드시 `process.env.NEXT_PUBLIC_…` 문자 그대로 써야 Next가 빌드 시 넣는다).
- SQL 문장, `db/schema.ts`, `drizzle.config.ts`, 권한·멤버십 로직은 바꾸지 않는다.
- 린트: 각 Task 시작 시 `npx oxlint > /tmp/lint-base.log`로 기준을 잡고, 끝에 새 오류 0(`diff <(grep error base|sort) <(grep error now|sort)`에 `>` 줄 없음).
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 모든 명령은 `web/`에서 실행한다.

## Review Focus

1. Next 개발 서버 HMR로 `lib/db.ts`가 다시 평가되면 연결이 계속 새로 열려 `database is locked`가 날 수 있다 → 연결을 `globalThis`에 캐시해 한 프로세스에 하나만 연다. (Task 1 Step 3 코드, Task 3 Step 10 수동 확인)
2. 마이그레이션 없이 `npm run dev`를 실행하면 `no such table` → README 실행 순서에 `db:migrate`를 먼저 적고, 서버 로그에 원인이 남는지 확인한다. (Task 4 Step 1)
3. Turbopack이 `node:sqlite`를 번들하려다 빌드가 실패하는 경우 → `npm run build` 성공과 `next start`에서 실제 DB 조회 200으로 확인한다. (Task 3 Step 9)
4. `next start`(운영 모드)에서 `.env.development`의 `AUTH_DEV_HEADERS=1`이 읽히거나 NODE_ENV 가드가 빠지면 사칭이 가능하다 → 운영 모드에서 개발 헤더 → 401. (Task 2 테스트 + Task 3 Step 9)
5. `NEXT_PUBLIC_*` 대신 다른 이름이나 동적 접근(`process.env[key]`)을 쓰면 화면 번들에 값이 들어가지 않아 로그인 버튼이 아무 동작도 하지 않는다 → 빌드 산출물(`.next/static`)에 Supabase 주소가 있는지 확인한다. (Task 3 Step 9)

---

## File Structure

| 파일 | 역할 |
|---|---|
| Create `web/lib/db.ts` | `Db`/`Statement` 타입, `openDatabase(path)`, `database()` |
| Create `web/scripts/migrate.mjs` | `migrate(path, dir)` + CLI. `_migrations` 기록 |
| Create `web/tests/db.test.ts` | DB 포트·마이그레이션 테스트 |
| Modify `web/lib/sprint-store.ts:1,19-21,312` | `./db` 사용, D1 타입 교체 |
| Modify `web/lib/auth.ts` | `process.env`, NODE_ENV 가드 |
| Modify `web/app/api/change-proposals/route.ts:3,46` | `process.env` |
| Modify `web/app/api/internal/reminders/route.ts:3,24-27,37` | `process.env` |
| Modify 테스트 8개 | 번들 플러그인 `./db`, `process.env` |
| Modify `web/package.json`, `web/tsconfig.json`, `web/.gitignore`, `web/.env.example`, `web/lib/supabase-browser.ts` | Next 전환 |
| Create `web/postcss.config.mjs`, `web/.env.development` | Next 전환 |
| Delete `web/vite.config.ts`, `web/wrangler.local.jsonc`, `web/.openai/` | Next 전환 |
| Modify `web/README.md`, `docs/dev-team-seed-notes.md`, `CLAUDE.md`, `.claude/launch.json` | 문서 |

---

### Task 1: DB 포트와 마이그레이션 스크립트

**Files:**
- Create: `web/lib/db.ts`, `web/scripts/migrate.mjs`
- Test: `web/tests/db.test.ts`
- Modify: `web/package.json`(`test`에 `tests/db.test.ts` 추가, `db:migrate` 변경)

**Interfaces:**
- Produces:
  - `type Statement = { bind(...args: unknown[]): Statement; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> }`
  - `type BatchResult<T> = { results: T[]; meta: { changes: number } }`
  - `type Db = { prepare(sql: string): Statement; batch<T = Record<string, unknown>>(statements: Statement[]): Promise<BatchResult<T>[]> }`
  - `openDatabase(path: string): Db`, `database(): Db` — `web/lib/db.ts`
  - `migrate(path: string, dir?: string): string[]`(적용한 파일 이름) — `web/scripts/migrate.mjs`

- [ ] **Step 1: 실패하는 테스트 — `web/tests/db.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.ts';
import { migrate } from '../scripts/migrate.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'projectmate-db-'));
  return join(dir, 'nested', 'test.sqlite'); // 없는 디렉터리도 만든다
}
function withTables() {
  const db = openDatabase(fresh());
  return db;
}
async function setup(db: ReturnType<typeof openDatabase>) {
  await db.prepare('CREATE TABLE parent (id TEXT PRIMARY KEY)').run();
  await db
    .prepare('CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parent(id))')
    .run();
}

void test('first·all·run은 D1과 같은 모양을 돌려준다', async () => {
  const db = withTables();
  await setup(db);
  const ins = await db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1').run();
  assert.deepEqual(ins.meta, { changes: 1 });
  assert.deepEqual(
    { ...(await db.prepare('SELECT id FROM parent WHERE id=?').bind('p1').first()) },
    { id: 'p1' },
  );
  assert.equal(await db.prepare('SELECT id FROM parent WHERE id=?').bind('none').first(), null);
  const all = await db.prepare('SELECT id FROM parent').all<{ id: string }>();
  assert.deepEqual(all.results.map((r) => r.id), ['p1']);
});

void test('batch는 한 문장이 실패하면 앞 문장까지 모두 되돌린다', async () => {
  const db = withTables();
  await setup(db);
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'),
      db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'), // PK 충돌
    ]),
  );
  assert.equal((await db.prepare('SELECT id FROM parent').all()).results.length, 0);
});

void test('batch는 문장마다 결과를 돌려주고 RETURNING 행도 돌려준다', async () => {
  const db = withTables();
  await setup(db);
  const [a, b, c] = await db.batch<{ id: string }>([
    db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'),
    db.prepare('INSERT INTO parent(id) VALUES(?) RETURNING id').bind('p2'),
    db.prepare('SELECT id FROM parent ORDER BY id'),
  ]);
  assert.deepEqual([a.results, a.meta.changes], [[], 1]);
  assert.deepEqual(b.results.map((r) => r.id), ['p2']);
  assert.deepEqual(c.results.map((r) => r.id), ['p1', 'p2']);
});

void test('외래키 위반은 실패한다', async () => {
  const db = withTables();
  await setup(db);
  await assert.rejects(db.prepare('INSERT INTO child(id, parent) VALUES(?, ?)').bind('c1', 'missing').run());
});

void test('마이그레이션은 여러 번 실행해도 파일마다 한 번만 적용한다', async () => {
  const path = fresh();
  const files = readdirSync('drizzle').filter((n) => n.endsWith('.sql'));
  assert.equal(migrate(path).length, files.length);
  assert.deepEqual(migrate(path), []);
  const db = openDatabase(path);
  const rows = await db.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>();
  assert.deepEqual(rows.results.map((r) => r.name), files.sort());
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sprints'").first());
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-strip-types --test tests/db.test.ts`
Expected: FAIL — `Cannot find module '…/lib/db.ts'`.

- [ ] **Step 3: `web/lib/db.ts` 작성**

```ts
// 서버 DB 포트. D1에서 쓰던 기능(prepare/bind/first/all/run/batch)만 같은 모양으로 둔다.
// 지금은 node:sqlite 파일, Supabase Postgres로 옮길 때 구현만 바꾼다.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Statement = {
  bind(...args: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};
export type BatchResult<T> = { results: T[]; meta: { changes: number } };
export type Db = {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<BatchResult<T>[]>;
};

class SqliteStatement implements Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly args: SQLInputValue[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new SqliteStatement(this.db, this.sql, args as SQLInputValue[]);
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
  async run() {
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } };
  }
  /** batch 안에서 동기 실행. 행을 돌려주는 문장(SELECT, RETURNING)인지는 열 정보로 판단한다. */
  execute(): BatchResult<unknown> {
    const st = this.db.prepare(this.sql);
    if (st.columns().length > 0) return { results: st.all(...this.args), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(st.run(...this.args).changes) } };
  }
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return {
    prepare: (sql) => new SqliteStatement(db, sql),
    // D1 batch처럼 한 트랜잭션. 안에 await가 없어 다른 요청과 섞이지 않는다.
    async batch<T>(statements: Statement[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => (s as SqliteStatement).execute());
        db.exec('COMMIT');
        return out as BatchResult<T>[];
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// Next 개발 서버는 모듈을 다시 평가한다. 연결을 프로세스에 하나만 두어 잠금 충돌을 막는다.
const shared = globalThis as typeof globalThis & { projectmateDb?: Db };
export function database(): Db {
  return (shared.projectmateDb ??= openDatabase(
    resolve(process.env.DATABASE_PATH || '.data/projectmate.sqlite'),
  ));
}
```

- [ ] **Step 4: `web/scripts/migrate.mjs` 작성**

```js
// drizzle/*.sql을 로컬 SQLite에 순서대로 적용한다. _migrations에 기록해 다시 실행해도 한 번씩만.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export function migrate(path, dir = 'drizzle') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
    const applied = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      db.exec('BEGIN');
      try {
        db.exec(readFileSync(join(dir, name), 'utf8'));
        db.prepare('INSERT INTO _migrations(name, applied_at) VALUES(?, ?)').run(
          name,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`${name}: ${e.message}`);
      }
      applied.push(name);
    }
    return applied;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applied = migrate(resolve(process.env.DATABASE_PATH || '.data/projectmate.sqlite'));
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --experimental-strip-types --test tests/db.test.ts`
Expected: PASS 5/5.

- [ ] **Step 6: 스크립트 연결**

`package.json`: `"db:migrate": "node scripts/migrate.mjs"`. `test` 문자열 끝에 ` tests/db.test.ts`. `.gitignore`의 `/.wrangler/` 줄 아래에 `/.data/` 추가.

```bash
DATABASE_PATH=/tmp/pm-migrate-check.sqlite npm run db:migrate && DATABASE_PATH=/tmp/pm-migrate-check.sqlite npm run db:migrate; rm -f /tmp/pm-migrate-check.sqlite*
```

Expected: 첫 줄 `applied: 0000_…, …, 0009_…`, 둘째 줄 `up to date`.

- [ ] **Step 7: 전체 테스트·타입·린트 후 커밋**

```bash
npm test && npx tsc --noEmit
git add lib/db.ts scripts/migrate.mjs tests/db.test.ts package.json .gitignore
git commit -m "feat: node:sqlite DB 포트와 마이그레이션 스크립트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: 테스트 전부 PASS(기존 167 + 5), 타입 오류 0. 이 시점에 앱 코드는 아직 `lib/db.ts`를 쓰지 않는다.

---

### Task 2: 서버 코드를 `process.env`와 `lib/db.ts`로 전환

**Files:**
- Modify: `web/lib/sprint-store.ts`, `web/lib/auth.ts`, `web/app/api/change-proposals/route.ts`, `web/app/api/internal/reminders/route.ts`
- Modify: `web/tests/{api,apply-revert,change-proposals,reminder-dispatch,reminder-consistency,save-guards,auth,dev-live-model}.test.mjs`

**Interfaces:**
- Consumes: Task 1의 `database(): Db`, `type Statement` (`web/lib/db.ts`).
- Produces: `lib/sprint-store.ts`가 `database`를 계속 내보낸다(다른 모듈 import 불변). 앱 코드에 `cloudflare:workers` import가 없다.

이 Task가 끝나면 vinext 개발 서버는 더 이상 동작하지 않는다(Task 3에서 Next로 교체). 테스트로만 확인한다.

- [ ] **Step 1: 테스트 번들 플러그인과 환경값 전환(먼저 테스트를 바꾼다)**

```bash
python3 - <<'EOF'
import re
files = ['api','apply-revert','change-proposals','reminder-dispatch','reminder-consistency','save-guards','auth']
for name in files:
    p = f'tests/{name}.test.mjs'
    s = open(p, encoding='utf-8').read()
    n1 = len(re.findall(r'filter: /\^cloudflare:workers\$/', s))
    s = re.sub(r'filter: /\^cloudflare:workers\$/', r'filter: /^\\.\\/db$/', s)
    s, n2 = re.subn(r"contents:\s*'export const env=[^']*'", "contents: 'export function database(){return globalThis.__TEST_DB}'", s)
    assert n1 == 1 and n2 == 1, (p, n1, n2)
    if name != 'auth':
        # 개발 헤더를 쓰는 파일. 첫 import 묶음 바로 뒤에 둔다.
        s = s.replace("import { test } from 'node:test';", "import { test } from 'node:test';\nprocess.env.AUTH_DEV_HEADERS = '1';", 1)
    open(p, 'w', encoding='utf-8').write(s)
EOF
grep -c "AUTH_DEV_HEADERS = '1'" tests/*.test.mjs | grep -v ":0"
```

Expected: 6개 파일이 각각 1.

`tests/reminder-dispatch.test.mjs`의 `globalThis.__TEST_ENV` 세 줄(744·751·765행 부근):

```js
  delete process.env.REMINDER_RUNNER_SECRET;          // = {} 였던 줄 (2곳)
  process.env.REMINDER_RUNNER_SECRET = 'runner-secret'; // = { REMINDER_RUNNER_SECRET: 'runner-secret' } 였던 줄
```

`tests/auth.test.mjs`:
- 61행 `globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };` → `process.env.SUPABASE_URL = SUPABASE;`
- 개발 헤더 테스트(215·220행 부근): `globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE, AUTH_DEV_HEADERS: '1' };` → `process.env.AUTH_DEV_HEADERS = '1';`, `finally`의 `globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };` → `delete process.env.AUTH_DEV_HEADERS;`
- "개발 헤더 플래그는 vite 개발 서버(serve)에서만…" 테스트(292행 부근)를 통째로 아래로 교체:

```js
test('운영 모드(NODE_ENV=production)에서는 AUTH_DEV_HEADERS=1이어도 개발 헤더를 무시한다', async () => {
  const dev = {
    'oai-authenticated-user-id': 'mallory',
    'oai-authenticated-user-email': 'a@test.local',
  };
  const before = process.env.NODE_ENV;
  process.env.AUTH_DEV_HEADERS = '1';
  try {
    assert.equal((await me(dev)).status, 200);
    process.env.NODE_ENV = 'production';
    assert.equal((await me(dev)).status, 401);
  } finally {
    delete process.env.AUTH_DEV_HEADERS;
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});
```


`tests/dev-live-model.test.mjs`(113~135행 부근):
- "Vite 개발 서버는 live-model 환경값을…" 테스트를 통째로 아래로 교체:

```js
test('route는 live-model 값을 process.env에서 읽고 저장소에 키를 두지 않는다', () => {
  const route = readFileSync('app/api/change-proposals/route.ts', 'utf8');
  assert.match(route, /const devBindings = process\.env as DevModelBindings;/);
  assert.doesNotMatch(route, /cloudflare:workers/);
  assert.doesNotMatch(route, /sk-[A-Za-z0-9_-]{10,}/);
});
```

- 다음 테스트의 `assert.match(route, /import \{ env \} from 'cloudflare:workers';/);` 한 줄을 삭제한다.

- [ ] **Step 2: 실패 확인**

Run: `npm test 2>&1 | tail -15`
Expected: FAIL — 번들 단계에서 `Could not resolve "cloudflare:workers"`(앱 코드가 아직 import), `dev-live-model`의 `process.env` 검사 실패.

- [ ] **Step 3: `lib/sprint-store.ts`**

1행 `import { env } from 'cloudflare:workers';` 삭제. import 묶음에 추가:

```ts
import { database, type Statement } from './db';
export { database };
```

19-21행의 `export function database() { return (env as unknown as { DB: D1Database }).DB; }` 삭제. 312행 부근 `extras: (mutation: string) => D1PreparedStatement[] = () => [],` → `extras: (mutation: string) => Statement[] = () => [],`. 파일 안 `D1` 문자열이 0개인지 `grep -n D1 lib/sprint-store.ts`로 확인(주석의 "One D1 transaction"은 "One transaction"으로).

- [ ] **Step 4: `lib/auth.ts`**

1행 import 삭제, `type AuthEnv` 삭제. `fromToken`의 첫 줄:

```ts
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
```

`identity()`의 개발 헤더 조건:

```ts
  // 운영(next start·Vercel은 NODE_ENV=production)에서는 값이 잘못 설정돼도 열리지 않는다.
  if (process.env.AUTH_DEV_HEADERS === '1' && process.env.NODE_ENV !== 'production')
    return fromDevHeaders(request);
```

- [ ] **Step 5: 라우트 두 개**

`app/api/change-proposals/route.ts`: 3행 import 삭제, 46행 → `const devBindings = process.env as DevModelBindings;`. 39행 주석 "Workers binding에서" → "서버 환경값(process.env)에서".

`app/api/internal/reminders/route.ts`: 3행 import 삭제,

```ts
  const secret = (process.env.REMINDER_RUNNER_SECRET ?? '').trim();
```

```ts
      sender: senderFrom(process.env as EmailEnv),
```

```bash
grep -rn "cloudflare:workers" app lib
```

Expected: 출력 없음.

- [ ] **Step 6: 전체 테스트·타입·린트**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npx tsc --noEmit
```

Expected: 전부 PASS, 타입 오류 0. `tsconfig`에 아직 `@cloudflare/workers-types`가 있어도 무관(Task 3에서 제거).

- [ ] **Step 7: 커밋**

```bash
git add lib/sprint-store.ts lib/auth.ts app/api/change-proposals/route.ts app/api/internal/reminders/route.ts tests
git commit -m "refactor: 서버 환경값은 process.env, DB는 lib/db.ts로

개발 헤더는 NODE_ENV=production이면 AUTH_DEV_HEADERS가 있어도 열지 않는다.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: vinext·Cloudflare·Sites를 걷어내고 Next.js로 실행

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/.gitignore`, `web/.env.example`, `web/lib/supabase-browser.ts`, `web/tests/auth.test.mjs`(define 키), `.claude/launch.json`(필요 시)
- Create: `web/postcss.config.mjs`, `web/.env.development`
- Delete: `web/vite.config.ts`, `web/wrangler.local.jsonc`, `web/.openai/`

**Interfaces:**
- Consumes: Task 2 이후 앱 코드에 `cloudflare:workers` 없음.
- Produces: `npm run dev|build|start`가 Next.js. 화면 환경값 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

- [ ] **Step 1: 화면 환경값 테스트를 먼저 바꾼다**

`tests/auth.test.mjs`의 복귀 주소 테스트 `define`:

```js
    define: {
      'process.env.NEXT_PUBLIC_SUPABASE_URL': 'undefined',
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': 'undefined',
    },
```

같은 파일 끝에 추가:

```js
test('화면 코드는 NEXT_PUBLIC_ 환경값을 문자 그대로 읽는다(Next가 빌드 시 넣는다)', () => {
  const src = readFileSync('lib/supabase-browser.ts', 'utf8');
  assert.match(src, /process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(src, /process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(src, /import\.meta\.env|VITE_/);
});
```

Run: `node --experimental-strip-types --test tests/auth.test.mjs 2>&1 | grep -E "^✖|^ℹ (pass|fail)"`
Expected: 새 테스트 FAIL.

- [ ] **Step 2: `lib/supabase-browser.ts`**

1행 `/// <reference types="vite/client" />` 삭제. 4-5행:

```ts
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
```

오류 문구 `'VITE_SUPABASE_URL·VITE_SUPABASE_ANON_KEY가 필요합니다.'` → `'NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY가 필요합니다.'`.

Run: 같은 명령. Expected: PASS.

- [ ] **Step 3: 의존성 교체**

```bash
npm uninstall vinext vite @cloudflare/vite-plugin @cloudflare/workers-types wrangler @openai/sites-vite-plugin @vitejs/plugin-react @vitejs/plugin-rsc react-server-dom-webpack
npm install next@^16
```

`package.json`:
- `"scripts"`: `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"`. 나머지 스크립트 유지.
- 최상위에 `"engines": { "node": ">=22.16" }`.

- [ ] **Step 4: 설정 파일**

삭제:

```bash
git rm -q vite.config.ts wrangler.local.jsonc
git rm -rq .openai
```

`web/postcss.config.mjs`:

```js
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
```

`web/tsconfig.json` `"types"`: `["node"]`.

`web/.env.development`:

```
# next dev에서만 읽힌다. 운영(NODE_ENV=production)에서는 lib/auth.ts가 이 값을 무시한다.
AUTH_DEV_HEADERS=1
```

`web/.gitignore`: `!.env.example` 아래에 `!.env.development`.

`web/.env.example`: `VITE_SUPABASE_URL=` → `NEXT_PUBLIC_SUPABASE_URL=`, `VITE_SUPABASE_ANON_KEY=` → `NEXT_PUBLIC_SUPABASE_ANON_KEY=`, 주석 "화면(빌드 시 포함…)" 유지.

- [ ] **Step 5: 남은 vinext·Cloudflare·Vite 흔적 확인**

```bash
grep -rnE "vinext|cloudflare|wrangler|import\.meta\.env|VITE_|sites-vite" --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.json' app components lib hooks scripts tests package.json tsconfig.json next.config.ts | grep -v node_modules
```

Expected: 출력 없음. 남으면 각각 고친다(테스트 파일 안 주석·문자열 포함).

- [ ] **Step 6: 사용자 `.env.local` 이름 변경 안내**

`web/.env.local`의 `VITE_SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`. 에이전트가 값을 출력하지 않고 이름만 바꿔도 된다:

```bash
sed -i '' -e 's/^VITE_SUPABASE_URL=/NEXT_PUBLIC_SUPABASE_URL=/' -e 's/^VITE_SUPABASE_ANON_KEY=/NEXT_PUBLIC_SUPABASE_ANON_KEY=/' .env.local
grep -oE '^[A-Z_]+=' .env.local
```

Expected: `SUPABASE_URL=`, `NEXT_PUBLIC_SUPABASE_URL=`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=`.

- [ ] **Step 7: 테스트·타입·린트·빌드**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npx tsc --noEmit
npm run build
```

Expected: 테스트 전부 PASS, 타입 오류 0, `next build` 성공. Next가 `tsconfig.json`·`next-env.d.ts`를 자동 수정하면 그 변경을 받아들인다. 빌드가 `node:sqlite`나 폰트로 실패하면 오류를 그대로 기록하고 원인을 고친다(`next.config.ts`에 설정이 필요하면 최소로).

- [ ] **Step 8: 개발 서버 확인**

```bash
npm run db:migrate
```

`npm run dev`를 백그라운드로 띄우고(포트 3000):

```bash
curl -s -o /dev/null -w '/ %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '/workspace %{http_code}\n' http://localhost:3000/workspace
curl -s -o /dev/null -w 'api no-auth %{http_code}\n' http://localhost:3000/api/projects
curl -s -o /dev/null -w 'api dev-header %{http_code}\n' -H 'oai-authenticated-user-id: dev-check' -H 'oai-authenticated-user-email: dev-check@projectmate.local' http://localhost:3000/api/projects
node scripts/seed-dev-team.mjs --base-url http://localhost:3000
```

Expected: `/ 200`, `/workspace 200`, `api no-auth 401`, `api dev-header 200`, 시드 스크립트 성공(4명 프로젝트). 개발 서버를 끈다.

- [ ] **Step 9: 운영 모드 확인**

`npm run build` 후 `npm start`를 백그라운드로(포트 3000, 같은 `.data` DB):

```bash
curl -s -o /dev/null -w '/ %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '/workspace %{http_code}\n' http://localhost:3000/workspace
curl -s -o /dev/null -w 'api no-auth %{http_code}\n' http://localhost:3000/api/projects
curl -s -o /dev/null -w 'api dev-header %{http_code}\n' -H 'oai-authenticated-user-id: dev-seed-lead-pm-qa' http://localhost:3000/api/projects
grep -rlF "$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- | sed 's#https://##')" .next/static | head -1 | sed 's#.*/##'
```

Expected: `/ 200`, `/workspace 200`, `api no-auth 401`, **`api dev-header 401`**, 마지막 줄에 파일 이름 하나(화면 번들에 Supabase 주소가 들어갔다). 값은 출력하지 않는다. 서버를 끈다.

- [ ] **Step 10: launch.json과 HMR 연결 확인**

`.claude/launch.json`의 `landing-race`(`npm --prefix web run dev -- --port 3100`)로 미리보기를 띄운다. `/workspace` 200을 확인한 뒤 `lib/sprint.ts`에 빈 줄을 넣었다 빼 HMR을 두 번 일으키고 `/api/projects`(개발 헤더)를 다시 불러 200, 서버 로그에 `database is locked` 없음을 확인한다. 인자 형식이 맞지 않으면 launch.json을 고친다.

- [ ] **Step 11: 커밋**

```bash
git add -A package.json package-lock.json tsconfig.json .gitignore .env.example .env.development postcss.config.mjs lib/supabase-browser.ts tests/auth.test.mjs
git add -A ../.claude/launch.json 2>/dev/null; git status --short | grep -E "vite.config|wrangler|\.openai"
git commit -m "feat: vinext·Cloudflare·Sites 대신 Next.js로 실행

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: 삭제 파일 3종이 `D`로 커밋에 포함. `.env.local`은 git에 들어가지 않는다(`git status`에 없음).

---

### Task 4: 문서와 실제 로그인 확인

**Files:**
- Modify: `web/README.md`, `docs/dev-team-seed-notes.md`, `CLAUDE.md`

- [ ] **Step 1: `web/README.md`**

로컬 실행 절을 다음으로 바꾼다(D1·Sites·wrangler 문장 삭제):

````markdown
```sh
npm ci
npm run db:migrate   # 처음 한 번, 그리고 drizzle/에 새 파일이 생길 때마다. 앱은 자동으로 마이그레이션하지 않는다.
npm run dev
```

로컬 DB는 `web/.data/projectmate.sqlite`(`DATABASE_PATH`로 바꿀 수 있다)다. 로그인은 Supabase Auth(Google)다. `.env.example`을 참고해 `web/.env.local`에 `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`를 넣고, Supabase Redirect URLs에 `http://localhost:*/**`를 등록한다. 토큰 없이 `oai-authenticated-*` 개발 헤더로 요청하는 방식은 `next dev`(`.env.development`의 `AUTH_DEV_HEADERS=1`)에서만 허용된다.
````

검증 명령 절의 oxlint 대상 목록에서 존재하지 않는 파일이 있으면 지운다.

`npm run db:migrate` 없이 `rm -rf .data && npm run dev` 후 `/api/projects`(개발 헤더)를 부르면 503이고 서버 로그에 `no such table`이 남는지 확인한다(Review Focus 2). 확인 뒤 `npm run db:migrate`.

- [ ] **Step 2: `docs/dev-team-seed-notes.md`**

"build 후 wrangler dev" 코드 블록과 `--var AUTH_DEV_HEADERS:1` 설명을 다음으로 바꾼다:

````markdown
```bash
npm run db:migrate
npm run dev   # http://localhost:3000, .env.development의 AUTH_DEV_HEADERS=1로 개발 헤더를 받는다
```
````

시드 명령의 `--base-url http://127.0.0.1:3001`은 `http://localhost:3000`으로, "브라우저에서 보는 법"의 주소와 Wrangler 언급도 같이 고친다. 마지막의 "vinext dev가 헤더를 보존하지 않는 환경…" 문단은 삭제한다.

- [ ] **Step 3: `CLAUDE.md` 기술 원칙**

`- 배포 서비스는 web/의 Workers 호환 API + D1(SQLite). 기존 Python 엔진은 보존된 별도 구현이며 웹에서 호출하지 않는다.` →

```markdown
- 웹 서비스는 web/의 Next.js. DB는 로컬 SQLite(lib/db.ts)이며 Supabase Postgres로 이전 중이고, 운영 배포(Vercel)는 아직 없다(사용자 결정 2026-10-03). 기존 Python 엔진은 보존된 별도 구현이며 웹에서 호출하지 않는다.
```

"비공개 Sites 접근과 프로젝트 멤버십은 별개다." 문장은 삭제한다(Sites를 쓰지 않는다).

- [ ] **Step 4: 사용자 확인 (코드 밖)**

사용자가 `npm run dev`(또는 launch `landing-race`)에서 Google 로그인 → 프로젝트 생성 → 새로고침 유지를 확인한다. 에이전트는 서버 로그(`/api/projects` 401 → `?code=` → 200, `POST /api/projects` 201)와 `.data/projectmate.sqlite`의 `project_members` 행(UUID 사용자 ID)으로 증거를 확인한다. 실패하면 단계·로그를 보고하고 멈춘다.

- [ ] **Step 5: 커밋**

```bash
git add README.md ../docs/dev-team-seed-notes.md ../CLAUDE.md
git commit -m "docs: Next.js·로컬 SQLite 실행 방법

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 범위 밖

- Supabase Postgres(하위 프로젝트 2), Vercel 배포·Cron(3), Supabase Storage·CareerFlow 결합(이후).
- `db/schema.ts`·`drizzle.config.ts` 변경, SQL 문장 변경.
