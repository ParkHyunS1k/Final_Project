# SQLite → Postgres(Supabase·PGlite) 이전 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서버 DB를 Postgres(운영 Supabase, 로컬·테스트 PGlite)로 옮기고, 네이티브 타입(timestamptz·boolean·jsonb)을 앱 코드까지 `Date`·`boolean`·객체로 쓴다.

**Architecture:** `lib/db.ts`의 D1 모양 포트(`prepare/bind/first/all/run/batch`)는 유지하고 구현을 postgres.js·PGlite로 바꾼다. 자리 표시 `?`→`$n`, 객체·배열 바인딩 JSON 직렬화, int8→number·date→문자열 파싱은 포트가 맡는다. 스키마는 `pgTable`로 다시 쓰고 drizzle-kit 기준 마이그레이션에 RLS를 켠다. 앱 코드는 시각을 `Date`로 다루고, 화면은 JSON으로 받은 문자열을 `Wire<T>` 타입으로 다룬다.

**Tech Stack:** Next.js 16, `postgres` ^3(3.4.9), `@electric-sql/pglite` ^0.5(0.5.8), drizzle-orm 0.45 / drizzle-kit 0.31, node:test + esbuild.

**Spec:** `docs/superpowers/specs/2026-10-03-postgres-migration-design.md`

## Global Constraints

- 브랜치 `postgres-migration`(`phs`의 `4c5e74e`에서). `phs`/PR #2에 커밋하지 않는다.
- 운영: `DATABASE_URL`이 있으면 postgres.js(`prepare: false`, `max: 5`). 없으면 PGlite(`DATABASE_PATH`, 기본 `.data/pglite`; 테스트는 메모리).
- 반환 값: timestamptz→`Date`, boolean→`boolean`, jsonb→파싱된 값, date→`'YYYY-MM-DD'` 문자열, int8→`number`.
- 바인딩: 일반 객체·배열은 포트가 `JSON.stringify`. 앱은 Postgres 배열 값을 쓰지 않는다.
- 모든 DB 오류는 `DatabaseError('database error: …', { cause })`(라우트 503 계약 유지).
- 모든 테이블 RLS ON, 정책 없음. 마이그레이션 디렉터리 `db/migrations/`(전환 후 `drizzle/` 삭제).
- `sprint_proposals` 테이블은 만들지 않는다. `''` 시각·날짜 쓰기 3곳은 NULL.
- 화면 응답 모양 변경은 `details.legacy`(boolean), `details.deliverables`(배열)뿐. 시각은 ISO 문자열 그대로.
- SQL 문장은 SQLite 전용 문법만 고친다. 쿼리 빌더 전환 없음.
- 린트: Task 시작 시 `npx oxlint > /tmp/lint-base.log`, 끝에 줄 번호 무시 비교로 새 오류 0.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 명령은 `web/`에서.

## Review Focus

1. `INSERT … SELECT ?,owner,… FROM sprints WHERE …`에서 타입 미정 매개변수가 정수·불리언·시각 컬럼으로 들어갈 때 Postgres가 `column "x" is of type integer but expression is of type text`로 거절할 수 있다 → API 테스트(PGlite)가 이 경로를 모두 지나므로, 실패하면 해당 자리에 `?::integer` 등 명시 캐스트를 넣는다. (Task 4 Step 6)
2. 실제 동시 요청(같은 프로젝트 "시작" 두 번)은 PGlite(연결 하나)로 재현되지 않는다 → Supabase에서 하나만 성공하는지 확인. (Task 5 Step 4)
3. anon 키로 Supabase REST가 테이블을 노출하면 누구나 읽고 쓴다 → RLS 테스트(Task 3) + 실제 REST 호출로 행이 안 나오는지 확인. (Task 5 Step 5)
4. postgres.js 쪽 파서 설정(int8·date)은 테스트(PGlite)가 지나지 않는다 → `scripts/db-check.ts`로 Supabase에서 값 타입을 확인. (Task 2 Step 6, Task 5 Step 2)
5. 개발 서버가 PGlite 파일을 연 채로 `npm run db:migrate`를 실행하면 파일 손상·잠금 → 마이그레이션 스크립트가 잠금을 감지해 안내하고 멈춘다. (Task 3 Step 7)

---

## File Structure

| 파일 | 역할 |
|---|---|
| Create `web/lib/time.ts` | `ms(x)`, `sameInstant(a,b)` |
| Create `web/lib/wire.ts` | `Wire<T>`: 응답 JSON 모양(Date→string) 타입 |
| Rewrite `web/lib/db.ts` | Postgres 포트(postgres.js·PGlite), `openPglite`, `openPostgres`, `database()` |
| Rewrite `web/scripts/migrate.mjs` | Postgres 마이그레이션 실행 |
| Create `web/scripts/db-check.ts` | 드라이버 값 타입 확인 |
| Rewrite `web/db/schema.ts`, Modify `web/drizzle.config.ts` | Postgres 스키마 |
| Create `web/db/migrations/0000_*.sql` (+ drizzle meta) | 기준 마이그레이션 + RLS |
| Delete `web/drizzle/` | SQLite 마이그레이션 |
| Create `web/tests/helpers/pg-db.mjs` | 테스트용 PGlite `Db` + 훅 + `rows()` |
| Rewrite `web/tests/db.test.ts`, `web/tests/schema-migrations.test.mjs` | |
| Modify 테스트 7개 + `db-route.test.mjs` | 헬퍼 사용, 값 단언 |
| Modify `lib/*.ts`, `app/api/**/route.ts`, 화면 3~4개 | 값 전환 |
| Modify `web/README.md`, `CLAUDE.md`, `docs/dev-team-seed-notes.md`, `web/.env.example` | 문서 |

---

### Task 1: 시각 비교와 응답 모양 도우미

**Files:**
- Create: `web/lib/time.ts`, `web/lib/wire.ts`
- Test: `web/tests/time.test.ts`
- Modify: `web/package.json`(`test`에 `tests/time.test.ts`)

**Interfaces:**
- Produces: `ms(x: Date | string | null | undefined): number`(null·빈 문자열·잘못된 값 → `NaN`), `sameInstant(a: Date | string | null | undefined, b: Date | string | null | undefined): boolean`(둘 다 비어 있으면 true, 하나만 비어 있으면 false, 아니면 밀리초 비교), `type Wire<T>`.

