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
