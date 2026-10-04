// 실제 lib/db.ts(PGlite 메모리)에 마이그레이션을 적용한 테스트 DB.
// 쓰기 직전 끼어들기 훅(__BEFORE_WRITE)은 이전 SQLite 대역과 같은 규칙으로, 패턴에 맞는
// 쓰기(batch/run) 앞에서 한 번 실행하고 끝날 때까지 기다린다.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 밖으로 뺀 pglite·postgres를 node_modules에서 찾도록 번들 결과는 web/ 아래에 둔다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const out = join(mkdtempSync(join(cache, 'pm-pg-')), 'db.mjs');
await build({
  stdin: {
    contents:
      "export { openPglite } from './lib/db.ts'; export { migrate } from './scripts/migrate.ts';",
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

async function fire(sqls) {
  const hook = globalThis.__BEFORE_WRITE;
  if (!hook) return;
  const pattern = globalThis.__BEFORE_WRITE_SQL ?? 'UPDATE sprints SET revision';
  if (!sqls.some((s) => s.includes(pattern))) return;
  globalThis.__BEFORE_WRITE = null;
  globalThis.__BEFORE_WRITE_SQL = null;
  await hook();
}

/**
 * globalThis.__TEST_DB(앱 코드가 ./db 대신 쓰는 DB)를 설정하고, 테스트용 비동기 조회를 돌려준다.
 * - rows(sql, ...args): 행 배열
 * - one(sql, ...args): 첫 행 또는 null
 * - run(sql, ...args): 영향받은 행 수
 * - exec(sql): 매개변수 없는 여러 문장
 */
export async function setupTestDb() {
  const real = openPglite();
  await migrate(real);
  const wrap = (sql, inner) => ({
    sql,
    inner,
    bind: (...args) => wrap(sql, inner.bind(...args)),
    first: () => inner.first(),
    all: () => inner.all(),
    run: async () => {
      if (!/^\s*SELECT/i.test(sql)) await fire([sql]);
      return inner.run();
    },
  });
  globalThis.__TEST_DB = {
    prepare: (sql) => wrap(sql, real.prepare(sql)),
    async batch(statements) {
      await fire(statements.map((s) => s.sql));
      return real.batch(statements.map((s) => s.inner));
    },
    exec: (sql) => real.exec(sql),
    close: () => real.close(),
  };
  return {
    rows: async (sql, ...args) => (await real.prepare(sql).bind(...args).all()).results,
    one: (sql, ...args) => real.prepare(sql).bind(...args).first(),
    run: async (sql, ...args) => (await real.prepare(sql).bind(...args).run()).meta.changes,
    exec: (sql) => real.exec(sql),
  };
}