- [ ] **Step 1: 실패하는 테스트 — `web/tests/time.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ms, sameInstant } from '../lib/time.ts';

const iso = '2026-10-03T09:00:00.000Z';

void test('ms는 Date와 ISO 문자열을 같은 밀리초로, 빈 값은 NaN으로', () => {
  assert.equal(ms(new Date(iso)), Date.parse(iso));
  assert.equal(ms(iso), Date.parse(iso));
  assert.ok(Number.isNaN(ms(null)));
  assert.ok(Number.isNaN(ms('')));
  assert.ok(Number.isNaN(ms(undefined)));
});

void test('sameInstant는 형태가 달라도 같은 시각이면 같다', () => {
  assert.equal(sameInstant(new Date(iso), iso), true);
  assert.equal(sameInstant('2026-10-03T18:00:00+09:00', iso), true);
  assert.equal(sameInstant(new Date(iso), new Date(Date.parse(iso) + 1)), false);
  assert.equal(sameInstant(null, null), true);
  assert.equal(sameInstant(null, ''), true);
  assert.equal(sameInstant(null, iso), false);
  assert.equal(sameInstant(new Date(iso), undefined), false);
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/time.test.ts` → FAIL(`Cannot find module …/lib/time.ts`).

- [ ] **Step 3: `web/lib/time.ts`**

```ts
// DB(timestamptz)는 Date, JSON(변경안 스냅샷·응답)은 ISO 문자열이다. 비교는 밀리초로 한다.
export type Instant = Date | string | null | undefined;

export function ms(x: Instant): number {
  if (x instanceof Date) return x.getTime();
  return x ? Date.parse(x) : NaN;
}

/** 둘 다 비어 있으면 같고, 하나만 비어 있으면 다르다. */
export function sameInstant(a: Instant, b: Instant): boolean {
  const x = ms(a);
  const y = ms(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
  return x === y;
}
```

`web/lib/wire.ts`:

```ts
// 서버 값이 Response.json을 거친 뒤 화면에 도착하는 모양. Date는 ISO 문자열이 된다.
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
```

- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS 2/2.
- [ ] **Step 5: 스크립트 등록·검증·커밋** — `package.json` `test` 끝에 ` tests/time.test.ts`. `npm test && npx tsc --noEmit`.

```bash
git add lib/time.ts lib/wire.ts tests/time.test.ts package.json
git commit -m "feat: 시각 비교(sameInstant)와 응답 모양(Wire) 도우미

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Postgres DB 포트

**Files:**
- Rewrite: `web/lib/db.ts`
- Create: `web/scripts/db-check.ts`
- Rewrite: `web/tests/db.test.ts`
- Modify: `web/tests/db-route.test.mjs`(로그 정규식), `web/package.json`

**Interfaces:**
- Produces (`web/lib/db.ts`):
  - `type Statement`, `type BatchResult<T>`, `type Db` — 지금과 같은 모양(`first<T>(): Promise<T|null>`, `all<T>(): Promise<{results:T[]}>`, `run(): Promise<{meta:{changes:number}}>`, `batch<T>(s: Statement[]): Promise<BatchResult<T>[]>`). 추가: `exec(sql: string): Promise<void>`(여러 문장, 매개변수 없음 — 마이그레이션·테스트용), `close(): Promise<void>`.
  - `class DatabaseError extends Error`(지금과 같음).
  - `toPositional(sql: string): string` — `?`→`$n`, 작은따옴표 안은 그대로.
  - `openPglite(dataDir?: string): Db`(없으면 메모리), `openPostgres(url: string): Db`, `database(): Db`(`DATABASE_URL` → postgres, 아니면 PGlite `DATABASE_PATH || '.data/pglite'`; `globalThis.projectmateDb` 캐시).

- [ ] **Step 1: 의존성** — `npm install postgres@^3 @electric-sql/pglite@^0.5`.

- [ ] **Step 2: 실패하는 테스트 — `web/tests/db.test.ts` 전체 교체**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseError, openPglite, toPositional, type Db } from '../lib/db.ts';

async function fresh(): Promise<Db> {
  const db = openPglite();
  await db.exec(`
    CREATE TABLE parent (id text PRIMARY KEY);
    CREATE TABLE child (id text PRIMARY KEY, parent text NOT NULL REFERENCES parent(id));
    CREATE TABLE vals (id text PRIMARY KEY, at timestamptz, ok boolean, data jsonb, day date, n integer, x double precision);
  `);
  return db;
}

void test('?는 $n으로, 작은따옴표 안의 ?는 그대로', () => {
  assert.equal(toPositional('SELECT ? , ?'), 'SELECT $1 , $2');
  assert.equal(toPositional("SELECT '?', ? WHERE a='it''s ?' AND b=?"), "SELECT '?', $1 WHERE a='it''s ?' AND b=$2");
});

void test('first·all·run 결과 모양', async () => {
  const db = await fresh();
  assert.deepEqual((await db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1').run()).meta, { changes: 1 });
  assert.deepEqual({ ...(await db.prepare('SELECT id FROM parent WHERE id=?').bind('p1').first()) }, { id: 'p1' });
  assert.equal(await db.prepare('SELECT id FROM parent WHERE id=?').bind('none').first(), null);
  assert.deepEqual((await db.prepare('SELECT id FROM parent').all<{ id: string }>()).results.map((r) => r.id), ['p1']);
});

void test('batch는 한 문장이 실패하면 모두 되돌린다', async () => {
  const db = await fresh();
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'),
      db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'),
    ]),
    (e: unknown) => e instanceof DatabaseError,
  );
  assert.equal((await db.prepare('SELECT id FROM parent').all()).results.length, 0);
});

void test('batch는 문장마다 결과를, RETURNING은 행을 돌려준다', async () => {
  const db = await fresh();
  const [a, b, c] = await db.batch<{ id: string }>([
    db.prepare('INSERT INTO parent(id) VALUES(?)').bind('p1'),
    db.prepare('INSERT INTO parent(id) VALUES(?) RETURNING id').bind('p2'),
    db.prepare('SELECT id FROM parent ORDER BY id'),
  ]);
  assert.deepEqual([a.results, a.meta.changes], [[], 1]);
  assert.deepEqual(b.results.map((r) => r.id), ['p2']);
  assert.deepEqual(c.results.map((r) => r.id), ['p1', 'p2']);
});

void test('외래키 위반은 DatabaseError', async () => {
  const db = await fresh();
  await assert.rejects(
    db.prepare('INSERT INTO child(id,parent) VALUES(?,?)').bind('c1', 'missing').run(),
    (e: unknown) => e instanceof DatabaseError && /database error:/.test((e as Error).message),
  );
});

void test('값 왕복: Date·boolean·jsonb(배열은 jsonb 배열)·date 문자열·int8 숫자', async () => {
  const db = await fresh();
  const at = new Date('2026-10-03T09:00:00.123Z');
  await db
    .prepare('INSERT INTO vals(id,at,ok,data,day,n,x) VALUES(?,?,?,?,?,?,?)')
    .bind('v1', at, true, ['a', { b: 1 }], '2026-10-03', 7, 0.5)
    .run();
  await db.prepare('INSERT INTO vals(id,at,data) VALUES(?,?,?)').bind('v2', at.toISOString(), { k: 'v' }).run();
  const r = await db.prepare('SELECT * FROM vals WHERE id=?').bind('v1').first<Record<string, unknown>>();
  assert.ok(r!.at instanceof Date);
  assert.equal((r!.at as Date).toISOString(), at.toISOString());
  assert.equal(r!.ok, true);
  assert.deepEqual(r!.data, ['a', { b: 1 }]);
  assert.equal(r!.day, '2026-10-03');
  assert.equal(r!.n, 7);
  assert.equal(r!.x, 0.5);
  const kind = await db.prepare("SELECT jsonb_typeof(data) AS t FROM vals WHERE id='v1'").first<{ t: string }>();
  assert.equal(kind!.t, 'array');
  const v2 = await db.prepare('SELECT at, data FROM vals WHERE id=?').bind('v2').first<Record<string, unknown>>();
  assert.equal((v2!.at as Date).toISOString(), at.toISOString());
  assert.deepEqual(v2!.data, { k: 'v' });
  const c = await db.prepare('SELECT count(*) AS n FROM vals').first<{ n: unknown }>();
  assert.equal(c!.n, 2);
});

void test('연결·쿼리 오류는 DatabaseError로 감싸고 cause를 남긴다', async () => {
  const db = await fresh();
  await assert.rejects(db.prepare('SELECT * FROM missing').all(), (e: unknown) => {
    assert.ok(e instanceof DatabaseError);
    assert.match(e.message, /^database error: .*does not exist/);
    assert.ok(e.cause);
    return true;
  });
});
```

