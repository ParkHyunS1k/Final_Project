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

// node --experimental-strip-types(테스트)는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
class SqliteStatement implements Statement {
  private readonly db: DatabaseSync;
  readonly sql: string;
  private readonly args: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, args: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
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
