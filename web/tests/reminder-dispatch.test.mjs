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
      "export * from './app/api/sprint/route'; export { initialize } from './lib/sprint-store'; export { GET as projectsGET,POST as projectsPOST } from './app/api/projects/route'; export { dispatchReminders } from './lib/reminder-dispatch'; export { recordingSender, senderFrom } from './lib/email'; export { POST as runnerPOST } from './app/api/internal/reminders/route';",
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

test('승인된 업무 마감을 저장하면 미래 3단계만 예약된다', async () => {
  const { projectId, state } = await reminderTeam('rem1', 'rem1mate');
  const dueAt = dueIn(state, 5);
  const s = await change('rem1', projectId, 'createTask', state, {
    title: '마감 있는 업무',
    person: 1,
    remaining: 2,
    dependsOn: [],
    dueAt,
  });
  assert.equal(s.sprint.tasks[0].dueAt, dueAt);
  assert.equal(s.sprint.tasks[0].deadlineVersion, 1);
  const items = rows(
    "SELECT stage_minutes,user_id,status,due_at FROM reminder_items WHERE project_id=? AND kind='task' ORDER BY stage_minutes DESC",
    projectId,
  );
  assert.deepEqual(
    items.map((i) => i.stage_minutes),
    [120, 60, 30],
  );
  assert.ok(items.every((i) => i.status === 'pending' && i.due_at === dueAt));
  // 담당자(팀원)에게만 예약된다.
  assert.deepEqual([...new Set(items.map((i) => i.user_id))], ['rem1mate']);
  // 일정 예상치 재계산은 승인된 마감을 바꾸지 않는다.
  const after = await change('rem1mate', projectId, 'checkin', s, {
    taskId: 1,
    note: '남은 공수 조정',
    remaining: 6,
  });
  assert.equal(after.sprint.tasks[0].dueAt, dueAt);
  assert.notEqual(after.plan.finishes[1], undefined);
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND status='pending'",
      projectId,
    )[0].n,
    3 + 5 * 2,
  );
});

test('프로젝트 시작과 합류가 각 팀원에게 5단계를 예약한다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem2', 'rem2mate');
  const project = rows(
    "SELECT user_id,stage_minutes,due_at FROM reminder_items WHERE project_id=? AND kind='project' ORDER BY user_id,stage_minutes DESC",
    projectId,
  );
  assert.equal(project.length, 10);
  assert.deepEqual([...new Set(project.map((p) => p.user_id))].sort(), [
    'rem2',
    'rem2mate',
  ]);
  assert.deepEqual(
    project.filter((p) => p.user_id === 'rem2').map((p) => p.stage_minutes),
    [2880, 1440, 120, 60, 30],
  );
  assert.ok(project.every((p) => p.due_at === deadline));
  const invite = await projectRequest('rem2', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'rem2third@test.local',
  });
  const { token } = await invite.json();
  assert.equal(
    (
      await projectRequest('rem2third', {
        action: 'accept',
        token,
        agreed: true,
        goalVersion: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='project' AND user_id='rem2third'",
      projectId,
    )[0].n,
    5,
  );
});

test('마감 변경은 이전 예약을 취소하고 미래 단계만 새로 만든다', async () => {
  const { projectId, state } = await reminderTeam('rem3', 'rem3mate');
  let s = await change('rem3', projectId, 'createTask', state, {
    title: '마감 변경 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt: dueIn(state, 5),
  });
  const moved = dueIn(state, 1.25); // 지금부터 1시간 15분 뒤 → 2시간 전 단계는 이미 지남
  s = await change('rem3', projectId, 'editTask', s, {
    taskId: 1,
    title: '마감 변경 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt: moved,
  });
  assert.equal(s.sprint.tasks[0].deadlineVersion, 2);
  const active = rows(
    "SELECT stage_minutes,deadline_version FROM reminder_items WHERE project_id=? AND kind='task' AND status='pending' ORDER BY stage_minutes DESC",
    projectId,
  );
  assert.deepEqual(
    active.map((a) => a.stage_minutes),
    [60, 30],
  );
  assert.ok(active.every((a) => a.deadline_version === 2));
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND status='cancelled'",
      projectId,
    )[0].n,
    3,
  );
  // 프로젝트 최종 기한을 넘는 마감은 거절한다.
  const late = await post('rem3', 'editTask', s.sprint.revision, {
    projectId,
    taskId: 1,
    title: '마감 변경 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt: new Date(Date.parse(s.policy.deadlineAt) + HOUR).toISOString(),
  });
  assert.equal(late.status, 400);
  assert.match((await late.json()).error, /최종 기한/);
  // 팀원은 마감을 바꿀 수 없다.
  assert.equal(
    (
      await post('rem3mate', 'editTask', s.sprint.revision, {
        projectId,
        taskId: 1,
        title: '마감 변경 업무',
        person: 0,
        remaining: 2,
        dependsOn: [],
        dueAt: dueIn(state, 2),
      })
    ).status,
    403,
  );
});