`package.json` `test`의 `tests/db.test.ts`는 이미 있다.

- [ ] **Step 3: 실패 확인** — `node --experimental-strip-types --test tests/db.test.ts` → FAIL(`openPglite`/`toPositional` export 없음).

- [ ] **Step 4: `web/lib/db.ts` 전체 교체**

```ts
// 서버 DB 포트. D1에서 쓰던 모양(prepare/bind/first/all/run/batch)을 유지한다.
// 운영은 Supabase Postgres(postgres.js), 로컬·테스트는 PGlite. 값은 Postgres 타입 그대로 돌려준다
// (timestamptz→Date, boolean, jsonb→객체). date는 'YYYY-MM-DD' 문자열, int8은 number.
import { PGlite, types } from '@electric-sql/pglite';
import postgres from 'postgres';

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
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
};

/** DB 계층 오류. 라우트는 문구의 'database'로 장애를 가려 503으로 돌리고 원문을 응답에 넣지 않는다. */
export class DatabaseError extends Error {
  constructor(cause: unknown) {
    super(`database error: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DatabaseError';
  }
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw e instanceof DatabaseError ? e : new DatabaseError(e);
  }
}

/** SQLite식 ?를 Postgres $n으로. 작은따옴표 문자열 안('' 이스케이프 포함)은 바꾸지 않는다. */
export function toPositional(sql: string): string {
  let out = '';
  let n = 0;
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += !quoted && ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/** 일반 객체·배열은 JSON 문자열로. 배열이 Postgres 배열 값으로 가지 않게 한다. */
function param(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || v instanceof Date || typeof v !== 'object') return v;
  return JSON.stringify(v);
}

type Query = (sql: string, args: unknown[]) => Promise<{ rows: Record<string, unknown>[]; changes: number }>;

class PgStatement implements Statement {
  readonly sql: string;
  readonly args: unknown[];
  private readonly run_: Query;
  constructor(run: Query, sql: string, args: unknown[] = []) {
    this.run_ = run;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: unknown[]) {
    return new PgStatement(this.run_, this.sql, args);
  }
  async first<T>() {
    const { rows } = await guarded(() => this.run_(this.sql, this.args));
    return (rows[0] as T | undefined) ?? null;
  }
  async all<T>() {
    const { rows } = await guarded(() => this.run_(this.sql, this.args));
    return { results: rows as T[] };
  }
  async run() {
    const { changes } = await guarded(() => this.run_(this.sql, this.args));
    return { meta: { changes } };
  }
}

function port(
  query: Query,
  transaction: <T>(fn: (q: Query) => Promise<T>) => Promise<T>,
  exec: (sql: string) => Promise<void>,
  close: () => Promise<void>,
): Db {
  return {
    prepare: (sql) => new PgStatement(query, sql),
    // D1 batch처럼 한 트랜잭션. 하나라도 실패하면 모두 되돌린다.
    batch: <T>(statements: Statement[]) =>
      guarded(() =>
        transaction(async (q) => {
          const out: BatchResult<T>[] = [];
          for (const s of statements as PgStatement[]) {
            const { rows, changes } = await q(s.sql, s.args);
            out.push({ results: rows as T[], meta: { changes } });
          }
          return out;
        }),
      ),
    exec: (sql) => guarded(() => exec(sql)),
    close,
  };
}

const pgliteParsers = {
  [types.INT8]: (v: string) => Number(v),
  [types.DATE]: (v: string) => v,
};

export function openPglite(dataDir?: string): Db {
  const db = new PGlite(dataDir, { parsers: pgliteParsers });
  const query: Query = async (sql, args) => {
    const r = await db.query<Record<string, unknown>>(toPositional(sql), args.map(param));
    return { rows: r.rows, changes: r.affectedRows ?? 0 };
  };
  return port(
    query,
    (fn) =>
      db.transaction(async (tx) =>
        fn(async (sql, args) => {
          const r = await tx.query<Record<string, unknown>>(toPositional(sql), args.map(param));
          return { rows: r.rows, changes: r.affectedRows ?? 0 };
        }),
      ),
    async (sql) => {
      await db.exec(sql);
    },
    () => db.close(),
  );
}

