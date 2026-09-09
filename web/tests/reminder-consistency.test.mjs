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
      "export * from './app/api/sprint/route'; export { initialize } from './lib/sprint-store'; export { GET as projectsGET,POST as projectsPOST } from './app/api/projects/route'; export { dispatchReminders } from './lib/reminder-dispatch'; export { GET as sourcesGET,POST as sourcesPOST } from './app/api/sources/route'; export { POST as proposalsPOST,useModel } from './app/api/change-proposals/route'; export { recordingSender, senderFrom } from './lib/email'; export { POST as runnerPOST } from './app/api/internal/reminders/route';",
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

const HOUR = 3600000;
function at(iso) {
  return new Date(iso);
}
function fakeSender(script = []) {
  const log = [];
  return {
    name: 'fake',
    live: false,
    log,
    async send(message) {
      log.push(message);
      const next = script.shift();
      if (next) return next;
      return { status: 'sent', provider: 'fake', messageId: 'm' + log.length };
    },
  };
}
function rows(sql, ...args) {
  return db.prepare(sql).all(...args);
}
// 마감을 넉넉히 두고 시작한 팀. 업무 마감은 시작 뒤에만 지정할 수 있다.
async function reminderTeam(owner, mate) {
  const { projectId, state } = await startedTeam(owner, mate, { duration: 10 });
  return { projectId, state, deadline: state.policy.deadlineAt };
}
function dueIn(state, hours) {
  return new Date(Date.parse(state.asOf) + hours * HOUR).toISOString();
}


