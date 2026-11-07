import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setupTestDb } from './helpers/pg-db.mjs';

process.env.AUTH_DEV_HEADERS = '1';
process.env.OPENAI_API_KEY = 'synthetic-test-key';
const db = await setupTestDb();
const dir = mkdtempSync(join(tmpdir(), 'career-write-test-'));
const out = join(dir, 'api.mjs');
await build({
  stdin: {
    contents: `export { POST } from './app/api/career/route';
      export { claimProfileWrite, releaseProfileWrite } from './lib/career/profile-write';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'memory-db',
      setup(b) {
        b.onResolve({ filter: /^\.\/db$/ }, () => ({
          path: 'db',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export function database(){return globalThis.__TEST_DB}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(out).href);
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
  await globalThis.__TEST_DB.close();
  rmSync(dir, { recursive: true });
});
const post = (user, over = {}) =>
  api.POST(
    new Request('https://test.local/api/career', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://test.local',
        'oai-authenticated-user-id': user,
      },
      body: JSON.stringify({
        action: 'profile',
        version: 0,
        mode: 'ai',
        consent: true,
        resumeName: '가상 이력서',
        resumeText: 'Python과 FastAPI로 문서 검색 API를 구현했습니다.',
        targetRole: 'ai-engineer',
        targetPosting: '',
        learningGoals: [],
        preferredRoles: ['ai'],
        noExperience: [],
        ...over,
      }),
    }),
  );
function modelResponse() {
  return Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              summary: 'Python API 구현 경험이 있습니다.',
              skills: [
                {
                  skillId: 'python',
                  level: 'applied',
                  quote: 'Python과 FastAPI로 문서 검색 API를 구현했습니다.',
                },
              ],
              requirements: [],
              questions: [],
            }),
          },
        ],
      },
    ],
  });
}
function holdModel() {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    entered.resolve();
    await finish.promise;
    return modelResponse();
  };
  return {
    entered: entered.promise,
    finish: () => finish.resolve(),
    calls: () => calls,
  };
}
const used = async (user) =>
  (
    await db.one(
      'SELECT sum(n) AS n FROM career_ai_quota WHERE user_id=?',
      user,
    )
  ).n ?? 0;
const row = (user) =>
  db.one('SELECT * FROM career_profile_writes WHERE user_id=?', user);

for (const version of [0, 1]) {
  test(
    `프로필 버전 ${version} 동시 저장은 모델과 한도를 한 번만 사용한다`,
    { timeout: 15000 },
    async () => {
      const user = 'concurrent-' + version;
      if (version)
        assert.equal((await post(user, { mode: 'basic' })).status, 200);
      const model = holdModel();
      const first = post(user, { version });
      try {
        await model.entered;
        const second = await post(user, { version });
        assert.equal(second.status, 409);
        assert.equal(model.calls(), 1);
        assert.equal(await used(user), 1);
      } finally {
        model.finish();
      }
      const response = await first;
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).profile.version, version + 1);
      assert.equal((await row(user)).claim_id, null);
      assert.equal((await post(user, { version })).status, 409);
      assert.equal(model.calls(), 1);
      assert.equal(await used(user), 1);
      assert.equal(
        (
          await db.one(
            'SELECT count(*) AS n FROM career_profile_versions WHERE user_id=?',
            user,
          )
        ).n,
        version + 1,
      );
    },
  );
}

test(
  'AI 처리 중 기본 저장도 차단하고 다른 계정은 독립적으로 저장한다',
  { timeout: 15000 },
  async () => {
    const model = holdModel();
    const first = post('basic-race');
    let other;
    try {
      await model.entered;
      assert.equal((await post('basic-race', { mode: 'basic' })).status, 409);
      other = post('independent');
    } finally {
      model.finish();
    }
    assert.equal((await first).status, 200);
    assert.equal((await other).status, 200);
    assert.equal(model.calls(), 2);
    assert.equal(await used('basic-race'), 1);
    assert.equal(await used('independent'), 1);
  },
);

test('기본 저장이 먼저 선점하면 AI 요청은 모델과 한도를 사용하지 않는다', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return modelResponse();
  };
  const claim = await api.claimProfileWrite('basic-first', 0, false);
  try {
    assert.equal((await post('basic-first')).status, 409);
    assert.equal(calls, 0);
    assert.equal(await used('basic-first'), 0);
  } finally {
    await api.releaseProfileWrite(claim);
  }
});

for (const failure of ['provider', 'timeout', 'save']) {
  test(`${failure} 실패 시 선점과 한도를 해제하고 같은 버전으로 재시도한다`, async () => {
    const user = 'failure-' + failure;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (failure === 'provider')
        return new Response('PRIVATE_PROVIDER_ERROR', { status: 500 });
      if (failure === 'timeout')
        throw new DOMException('timeout', 'TimeoutError');
      globalThis.__BEFORE_WRITE_SQL = 'INSERT INTO career_profiles';
      globalThis.__BEFORE_WRITE = async () => {
        throw new Error('PRIVATE_DB_ERROR');
      };
      return modelResponse();
    };
    const response = await post(user);
    assert.equal(response.status, failure === 'save' ? 503 : 502);
    assert.doesNotMatch(await response.text(), /PRIVATE_/);
    assert.equal((await row(user)).claim_id, null);
    assert.equal(await used(user), 0);
    assert.equal(
      await db.one('SELECT * FROM career_profiles WHERE user_id=?', user),
      null,
    );
    globalThis.fetch = async () => {
      calls++;
      return modelResponse();
    };
    assert.equal((await post(user)).status, 200);
    assert.equal(calls, 2);
    assert.equal(await used(user), 1);
  });
}

test(
  '만료된 요청의 늦은 결과가 새 선점이나 새 프로필을 덮어쓰지 않는다',
  { timeout: 15000 },
  async () => {
    const oldModel = holdModel();
    const oldRequest = post('expired');
    await oldModel.entered;
    await db.run(
      "UPDATE career_profile_writes SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=?",
      'expired',
    );
    const newModel = holdModel();
    const newRequest = post('expired');
    try {
      await newModel.entered;
      const newClaim = (await row('expired')).claim_id;
      oldModel.finish();
      assert.equal((await oldRequest).status, 409);
      assert.equal((await row('expired')).claim_id, newClaim);
      assert.equal(await used('expired'), 1);
    } finally {
      oldModel.finish();
      newModel.finish();
    }
    assert.equal((await newRequest).status, 200);
    assert.equal((await row('expired')).claim_id, null);
    assert.equal(
      (
        await db.one(
          'SELECT count(*) AS n FROM career_profile_versions WHERE user_id=?',
          'expired',
        )
      ).n,
      1,
    );
  },
);

test('프로세스가 중단돼 남은 선점은 만료 후 다시 사용할 수 있다', async () => {
  const abandoned = await api.claimProfileWrite('abandoned', 0, false);
  await db.run(
    "UPDATE career_profile_writes SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=?",
    abandoned.userId,
  );
  globalThis.fetch = async () => modelResponse();
  assert.equal((await post(abandoned.userId)).status, 200);
  assert.equal(await used(abandoned.userId), 1);
});

test('한도 초과는 모델을 호출하지 않고 선점을 해제해 기본 추출을 허용한다', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return modelResponse();
  };
  await db.run(
    "INSERT INTO career_ai_quota(user_id,day,n) VALUES(?,(now() AT TIME ZONE 'Asia/Seoul')::date,10)",
    'limited',
  );
  assert.equal((await post('limited')).status, 429);
  assert.equal(calls, 0);
  assert.equal(await used('limited'), 10);
  assert.equal((await row('limited')).claim_id, null);
  assert.equal((await post('limited', { mode: 'basic' })).status, 200);
});