export function openPostgres(url: string): Db {
  // Supabase 연결 풀러(트랜잭션 모드)는 prepared statement를 쓸 수 없다.
  const sql = postgres(url, {
    prepare: false,
    max: 5,
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
  type Unsafe = { unsafe: (q: string, a: unknown[]) => Promise<Record<string, unknown>[] & { count: number }> };
  const viaUnsafe =
    (s: Unsafe): Query =>
    async (q, args) => {
      const rows = await s.unsafe(toPositional(q), args.map(param));
      return { rows: [...rows], changes: rows.count ?? 0 };
    };
  return port(
    viaUnsafe(sql as unknown as Unsafe),
    (fn) => sql.begin((tx) => fn(viaUnsafe(tx as unknown as Unsafe))) as never,
    async (q) => {
      await sql.unsafe(q);
    },
    () => sql.end(),
  );
}

// Next 개발 서버는 모듈을 다시 평가한다. 연결을 프로세스에 하나만 둔다.
const shared = globalThis as typeof globalThis & { projectmateDb?: Db };
export function database(): Db {
  if (shared.projectmateDb) return shared.projectmateDb;
  const url = process.env.DATABASE_URL;
  return (shared.projectmateDb = url
    ? openPostgres(url)
    : openPglite(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || '.data/pglite'));
}
```

`PGlite`의 `parsers` 옵션 키는 Postgres 타입 OID 숫자다(`types.INT8`=20, `types.DATE`=1082). 생성자 시그니처가 다르면(`new PGlite({ dataDir, parsers })`) 그 형태로 맞추고 Ruling으로 남긴다.

- [ ] **Step 5: 통과 확인** — `node --experimental-strip-types --test tests/db.test.ts` → PASS 7/7.

- [ ] **Step 6: 값 타입 확인 스크립트 — `web/scripts/db-check.ts`**

```ts
// 드라이버가 Postgres 값을 앱이 기대하는 JS 타입으로 돌려주는지 확인한다(테이블 불필요).
// 로컬: node --experimental-strip-types scripts/db-check.ts
// Supabase: DATABASE_URL=... node --experimental-strip-types scripts/db-check.ts
import { database } from '../lib/db.ts';

const db = database();
const r = await db
  .prepare("SELECT now() AS at, true AS ok, '[1]'::jsonb AS j, '2026-10-03'::date AS d, count(*) AS n FROM (VALUES (1),(2)) v(x)")
  .first<Record<string, unknown>>();
const got = {
  at: r!.at instanceof Date,
  ok: r!.ok === true,
  j: Array.isArray(r!.j),
  d: r!.d === '2026-10-03',
  n: r!.n === 2,
};
console.log(JSON.stringify(got));
await db.close();
if (!Object.values(got).every(Boolean)) process.exit(1);
```

Run: `DATABASE_PATH=/tmp/pm-dbcheck node --experimental-strip-types scripts/db-check.ts`
Expected: `{"at":true,"ok":true,"j":true,"d":true,"n":true}`, 종료 코드 0.

- [ ] **Step 7: `tests/db-route.test.mjs` 로그 정규식** — `assert.match(r.log, /no such table/);` → `assert.match(r.log, /does not exist/);`, `assert.doesNotMatch(r.body, /no such table|sqlite/i);` → `assert.doesNotMatch(r.body, /does not exist|relation/i);`. 첫 테스트의 경로 `join(dir, 'fresh', 'x.sqlite')` → `join(dir, 'fresh-pglite')`. 이 파일의 esbuild `build({...})`에 `external: ['@electric-sql/pglite', 'postgres']`를 추가한다(PGlite의 wasm·데이터 파일은 번들하지 않고 node_modules에서 읽는다).

Run: `node --experimental-strip-types --test tests/db-route.test.mjs` → PASS 2/2. 다른 API 테스트는 아직 `./db`를 SQLite 대역으로 바꿔치기하므로 영향 없다.

- [ ] **Step 8: 전체·커밋** — `npm test && npx tsc --noEmit`, 린트 비교.

```bash
git add lib/db.ts scripts/db-check.ts tests/db.test.ts tests/db-route.test.mjs package.json package-lock.json
git commit -m "feat: Postgres DB 포트(postgres.js·PGlite)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Postgres 스키마·기준 마이그레이션·RLS·실행 스크립트

**Files:**
- Rewrite: `web/db/schema.ts`; Modify: `web/drizzle.config.ts`
- Create: `web/db/migrations/0000_*.sql`, `web/db/migrations/meta/*`(drizzle-kit 생성)
- Rewrite: `web/scripts/migrate.mjs` → `web/scripts/migrate.ts`; `package.json` `db:migrate`
- Rewrite: `web/tests/schema-migrations.test.mjs`
- Test: `web/tests/db.test.ts`(RLS·마이그레이션 테스트 추가)

**Interfaces:**
- Consumes: Task 2 `openPglite`, `Db.exec`.
- Produces: `migrate(db: Db, dir = 'db/migrations'): Promise<string[]>` — `web/scripts/migrate.ts`(export). CLI: `npm run db:migrate`.

- [ ] **Step 1: 실패하는 테스트 — `tests/db.test.ts` 끝에 추가**

```ts
import { readdirSync } from 'node:fs';
import { migrate } from '../scripts/migrate.ts';

void test('기준 마이그레이션: 두 번 실행해도 한 번만, 모든 테이블 RLS 켜짐, sprint_proposals 없음', async () => {
  const db = openPglite();
  const files = readdirSync('db/migrations').filter((n) => n.endsWith('.sql')).sort();
  assert.deepEqual(await migrate(db), files);
  assert.deepEqual(await migrate(db), []);
  const tables = await db
    .prepare("SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_migrations'")
    .all<{ name: string; rls: boolean }>();
  assert.equal(tables.results.length, 18);
  assert.deepEqual(tables.results.filter((t) => !t.rls).map((t) => t.name), []);
  assert.ok(!tables.results.some((t) => t.name === 'sprint_proposals'));
});
```

Run → FAIL(`scripts/migrate.ts` 없음).

- [ ] **Step 2: `web/db/schema.ts` 다시 쓰기**

규칙(모든 테이블에 그대로 적용):
- `import { pgTable, text, integer, doublePrecision, boolean, jsonb, timestamp, date, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';`
- `sqliteTable` → `pgTable`, `real(` → `doublePrecision(`.
- 시각 컬럼: `text('x_at')` 등 → `timestamp('x_at', { withTimezone: true, mode: 'date' })`. 대상: 모든 `*_at` 컬럼, `sprints.deadline`, `sprints.updated_at`, `sprint_tasks.due_at`, `project_invites.expires_at`, `reminder_items.due_at`, `reminder_items.scheduled_at`, `reminder_batches.scheduled_at`, `reminder_batches.first_attempt_at`, `reminder_batches.last_attempt_at`, `source_documents.captured_at`.
- 날짜: `sprints.start_date`, `sprint_capacity.date` → `date('…', { mode: 'string' })`.
- 불리언: `sprints.joined`, `sprints.finished`, `sprint_tasks.optional`, `sprint_tasks.deferred`, `sprint_tasks.done`, `project_details.legacy`, `project_deliverables.confirmed` → `boolean('…').notNull().default(false)`.
- JSON: `project_details.deliverables`, `ai_proposal_changes.before`, `ai_proposal_changes.after`, `ai_change_applications.entries` → `jsonb('…').notNull()`.
- NULL 허용으로: `sprints.start_date`, `sprints.deadline`, `project_agreement.fixed_at`(`.notNull()` 제거).
- `sprintProposals` 정의 삭제.
- 인덱스·기본키·고유 인덱스는 그대로 옮긴다.

`web/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
});
```

- [ ] **Step 3: 기준 마이그레이션 생성과 RLS**

```bash
npx drizzle-kit generate --name init
ls db/migrations
```

생성된 `db/migrations/0000_init.sql` 끝에 테이블마다 한 줄씩 덧붙인다(테이블 이름은 생성 파일의 `CREATE TABLE` 목록과 같게):

```sql
--> statement-breakpoint
-- Supabase는 public 테이블을 anon 키로 REST에 노출한다. RLS를 켜고 정책을 두지 않아 막는다.
-- 서버는 테이블 소유자 역할로 접속하므로 영향을 받지 않는다.
ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sprint_tasks" ENABLE ROW LEVEL SECURITY;
```
(18개 테이블 전부. `--> statement-breakpoint`는 drizzle 구분자이며 `exec`에서는 주석이다.)

- [ ] **Step 4: `web/scripts/migrate.ts`(기존 `migrate.mjs` 삭제)**

```ts
// db/migrations/*.sql을 순서대로 한 번씩 적용한다. DATABASE_URL이 있으면 그 DB, 없으면 로컬 PGlite.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database, type Db } from '../lib/db.ts';

export async function migrate(db: Db, dir = 'db/migrations'): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL)',
  );
  const done = new Set(
    (await db.prepare('SELECT name FROM _migrations').all<{ name: string }>()).results.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    // 파일 하나를 트랜잭션 하나로. 여러 문장을 exec로 보낸다.
    await db.exec(`BEGIN;\n${readFileSync(join(dir, name), 'utf8')}\n;INSERT INTO _migrations(name, applied_at) VALUES('${name.replace(/'/g, "''")}', now());\nCOMMIT;`);
    applied.push(name);
  }
  return applied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const db = database();
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    await db.close();
  } catch (e) {
    if (!process.env.DATABASE_URL && /lock|busy|already/i.test(String((e as Error).message)))
      console.error('로컬 DB(.data/pglite)가 사용 중입니다. 개발 서버(npm run dev)를 끄고 다시 실행하세요.');
    throw e;
  }
}
```

`package.json`: `"db:migrate": "node --experimental-strip-types scripts/migrate.ts"`. `exec` 중 실패하면 `BEGIN` 이후가 되돌려진다(PGlite·postgres.js 단순 쿼리 프로토콜은 한 번에 보낸 문장들을 묵시적 트랜잭션 블록으로 처리하고, 명시 BEGIN/COMMIT도 지원한다).

- [ ] **Step 5: 통과 확인** — `node --experimental-strip-types --test tests/db.test.ts` → PASS 8/8. 테이블 수가 18이 아니면 스키마의 실제 테이블 수(19 − sprint_proposals)를 확인하고 단언을 고친다.

- [ ] **Step 6: `tests/schema-migrations.test.mjs` 다시 쓰기**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('db/schema.ts와 db/migrations가 일치한다(drizzle-kit generate가 새 파일을 만들지 않는다)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-mig-'));
  cpSync('db/migrations', join(dir, 'migrations'), { recursive: true });
  const before = readdirSync(join(dir, 'migrations')).filter((n) => n.endsWith('.sql'));
  const out = execFileSync(
    'npx',
    ['drizzle-kit', 'generate', '--dialect', 'postgresql', '--schema', './db/schema.ts', '--out', join(dir, 'migrations')],
    { encoding: 'utf8' },
  );
  const after = readdirSync(join(dir, 'migrations')).filter((n) => n.endsWith('.sql'));
  assert.deepEqual(after, before, out);
});
```