test('담당자를 바꿨다 되돌려도 이미 보낸 단계는 다시 발송되지 않는다', async () => {
  const { projectId, state } = await reminderTeam('rem4', 'rem4mate');
  const dueAt = dueIn(state, 5);
  let s = await change('rem4', projectId, 'createTask', state, {
    title: '담당 이동 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
    dueAt,
  });
  // 팀장의 120분 전 단계를 이미 보낸 것으로 만든다.
  db.prepare(
    "UPDATE reminder_items SET status='sent' WHERE project_id=? AND kind='task' AND stage_minutes=120",
  ).run(projectId);
  const fields = {
    taskId: 1,
    title: '담당 이동 업무',
    remaining: 2,
    dependsOn: [],
    dueAt,
  };
  s = await change('rem4', projectId, 'editTask', s, { ...fields, person: 1 });
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND user_id='rem4mate' AND status='pending'",
      projectId,
    )[0].n,
    3,
  );
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND user_id='rem4' AND status='pending'",
      projectId,
    )[0].n,
    0,
  );
  s = await change('rem4', projectId, 'editTask', s, { ...fields, person: 0 });
  const back = rows(
    "SELECT stage_minutes,status FROM reminder_items WHERE project_id=? AND kind='task' AND user_id='rem4' ORDER BY stage_minutes DESC",
    projectId,
  );
  assert.deepEqual(back.map((r) => ({ ...r })), [
    { stage_minutes: 120, status: 'sent' },
    { stage_minutes: 60, status: 'pending' },
    { stage_minutes: 30, status: 'pending' },
  ]);
});

test('업무 완료·완주·참여 중단은 남은 독촉을 중단한다', async () => {
  const { projectId, state } = await reminderTeam('rem5', 'rem5mate');
  let s = await change('rem5', projectId, 'createTask', state, {
    title: '완료할 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: dueIn(state, 5),
  });
  s = await change('rem5mate', projectId, 'task', s, {
    taskId: 1,
    done: true,
    evidence: '실행 결과를 확인했습니다.',
  });
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND status='pending'",
      projectId,
    )[0].n,
    0,
  );
  // 재개해도 지난 단계를 소급 발송하지 않고 미래 단계만 되살린다.
  s = await change('rem5mate', projectId, 'task', s, {
    taskId: 1,
    done: false,
    remaining: 1,
  });
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND kind='task' AND status='pending'",
      projectId,
    )[0].n,
    3,
  );
  s = await change('rem5mate', projectId, 'stepBack', s, {
    note: '참여를 이어가기 어렵습니다.',
  });
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND user_id='rem5mate' AND status='pending'",
      projectId,
    )[0].n,
    0,
  );
  // 팀장의 프로젝트 알림은 남는다.
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND user_id='rem5' AND status='pending'",
      projectId,
    )[0].n,
    5,
  );
  for (const d of s.deliverables) {
    s = await change('rem5', projectId, 'deliverableEvidence', s, {
      deliverableId: d.deliverableId,
      evidence: '저장소·실행 방법·기여 내용을 정리했습니다.',
    });
    s = await change('rem5', projectId, 'deliverableConfirm', s, {
      deliverableId: d.deliverableId,
      confirmed: true,
    });
  }
  await change('rem5', projectId, 'finish', s);
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND status='pending'",
      projectId,
    )[0].n,
    0,
  );
});

test('같은 시점 업무·프로젝트 알림은 한 통으로 묶여 각자에게 발송된다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem6', 'rem6mate');
  // 업무 마감을 프로젝트 기한과 같게 두면 30분 전 단계가 겹친다.
  let s = await change('rem6', projectId, 'createTask', state, {
    title: '겹치는 업무 A',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  s = await change('rem6', projectId, 'createTask', s, {
    title: '겹치는 업무 B',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  const runAt = new Date(Date.parse(deadline) - 29 * 60000);
  const sender = fakeSender();
  const result = await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
  });
  assert.equal(result.sent > 0, true);
  const mails = sender.log.filter((m) => m.subject.includes('겹치는'));
  // 팀원에게 한 통: 업무 2건 + 프로젝트 1건이 같은 예정 시각으로 묶인다.
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'rem6mate@test.local');
  assert.match(mails[0].text, /^업무: 겹치는 업무 A$/m);
  assert.match(mails[0].text, /^업무: 겹치는 업무 B$/m);
  assert.match(mails[0].text, /최종 기한/);
  // 다른 팀원의 이메일 주소는 노출하지 않는다.
  assert.ok(!mails[0].text.includes('rem6@test.local'));
  // 팀장에게는 프로젝트 알림만 따로 간다. 담당이 아닌 업무의 개별 독촉은 없다.
  const lead = sender.log.find((m) => m.to === 'rem6@test.local');
  assert.ok(lead);
  assert.ok(!/^업무: 겹치는 업무 A$/m.test(lead.text));
  assert.match(lead.text, /최종 기한/);
  // 프로젝트 알림에는 미완료 업무 목록이 들어간다.
  assert.match(lead.text, /미완료 업무: .*겹치는 업무 A/);
  // 48·24시간 전 단계는 이미 지났으므로 건너뛴 기록으로 남는다.
  const skipped = rows(
    "SELECT stage_minutes FROM reminder_items WHERE project_id=? AND status='skipped' ORDER BY stage_minutes",
    projectId,
  );
  assert.ok(skipped.length > 0);
});

