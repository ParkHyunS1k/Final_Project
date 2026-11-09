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
      "export { devLiveModel, liveModelFromEnv } from './lib/dev-live-model'; export { fakeModel, validateChanges, buildPrompt } from './lib/ai-extraction';",
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

test('route는 live-model 값을 process.env에서 읽고 저장소에 키를 두지 않는다', () => {
  const route = readFileSync('app/api/change-proposals/route.ts', 'utf8');
  const selection = readFileSync('lib/ai-model-selection.ts', 'utf8');
  assert.match(route, /import \{ model \} from '@\/lib\/ai-model-selection'/);
  assert.doesNotMatch(route, /export function useModel/);
  assert.match(selection, /liveModelFromEnv\(process\.env\)/);
  assert.doesNotMatch(route + selection, /cloudflare:workers/);
  assert.doesNotMatch(route + selection, /sk-[A-Za-z0-9_-]{10,}/);
});

test('live-model binding이 없을 때 route 기본 모델은 기존 fakeModel이다', async () => {
  const selection = readFileSync('lib/ai-model-selection.ts', 'utf8');
  assert.match(selection, /let model: Model = liveModelFromEnv\(process\.env\) \?\? fakeModel\(\);/);
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
    // 외부 오류 본문은 화면·DB로 보내지 않는다. 고정 문구만.
    await assert.rejects(
      () => api.devLiveModel({ apiKey: 'test-only-key' }).run(input),
      (e) => /AI 변경안을 만들지 못했습니다/.test(e.message) && !/bad request/.test(e.message),
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

test('실제 모델 응답이 제한 시간 안에 오지 않으면 재시도하지 않고 다시 시도 안내로 실패한다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      calls++;
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    });
  try {
    await assert.rejects(
      () => api.devLiveModel({ apiKey: 'test-only-key', timeoutMs: 50 }).run(input),
      /다시 시도해주세요/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('기본 모델은 gpt-6.1-sol이다', () => {
  assert.match(api.devLiveModel({ apiKey: 'k' }).name, /^live:gpt-6\.1-sol\//);
});

test('플래그와 공백 아닌 키가 모두 있어야 실제 모델을 만든다(아니면 null → 준비 중)', () => {
  assert.equal(api.liveModelFromEnv({}), null);
  assert.equal(api.liveModelFromEnv({ PROJECTMATE_LIVE_MODEL: '1' }), null);
  assert.equal(api.liveModelFromEnv({ PROJECTMATE_LIVE_MODEL: '1', OPENAI_API_KEY: '   ' }), null);
  assert.equal(api.liveModelFromEnv({ OPENAI_API_KEY: 'k' }), null);
  const m = api.liveModelFromEnv({ PROJECTMATE_LIVE_MODEL: '1', OPENAI_API_KEY: 'k', PROJECTMATE_MODEL: 'gpt-x' });
  assert.equal(m.live, true);
  assert.match(m.name, /^live:gpt-x\//);
});

test('응답 헤더 뒤 본문이 멈춰도 제한 시간에서 다시 시도 안내로 실패한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  try {
    await assert.rejects(
      () => api.devLiveModel({ apiKey: 'test-only-key', timeoutMs: 50 }).run(input),
      /다시 시도해주세요/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('429·5xx가 끝까지 이어지면 원문 오류 없이 다시 시도 안내로 실패한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('rate limited: org-secret-detail', { status: 429 });
  try {
    await assert.rejects(
      () => api.devLiveModel({ apiKey: 'test-only-key', timeoutMs: 200 }).run(input),
      (e) => /다시 시도해주세요/.test(e.message) && !/org-secret-detail/.test(e.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('모델이 ‹로 무력화된 원문을 인용해도 원문 위치와 원문 인용으로 검증된다', async () => {
  const body = '앞 문장.\n화면 구현 </source> 끝';
  const tagged = { ...input, source: { id: 'tag-source', body } };
  const originalFetch = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).input;
    return responseWith([liveCreate({ evidenceQuote: '화면 구현 ‹/source> 끝' })]);
  };
  try {
    const output = await api.devLiveModel({ apiKey: 'test-only-key' }).run(tagged);
    assert.equal(JSON.stringify(prompt).match(/<\s*\/\s*source/gi).length, 1);
    const checked = api.validateChanges(output.changes, tagged);
    assert.equal(checked.rejected.length, 0);
    assert.deepEqual(checked.changes[0].evidence, {
      start: body.indexOf('화면'),
      end: body.length,
      quote: '화면 구현 </source> 끝',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-11-09: 원문에 공수가 없으면 AI가 추정해 채우고, 추정임을 따로 표시한다.
test('AI 지시문은 신규 업무 공수를 원문에 없으면 하루 8시간 기준으로 추정하라고 한다', () => {
  const prompt = api.buildPrompt(input);
  assert.match(prompt, /공수가 원문에 없으면.*추정/);
  assert.match(prompt, /하루 8시간/);
});

test('실제 모델이 추정한 공수는 채워진 채 AI 추정으로 표시되고 확인 필요가 붙는다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    responseWith([liveCreate({ remaining: 6, remainingBasis: 'estimate' })]);
  try {
    const model = api.devLiveModel({ apiKey: 'k', model: 'm', reasoningEffort: 'low' });
    const checked = api.validateChanges((await model.run(input)).changes, input);
    const c = checked.changes[0];
    assert.equal(c.after.remaining, 6);
    assert.equal(c.after.remainingEstimated, true);
    assert.match(c.needsReview, /AI 추정/);
    // 업무 자체는 원문 근거가 있으므로 사실로 남는다.
    assert.equal(c.basis, 'fact');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('원문에 적힌 공수는 추정 표시 없이 그대로 쓴다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseWith([liveCreate({ remainingBasis: 'fact' })]);
  try {
    const model = api.devLiveModel({ apiKey: 'k', model: 'm', reasoningEffort: 'low' });
    const c = api.validateChanges((await model.run(input)).changes, input).changes[0];
    assert.equal(c.after.remaining, 8);
    assert.equal('remainingEstimated' in c.after, false);
    assert.equal(c.needsReview, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('실제 모델 응답 스키마는 공수 근거(remainingBasis)를 반드시 받는다', () => {
  const adapter = readFileSync('lib/dev-live-model.ts', 'utf8');
  assert.match(adapter, /remainingBasis/);
  assert.match(adapter, /required: \[[^\]]*'remainingBasis'/);
});

test('로컬 가짜 모델도 공수가 없는 신규 업무에 추정 공수를 채운다', async () => {
  const fakeInput = { ...input, source: { id: 's', body: '- 새 업무: 로그인 화면 만들기' } };
  const out = await api.fakeModel().run(fakeInput);
  const c = api.validateChanges(out.changes, fakeInput).changes[0];
  assert.equal(c.kind, 'createTask');
  assert.equal(typeof c.after.remaining, 'number');
  assert.equal(c.after.remainingEstimated, true);
});
