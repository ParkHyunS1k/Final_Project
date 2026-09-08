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
  async all() {
    return this.execute();
  }
  execute() {
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
      "export * from './app/api/sprint/route'; export { initialize } from './lib/sprint-store'; export { GET as projectsGET,POST as projectsPOST } from './app/api/projects/route';",
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
          contents: 'export const env={DB:globalThis.__TEST_DB};',
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
let version = 0;
test('authentication, persistence, recovery and optimistic concurrency', async () => {
  assert.equal((await get(null)).status, 401);
  let a = await data('alice');
  assert.equal(a.sprint.revision, 0);
  assert.equal((await post('alice', 'finish', 0)).status, 400);
  assert.equal((await post('alice', 'join', 0, { agreed: true })).status, 200);
  version = 1;
  a = await data('alice');
  assert.equal(a.sprint.joined, true);
  assert.equal((await data('bob')).sprint.joined, false);
  assert.equal(
    (
      await post('alice', 'checkin', version, {
        taskId: 4,
        note: 'PDF 지원에 예상보다 오래 걸립니다.',
        remaining: 30,
      })
    ).status,
    200,
  );
  version++;
  a = await data('alice');
  assert.equal(a.sprint.tasks.find((t) => t.id === 4).remaining, 30);
  assert.equal(a.schedule.feasible, false);
  assert.equal(a.checkins.length, 1);
  let p = await post('alice', 'propose', version);
  assert.equal(p.status, 200);
  a = await p.json();
  version++;
  const stale = a.proposal.id;
  assert.equal(
    (
      await post('alice', 'capacity', version, {
        person: 0,
        date: a.sprint.startDate,
        hours: 2,
      })
    ).status,
    200,
  );
  version++;
  assert.equal(
    (await post('alice', 'approve', version, { proposalId: stale })).status,
    409,
  );
  a = await data('alice');
  assert.equal(a.sprint.revision, version);
  assert.equal(a.sprint.tasks.find((t) => t.id === 4).deferred, false);
  p = await post('alice', 'propose', version);
  a = await p.json();
  assert.equal(p.status, 200);
  version++;
  const id = a.proposal.id;
  assert.equal(
    (await post('bob', 'approve', 0, { proposalId: id })).status,
    400,
  );
  assert.equal(
    (await post('alice', 'approve', version, { proposalId: id })).status,
    200,
  );
  version++;
  a = await data('alice');
  assert.equal(a.sprint.tasks.find((t) => t.id === 4).deferred, true);
  assert.equal(a.proposal.status, 'approved');
  assert.equal(a.schedule.feasible, true);
  assert.equal(
    (await post('alice', 'approve', version, { proposalId: id })).status,
    400,
  );
  const concurrent = await Promise.all([
    post('alice', 'capacity', version, {
      person: 0,
      date: a.sprint.startDate,
      hours: 1,
    }),
    post('alice', 'capacity', version, {
      person: 0,
      date: a.sprint.startDate,
      hours: 3,
    }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  version++;
  a = await data('alice');
  assert.equal(a.sprint.revision, version);
  assert.equal(a.events.length, version);
  assert.equal(
    (
      await post('alice', 'task', version, {
        taskId: 1,
        done: true,
        evidence: '',
      })
    ).status,
    400,
  );
  for (const t of a.sprint.tasks.filter((t) => !t.deferred)) {
    assert.equal(
      (
        await post('alice', 'task', version, {
          taskId: t.id,
          done: true,
          evidence: '테스트 실행과 결과물을 직접 확인했습니다.',
        })
      ).status,
      200,
    );
    version++;
  }
  assert.equal((await post('alice', 'finish', version)).status, 200);
  version++;
  a = await data('alice');
  assert.equal(a.sprint.finished, true);
  assert.equal(
    (
      await post('alice', 'capacity', version, {
        person: 0,
        date: a.sprint.startDate,
        hours: 2,
      })
    ).status,
    400,
  );
});
test('transaction failure rolls back project, task and event together', async () => {
  let s = await data('rollback');
  await post('rollback', 'join', 0, { agreed: true });
  db.exec(
    "CREATE TRIGGER fail_checkin BEFORE INSERT ON sprint_checkins WHEN NEW.owner='rollback' BEGIN SELECT RAISE(ABORT,'SQLITE test rollback'); END;",
  );
  const result = await post('rollback', 'checkin', 1, {
    taskId: 2,
    note: 'rollback case',
    remaining: 100,
  });
  assert.equal(result.status, 503);
  s = await data('rollback');
  assert.equal(s.sprint.revision, 1);
  assert.equal(s.sprint.tasks.find((t) => t.id === 2).remaining, 6);
  assert.equal(s.checkins.length, 0);
  assert.equal(s.events.length, 1);
});
test('reject malformed, cross-origin and invalid input without writes', async () => {
  await data('invalid');
  await post('invalid', 'join', 0, { agreed: true });
  for (const fields of [
    { person: 0, date: '2099-01-01', hours: 2 },
    { person: 0, date: (await data('invalid')).sprint.startDate, hours: 13 },
  ])
    assert.equal((await post('invalid', 'capacity', 1, fields)).status, 400);
  assert.equal(
    (
      await api.POST(
        new Request('https://test.local/api/sprint', {
          method: 'POST',
          headers: {
            'oai-authenticated-user-id': 'invalid',
            origin: 'https://evil.local',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
    ).status,
    403,
  );
  assert.equal((await data('invalid')).sprint.revision, 1);
});
test('reject a late completion even with all evidence', async () => {
  await data('late');
  await post('late', 'join', 0, { agreed: true });
  await post('late', 'checkin', 1, {
    taskId: 1,
    note: 'completed evidence',
    remaining: 0,
  });
  db.exec(
    "UPDATE sprint_tasks SET done=1,evidence='verified evidence',remaining=0 WHERE owner='late'; UPDATE sprints SET deadline='2000-01-01T18:00:00+09:00' WHERE owner='late';",
  );
  assert.equal((await post('late', 'finish', 2)).status, 400);
  assert.equal((await data('late')).sprint.finished, false);
});
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
async function scoped(user, id) {
  return api.GET(
    new Request('https://test.local/api/sprint?project=' + id, {
      headers: headers(user),
    }),
  );
}
test('project creation, invitation and isolation across three identities', async () => {
  const newUser = await api.projectsGET(
    new Request('https://test.local/api/projects', {
      headers: headers('creator'),
    }),
  );
  assert.deepEqual((await newUser.json()).projects, []);
  const start = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const input = {
    action: 'create',
    title: '출시 QA',
    goal: '목표 저장 확인',
    startDate: start,
    duration: 7,
    deliverables: '서비스 URL\n시연 영상',
    completionCriteria: '핵심 흐름을 실제로 실행한다',
    agreed: true,
  };
  assert.equal(
    (await projectRequest('creator', { ...input, duration: 6 })).status,
    400,
  );
  assert.equal(
    (await projectRequest('creator', { ...input, agreed: false })).status,
    400,
  );
  const created = await projectRequest('creator', input);
  assert.equal(created.status, 201);
  const { projectId } = await created.json();
  let state = await (await scoped('creator', projectId)).json();
  assert.equal(state.details.goal, input.goal);
  assert.equal(state.sprint.tasks.length, 0);
  assert.equal(state.members.length, 1);
  assert.equal(state.sprint.capacity.length, 7);
  assert.equal(state.sprint.people.length, 1);
  assert.equal((await scoped('outsider', projectId)).status, 403);
  assert.equal(
    (
      await post('outsider', 'capacity', 0, {
        projectId,
        person: 0,
        date: start,
        hours: 3,
      })
    ).status,
    403,
  );
  assert.equal((await post('creator', 'finish', 0, { projectId })).status, 400);
  let invitation = await projectRequest('creator', {
    action: 'invite',
    projectId,
    revision: 0,
    email: 'mate@test.local',
  });
  assert.equal(invitation.status, 201);
  const { token } = await invitation.json();
  assert.equal(
    (
      await projectRequest('outsider', {
        action: 'accept',
        token,
        agreed: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (await projectRequest('mate', { action: 'accept', token, agreed: false }))
      .status,
    400,
  );
  assert.equal(
    (await projectRequest('mate', { action: 'accept', token, agreed: true }))
      .status,
    200,
  );
  state = await (await scoped('mate', projectId)).json();
  assert.equal(state.me.role, 'member');
  assert.equal(state.members.length, 2);
  assert.equal(state.sprint.people.length, 2);
  assert.equal(
    (await projectRequest('mate', { action: 'accept', token, agreed: true }))
      .status,
    410,
  );
  assert.equal(
    (
      await projectRequest('mate', {
        action: 'invite',
        projectId,
        revision: 2,
        email: 'outsider@test.local',
      })
    ).status,
    403,
  );
  for (const action of ['approve', 'reject', 'finish'])
    assert.equal((await post('mate', action, 2, { projectId })).status, 403);
  assert.equal(
    (
      await post('mate', 'capacity', 2, {
        projectId,
        person: 0,
        date: start,
        hours: 3,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post('mate', 'capacity', 2, {
        projectId,
        person: 1,
        date: start,
        hours: 3,
      })
    ).status,
    200,
  );
  state = await (await scoped('creator', projectId)).json();
  assert.equal(state.sprint.revision, 3);
  assert.equal(
    state.sprint.capacity.find((c) => c.person === 1 && c.date === start).hours,
    3,
  );
  assert.equal(
    (
      await post('creator', 'capacity', 2, {
        projectId,
        person: 0,
        date: start,
        hours: 2,
      })
    ).status,
    409,
  );
  invitation = await projectRequest('creator', {
    action: 'invite',
    projectId,
    revision: 3,
    email: 'next@test.local',
  });
  const second = await invitation.json();
  assert.equal(
    (
      await projectRequest('creator', {
        action: 'revoke',
        projectId,
        revision: 4,
        inviteId: second.id,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await projectRequest('next', {
        action: 'accept',
        token: second.token,
        agreed: true,
      })
    ).status,
    410,
  );
  invitation = await projectRequest('creator', {
    action: 'invite',
    projectId,
    revision: 5,
    email: 'next@test.local',
  });
  const expired = await invitation.json();
  db.prepare(
    "UPDATE project_invites SET expires_at='2000-01-01' WHERE id=?",
  ).run(expired.id);
  assert.equal(
    (
      await projectRequest('next', {
        action: 'accept',
        token: expired.token,
        agreed: true,
      })
    ).status,
    410,
  );
  const list = await api.projectsGET(
    new Request('https://test.local/api/projects', {
      headers: headers('mate'),
    }),
  );
  assert.equal((await list.json()).projects[0].id, projectId);
  const other = await projectRequest('creator', {
    ...input,
    title: '두 번째 프로젝트',
  });
  const otherId = (await other.json()).projectId;
  assert.equal((await scoped('mate', otherId)).status, 403);
});
test('simultaneous invitation acceptance keeps member slots unique and respects team limit', async () => {
  const start = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const created = await projectRequest('lead', {
    action: 'create',
    title: '동시 참여',
    goal: '팀 슬롯 중복 방지',
    startDate: start,
    duration: 10,
    deliverables: '프로젝트',
    completionCriteria: '팀원별 역할 유지',
    agreed: true,
  });
  const { projectId } = await created.json();
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const state = await (await scoped('lead', projectId)).json();
    const r = await projectRequest('lead', {
      action: 'invite',
      projectId,
      revision: state.sprint.revision,
      email: `join${i}@test.local`,
    });
    tokens.push((await r.json()).token);
  }
  const results = await Promise.all(
    [0, 1].map((i) =>
      projectRequest('join' + i, {
        action: 'accept',
        token: tokens[i],
        agreed: true,
      }),
    ),
  );
  for (let i = 0; i < 2; i++) {
    assert.ok([200, 409].includes(results[i].status));
    if (results[i].status === 409)
      assert.equal(
        (
          await projectRequest('join' + i, {
            action: 'accept',
            token: tokens[i],
            agreed: true,
          })
        ).status,
        200,
      );
  }
  assert.equal(
    (
      await projectRequest('join2', {
        action: 'accept',
        token: tokens[2],
        agreed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await projectRequest('join3', {
        action: 'accept',
        token: tokens[3],
        agreed: true,
      })
    ).status,
    400,
  );
  const state = await (await scoped('lead', projectId)).json();
  assert.equal(state.members.length, 4);
  assert.equal(new Set(state.members.map((m) => m.person)).size, 4);
  db.prepare(
    "INSERT INTO sprint_tasks(owner,id,title,person,remaining,optional,deferred,done,evidence) VALUES(?,1,'팀장 업무',0,2,0,0,0,'')",
  ).run(projectId);
  assert.equal(
    (
      await post('join0', 'checkin', state.sprint.revision, {
        projectId,
        taskId: 1,
        note: '다른 사람 업무',
        remaining: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post('join0', 'task', state.sprint.revision, {
        projectId,
        taskId: 1,
        done: true,
        evidence: '권한 없는 결과 확인',
      })
    ).status,
    403,
  );
});
process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function taskProject(user) {
  const startDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const created = await projectRequest(user, {
    action: 'create',
    title: '실제 업무 설정',
    goal: '필수 흐름 출시',
    startDate,
    duration: 7,
    deliverables: '동작하는 서비스',
    completionCriteria: '핵심 흐름 시연',
    agreed: true,
  });
  assert.equal(created.status, 201);
  const { projectId } = await created.json();
  const read = async () => (await scoped(user, projectId)).json();
  return { projectId, startDate, read };
}
const taskFields = {
  title: '화면 구현',
  person: 0,
  remaining: 1,
  optional: false,
  dependsOn: [],
};

test('real tasks persist, assign to members and recalculate from dependencies and capacity', async () => {
  const { projectId, startDate, read } = await taskProject('planner');
  let state = await read();
  async function change(action, fields, user = 'planner') {
    const r = await post(user, action, state.sprint.revision, {
      projectId,
      ...fields,
    });
    assert.equal(r.status, 200, await r.clone().text());
    state = await r.json();
  }
  await change('createTask', taskFields);
  assert.equal(state.sprint.tasks.length, 1);
  assert.equal(state.schedule.feasible, false);
  await change('createTask', {
    ...taskFields,
    title: '출시 검증',
    dependsOn: [1],
  });
  await change('capacity', { person: 0, date: startDate, hours: 2 });
  assert.equal(state.schedule.feasible, true);
  assert.equal(state.schedule.finishes[1], state.schedule.starts[2]);
  const invite = await projectRequest('planner', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'worker@test.local',
  });
  const { token } = await invite.json();
  assert.equal(
    (await projectRequest('worker', { action: 'accept', token, agreed: true }))
      .status,
    200,
  );
  state = await read();
  await change('editTask', {
    ...taskFields,
    taskId: 2,
    title: '팀원 출시 검증',
    status: 'todo',
    description: '',
    person: 1,
    dependsOn: [1],
    optional: true,
  });
  assert.equal(state.schedule.feasible, false);
  await change('capacity', { person: 1, date: startDate, hours: 2 }, 'worker');
  assert.equal(state.schedule.feasible, true);
  const shared = await (await scoped('worker', projectId)).json();
  assert.deepEqual(shared.sprint.tasks, state.sprint.tasks);
  assert.deepEqual(shared.sprint.tasks[1], {
    id: 2,
    title: '팀원 출시 검증',
    status: 'todo',
    description: '',
    person: 1,
    remaining: 1,
    optional: true,
    done: false,
    deferred: false,
    evidence: '',
    dependsOn: [1],
  });
  assert.equal(
    (
      await post('worker', 'editTask', state.sprint.revision, {
        projectId,
        taskId: 2,
        ...taskFields,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post('worker', 'createTask', state.sprint.revision, {
        projectId,
        ...taskFields,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post('stranger', 'createTask', state.sprint.revision, {
        projectId,
        ...taskFields,
      })
    ).status,
    403,
  );
  await change(
    'checkin',
    { taskId: 2, remaining: 1.5, note: '추가 검증 필요' },
    'worker',
  );
  assert.equal(state.schedule.feasible, false);
  await change('capacity', { person: 1, date: startDate, hours: 3 }, 'worker');
  assert.equal(state.schedule.feasible, true);
  state = await read();
  assert.equal(state.sprint.tasks[1].remaining, 1.5);
  assert.ok(state.events.some((e) => e.action === 'editTask'));
});

test('task validation rejects invalid members, hours and cyclic dependencies without writes', async () => {
  const { projectId, read } = await taskProject('validator');
  let state = await read();
  for (const fields of [
    taskFields,
    { ...taskFields, title: '검증', dependsOn: [1] },
  ]) {
    const r = await post('validator', 'createTask', state.sprint.revision, {
      projectId,
      ...fields,
    });
    assert.equal(r.status, 200);
    state = await r.json();
  }
  const before = await read();
  for (const invalid of [
    { title: '' },
    { title: 'x'.repeat(201) },
    { person: 1 },
    { person: -1 },
    { person: '0' },
    { remaining: 0 },
    { remaining: 0.1 },
    { remaining: 201 },
    { optional: 'true' },
    { dependsOn: [99] },
    { dependsOn: [1, 1] },
    { dependsOn: [1] },
    { dependsOn: [2] },
    { dependsOn: '2' },
  ]) {
    const r = await post('validator', 'editTask', state.sprint.revision, {
      projectId,
      taskId: 1,
      ...taskFields,
      ...invalid,
    });
    assert.equal(r.status, 400, JSON.stringify(invalid));
  }
  assert.deepEqual((await read()).sprint, before.sprint);
  assert.deepEqual((await read()).events, before.events);
  const completed = await post('validator', 'task', state.sprint.revision, {
    projectId,
    taskId: 1,
    done: true,
    evidence: '화면 동작 확인 완료',
  });
  state = await completed.json();
  assert.equal(
    (
      await post('validator', 'editTask', state.sprint.revision, {
        projectId,
        taskId: 1,
        ...taskFields,
      })
    ).status,
    400,
  );
});

test('concurrent task writes and a dependency failure never leave partial records', async () => {
  const { projectId, read } = await taskProject('atomic');
  const replies = await Promise.all([
    post('atomic', 'createTask', 0, { projectId, ...taskFields }),
    post('atomic', 'createTask', 0, {
      projectId,
      ...taskFields,
      title: '동시 등록',
    }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  let state = await read();
  assert.equal(state.sprint.tasks.length, 1);
  const added = await post('atomic', 'createTask', state.sprint.revision, {
    projectId,
    ...taskFields,
    dependsOn: [1],
  });
  assert.equal(added.status, 200);
  state = await read();
  db.exec(
    "CREATE TRIGGER fail_task_dependency BEFORE INSERT ON sprint_dependencies BEGIN SELECT RAISE(ABORT,'SQLITE dependency rollback'); END",
  );
  try {
    const r = await post('atomic', 'editTask', state.sprint.revision, {
      projectId,
      taskId: 2,
      ...taskFields,
      title: '롤백될 변경',
      dependsOn: [1],
    });
    assert.equal(r.status, 503);
    const after = await read();
    assert.deepEqual(after.sprint, state.sprint);
    assert.deepEqual(after.events, state.events);
  } finally {
    db.exec('DROP TRIGGER fail_task_dependency');
  }
  const edits = await Promise.all([
    post('atomic', 'editTask', state.sprint.revision, {
      projectId,
      taskId: 2,
      ...taskFields,
      title: '선행 해제',
      dependsOn: [],
    }),
    post('atomic', 'editTask', state.sprint.revision, {
      projectId,
      taskId: 2,
      ...taskFields,
      title: '선행 유지',
      dependsOn: [1],
    }),
  ]);
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
  state = await read();
  assert.equal(
    state.sprint.tasks[1].title === '선행 해제',
    state.sprint.tasks[1].dependsOn.length === 0,
  );
});

test('task details persist status and description, enforce ownership and preserve completion evidence', async () => {
  const { projectId, read } = await taskProject('detail-owner');
  let response = await post('detail-owner', 'createTask', 0, {
    projectId,
    ...taskFields,
  });
  assert.equal(response.status, 200);
  let state = await response.json();
  const invitation = await projectRequest('detail-owner', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'detail-member@test.local',
  });
  const { token } = await invitation.json();
  assert.equal(
    (
      await projectRequest('detail-member', {
        action: 'accept',
        token,
        agreed: true,
      })
    ).status,
    200,
  );
  state = await read();
  const details = {
    projectId,
    taskId: 1,
    status: 'in_progress',
    description: '목표: 화면 연결\n확인: 정상 제출과 오류 표시',
    remaining: 2.5,
  };
  assert.equal(
    (await post('detail-member', 'taskDetails', state.sprint.revision, details))
      .status,
    403,
  );
  assert.equal(
    (await post('outside', 'taskDetails', state.sprint.revision, details))
      .status,
    403,
  );
  for (const bad of [
    { status: 'done' },
    { status: 'deferred' },
    { description: 12 },
    { description: 'x'.repeat(10001) },
    { remaining: -1 },
  ]) {
    assert.equal(
      (
        await post('detail-owner', 'taskDetails', state.sprint.revision, {
          ...details,
          ...bad,
        })
      ).status,
      400,
    );
  }
  const before = state.sprint.revision;
  response = await post('detail-owner', 'taskDetails', before, details);
  assert.equal(response.status, 200);
  state = await read();
  assert.equal(state.sprint.tasks[0].description, details.description);
  assert.equal(state.sprint.tasks[0].status, 'in_progress');
  assert.equal(state.schedule.needed, 2.5);
  assert.equal(
    (
      await post('detail-owner', 'taskDetails', before, {
        ...details,
        description: '오래된 편집',
      })
    ).status,
    409,
  );
  response = await post('detail-owner', 'editTask', state.sprint.revision, {
    projectId,
    taskId: 1,
    ...taskFields,
    person: 1,
    remaining: 2.5,
  });
  assert.equal(response.status, 200);
  state = await response.json();
  response = await post('detail-member', 'taskDetails', state.sprint.revision, {
    ...details,
    description: '담당자가 보완한 설명',
  });
  assert.equal(response.status, 200);
  state = await response.json();
  response = await post('detail-member', 'task', state.sprint.revision, {
    projectId,
    taskId: 1,
    done: true,
    evidence: '핵심 화면 연결 및 제출 검증 완료',
  });
  assert.equal(response.status, 200);
  state = await read();
  assert.equal(state.sprint.tasks[0].done, true);
  assert.equal(state.sprint.tasks[0].description, '담당자가 보완한 설명');
  assert.equal(state.schedule.needed, 0);
  assert.equal(
    (await post('detail-member', 'taskDetails', state.sprint.revision, details))
      .status,
    400,
  );
  response = await post('detail-member', 'task', state.sprint.revision, {
    projectId,
    taskId: 1,
    done: false,
    remaining: 1,
  });
  assert.equal(response.status, 200);
  state = await read();
  assert.equal(state.sprint.tasks[0].status, 'in_progress');
  assert.equal(state.sprint.tasks[0].evidence, '');
  assert.equal(state.sprint.tasks[0].description, '담당자가 보완한 설명');
});

test('workspace migration preserves existing tasks and adds empty descriptions', () => {
  const old = new DatabaseSync(':memory:');
  try {
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files.filter((f) => f < '0004'))
      old.exec(readFileSync('drizzle/' + file, 'utf8'));
    old.exec(
      "INSERT INTO sprints(owner,title,start_date,deadline,updated_at) VALUES('legacy','출시','2026-09-08','2026-09-17','2026-09-08')",
    );
    old.exec(
      "INSERT INTO sprint_tasks(owner,id,title,person,remaining,done,evidence) VALUES('legacy',1,'기존 완료 업무',0,0,1,'실행 결과 확인')",
    );
    old.exec(readFileSync('drizzle/0004_boring_reavers.sql', 'utf8'));
    const row = old
      .prepare(
        'SELECT title,done,evidence,status,description FROM sprint_tasks',
      )
      .get();
    assert.deepEqual(
      { ...row },
      {
        title: '기존 완료 업무',
        done: 1,
        evidence: '실행 결과 확인',
        status: 'todo',
        description: '',
      },
    );
  } finally {
    old.close();
  }
});
