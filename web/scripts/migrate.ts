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
    // 로컬 PGlite를 개발 서버가 쓰고 있으면 lib/db.ts가 잠금 안내를 담아 던진다.
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
