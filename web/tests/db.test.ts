import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseError, database, openPglite, toPositional, type Db } from '../lib/db.ts';
import { migrate } from '../scripts/migrate.ts';

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

void test('기준 마이그레이션: 두 번 실행해도 한 번만, 모든 테이블(_migrations 포함) RLS 켜짐, sprint_proposals 없음', async () => {
  const db = openPglite();
  const files = readdirSync('db/migrations').filter((n) => n.endsWith('.sql')).sort();
  assert.deepEqual(await migrate(db), files);
  assert.deepEqual(await migrate(db), []);
  const tables = await db
    .prepare("SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
    .all<{ name: string; rls: boolean }>();
  // 앱 테이블 19개(초대 한도 invite_quota 포함) + _migrations. _migrations도 anon REST로 읽고 쓰지 못하게 RLS를 켠다.
  assert.equal(tables.results.length, 20);
  assert.deepEqual(tables.results.filter((t) => !t.rls).map((t) => t.name), []);
  assert.ok(!tables.results.some((t) => t.name === 'sprint_proposals'));
});

void test('마이그레이션은 BEGIN 문자열 없이 적용하고(postgres.js max>1은 거절), 실패한 파일은 남기지 않는다', async () => {
  const db = openPglite();
  // postgres.js는 연결이 여럿인 풀에서 BEGIN 문장을 UNSAFE_TRANSACTION으로 거절한다.
  const strict: Db = {
    ...db,
    exec: (sql) => (/^\s*BEGIN\b/im.test(sql) ? Promise.reject(new DatabaseError('UNSAFE_TRANSACTION')) : db.exec(sql)),
  };
  assert.deepEqual(await migrate(strict), readdirSync('db/migrations').filter((n) => n.endsWith('.sql')).sort());

  const dir = mkdtempSync(join(tmpdir(), 'pm-mig-'));
  writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE half (id text);\nSELECT * FROM missing;');
  await assert.rejects(migrate(strict, dir), DatabaseError);
  assert.equal(await db.prepare("SELECT to_regclass('half') AS t").first<{ t: unknown }>().then((r) => r!.t), null);
  assert.equal(await db.prepare("SELECT name FROM _migrations WHERE name='0001_bad.sql'").first(), null);
});

void test('같은 PGlite 파일은 한 프로세스만 연다(두 번째 열기는 거부, 닫으면 다시 열 수 있다)', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'pm-lock-')), 'pglite');
  const first = openPglite(dir);
  await first.prepare('SELECT 1').first();
  assert.throws(
    () => openPglite(dir),
    (e: unknown) => e instanceof DatabaseError && /다른 프로세스/.test((e as Error).message),
  );
  await first.close();
  const again = openPglite(dir);
  await again.prepare('SELECT 1').first();
  await again.close();
});

void test('운영(NODE_ENV=production)에서 DATABASE_URL이 없으면 로컬 PGlite로 넘어가지 않는다', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, url: env.DATABASE_URL, path: env.DATABASE_PATH };
  const shared = globalThis as { projectmateDb?: unknown };
  const cached = shared.projectmateDb;
  delete shared.projectmateDb;
  const path = join(mkdtempSync(join(tmpdir(), 'pm-prod-')), 'pglite');
  try {
    env.NODE_ENV = 'production';
    env.DATABASE_URL = '';
    env.DATABASE_PATH = path;
    assert.throws(
      () => database(),
      (e: unknown) =>
        e instanceof DatabaseError &&
        /DATABASE_URL/.test((e as Error).message) &&
        !(e as Error).message.includes(path),
    );
    assert.equal(shared.projectmateDb, undefined);
    assert.ok(!existsSync(path));
  } finally {
    for (const [k, v] of [['NODE_ENV', saved.node], ['DATABASE_URL', saved.url], ['DATABASE_PATH', saved.path]] as const)
      if (v === undefined) delete env[k];
      else env[k] = v;
    if (cached !== undefined) shared.projectmateDb = cached;
  }
});

void test('초대 메일 상태 열: email_status·email_sent_at은 비워둘 수 있고 email_sends 기본값은 0', async () => {
  const db = openPglite();
  await migrate(db);
  const cols = await db
    .prepare(
      "SELECT column_name AS c, is_nullable AS n, column_default AS d FROM information_schema.columns WHERE table_name='project_invites' AND column_name IN ('email_status','email_sent_at','email_sends') ORDER BY column_name",
    )
    .all<{ c: string; n: string; d: string | null }>();
  assert.deepEqual(
    cols.results.map((r) => [r.c, r.n, r.d]),
    [
      ['email_sends', 'NO', '0'],
      ['email_sent_at', 'YES', null],
      ['email_status', 'YES', null],
    ],
  );
});