이전 규칙 데이터(시드) 조회 검증은 Task 4에서 API 테스트(`api.test.mjs`의 legacy 테스트)가 맡는다.

Run: `node --test tests/schema-migrations.test.mjs` → PASS.

- [ ] **Step 7: 잠금 안내 확인** — `npm run dev`를 백그라운드로 띄운 뒤 `npm run db:migrate`. Expected: 한국어 잠금 안내와 함께 실패(또는 PGlite가 잠그지 않으면 그 사실을 Ruling으로 남긴다). 개발 서버를 끄고 `npm run db:migrate` → `applied: 0000_init.sql`. 다시 → `up to date`.

- [ ] **Step 8: 검증·커밋** — `node --experimental-strip-types --test tests/db.test.ts tests/schema-migrations.test.mjs tests/time.test.ts`, `npx tsc --noEmit`. **이 Task 끝에서 API 테스트 7개 파일은 아직 SQLite 대역(`drizzle/*.sql`)으로 돌아 통과해야 한다**(`npm test`).

```bash
git add db/schema.ts db/migrations drizzle.config.ts scripts/migrate.ts tests/db.test.ts tests/schema-migrations.test.mjs package.json
git rm -q scripts/migrate.mjs
git commit -m "feat: Postgres 스키마와 기준 마이그레이션(RLS 켬)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 앱과 테스트를 Postgres로 전환

이 Task 안에서는 중간에 테스트가 빨갛다. 끝에서 `npm test` 전체가 초록이어야 한다.

**Files:**
- Create: `web/tests/helpers/pg-db.mjs`
- Modify: `web/tests/{api,apply-revert,auth,change-proposals,reminder-dispatch,reminder-consistency,save-guards}.test.mjs`
- Modify: `web/lib/{sprint-store,projects,reminder-store,reminder-dispatch,reminders,source-documents,change-proposals,deliverables,sprint-policy,sprint}.ts`, `web/app/api/{sprint,change-proposals}/route.ts`, `web/components/{project-workspace,task-editor,deadline-calendar,change-review}.tsx`, `web/app/workspace/page.tsx`
- Delete: `web/drizzle/`

**Interfaces:**
- Consumes: Task 1 `ms`, `sameInstant`, `Wire`; Task 2 `openPglite`; Task 3 `migrate`.
- Produces: `tests/helpers/pg-db.mjs` — `export async function setupTestDb(): Promise<{ db, rows(sql, ...args): Promise<object[]>, exec(sql): Promise<void> }>`(전역 `__TEST_DB` 설정, `__BEFORE_WRITE`/`__BEFORE_WRITE_SQL` 훅 유지).

- [ ] **Step 1: 테스트 헬퍼 — `web/tests/helpers/pg-db.mjs`**

```js
// 실제 lib/db.ts(PGlite 메모리)에 마이그레이션을 적용한 테스트 DB.
// 쓰기 직전 끼어들기 훅(__BEFORE_WRITE)은 기존 SQLite 대역과 같은 규칙으로 batch/run 앞에서 한 번 실행한다.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'pm-pg-'));
const out = join(dir, 'db.mjs');
await build({
  stdin: {
    contents: "export { openPglite } from './lib/db.ts'; export { migrate } from './scripts/migrate.ts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@electric-sql/pglite', 'postgres'],
});
const { openPglite, migrate } = await import(pathToFileURL(out).href);

function fire(sqls) {
  const hook = globalThis.__BEFORE_WRITE;
  if (!hook) return;
  const pattern = globalThis.__BEFORE_WRITE_SQL ?? 'UPDATE sprints SET revision';
  if (!sqls.some((s) => s.includes(pattern))) return;
  globalThis.__BEFORE_WRITE = null;
  globalThis.__BEFORE_WRITE_SQL = null;
  return hook();
}

export async function setupTestDb() {
  const real = openPglite();
  await migrate(real);
  const db = {
    prepare(sql) {
      const st = real.prepare(sql);
      const wrap = (s) => ({
        sql,
        inner: s,
        bind: (...a) => wrap(s.bind(...a)),
        first: () => s.first(),
        all: () => s.all(),
        run: async () => {
          if (!/^\s*SELECT/i.test(sql)) await fire([sql]);
          return s.run();
        },
      });
      return wrap(st);
    },
    async batch(statements) {
      await fire(statements.map((s) => s.sql));
      return real.batch(statements.map((s) => s.inner));
    },
    exec: (sql) => real.exec(sql),
    close: () => real.close(),
  };
  globalThis.__TEST_DB = db;
  return {
    db,
    rows: async (sql, ...args) => (await real.prepare(sql).bind(...args).all()).results,
    exec: (sql) => real.exec(sql),
  };
}
```

훅(`__BEFORE_WRITE`)이 기존 테스트에서 동기 함수로 DB를 쓰고 있었다면(`db.prepare(...).run()` 결과를 기다리지 않음) `await hook()`이 Promise를 기다리도록 해당 테스트의 훅을 `async`로 바꾼다.

- [ ] **Step 2: 테스트 7개 파일의 SQLite 대역 교체**

각 파일에서:
1. `import { DatabaseSync } from 'node:sqlite';`와 `const db = new DatabaseSync(':memory:')`부터 `globalThis.__TEST_DB = {…};`까지(마이그레이션 실행, `fireBeforeWrite`, `class Prepared` 포함)를 지운다.
2. 그 자리에:

```js
import { setupTestDb } from './helpers/pg-db.mjs';
const { rows, exec } = await setupTestDb();
```

3. 파일 안에서 `db.prepare(sql).all(...)`/`.get(...)`처럼 SQLite 대역을 직접 쓰던 원시 조회 헬퍼는 `await rows(sql, ...args)`(배열) / `(await rows(sql, ...args))[0]`로 바꾼다. `db.exec(...)`(트리거 등)는 `await exec(...)`.
4. esbuild 플러그인의 `./db` 바꿔치기(`export function database(){return globalThis.__TEST_DB}`)는 그대로 둔다.

- [ ] **Step 3: SQLite 트리거 2곳을 Postgres로** — `api.test.mjs`(697행 부근), `save-guards.test.mjs`(502행 부근)의 `CREATE TRIGGER … RAISE(ABORT,'SQLITE …')`를:

```js
await exec(`
  CREATE OR REPLACE FUNCTION pm_test_fail() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql;
  CREATE TRIGGER pm_test_fail BEFORE INSERT ON <원래 테이블> FOR EACH ROW EXECUTE FUNCTION pm_test_fail();
`);
```

(`<원래 테이블>`과 `BEFORE INSERT/UPDATE`는 기존 트리거와 같게.) 해제(`DROP TRIGGER`)도 `DROP TRIGGER pm_test_fail ON <테이블>; DROP FUNCTION pm_test_fail();`. 503 판정은 `DatabaseError`(문구 `database error:`)가 맡는다.

- [ ] **Step 4: 원시 값 단언 6곳**
  - `reminder-dispatch.test.mjs:259` `i.due_at === dueAt` → `sameInstant(i.due_at, dueAt)`, `:294` `p.due_at === deadline` → `sameInstant(p.due_at, deadline)`.
  - `reminder-consistency.test.mjs:445` `dues.map(d=>d.due_at)` → `dues.map((d) => d.due_at.toISOString())`.
  - `api.test.mjs:932-935` `done: 1` → `done: true`; `:952-955` `deliverables === '["기존 결과물"]'` → `assert.deepEqual(row.deliverables, ['기존 결과물'])`.
  - `sameInstant`은 `import { sameInstant } from '../lib/time.ts';`.
  - `api.test.mjs:916-929` 이전 규칙 시드 픽스처의 `start_date`·`deadline`·boolean 값은 Postgres가 받는 형태(`'2026-09-01'`, `'2026-09-08T18:00:00+09:00'`, `true/false`)로 쓴다. `''`는 NULL로.

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"` → 아직 FAIL(앱 코드 미전환). 실패 목록을 workspace에 저장해 이후 단계마다 줄어드는지 본다.

- [ ] **Step 5: SQLite 전용 SQL**
  - `lib/sprint-store.ts:104,112,120,129`, `lib/projects.ts:55,60`: `INSERT OR IGNORE INTO` → `INSERT INTO`, 문장 끝에 ` ON CONFLICT DO NOTHING`.
  - `lib/projects.ts:55` 리터럴 `,1,?)`(legacy) → `,true,?)`; 같은 문장의 `'["핵심 사용자 흐름"]'`은 jsonb로 그대로 들어간다.
  - `lib/projects.ts:273` `VALUES(?,?,'','',0,?)` → `VALUES(?,?,NULL,NULL,false,?)`; `:297` `.bind(id, v.title, v.goal, v.scope, v.completion, '')` → 마지막 `''` → `null`.
  - `lib/reminder-store.ts:37-40` `ON CONFLICT DO UPDATE` → `ON CONFLICT (project_id,kind,task_id,user_id,deadline_version,stage_minutes) DO UPDATE`(스키마의 고유 인덱스 컬럼과 같은지 확인).
  - `lib/sprint-store.ts:300`, `lib/source-documents.ts:69`: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` → `now()`.
  - `lib/reminder-dispatch.ts:88` `done=0` → `done=false`; `app/api/sprint/route.ts:509` `confirmed=0` → `confirmed=false`.
  - 불리언 바인딩: `lib/sprint-store.ts:114` `Number(t.optional)` → `t.optional`; `:326-327`, `:342-343`의 `Number(...)`/`? 1 : 0` → 불리언 그대로; `app/api/sprint/route.ts:543` `Number(b.confirmed)` → `Boolean(b.confirmed)`; `app/api/change-proposals/route.ts:531` `typeof value === 'boolean' ? Number(value) : value` → `value`.
  - JSON 쓰기: `lib/projects.ts:284` `JSON.stringify(v.deliverables)` → `v.deliverables`; `app/api/sprint/route.ts:200`, `app/api/change-proposals/route.ts:258-259, 627`의 `JSON.stringify(x)` → `x`(포트가 직렬화).

- [ ] **Step 6: 시각·JSON 읽기 전환**
  - 타입: `lib/sprint.ts` `Task.dueAt?: Date | null`. `lib/sprint-policy.ts` `Policy.startedAt/deadlineAt/completedAt: Date | null`, `policyRow`는 `(row.x as Date | null) ?? null`. `lib/deliverables.ts` `fixedAt/evidenceAt/confirmedAt: Date | null`. `lib/sprint-store.ts` `Member.joinedAt: Date`, `leftAt: Date | null`. `lib/reminder-store.ts` `ClaimedRow.dueAt/scheduledAt: Date`. 문서(`source-documents.ts`) `capturedAt: Date | null`, `createdAt: Date`. 변경안(`change-proposals.ts`) `createdAt: Date`, 적용 기록 `approvedAt: Date`.
  - `String(시각)` 제거: `lib/sprint-store.ts:186` `String(r.joined_at)` → `r.joined_at as Date`; `lib/reminder-store.ts:141-142` → `r.due_at as Date`, `r.scheduled_at as Date`; `lib/source-documents.ts:31,134` → `row.created_at as Date`; `lib/change-proposals.ts:64` → `head.created_at as Date`; `app/api/change-proposals/route.ts:131` → `r.approved_at as Date`.
  - 이전 규칙 일정(문자열 유지): `lib/sprint-store.ts:66-67` → `startDate: (row.start_date as string | null) ?? ''`, `deadline: row.deadline ? (row.deadline as Date).toISOString() : ''`.
  - 비교: `lib/reminder-dispatch.ts:59` → `if (!sameInstant(policy!.deadlineAt, item.dueAt))`; `:65` `Number(task.done)` → `task.done`; `:67` `task.due_at !== item.dueAt` → `!sameInstant(task.due_at as Date | null, item.dueAt)`. `app/api/sprint/route.ts:313` → `const dueChanged = !sameInstant(previous?.dueAt ?? null, dueAt);`. `app/api/change-proposals/route.ts:538` → `const dueChanged = !sameInstant(task?.dueAt ?? null, finalDue ?? null);`. `lib/change-proposals.ts:280`, `:411`: `(current ?? null) !== (value ?? null)` → `!(field === 'dueAt' ? sameInstant(current as Date | null, value as string | null) : (current ?? null) === (value ?? null))`(`:411`은 `if` 조건이 같다).
  - 초대 만료: `lib/projects.ts:380` `String(invite.expires_at) <= new Date().toISOString()` → `(invite.expires_at as Date).getTime() <= Date.now()`; `:431` `String(invite.expires_at) <= now` → `(invite.expires_at as Date).getTime() <= Date.now()`.
  - `Date.parse(x)`로 Policy/Task 시각을 읽던 곳은 `ms(x)`: `lib/sprint-policy.ts:59`, `app/api/sprint/route.ts:51,55`, `lib/ai-extraction.ts:198-200`, `lib/change-proposals.ts:291-293`, `lib/reminders.ts:27,60,67,93`. `lib/reminders.ts:83`(묶음 키)와 `:102`(`idempotencyKey`)는 `scheduledAt.toISOString()`으로 지금과 같은 문자열을 만든다.
  - `lib/sprint.ts`의 공용 함수(`deadlineDays(startedAt, deadline, tasks)`, `seoulTime(x)`)는 매개변수를 `Date | string`으로 받고 내부 `Date.parse(...)`를 `ms(...)`로.
  - JSON 읽기: `lib/change-proposals.ts:26-27` `JSON.parse(String(row.before))` → `row.before as Record<string, unknown>`(after도); `:104` `JSON.parse(r.entries)` → `r.entries as AppliedEntry[]`(타입 `entries: AppliedEntry[]`); `app/api/change-proposals/route.ts:133, 368` `JSON.parse(String(r.entries))` → `r.entries as AppliedEntry[]`.

Run 반복: `npm test 2>&1 | grep -E "^✖|^ℹ (pass|fail)" | head -40`. 남은 실패마다 원인을 고친다. Review Focus 1(`INSERT … SELECT`의 타입 미정 매개변수) 오류가 나면 그 자리에 명시 캐스트(`?::integer`, `?::boolean`, `?::timestamptz`)를 넣고 Ruling으로 남긴다.

- [ ] **Step 7: 화면 타입**
  - `components/task-editor.tsx`, `components/deadline-calendar.tsx`, `components/change-review.tsx`: `import type { Task }` 쓰는 곳을 `Wire<Task>`로(`import type { Wire } from '@/lib/wire';`). 화면이 받는 State·Policy 타입도 `Wire<…>`로 감싼다(`app/workspace/page.tsx`의 `State` 정의).
  - `components/project-workspace.tsx:111` `legacy: number` → `legacy: boolean`; `:492` `JSON.parse(state.details.deliverables)` → `state.details.deliverables`(타입 `deliverables: string[]`).
  - `npx tsc --noEmit` 오류가 0이 될 때까지 고친다. 화면 코드에서 시각은 `string`으로, 서버 코드에서는 `Date`로 다룬다.

- [ ] **Step 8: SQLite 흔적 삭제와 전체 검증**

```bash
git rm -rq drizzle
grep -rnE "node:sqlite|DatabaseSync|INSERT OR IGNORE|strftime|sqlite_master" app components lib scripts tests db | grep -v node_modules
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npx tsc --noEmit
npm run build
```

Expected: grep 출력 없음(테스트의 금지 단언 문자열 제외), 테스트 전부 PASS, 타입 0, 빌드 성공, 린트 새 오류 0.

- [ ] **Step 9: 커밋**

```bash
git add -A lib app components tests db package.json
git commit -m "feat: 앱과 테스트를 Postgres로 전환(시각 Date, boolean, jsonb)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 실제 환경 확인과 문서

**Files:**
- Modify: `web/README.md`, `CLAUDE.md`, `docs/dev-team-seed-notes.md`, `web/.env.example`

- [ ] **Step 1: 로컬(PGlite)** — 개발 서버를 끈 상태에서 `npm run db:migrate` → `npm run dev`. `curl`로 `/`·`/workspace` 200, 개발 헤더 `/api/projects` 200, `node scripts/seed-dev-team.mjs --base-url http://localhost:3000` 성공. 사용자: Google 로그인 → 프로젝트 생성 → 새로고침 유지. 증거: 서버 로그, `rows`로 `project_members`(UUID, `joined_at` timestamptz) 확인.

- [ ] **Step 2: Supabase 값 타입** — 사용자가 `web/.env.local`에 `DATABASE_URL`(Supabase → Project Settings → Database → Connection pooling, Transaction mode, 6543)을 넣는다. 에이전트는 값을 출력하지 않는다.

```bash
set -a; . ./.env.local; set +a; node --experimental-strip-types scripts/db-check.ts
```

Expected: `{"at":true,"ok":true,"j":true,"d":true,"n":true}`.

- [ ] **Step 3: Supabase 마이그레이션과 앱** — `set -a; . ./.env.local; set +a; npm run db:migrate` → `applied: 0000_init.sql`. `npm run dev`(같은 셸 환경, 또는 `.env.local`에 `DATABASE_URL`이 있으면 Next가 읽는다) → 시드 스크립트, Google 로그인 → 생성 → 새로고침.

- [ ] **Step 4: 동시성(Review Focus 2)** — 시드 프로젝트를 준비 상태로 하나 더 만들고(시드 스크립트의 시작 전 단계까지, 또는 API로 생성·초대·수락), 같은 `revision`으로 `start` 요청 두 개를 동시에:

```bash
for i in 1 2; do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/sprint -H 'content-type: application/json' -H 'origin: http://localhost:3000' -H 'oai-authenticated-user-id: dev-seed-lead-pm-qa' -d "{\"action\":\"start\",\"projectId\":\"$PID\",\"revision\":$REV}" & done; wait
```

Expected: `200` 하나, `409` 하나.

- [ ] **Step 5: REST 차단(Review Focus 3)**

```bash
set -a; . ./.env.local; set +a
for t in sprints project_members project_invites; do curl -s -w " %{http_code}\n" "$SUPABASE_URL/rest/v1/$t?select=*&limit=1" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY"; done
```

Expected: 각 테이블 `[] 200`(RLS로 행 없음) 또는 401/404. 행이 하나라도 나오면 멈추고 보고한다.

- [ ] **Step 6: 문서**
  - `web/.env.example`: `DATABASE_URL=`(주석: Supabase 연결 풀러 Transaction mode, 비우면 로컬 PGlite), `DATABASE_PATH=`(주석: 로컬 PGlite 경로, 기본 .data/pglite).
  - `web/README.md` 로컬 실행: "로컬 DB는 PGlite(`web/.data/pglite`). `npm run db:migrate`는 개발 서버를 끈 상태에서. `DATABASE_URL`을 넣으면 Supabase Postgres를 쓴다." Node 요구사항은 22.16 → 실제 필요 버전으로(`node:sqlite` 제거; Next 16 요구 `>=20.9`이지만 테스트·스크립트가 `--experimental-strip-types`를 쓰므로 22.6 이상). `package.json` `engines.node`도 같은 값.
  - `CLAUDE.md` 기술 원칙: "DB는 로컬 SQLite(lib/db.ts)이며 Supabase Postgres로 이전 중" → "DB는 Postgres. 운영 Supabase, 로컬·테스트 PGlite(lib/db.ts). 모든 테이블 RLS ON(정책 없음), 서버만 접근".
  - `docs/dev-team-seed-notes.md`: `npm run db:migrate` 안내에 "개발 서버를 끈 상태에서".

- [ ] **Step 7: 커밋**

```bash
git add README.md .env.example package.json ../CLAUDE.md ../docs/dev-team-seed-notes.md
git commit -m "docs: Postgres(Supabase·PGlite) 실행 방법

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 범위 밖

- Vercel 배포·Cron(3단계), Supabase Storage·CareerFlow 결합, 쿼리 빌더 전환, 리마인더 실행기 다중화.