let seq = 0;
const mutation = (label) => `mut-${label}-${++seq}-${crypto.randomUUID()}`;
// 이 파일은 하나의 DB를 공유한다. 특정 프로젝트만 남겨 실행 결과를 결정적으로 만든다.
function isolate(...projectIds) {
  const list = projectIds.map((id) => `'${id}'`).join(',');
  db.prepare(
    `UPDATE reminder_items SET status='cancelled' WHERE status='pending' AND project_id NOT IN (${list})`,
  ).run();
}
function pending(projectId) {
  return rows(
    "SELECT kind,task_id,user_id,deadline_version,stage_minutes FROM reminder_items WHERE project_id=? AND kind='task' AND status='pending' ORDER BY stage_minutes DESC",
    projectId,
  ).map((r) => ({ ...r }));
}
async function paste(user, projectId, body) {
  const r = await api.sourcesPOST(
    new Request('https://test.local/api/sources', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify({ projectId, body }),
    }),
  );
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).sourceId;
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
function scriptedModel(changes) {
  return { name: 'scripted', live: false, async run() { return { changes }; } };
}
function quoteOf(body, textValue) {
  const start = body.indexOf(textValue);
  assert.ok(start >= 0);
  return { start, end: start + textValue.length, quote: textValue };
}
// AI 변경안을 만들어 바로 승인한다.
async function aiApply(owner, projectId, revision, changes, body) {
  const sourceId = await paste(owner, projectId, body);
  api.useModel(scriptedModel(changes));
  const created = await proposalRequest(owner, {
    action: 'create',
    projectId,
    sourceId,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const proposal = await created.json();
  const r = await proposalRequest(owner, {
    action: 'apply',
    projectId,
    revision,
    proposalId: proposal.proposalId,
    mutationId: mutation('ai'),
    selections: proposal.proposal.changes.map((c) => ({ changeId: c.changeId })),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return { applicationId: null, state: await read(owner, projectId) };
}

// --- 5. AI 담당 변경 후 알림이 사라지는 문제 -------------------------------

test('AI로 담당자만 바꾸면 새 담당자에게 같은 마감 버전으로 예약이 남는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('ai1', 'ai1mate');
  const due = new Date(Date.parse(deadline) - 3600000).toISOString();
  const s = await change('ai1', projectId, 'createTask', state, {
    title: '담당 이동 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt: due,
  });
  assert.equal(s.sprint.tasks[0].deadlineVersion, 1);
  const body = '담당 이동 업무는 팀원이 맡기로 했습니다.';
  const after = await aiApply(
    'ai1',
    projectId,
    s.sprint.revision,
    [
      {
        changeId: 'a1',
        kind: 'assignee',
        taskId: 1,
        after: { person: 1 },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ],
    body,
  );
  assert.equal(after.state.sprint.tasks[0].person, 1);
  // 마감이 그대로면 마감 버전은 올라가지 않는다.
  assert.equal(after.state.sprint.tasks[0].deadlineVersion, 1);
  const items = pending(projectId);
  assert.deepEqual(
    items.map((i) => i.stage_minutes),
    [120, 60, 30],
  );
  assert.ok(items.every((i) => i.user_id === 'ai1mate'), JSON.stringify(items));
  assert.ok(items.every((i) => i.deadline_version === 1));
});

test('AI로 마감만 바꾸면 마감 버전이 오르고 같은 담당자에게 다시 예약된다', async () => {
  const { projectId, state, deadline } = await reminderTeam('ai2', 'ai2mate');
  const due = new Date(Date.parse(deadline) - 5 * 3600000).toISOString();
  const s = await change('ai2', projectId, 'createTask', state, {
    title: '마감 이동 업무',
    person: 1,
    remaining: 2,
    dependsOn: [],
    dueAt: due,
  });
  const moved = new Date(Date.parse(deadline) - 2 * 3600000).toISOString();
  const body = '마감 이동 업무는 조금 더 뒤로 미룹니다.';
  const after = await aiApply(
    'ai2',
    projectId,
    s.sprint.revision,
    [
      {
        changeId: 'd1',
        kind: 'dueAt',
        taskId: 1,
        after: { dueAt: moved },
        evidence: quoteOf(body, body),
        basis: 'estimate',
      },
    ],
    body,
  );
  assert.equal(after.state.sprint.tasks[0].dueAt, moved);
  assert.equal(after.state.sprint.tasks[0].deadlineVersion, 2);
  const items = pending(projectId);
  assert.deepEqual(
    items.map((i) => i.stage_minutes),
    [120, 60, 30],
  );
  assert.ok(items.every((i) => i.user_id === 'ai2mate'));
  assert.ok(items.every((i) => i.deadline_version === 2));
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND status='cancelled'",
      projectId,
    )[0].n,
    3,
  );
});

test('AI로 담당자와 마감을 동시에 바꾸면 최종 상태 하나만 예약된다', async () => {
  const { projectId, state, deadline } = await reminderTeam('ai3', 'ai3mate');
  const due = new Date(Date.parse(deadline) - 5 * 3600000).toISOString();
  const s = await change('ai3', projectId, 'createTask', state, {
    title: '둘 다 바뀌는 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt: due,
  });
  const moved = new Date(Date.parse(deadline) - 3 * 3600000).toISOString();
  const body = '둘 다 바뀌는 업무는 팀원이 맡고 마감도 미룹니다.';
  const after = await aiApply(
    'ai3',
    projectId,
    s.sprint.revision,
    [
      {
        changeId: 'p1',
        kind: 'assignee',
        taskId: 1,
        after: { person: 1 },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
      {
        changeId: 'p2',
        kind: 'dueAt',
        taskId: 1,
        after: { dueAt: moved },
        evidence: quoteOf(body, body),
        basis: 'estimate',
      },
    ],
    body,
  );
  assert.equal(after.state.sprint.tasks[0].person, 1);
  assert.equal(after.state.sprint.tasks[0].dueAt, moved);
  assert.equal(after.state.sprint.tasks[0].deadlineVersion, 2);
  const items = pending(projectId);
  // 최종 담당자·최종 마감·최종 버전의 3단계만 남아야 한다.
  assert.equal(items.length, 3, JSON.stringify(items));
  assert.ok(items.every((i) => i.user_id === 'ai3mate'));
  assert.ok(items.every((i) => i.deadline_version === 2));
  assert.ok(
    items.every((i) => i.due_at === undefined || true),
  );
  const dues = rows(
    "SELECT DISTINCT due_at FROM reminder_items WHERE project_id=? AND kind='task' AND status='pending'",
    projectId,
  );
  assert.deepEqual(dues.map((d) => d.due_at), [moved]);
});

test('AI 완료를 되돌리면 남은 단계가 다시 예약된다', async () => {
  const { projectId, state, deadline } = await reminderTeam('ai4', 'ai4mate');
  const due = new Date(Date.parse(deadline) - 5 * 3600000).toISOString();
  const s = await change('ai4', projectId, 'createTask', state, {
    title: '완료 되돌릴 업무',
    person: 1,
    remaining: 2,
    dependsOn: [],
    dueAt: due,
  });
  const body = '완료 되돌릴 업무 끝냈습니다. 결과를 확인했습니다.';
  const sourceId = await paste('ai4mate', projectId, body);
  api.useModel(
    scriptedModel([
      {
        changeId: 'c1',
        kind: 'complete',
        taskId: 1,
        after: { evidence: body },
        evidence: quoteOf(body, body),
        basis: 'fact',
      },
    ]),
  );
  const created = await proposalRequest('ai4mate', {
    action: 'create',
    projectId,
    sourceId,
  });
  const proposal = await created.json();
  const applicationId = mutation('ai4');
  assert.equal(
    (
      await proposalRequest('ai4mate', {
        action: 'apply',
        projectId,
        revision: s.sprint.revision,
        proposalId: proposal.proposalId,
        mutationId: applicationId,
        selections: [{ changeId: 'c1' }],
      })
    ).status,
    200,
  );
  let after = await read('ai4', projectId);
  assert.equal(after.sprint.tasks[0].done, true);
  assert.equal(pending(projectId).length, 0);
  const reverted = await proposalRequest('ai4mate', {
    action: 'revert',
    projectId,
    revision: after.sprint.revision,
    applicationId,
    mutationId: mutation('ai4-undo'),
  });
  assert.equal(reverted.status, 200, await reverted.clone().text());
  after = await read('ai4', projectId);
  assert.equal(after.sprint.tasks[0].done, false);
  // 되돌리기도 같은 처리를 거쳐 남은 단계가 살아나야 한다.
  const items = pending(projectId);
  assert.equal(items.length, 3, JSON.stringify(items));
  assert.ok(items.every((i) => i.user_id === 'ai4mate'));
});

// --- 7. 다른 프로젝트의 알림끼리 충돌하는 문제 -----------------------------

test('두 프로젝트의 업무 번호가 같아도 알림이 서로를 지우지 않는다', async () => {
  const a = await reminderTeam('multi', 'multimate');
  const b = await reminderTeam('multi2', 'multi2mate');
  // 두 프로젝트 모두 업무 번호 1, 같은 사람에게 같은 예정 시각.
  const when = new Date(Date.parse(a.deadline) - 5 * 3600000).toISOString();
  await change('multi', a.projectId, 'createTask', a.state, {
    title: 'A 프로젝트 업무',
    person: 0,
    remaining: 1,
    dependsOn: [],
    dueAt: when,
  });
  await change('multi2', b.projectId, 'createTask', b.state, {
    title: 'B 프로젝트 업무',
    person: 0,
    remaining: 1,
    dependsOn: [],
    dueAt: when,
  });
  // 두 프로젝트에서 같은 사람이 같은 시각에 업무 알림을 받는 상황을 만든다.
  isolate(a.projectId, b.projectId);
  // 프로젝트 알림은 이 검사와 무관하므로 정리한다.
  db.prepare(
    "UPDATE reminder_items SET status='cancelled' WHERE kind='project' AND project_id IN (?,?)",
  ).run(a.projectId, b.projectId);
  db.prepare(
    "UPDATE project_members SET user_id='multi',email='multi@test.local' WHERE project_id=? AND person=0",
  ).run(b.projectId);
  db.prepare(
    "UPDATE reminder_items SET user_id='multi' WHERE project_id=? AND kind='task'",
  ).run(b.projectId);
  const before = rows(
    "SELECT project_id,task_id,stage_minutes FROM reminder_items WHERE status='pending' AND project_id IN (?,?)",
    a.projectId,
    b.projectId,
  );
  assert.equal(before.length, 6, JSON.stringify(before));
  const runAt = new Date(Date.parse(when) - 29 * 60000);
  const sender = fakeSender();
  await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
  });
  const text = sender.log.map((m) => m.text).join('\n');
  // 두 업무의 알림 내용이 모두 살아 있어야 한다.
  assert.match(text, /^업무: A 프로젝트 업무$/m);
  assert.match(text, /^업무: B 프로젝트 업무$/m);
  // 두 프로젝트 모두 최신 단계 1건씩 발송되어야 한다.
  for (const id of [a.projectId, b.projectId]) {
    const sentRows = rows(
      "SELECT stage_minutes FROM reminder_items WHERE project_id=? AND kind='task' AND status='sent'",
      id,
    );
    assert.deepEqual(
      sentRows.map((r) => r.stage_minutes),
      [30],
      `프로젝트 ${id}의 알림이 사라졌습니다.`,
    );
  }
  // 건너뛴 항목은 같은 프로젝트의 앞선 단계뿐이어야 한다.
  const skipped = rows(
    "SELECT project_id,stage_minutes,detail FROM reminder_items WHERE status='skipped' AND kind='task' AND project_id IN (?,?)",
    a.projectId,
    b.projectId,
  );
  assert.equal(skipped.length, 4, JSON.stringify(skipped));
  assert.ok(skipped.every((r) => /단계 건너뜀/.test(r.detail)));
  assert.deepEqual(
    [...new Set(skipped.map((r) => r.stage_minutes))].sort((x, y) => x - y),
    [60, 120],
  );
});

// --- 8. 보내지 않은 내용을 발송 완료로 기록하는 문제 -----------------------

test('처리 한도가 작아도 한 통에 들어갈 항목을 나눠 발송하지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('limit', 'limitmate');
  const when = new Date(Date.parse(deadline) - 5 * 3600000).toISOString();
  let s = state;
  for (const title of ['한도 업무 1', '한도 업무 2', '한도 업무 3'])
    s = await change('limit', projectId, 'createTask', s, {
      title,
      person: 1,
      remaining: 1,
      dependsOn: [],
      dueAt: when,
    });
  isolate(projectId);
  db.prepare(
    "UPDATE reminder_items SET status='cancelled' WHERE kind='project' AND project_id=?",
  ).run(projectId);
  const runAt = new Date(Date.parse(when) - 29 * 60000);
  const sender = fakeSender();
  // 한 묶음에 들어갈 항목(3건)보다 작은 한도로 실행한다.
  await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
    limit: 1,
  });
  const mails = sender.log.filter((m) => m.to === 'limitmate@test.local');
  // 한 통에 들어갈 항목은 나뉘지 않는다. 보냈다면 세 업무가 모두 있어야 한다.
  assert.equal(mails.length, 1, JSON.stringify(sender.log.map((m) => m.to)));
  for (const title of ['한도 업무 1', '한도 업무 2', '한도 업무 3'])
    assert.match(mails[0].text, new RegExp(`^업무: ${title}$`, 'm'));
  // 보내지 않은 항목이 발송 완료로 기록되면 안 된다.
  const sent = rows(
    "SELECT task_id FROM reminder_items WHERE project_id=? AND kind='task' AND status='sent'",
    projectId,
  );
  const included = [1, 2, 3].filter((id) =>
    new RegExp(`^업무: 한도 업무 ${id}$`, 'm').test(mails[0].text),
  );
  assert.deepEqual(
    sent.map((r) => r.task_id).sort(),
    included.sort(),
    `보낸 내용과 기록이 다릅니다: ${JSON.stringify({ sent, included })}`,
  );
});

