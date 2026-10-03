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
