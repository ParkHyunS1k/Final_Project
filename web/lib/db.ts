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
  // new PGlite(dataDir, options)는 options를 무시한다(0.5.8에서 확인). 객체 하나로 넘긴다.
  const db = new PGlite({ dataDir, parsers: pgliteParsers });
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