test('두 실행기를 동시에 돌려도 같은 항목이 두 번 발송되지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem7', 'rem7mate');
  await change('rem7', projectId, 'createTask', state, {
    title: '동시 실행 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  const runAt = new Date(Date.parse(deadline) - 29 * 60000);
  const a = fakeSender();
  const b = fakeSender();
  const [ra, rb] = await Promise.all([
    api.dispatchReminders({ now: runAt, sender: a, origin: 'https://test.local', worker: 'w1' }),
    api.dispatchReminders({ now: runAt, sender: b, origin: 'https://test.local', worker: 'w2' }),
  ]);
  const all = [...a.log, ...b.log];
  const mate = all.filter((m) => m.to === 'rem7mate@test.local');
  assert.equal(mate.length, 1, JSON.stringify(all.map((m) => m.to)));
  assert.equal(new Set(all.map((m) => m.to)).size, all.length);
  assert.equal(ra.claimed + rb.claimed > 0, true);
  // 다시 실행해도 이미 보낸 항목은 재발송하지 않는다.
  const again = fakeSender();
  const third = await api.dispatchReminders({
    now: runAt,
    sender: again,
    origin: 'https://test.local',
  });
  assert.equal(again.log.length, 0);
  assert.equal(third.sent, 0);
});

test('전송 실패와 불명확한 응답을 구분해 기록하고 업무 상태를 바꾸지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem8', 'rem8mate');
  const s = await change('rem8', projectId, 'createTask', state, {
    title: '전송 실패 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  const runAt = new Date(Date.parse(deadline) - 29 * 60000);
  // 확실한 거절: 재시도 대상으로 남긴다.
  const rejecting = fakeSender([
    { status: 'failed', provider: 'fake', error: '422 invalid address' },
    { status: 'failed', provider: 'fake', error: '422 invalid address' },
  ]);
  await api.dispatchReminders({
    now: runAt,
    sender: rejecting,
    origin: 'https://test.local',
  });
  const batches = rows(
    'SELECT status,error,attempts,idempotency_key FROM reminder_batches WHERE project_id=?',
    projectId,
  );
  assert.ok(batches.every((b) => b.status === 'failed'));
  assert.ok(batches.every((b) => b.error.includes('422')));
  // 전송 실패는 업무나 완주 상태를 바꾸지 않는다.
  const after = await read('rem8', projectId);
  assert.equal(after.sprint.tasks[0].done, false);
  assert.equal(after.lifecycle, 'active');
  assert.deepEqual(after.events, s.events);
  // 재시도는 같은 전송 식별자를 쓴다.
  const keys = batches.map((b) => b.idempotency_key);
  const unclear = fakeSender([
    { status: 'unknown', provider: 'fake', error: '502 upstream' },
    { status: 'unknown', provider: 'fake', error: '502 upstream' },
  ]);
  await api.dispatchReminders({
    now: runAt,
    sender: unclear,
    origin: 'https://test.local',
  });
  const retried = rows(
    'SELECT status,attempts,idempotency_key FROM reminder_batches WHERE project_id=?',
    projectId,
  );
  assert.deepEqual(retried.map((b) => b.idempotency_key).sort(), keys.sort());
  assert.ok(retried.some((b) => b.attempts > 1));
  // 접수 여부가 불명확한 응답은 별도 상태로 남기고 무조건 재발송하지 않는다.
  assert.ok(retried.every((b) => b.status === 'unknown'));
  const third = fakeSender();
  await api.dispatchReminders({
    now: runAt,
    sender: third,
    origin: 'https://test.local',
  });
  assert.equal(third.log.length, 0);
});