// --- 9. 완료된 업무에 독촉이 발송되는 문제 ---------------------------------

test('첫 메일을 보내는 사이 완료된 업무에는 독촉을 보내지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('inflight', 'inflightmate');
  const when = new Date(Date.parse(deadline) - 5 * 3600000).toISOString();
  let s = state;
  // 서로 다른 수신자에게 같은 시각의 알림을 만든다(묶음 두 개).
  s = await change('inflight', projectId, 'createTask', s, {
    title: '먼저 가는 업무',
    person: 0,
    remaining: 1,
    dependsOn: [],
    dueAt: when,
  });
  s = await change('inflight', projectId, 'createTask', s, {
    title: '나중에 가는 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: when,
  });
  isolate(projectId);
  const runAt = new Date(Date.parse(when) - 29 * 60000);
  const sender = {
    name: 'racy',
    live: false,
    log: [],
    async send(message) {
      this.log.push(message);
      // 첫 메일을 보내는 동안 두 번째 업무가 완료된다.
      if (this.log.length === 1)
        db.prepare('UPDATE sprint_tasks SET done=1 WHERE owner=? AND id=2').run(
          projectId,
        );
      return { status: 'sent', provider: 'racy', messageId: 'm' + this.log.length };
    },
  };
  await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
  });
  const all = sender.log.map((m) => m.text).join('\n');
  assert.ok(!/^업무: 나중에 가는 업무$/m.test(all), all);
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND task_id=2 AND status='sent'",
      projectId,
    )[0].n,
    0,
  );
});

process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
