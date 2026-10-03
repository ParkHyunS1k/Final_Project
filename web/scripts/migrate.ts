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
    // 파일 하나를 트랜잭션 하나로. 여러 문장을 한 번에 보내면 Postgres가 암묵적 트랜잭션으로 묶는다.
    // BEGIN 문장은 쓰지 않는다: postgres.js는 연결이 여럿인 풀에서 이를 거절한다(UNSAFE_TRANSACTION).
    await db.exec(`${readFileSync(join(dir, name), 'utf8')}\n;INSERT INTO _migrations(name, applied_at) VALUES('${name.replace(/'/g, "''")}', now());`);
    applied.push(name);
  }
  return applied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db: Db | undefined;
  try {
    db = database();
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  } catch (e) {
    // 로컬 PGlite를 개발 서버가 쓰고 있으면 lib/db.ts가 잠금 안내를 담아 던진다.
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    // 연결을 닫지 않으면 postgres.js 풀이 프로세스를 붙잡는다.
    await db?.close();
  }
}
