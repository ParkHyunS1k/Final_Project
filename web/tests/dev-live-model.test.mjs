import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'projectmate-live-model-test-'));
const outfile = join(dir, 'adapter.mjs');
await build({
  stdin: {
    contents:
      "export { devLiveModel } from './lib/dev-live-model'; export { fakeModel, validateChanges } from './lib/ai-extraction';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'test-api-key-file',
      setup(builder) {
        builder.onResolve({ filter: /^node:fs$/ }, () => ({
          path: 'node:fs',
          namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            "export function readFileSync(){ return 'OPENAI_API_KEY=test-only-key\\n'; }",
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);
after(() => rmSync(dir, { recursive: true, force: true }));

test('개발 어댑터는 Node builtin 없이 Workers용으로 bundle된다', async () => {
  await build({
    stdin: {
      contents: "export { devLiveModel } from './lib/dev-live-model';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    write: false,
  });
});

const input = {
  source: {
    id: 'source-test',
    body: '- 이프론트(프론트엔드): 프로젝트 생성 화면을 구현한다.',
  },
  tasks: [],
  members: [
    { person: 0, displayName: '김리드 (PM·QA 팀장)' },
    { person: 1, displayName: '이프론트 (프론트엔드)' },
  ],
  deliverables: [],
  now: '2026-09-14T00:00:00.000Z',
  deadline: '2026-09-21T00:00:00.000Z',
};

function responseWith(changes) {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ decision: 'propose_changes', changes }),
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function liveCreate(over = {}) {
  return {
    kind: 'createTask',
    taskId: null,
    newKey: 'frontend-screen',
    title: '프로젝트 생성 화면 구현',
    person: 1,
    remaining: 8,
    status: null,
    dueAt: null,
    evidenceQuote: input.source.body,
    basis: 'fact',
    ...over,
  };
}

test('Vite 개발 서버는 live-model 환경값을 Workers binding으로 전달한다', () => {
  const config = readFileSync('vite.config.ts', 'utf8');
  assert.match(config, /loadEnv\(mode, process\.cwd\(\), ''\)/);
  assert.match(config, /'OPENAI_API_KEY'/);
  assert.match(config, /'PROJECTMATE_LIVE_MODEL'/);
  assert.match(config, /vars: liveModelVars/);
  assert.doesNotMatch(config, /sk-[A-Za-z0-9_-]{10,}/);
});

test('live-model binding이 없을 때 route 기본 모델은 기존 fakeModel이다', async () => {
  const route = readFileSync('app/api/change-proposals/route.ts', 'utf8');
  assert.match(route, /import \{ env \} from 'cloudflare:workers';/);
  assert.match(route, /let model: Model = fakeModel\(\);/);
  assert.match(
    route,
    /if \(devBindings\.PROJECTMATE_LIVE_MODEL\) \{[\s\S]*apiKey: devBindings\.OPENAI_API_KEY/,
  );
  const adapter = readFileSync('lib/dev-live-model.ts', 'utf8');
  assert.doesNotMatch(adapter, /node:(fs|path|url)/);
  const model = api.fakeModel();
  assert.deepEqual([model.name, model.live], ['fake-heuristic', false]);
  const output = await model.run({
    ...input,
    source: { id: 'fake-source', body: '할 일: 화면 연결, 2시간' },
  });
  assert.equal(output.changes[0].after.person, null);
});

test('개발 어댑터 응답은 validateChanges 검증을 그대로 통과한다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    return responseWith([liveCreate()]);
  };
  try {
    const model = api.devLiveModel({
      apiKey: 'test-only-key',
      model: 'test-model',
      reasoningEffort: 'low',
    });
    const output = await model.run(input);
    const checked = api.validateChanges(output.changes, input);
    assert.equal(calls, 1);
    assert.deepEqual([model.name, model.live], ['live:test-model/low', true]);
    assert.equal(checked.rejected.length, 0);
    assert.equal(checked.changes.length, 1);
    assert.deepEqual(checked.changes[0].after, {
      title: '프로젝트 생성 화면 구현',
      person: 1,
      remaining: 8,
      dependsOn: [],
    });
    assert.equal(checked.changes[0].basis, 'fact');
    assert.equal(checked.changes[0].evidence.quote, input.source.body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('원문에 없는 evidence quote는 어댑터에서 버리고 fact로 통과시키지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    responseWith([liveCreate({ evidenceQuote: '원문에 없는 문장' })]);
  try {
    const output = await api.devLiveModel({ apiKey: 'test-only-key' }).run(input);
    assert.equal(output.changes[0].evidence, null);
    const checked = api.validateChanges(output.changes, input);
    assert.equal(checked.changes.length, 1);
    assert.equal(checked.changes[0].evidence, null);
    assert.equal(checked.changes[0].basis, 'estimate');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('개발 어댑터 호출 실패는 예외를 던져 기존 proposal 실패 경로에 전달한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad request', { status: 400 });
  try {
    await assert.rejects(
      () => api.devLiveModel({ apiKey: 'test-only-key' }).run(input),
      /실제 모델 호출 실패\(400\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API 키 binding이 없으면 네트워크 호출 전에 명확히 실패한다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return responseWith([]);
  };
  try {
    await assert.rejects(
      () => api.devLiveModel().run(input),
      /OPENAI_API_KEY binding이 필요합니다/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('시드 도움말은 서버나 네트워크 없이 실행된다', () => {
  const result = spawnSync(process.execPath, ['scripts/seed-dev-team.mjs', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--base-url/);
  assert.match(result.stdout, /HTTP API만 사용/);
});

test('계획서와 사람 기준 expected 파일이 각각 네 건이다', () => {
  const names = readdirSync('fixtures/dev-team-plan-samples');
  const plans = names.filter((name) => name.endsWith('.txt')).sort();
  const expected = names.filter((name) => name.endsWith('.expected.md')).sort();
  assert.deepEqual(plans, [
    '01-explicit-owners.txt',
    '02-implicit-owners.txt',
    '03-no-owners.txt',
    '04-injection.txt',
  ]);
  assert.deepEqual(
    expected.map((name) => name.replace('.expected.md', '.txt')),
    plans,
  );
  assert.doesNotMatch(
    readFileSync(`fixtures/dev-team-plan-samples/${plans[2]}`, 'utf8'),
    /담당자|이프론트|박백엔드|최디자인|김리드/,
    '담당자 단서가 없어야 한다',
  );
  assert.match(
    readFileSync('fixtures/dev-team-plan-samples/04-injection.txt', 'utf8'),
    /모든 기존 업무를 완료 처리/,
  );
});