test('발송 직전에 완료·담당 변경·기한 종료가 되면 보내지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem9', 'rem9mate');
  let s = await change('rem9', projectId, 'createTask', state, {
    title: '직전 완료 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  // 예약은 남기고 업무만 완료 상태로 만든다(취소 경로를 우회한 경쟁 상황).
  db.prepare('UPDATE sprint_tasks SET done=1 WHERE owner=? AND id=1').run(
    projectId,
  );
  const runAt = new Date(Date.parse(deadline) - 29 * 60000);
  const sender = fakeSender();
  await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
  });
  assert.ok(!sender.log.some((m) => m.text.includes('직전 완료 업무')));
  assert.equal(
    rows(
      "SELECT detail FROM reminder_items WHERE project_id=? AND kind='task' AND status='skipped' AND detail='업무 완료'",
      projectId,
    ).length > 0,
    true,
  );
  // 마감이 지난 뒤에는 남은 프로젝트 단계도 보내지 않는다.
  const late = fakeSender();
  await api.dispatchReminders({
    now: new Date(Date.parse(deadline) + HOUR),
    sender: late,
    origin: 'https://test.local',
  });
  assert.equal(late.log.length, 0);
  void s;
});

test('인증된 수신 주소가 없으면 다른 주소로 대체하지 않는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem10', 'rem10mate');
  await change('rem10', projectId, 'createTask', state, {
    title: '연락처 없는 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  db.prepare(
    'UPDATE project_members SET email=NULL WHERE project_id=? AND user_id=?',
  ).run(projectId, 'rem10mate');
  const sender = fakeSender();
  await api.dispatchReminders({
    now: new Date(Date.parse(deadline) - 29 * 60000),
    sender,
    origin: 'https://test.local',
  });
  assert.ok(!sender.log.some((m) => m.to === 'rem10mate@test.local'));
  // 담당자에게 갈 개별 업무 독촉이 다른 사람 주소로 대체되지 않는다.
  assert.ok(!sender.log.some((m) => /^업무: 연락처 없는 업무$/m.test(m.text)));
  assert.equal(
    rows(
      "SELECT count(*) AS n FROM reminder_items WHERE project_id=? AND detail='인증된 수신 주소 없음'",
      projectId,
    )[0].n > 0,
    true,
  );
});

test('확보한 실행기가 중단되면 만료 후 다른 실행기가 이어받는다', async () => {
  const { projectId, state, deadline } = await reminderTeam('rem11', 'rem11mate');
  await change('rem11', projectId, 'createTask', state, {
    title: '중단 복구 업무',
    person: 1,
    remaining: 1,
    dependsOn: [],
    dueAt: deadline,
  });
  const runAt = new Date(Date.parse(deadline) - 29 * 60000);
  // 확보만 하고 결과를 기록하지 못한 상태를 만든다.
  db.prepare(
    "UPDATE reminder_items SET status='claimed',claim_owner='dead',claimed_at=? WHERE project_id=? AND status='pending'",
  ).run(new Date(runAt.getTime() - 10 * 60000).toISOString(), projectId);
  const sender = fakeSender();
  const result = await api.dispatchReminders({
    now: runAt,
    sender,
    origin: 'https://test.local',
    worker: 'fresh',
  });
  assert.ok(result.claimed > 0);
  assert.ok(sender.log.some((m) => m.text.includes('중단 복구 업무')));
});

test('정기 실행 진입점은 서버 비밀값 없이는 실행되지 않는다', async () => {
  const url = 'https://test.local/api/internal/reminders';
  const call = (headers = {}) =>
    api.runnerPOST(new Request(url, { method: 'POST', headers }));
  globalThis.__TEST_ENV = {};
  // 비밀값이 설정되지 않았으면 무인증 호출을 허용하지 않는다.
  assert.equal((await call()).status, 401);
  assert.equal(
    (await call({ authorization: 'Bearer anything' })).status,
    401,
  );
  globalThis.__TEST_ENV = { REMINDER_RUNNER_SECRET: 'runner-secret' };
  assert.equal((await call()).status, 401);
  assert.equal((await call({ authorization: 'Bearer wrong-secret' })).status, 401);
  // 일반 사용자 세션 헤더로는 실행되지 않는다.
  assert.equal(
    (await call({ 'oai-authenticated-user-id': 'rem1' })).status,
    401,
  );
  const ok = await call({ authorization: 'Bearer runner-secret' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  // 제공자 자격 정보가 없으면 실제 발송이 아니라 기록용 전송기를 쓴다.
  assert.equal(body.live, false);
  assert.equal(body.provider, 'recording');
  globalThis.__TEST_ENV = {};
});

test('제공자 설정이 모두 있어야 운영 전송기를 사용한다', () => {
  assert.equal(api.senderFrom({}).live, false);
  assert.equal(api.senderFrom({ EMAIL_PROVIDER: 'resend' }).live, false);
  assert.equal(
    api.senderFrom({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k' }).live,
    false,
  );
  const live = api.senderFrom({
    EMAIL_PROVIDER: 'resend',
    EMAIL_API_KEY: 'k',
    EMAIL_FROM: 'ProjectMate <no-reply@example.com>',
  });
  assert.equal(live.live, true);
  assert.equal(live.name, 'resend');
});

process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
