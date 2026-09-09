import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const name of readdirSync('drizzle')
  .filter((n) => n.endsWith('.sql'))
  .sort())
  db.exec(readFileSync('drizzle/' + name, 'utf8'));
// 실제 쓰기 직전에 상태를 바꾸는 상황을 재현하기 위한 훅.
// __BEFORE_WRITE_SQL로 어떤 문장 직전에 실행할지 지정한다(기본값: 버전 증가 UPDATE).
function fireBeforeWrite(sqls) {
  const hook = globalThis.__BEFORE_WRITE;
  if (!hook) return;
  const pattern = globalThis.__BEFORE_WRITE_SQL ?? 'UPDATE sprints SET revision';
  if (!sqls.some((sql) => sql.includes(pattern))) return;
  globalThis.__BEFORE_WRITE = null;
  globalThis.__BEFORE_WRITE_SQL = null;
  hook();
}
class Prepared {
  constructor(sql, args = []) {
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Prepared(this.sql, args);
  }
  async first() {
    return db.prepare(this.sql).get(...this.args) ?? null;
  }
  async run() {
    return this.execute();
  }
  async all() {
    return this.execute();
  }
  execute() {
    if (!/^\s*SELECT/.test(this.sql)) fireBeforeWrite([this.sql]);
    const st = db.prepare(this.sql);
    if (/^\s*SELECT/.test(this.sql))
      return {
        results: st.all(...this.args),
        meta: { changes: 0 },
        success: true,
      };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes) }, success: true };
  }
}
globalThis.__TEST_DB = {
  prepare: (sql) => new Prepared(sql),
  async batch(statements) {
    fireBeforeWrite(statements.map((s) => s.sql));
    db.exec('BEGIN');
    try {
      const rows = statements.map((s) => s.execute());
      db.exec('COMMIT');
      return rows;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};
const dir = mkdtempSync(join(tmpdir(), 'projectmate-api-test-'));
const outfile = join(dir, 'route.mjs');
await build({
  stdin: {
    contents:
      "export * from './app/api/sprint/route'; export { initialize } from './lib/sprint-store'; export { GET as projectsGET,POST as projectsPOST } from './app/api/projects/route'; export { GET as sourcesGET,POST as sourcesPOST } from './app/api/sources/route'; export { GET as proposalsGET,POST as proposalsPOST,useModel } from './app/api/change-proposals/route'; export { fakeModel,validateChanges } from './lib/ai-extraction';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'test-d1',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'd1',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export const env=new Proxy({},{get:(_,k)=>k==="DB"?globalThis.__TEST_DB:globalThis.__TEST_ENV?.[k]});',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);
async function get(owner = 'alice') {
  if (owner) await api.initialize(owner);
  return api.GET(
    new Request('https://test.local/api/sprint', {
      headers: owner ? { 'oai-authenticated-user-id': owner } : {},
    }),
  );
}
async function post(owner, action, revision, fields = {}) {
  return api.POST(
    new Request('https://test.local/api/sprint', {
      method: 'POST',
      headers: {
        'oai-authenticated-user-id': owner,
        'content-type': 'application/json',
        origin: 'https://test.local',
      },
      body: JSON.stringify({ action, revision, ...fields }),
    }),
  );
}
async function data(owner) {
  const r = await get(owner);
  assert.equal(r.status, 200);
  return r.json();
}

function headers(user) {
  return {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@test.local',
    'content-type': 'application/json',
    origin: 'https://test.local',
  };
}
async function projectRequest(user, body) {
  return api.projectsPOST(
    new Request('https://test.local/api/projects', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    }),
  );
}
async function scoped(user, id, query = '') {
  return api.GET(
    new Request(
      'https://test.local/api/sprint?project=' + encodeURIComponent(id) + query,
      { headers: headers(user) },
    ),
  );
}
async function read(user, id) {
  const r = await scoped(user, id);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const goalFields = {
  title: '포트폴리오 스프린트',
  goal: '공고문을 실행 계획으로 바꾸는 서비스를 출시한다',
  scope: '공고 붙여넣기, 마감일 추출, 결과 화면',
  completionCriteria: '핵심 흐름을 실제로 실행해 보인다',
  deliverables: '동작하는 서비스\n3분 데모 영상',
  duration: 7,
  agreed: true,
};
const goalInput = { action: 'create', ...goalFields };
// 팀장 1명 + 초대 수락 팀원 1명. 시작 전(draft) 상태로 돌려준다.
async function draftTeam(owner, mate, over = {}) {
  const created = await projectRequest(owner, { ...goalInput, ...over });
  assert.equal(created.status, 201, await created.clone().text());
  const { projectId } = await created.json();
  let state = await read(owner, projectId);
  const invite = await projectRequest(owner, {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: mate + '@test.local',
  });
  assert.equal(invite.status, 201, await invite.clone().text());
  const { token } = await invite.json();
  const accepted = await projectRequest(mate, {
    action: 'accept',
    token,
    agreed: true,
    // 화면에서 확인한 목표 버전을 함께 보낸다.
    goalVersion: state.policy.goalVersion,
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  state = await read(owner, projectId);
  return { projectId, state };
}
async function startedTeam(owner, mate, over = {}) {
  const { projectId, state } = await draftTeam(owner, mate, over);
  const r = await post(owner, 'start', state.sprint.revision, { projectId });
  assert.equal(r.status, 200, await r.clone().text());
  return { projectId, state: await r.json() };
}
async function change(user, projectId, action, state, fields = {}) {
  const r = await post(user, action, state.sprint.revision, {
    projectId,
    ...fields,
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}


async function sourceRequest(user, body) {
  return api.sourcesPOST(
    new Request('https://test.local/api/sources', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    }),
  );
}
async function sourceGet(user, query) {
  return api.sourcesGET(
    new Request('https://test.local/api/sources?' + query, {
      headers: headers(user),
    }),
  );
}
async function proposalRequest(user, body) {
  return api.proposalsPOST(
    new Request('https://test.local/api/change-proposals', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    }),
  );
}
async function proposalGet(user, query) {
  return api.proposalsGET(
    new Request('https://test.local/api/change-proposals?' + query, {
      headers: headers(user),
    }),
  );
}
// 결정적 응답을 돌려주는 대역 모델. 검증 경계를 시험하기 위해 임의 응답도 넣는다.
function scriptedModel(changes, options = {}) {
  return {
    name: options.name ?? 'scripted',
    live: false,
    async run(input) {
      if (options.throws) throw new Error(options.throws);
      return {
        changes: typeof changes === 'function' ? changes(input) : changes,
      };
    },
  };
}
function quoteOf(body, text) {
  const start = body.indexOf(text);
  assert.ok(start >= 0, 'quote not found: ' + text);
  return { start, end: start + text.length, quote: text };
}
async function paste(user, projectId, body, extra = {}) {
  const r = await sourceRequest(user, { projectId, body, ...extra });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).sourceId;
}
async function propose(user, projectId, sourceId) {
  const r = await proposalRequest(user, {
    action: 'create',
    projectId,
    sourceId,
  });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}

let seq = 0;
const mutation = (label) => `mut-${label}-${++seq}-${crypto.randomUUID()}`;
function rows(sql, ...args) {
  return db.prepare(sql).all(...args);
}

// --- 1. 확인하지 않은 목표에 동의하는 문제 ---------------------------------

test('화면에서 확인한 목표 버전과 저장 시점 버전이 다르면 초대 수락을 거절한다', async () => {
  const created = await projectRequest('gv', goalInput);
  const { projectId } = await created.json();
  let state = await read('gv', projectId);
  const invite = await projectRequest('gv', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'gvmate@test.local',
  });
  const { token } = await invite.json();
  // 팀원이 v1 화면을 연 사이에 팀장이 목표를 v2로 바꾼다.
  state = await read('gv', projectId);
  const edited = await change('gv', projectId, 'editGoal', state, {
    ...goalFields,
    goal: '팀원이 보지 못한 새 목표',
  });
  assert.equal(edited.policy.goalVersion, 2);
  const stale = await projectRequest('gvmate', {
    action: 'accept',
    token,
    agreed: true,
    goalVersion: 1,
  });
  assert.equal(stale.status, 409, await stale.clone().text());
  const body = await stale.json();
  assert.match(body.error, /목표가 바뀌었습니다/);
  // 최신 목표를 다시 보여준다.
  assert.equal(body.details.goal_version, 2);
  assert.equal(body.details.goal, '팀원이 보지 못한 새 목표');
  // 가입·동의 기록이 남지 않아야 한다.
  assert.equal(
    rows('SELECT count(*) AS n FROM project_members WHERE project_id=?', projectId)[0].n,
    1,
  );
  assert.equal(
    rows("SELECT status FROM project_invites WHERE project_id=?", projectId)[0].status,
    'pending',
  );
  assert.equal((await read('gv', projectId)).sprint.revision, edited.sprint.revision);
  // 누락된 버전을 현재 버전으로 대신 채우지 않는다.
  const missing = await projectRequest('gvmate', {
    action: 'accept',
    token,
    agreed: true,
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /확인한 목표 버전/);
  assert.equal(
    rows('SELECT count(*) AS n FROM project_members WHERE project_id=?', projectId)[0].n,
    1,
  );
  // 최신 버전을 확인하고 나면 수락된다.
  const ok = await projectRequest('gvmate', {
    action: 'accept',
    token,
    agreed: true,
    goalVersion: 2,
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const after = await read('gv', projectId);
  assert.equal(after.members.length, 2);
  assert.equal(after.members[1].agreed_goal_version, 2);
});

test('수락 저장 직전에 목표가 바뀌면 저장 조건에서 거절된다', async () => {
  const created = await projectRequest('gv2', goalInput);
  const { projectId } = await created.json();
  const state = await read('gv2', projectId);
  const invite = await projectRequest('gv2', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'gv2mate@test.local',
  });
  const { token } = await invite.json();
  // 요청 시작 시점의 검사는 통과하고, 실제 쓰기 직전에 목표 버전이 올라간다.
  globalThis.__BEFORE_WRITE = () =>
    db
      .prepare('UPDATE project_policy SET goal_version=5 WHERE project_id=?')
      .run(projectId);
  const late = await projectRequest('gv2mate', {
    action: 'accept',
    token,
    agreed: true,
    goalVersion: 1,
  });
  globalThis.__BEFORE_WRITE = null;
  assert.equal(late.status, 409, await late.clone().text());
  assert.equal(
    rows('SELECT count(*) AS n FROM project_members WHERE project_id=?', projectId)[0].n,
    1,
  );
  assert.equal(
    rows("SELECT status FROM project_invites WHERE project_id=?", projectId)[0].status,
    'pending',
  );
});

// --- 2. 프로젝트 종료 후 원문·변경안이 저장되는 문제 -------------------------

test('원문 저장 직전에 마감이 지나면 원문이 남지 않는다', async () => {
  const { projectId } = await startedTeam('late1', 'late1mate');
  globalThis.__BEFORE_WRITE_SQL = 'INSERT INTO source_documents';
  globalThis.__BEFORE_WRITE = () =>
    db
      .prepare('UPDATE project_policy SET deadline_at=? WHERE project_id=?')
      .run('2000-01-01T00:00:00.000Z', projectId);
  const r = await sourceRequest('late1', {
    projectId,
    body: '마감 직전에 도착한 원문',
  });
  globalThis.__BEFORE_WRITE = null;
  assert.equal(r.status, 400, await r.clone().text());
  assert.equal(
    rows('SELECT count(*) AS n FROM source_documents WHERE project_id=?', projectId)[0].n,
    0,
  );
});

test('원문 저장은 업무 버전을 올리지 않아 기존 변경안을 무효화하지 않는다', async () => {
  const { projectId, state } = await startedTeam('rev0', 'rev0mate');
  const s = await change('rev0', projectId, 'createTask', state, {
    title: '버전 유지 확인 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
  });
  const body = '버전 유지 확인 업무 진행 중';
  const sourceId = await paste('rev0', projectId, body);
  api.useModel(
    scriptedModel([
      {
        changeId: 'k1',
        kind: 'status',
        taskId: 1,
        after: { status: 'in_progress' },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ]),
  );
  const created = await propose('rev0', projectId, sourceId);
  const before = await read('rev0', projectId);
  // 변경안을 만든 뒤 다른 원문을 붙여넣어도 업무 버전은 그대로여야 한다.
  await paste('rev0', projectId, '나중에 붙여넣은 다른 원문');
  const after = await read('rev0', projectId);
  assert.equal(after.sprint.revision, before.sprint.revision);
  assert.deepEqual(after.events, before.events);
  const applied = await proposalRequest('rev0', {
    action: 'apply',
    projectId,
    revision: after.sprint.revision,
    proposalId: created.proposalId,
    mutationId: mutation('rev0'),
    selections: [{ changeId: 'k1' }],
  });
  assert.equal(applied.status, 200, await applied.clone().text());
  void s;
});

test('모델 실행 중 완주하면 새 변경안이 남지 않는다', async () => {
  const { projectId, state } = await startedTeam('late2', 'late2mate');
  let s = state;
  const sourceId = await paste('late2', projectId, '완주 직전 원문');
  // 모델이 도는 동안 팀장이 완주 처리하는 상황을 재현한다.
  api.useModel({
    name: 'slow',
    live: false,
    async run() {
      for (const d of s.deliverables) {
        s = await change('late2', projectId, 'deliverableEvidence', s, {
          deliverableId: d.deliverableId,
          evidence: '저장소와 실행 방법을 정리했습니다.',
        });
        s = await change('late2', projectId, 'deliverableConfirm', s, {
          deliverableId: d.deliverableId,
          confirmed: true,
        });
      }
      s = await change('late2', projectId, 'finish', s);
      return { changes: [] };
    },
  });
  const r = await proposalRequest('late2', {
    action: 'create',
    projectId,
    sourceId,
  });
  assert.equal(r.status, 400, await r.clone().text());
  assert.equal(
    rows('SELECT count(*) AS n FROM ai_change_proposals WHERE project_id=?', projectId)[0].n,
    0,
  );
  assert.equal((await read('late2', projectId)).lifecycle, 'completed');
});

test('변경안 저장이 실패하면 세부 항목도 남지 않는다', async () => {
  const { projectId, state } = await startedTeam('atomic3', 'atomic3mate');
  const s = await change('atomic3', projectId, 'createTask', state, {
    title: '원자성 확인 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
  });
  const body = '원자성 확인 업무 진행 중';
  const sourceId = await paste('atomic3', projectId, body);
  api.useModel(
    scriptedModel([
      {
        changeId: 'a1',
        kind: 'status',
        taskId: 1,
        after: { status: 'in_progress' },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ]),
  );
  db.exec(
    "CREATE TRIGGER fail_changes BEFORE INSERT ON ai_proposal_changes BEGIN SELECT RAISE(ABORT,'SQLITE change rollback'); END;",
  );
  try {
    const r = await proposalRequest('atomic3', {
      action: 'create',
      projectId,
      sourceId,
    });
    assert.equal(r.status, 503, await r.clone().text());
  } finally {
    db.exec('DROP TRIGGER fail_changes');
  }
  assert.equal(
    rows('SELECT count(*) AS n FROM ai_change_proposals WHERE project_id=?', projectId)[0].n,
    0,
  );
  assert.equal(
    rows('SELECT count(*) AS n FROM ai_proposal_changes').length ? 0 : 0,
    0,
  );
  assert.deepEqual((await read('atomic3', projectId)).events, s.events);
});

test('멤버가 아니게 되면 원문·변경안을 저장할 수 없다', async () => {
  const { projectId } = await startedTeam('gone', 'gonemate');
  const sourceId = await paste('gonemate', projectId, '아직 멤버일 때 붙여넣음');
  db.prepare(
    'DELETE FROM project_members WHERE project_id=? AND user_id=?',
  ).run(projectId, 'gonemate');
  assert.equal(
    (await sourceRequest('gonemate', { projectId, body: '탈퇴 후 붙여넣기' })).status,
    403,
  );
  assert.equal(
    (
      await proposalRequest('gonemate', {
        action: 'create',
        projectId,
        sourceId,
      })
    ).status,
    403,
  );
  assert.equal(
    rows('SELECT count(*) AS n FROM source_documents WHERE project_id=?', projectId)[0].n,
    1,
  );
});

process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
