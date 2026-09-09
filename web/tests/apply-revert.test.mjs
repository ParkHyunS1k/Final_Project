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
const goalInput = {
  action: 'create',
  title: '포트폴리오 스프린트',
  goal: '공고문을 실행 계획으로 바꾸는 서비스를 출시한다',
  scope: '공고 붙여넣기, 마감일 추출, 결과 화면',
  completionCriteria: '핵심 흐름을 실제로 실행해 보인다',
  deliverables: '동작하는 서비스\n3분 데모 영상',
  duration: 7,
  agreed: true,
};
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
// 신규 업무 생성 변경안 하나를 만들어 승인까지 마친 상태를 돌려준다.
async function createdByAi(owner, mate, title) {
  const { projectId, state } = await startedTeam(owner, mate);
  const body = `할 일: ${title}, 2시간`;
  const sourceId = await paste(owner, projectId, body);
  api.useModel(
    scriptedModel([
      {
        changeId: 'g1',
        kind: 'createTask',
        newKey: 'k1',
        after: { title, person: 0, remaining: 2, dependsOn: [] },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ]),
  );
  const created = await propose(owner, projectId, sourceId);
  const applicationId = mutation('create');
  const r = await proposalRequest(owner, {
    action: 'apply',
    projectId,
    revision: state.sprint.revision,
    proposalId: created.proposalId,
    mutationId: applicationId,
    selections: [{ changeId: 'g1' }],
  });
  assert.equal(r.status, 200, await r.clone().text());
  return { projectId, sourceId, applicationId, state: await read(owner, projectId) };
}

// --- 4. 되돌리기가 팀원의 후속 기록을 삭제하는 문제 -------------------------

test('생성 이후 설명만 바뀌어도 신규 업무 되돌리기를 거절한다', async () => {
  const { projectId, applicationId, state } = await createdByAi(
    'undo1',
    'undo1mate',
    '설명이 붙을 업무',
  );
  assert.equal(state.sprint.tasks.length, 1);
  // 팀장이 담당이므로 팀장이 설명만 수정한다. 제목·담당자·공수는 그대로다.
  const edited = await change('undo1', projectId, 'taskDetails', state, {
    taskId: 1,
    status: 'todo',
    description: '담당자가 정리한 실행 메모',
    remaining: 2,
  });
  assert.equal(edited.sprint.tasks[0].title, '설명이 붙을 업무');
  assert.equal(edited.sprint.tasks[0].remaining, 2);
  const reverted = await proposalRequest('undo1', {
    action: 'revert',
    projectId,
    revision: edited.sprint.revision,
    applicationId,
    mutationId: mutation('undo1'),
  });
  assert.equal(reverted.status, 409, await reverted.clone().text());
  const conflict = await reverted.json();
  assert.equal(conflict.conflicts[0].status, 'changed');
  // 기록이 보존되어야 한다.
  const after = await read('undo1', projectId);
  assert.equal(after.sprint.tasks.length, 1);
  assert.equal(after.sprint.tasks[0].description, '담당자가 정리한 실행 메모');
});

test('상태·체크인·마감 변경도 신규 업무 되돌리기를 막는다', async () => {
  for (const label of ['status', 'checkin', 'dueAt']) {
    const { projectId, applicationId, state } = await createdByAi(
      'undo2',
      'undo2mate',
      `${label} 업무`,
    );
    const edited =
      label === 'status'
        ? await change('undo2', projectId, 'taskDetails', state, {
            taskId: 1,
            status: 'in_progress',
            description: '',
            remaining: 2,
          })
        : label === 'checkin'
          ? await change('undo2', projectId, 'checkin', state, {
              taskId: 1,
              note: '진행 상황을 남깁니다.',
              remaining: 1.5,
            })
          : await change('undo2', projectId, 'editTask', state, {
              taskId: 1,
              title: `${label} 업무`,
              person: 0,
              remaining: 2,
              dependsOn: [],
              dueAt: new Date(Date.parse(state.asOf) + 3600000).toISOString(),
            });
    const reverted = await proposalRequest('undo2', {
      action: 'revert',
      projectId,
      revision: edited.sprint.revision,
      applicationId,
      mutationId: mutation('undo2-' + label),
    });
    assert.equal(
      reverted.status,
      409,
      `${label}: ${await reverted.clone().text()}`,
    );
    assert.equal((await read('undo2', projectId)).sprint.tasks.length, 1, label);
  }
});

test('아무도 수정하지 않은 신규 업무는 정상적으로 되돌릴 수 있다', async () => {
  const { projectId, applicationId, state } = await createdByAi(
    'undo3',
    'undo3mate',
    '손대지 않은 업무',
  );
  const reverted = await proposalRequest('undo3', {
    action: 'revert',
    projectId,
    revision: state.sprint.revision,
    applicationId,
    mutationId: mutation('undo3'),
  });
  assert.equal(reverted.status, 200, await reverted.clone().text());
  assert.equal((await read('undo3', projectId)).sprint.tasks.length, 0);
});

test('프로젝트의 다른 업무를 수정해도 되돌리기를 막지 않는다', async () => {
  const { projectId, applicationId, state } = await createdByAi(
    'undo4',
    'undo4mate',
    '되돌릴 업무',
  );
  // 관계 없는 다른 업무를 만들고 수정한다.
  let s = await change('undo4', projectId, 'createTask', state, {
    title: '다른 업무',
    person: 1,
    remaining: 3,
    dependsOn: [],
  });
  s = await change('undo4mate', projectId, 'taskDetails', s, {
    taskId: 2,
    status: 'in_progress',
    description: '다른 업무의 메모',
    remaining: 2,
  });
  const reverted = await proposalRequest('undo4', {
    action: 'revert',
    projectId,
    revision: s.sprint.revision,
    applicationId,
    mutationId: mutation('undo4'),
  });
  assert.equal(reverted.status, 200, await reverted.clone().text());
  const after = await read('undo4', projectId);
  assert.deepEqual(after.sprint.tasks.map((t) => t.id), [2]);
  assert.equal(after.sprint.tasks[0].description, '다른 업무의 메모');
});

// --- 6. 같은 원문에서 업무가 중복 생성되는 문제 ----------------------------

test('같은 원문의 변경안 두 개를 순서대로 승인해도 업무는 한 번만 생성된다', async () => {
  const { projectId, state } = await startedTeam('dup2', 'dup2mate');
  const body = '할 일: 한 번만 생성될 업무, 2시간';
  const sourceId = await paste('dup2', projectId, body);
  api.useModel(
    scriptedModel([
      {
        changeId: 'n1',
        kind: 'createTask',
        newKey: 'k1',
        after: { title: '한 번만 생성될 업무', person: 0, remaining: 2, dependsOn: [] },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ]),
  );
  // 같은 원문으로 변경안을 두 개 미리 만든다(둘 다 같은 baseRevision).
  const first = await propose('dup2', projectId, sourceId);
  const second = await propose('dup2', projectId, sourceId);
  assert.equal(first.proposal.baseRevision, second.proposal.baseRevision);
  const ok = await proposalRequest('dup2', {
    action: 'apply',
    projectId,
    revision: state.sprint.revision,
    proposalId: first.proposalId,
    mutationId: mutation('dup2-first'),
    selections: [{ changeId: 'n1' }],
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const afterFirst = await read('dup2', projectId);
  assert.equal(afterFirst.sprint.tasks.length, 1);
  // 두 번째 변경안은 기준 상태가 달라졌으므로 그대로 승인할 수 없다.
  const again = await proposalRequest('dup2', {
    action: 'apply',
    projectId,
    revision: afterFirst.sprint.revision,
    proposalId: second.proposalId,
    mutationId: mutation('dup2-second'),
    selections: [{ changeId: 'n1' }],
  });
  // 이미 적용한 생성 항목(400) 또는 기준 상태 변경(409) 중 하나로 거절된다.
  assert.ok([400, 409].includes(again.status), await again.clone().text());
  assert.match((await again.json()).error, /이미 적용|기준 상태|다시 검토/);
  assert.equal((await read('dup2', projectId)).sprint.tasks.length, 1);
  // 생성이 아닌 항목만 담긴 오래된 변경안은 기준 상태 검사로 걸러진다.
  const statusBody = '한 번만 생성될 업무 진행 중';
  const statusSource = await paste('dup2', projectId, statusBody);
  api.useModel(
    scriptedModel([
      {
        changeId: 's1',
        kind: 'status',
        taskId: 1,
        after: { status: 'in_progress' },
        evidence: quoteOf(statusBody, statusBody),
        basis: 'fact',
      },
    ]),
  );
  const statusProposal = await propose('dup2', projectId, statusSource);
  // 그 사이 다른 저장이 일어나 기준 상태가 달라진다.
  const moved = await change('dup2', projectId, 'createTask', afterFirst, {
    title: '사이에 생긴 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
  });
  const stale = await proposalRequest('dup2', {
    action: 'apply',
    projectId,
    revision: moved.sprint.revision,
    proposalId: statusProposal.proposalId,
    mutationId: mutation('dup2-stale'),
    selections: [{ changeId: 's1' }],
  });
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.match((await stale.json()).error, /기준 상태가 달라졌습니다/);
  assert.equal((await read('dup2', projectId)).sprint.tasks[0].status, 'todo');
});

test('이미 적용한 생성 항목은 제목이 달라도 승인 단계에서 다시 걸러진다', async () => {
  const { projectId, state } = await startedTeam('dup3', 'dup3mate');
  const body = '할 일: 원래 이름 업무, 2시간';
  const sourceId = await paste('dup3', projectId, body);
  const change1 = {
    changeId: 'n1',
    kind: 'createTask',
    newKey: 'k1',
    after: { title: '원래 이름 업무', person: 0, remaining: 2, dependsOn: [] },
    evidence: quoteOf(body, body),
    basis: 'fact',
  };
  api.useModel(scriptedModel([change1]));
  const first = await propose('dup3', projectId, sourceId);
  const second = await propose('dup3', projectId, sourceId);
  assert.equal(
    (
      await proposalRequest('dup3', {
        action: 'apply',
        projectId,
        revision: state.sprint.revision,
        proposalId: first.proposalId,
        mutationId: mutation('dup3-first'),
        selections: [{ changeId: 'n1' }],
      })
    ).status,
    200,
  );
  const afterFirst = await read('dup3', projectId);
  // 두 번째 변경안의 baseRevision을 현재 값으로 맞춰도(제목만 바꿔 승인해도)
  // 같은 원문·같은 근거의 생성 항목이면 다시 만들지 않는다.
  db.prepare('UPDATE ai_change_proposals SET base_revision=? WHERE id=?').run(
    afterFirst.sprint.revision,
    second.proposalId,
  );
  const renamed = await proposalRequest('dup3', {
    action: 'apply',
    projectId,
    revision: afterFirst.sprint.revision,
    proposalId: second.proposalId,
    mutationId: mutation('dup3-renamed'),
    selections: [{ changeId: 'n1', edited: { title: '이름만 바꾼 업무' } }],
  });
  assert.equal(renamed.status, 400, await renamed.clone().text());
  assert.match((await renamed.json()).error, /이미 적용/);
  assert.equal((await read('dup3', projectId)).sprint.tasks.length, 1);
});

test('되돌린 생성 항목은 다시 승인할 수 있다', async () => {
  const { projectId, sourceId, applicationId, state } = await createdByAi(
    'dup4',
    'dup4mate',
    '되돌린 뒤 다시 만들 업무',
  );
  assert.equal(
    (
      await proposalRequest('dup4', {
        action: 'revert',
        projectId,
        revision: state.sprint.revision,
        applicationId,
        mutationId: mutation('dup4-undo'),
      })
    ).status,
    200,
  );
  const afterUndo = await read('dup4', projectId);
  assert.equal(afterUndo.sprint.tasks.length, 0);
  // 되돌린 뒤 같은 원문을 다시 처리하면 차단 표시가 없어야 한다.
  const again = await propose('dup4', projectId, sourceId);
  const candidate = again.proposal.changes.find((c) => c.kind === 'createTask');
  assert.equal(candidate.blocked, '', candidate.blocked);
  const r = await proposalRequest('dup4', {
    action: 'apply',
    projectId,
    revision: afterUndo.sprint.revision,
    proposalId: again.proposalId,
    mutationId: mutation('dup4-again'),
    selections: [{ changeId: candidate.changeId }],
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await read('dup4', projectId)).sprint.tasks.length, 1);
});

process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
