import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

process.env.AUTH_DEV_HEADERS = '1';
process.env.JOOBLE_API_KEY = 'test-key';

const out = join(mkdtempSync(join(tmpdir(), 'projectmate-jobs-')), 'api.mjs');
await build({
  stdin: {
    contents: "export { GET } from './app/api/jobs/route';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const api = await import(pathToFileURL(out).href);

const realFetch = globalThis.fetch;
let captured;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : '';
  captured = { url, init };
  return new Response(
    JSON.stringify({
      totalCount: 1,
      jobs: [
        {
          id: 42,
          title: '백엔드 개발자',
          company: 'ProjectMate',
          location: '서울',
          snippet: '<p>API와 테스트를 만듭니다.</p>',
          salary: '협의',
          source: 'example',
          type: 'Full-time',
          link: 'https://example.com/jobs/42',
          updated: '2026-10-08T00:00:00Z',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

after(() => {
  globalThis.fetch = realFetch;
});

const request = (user, path) =>
  new Request('https://test.local' + path, {
    headers: {
      'oai-authenticated-user-id': user,
      'oai-authenticated-user-email': user + '@test.local',
    },
  });

test('공고 검색은 로그인과 입력값을 확인하고 Jooble 결과를 정규화한다', async () => {
  const response = await api.GET(
    request('user-a', '/api/jobs?keywords=백엔드%20개발&location=서울&page=2'),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jobs[0].title, '백엔드 개발자');
  assert.equal(body.jobs[0].link, 'https://example.com/jobs/42');
  assert.equal(captured.url, 'https://kr.jooble.org/api/test-key');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.body, /"keywords":"백엔드 개발"/);
  assert.match(captured.init.body, /"location":"서울"/);
  assert.match(captured.init.body, /"page":"2"/);
});

test('공고 검색은 인증되지 않은 요청을 차단한다', async () => {
  const response = await api.GET(
    new Request('https://test.local/api/jobs?keywords=백엔드'),
  );
  assert.equal(response.status, 401);
});

test('공고 검색은 너무 짧은 검색어를 Jooble에 보내지 않는다', async () => {
  const response = await api.GET(
    request('user-a', '/api/jobs?keywords=x&location=서울'),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /두 글자/);
});

test('서버에 공고 검색 키가 없으면 설정 정보 대신 준비 중이라고 답한다', async () => {
  const key = process.env.JOOBLE_API_KEY;
  delete process.env.JOOBLE_API_KEY;
  try {
    const response = await api.GET(
      request('user-a', '/api/jobs?keywords=백엔드&location=서울'),
    );
    assert.equal(response.status, 503);
    const { error } = await response.json();
    assert.match(error, /준비 중/);
    assert.doesNotMatch(error, /env|API 키/);
  } finally {
    process.env.JOOBLE_API_KEY = key;
  }
});
