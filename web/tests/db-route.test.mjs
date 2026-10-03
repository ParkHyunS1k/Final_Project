import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 다른 API 테스트는 ./db를 대역으로 바꾼다. 이 파일은 실제 lib/db.ts로 라우트의 503 계약을 확인한다.
process.env.AUTH_DEV_HEADERS = '1';
const dir = mkdtempSync(join(tmpdir(), 'projectmate-db-route-'));
const outfile = join(dir, 'route.mjs');
await build({
  stdin: {
    contents: "export { GET } from './app/api/projects/route';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { GET } = await import(pathToFileURL(outfile).href);

/** 새 DB 경로로 요청을 보내고, 응답과 서버 로그(console.error)를 돌려준다. */
async function request(path) {
  delete globalThis.projectmateDb; // 연결 캐시를 비워 새 경로를 연다
  process.env.DATABASE_PATH = path;
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const r = await GET(
      new Request('https://test.local/api/projects', {
        headers: {
          'oai-authenticated-user-id': 'u1',
          'oai-authenticated-user-email': 'u1@test.local',
        },
      }),
    );
    return { status: r.status, body: await r.text(), log: logs.join('\n') };
  } finally {
    console.error = original;
  }
}

test('마이그레이션하지 않은 DB는 503으로 숨기고 원인은 서버 로그에만 남긴다', async () => {
  const r = await request(join(dir, 'fresh', 'x.sqlite'));
  assert.equal(r.status, 503, r.body);
  assert.doesNotMatch(r.body, /no such table|sqlite/i);
  assert.match(r.log, /no such table/);
});

test('DB 파일을 열 수 없으면 503으로 숨기고 경로를 응답에 넣지 않는다', async () => {
  const r = await request('/dev/null/nested/x.sqlite');
  assert.equal(r.status, 503, r.body);
  assert.doesNotMatch(r.body, /dev\/null|ENOTDIR|mkdir/);
  assert.match(r.log, /database error/);
});
