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
  async run() {
    return this.execute();
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
    // 실제 쓰기 직전에 상태를 바꾸는 상황을 재현하기 위한 훅.
    if (
      globalThis.__BEFORE_WRITE &&
      statements.some((s) => s.sql.includes('UPDATE sprints SET revision'))
    ) {
      const hook = globalThis.__BEFORE_WRITE;
      globalThis.__BEFORE_WRITE = null;
      hook();
    }
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

test('이전 규칙 기록은 열람·내보내기만 되고 모든 변경은 거절된다', async () => {
  // 근거: 기존 프로젝트를 새 규칙에 자동 동의한 것으로 변환하지 않는다(A1).
  await api.initialize('legacy-user');
  const state = await read('legacy-user', 'legacy-user');
  assert.equal(state.lifecycle, 'legacy');
  assert.equal(state.policy, null);
  assert.equal(state.sprint.tasks.length, 6);
  assert.ok(state.legacySchedule);
  for (const action of [
    'start',
    'editGoal',
    'agreeGoal',
    'createTask',
    'checkin',
    'task',
    'finish',
    'deliverableConfirm',
    'stepBack',
  ]) {
    const r = await post('legacy-user', action, state.sprint.revision, {
      projectId: 'legacy-user',
    });
    assert.equal(r.status, 400, action);
    assert.match((await r.json()).error, /이전 규칙|지원하지 않는/);
  }
  // 제거된 예전 기능은 직접 요청해도 거절된다.
  for (const action of ['capacity', 'propose', 'approve', 'reject', 'join']) {
    const r = await post('legacy-user', action, state.sprint.revision, {
      projectId: 'legacy-user',
      person: 0,
      hours: 2,
    });
    assert.equal(r.status, 400, action);
  }
  const after = await read('legacy-user', 'legacy-user');
  assert.equal(after.sprint.revision, state.sprint.revision);
  assert.deepEqual(after.events, state.events);
  const exported = await scoped('legacy-user', 'legacy-user', '&format=export');
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).lifecycle, 'legacy');
});

test('생성은 준비 상태이며 혼자서는 시작할 수 없다', async () => {
  const created = await projectRequest('solo', goalInput);
  assert.equal(created.status, 201);
  const { projectId } = await created.json();
  const state = await read('solo', projectId);
  assert.equal(state.lifecycle, 'draft');
  assert.equal(state.policy.startedAt, null);
  assert.equal(state.policy.deadlineAt, null);
  assert.equal(state.policy.goalVersion, 1);
  assert.equal(state.deliverables.length, 2);
  assert.equal(state.deliverables[0].fixedAt, null);
  assert.equal(state.readiness.ready, false);
  assert.equal(state.readiness.joined, 1);
  // 준비 중 계획은 예상치로만 표시한다.
  assert.equal(state.plan.provisional, true);
  const start = await post('solo', 'start', state.sprint.revision, {
    projectId,
  });
  assert.equal(start.status, 400);
  assert.match((await start.json()).error, /2명 이상/);
  // 시작 거절은 준비 기간을 소모하지 않는다.
  const after = await read('solo', projectId);
  assert.equal(after.policy.startedAt, null);
  assert.equal(after.sprint.revision, state.sprint.revision);
  // 잘못된 기간은 생성 단계에서 거절한다.
  assert.equal(
    (await projectRequest('solo', { ...goalInput, duration: 6 })).status,
    400,
  );
  assert.equal(
    (await projectRequest('solo', { ...goalInput, agreed: false })).status,
    400,
  );
});

test('목표를 편집하면 이전 동의로 시작할 수 없다', async () => {
  const { projectId, state } = await draftTeam('editor', 'editmate');
  assert.equal(state.readiness.ready, true);
  const edited = await change('editor', projectId, 'editGoal', state, {
    ...goalFields,
    goal: '범위를 다시 합의한 목표',
    deliverables: '동작하는 서비스\n3분 데모 영상\n팀원별 기여 정리',
  });
  assert.equal(edited.policy.goalVersion, 2);
  assert.equal(edited.readiness.ready, false);
  assert.match(edited.readiness.missing.join(' '), /최신 목표 미동의/);
  assert.equal(edited.deliverables.length, 3);
  const rejected = await post('editor', 'start', edited.sprint.revision, {
    projectId,
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /최신 목표 미동의/);
  // 미동의 팀원은 읽기만 한다.
  const mateState = await read('editmate', projectId);
  assert.equal(mateState.me.agreedGoalVersion, 1);
  const blocked = await post('editmate', 'checkin', edited.sprint.revision, {
    projectId,
    taskId: 1,
    note: 'x',
    remaining: 1,
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /최신 목표/);
  // 오래된 버전 동의는 거절된다.
  assert.equal(
    (
      await post('editmate', 'agreeGoal', edited.sprint.revision, {
        projectId,
        goalVersion: 1,
      })
    ).status,
    409,
  );
  const agreed = await change('editmate', projectId, 'agreeGoal', edited, {
    goalVersion: 2,
  });
  assert.equal(agreed.readiness.ready, true);
  const started = await change('editor', projectId, 'start', agreed);
  assert.equal(started.lifecycle, 'active');
  assert.ok(started.policy.startedAt);
  assert.equal(
    Date.parse(started.policy.deadlineAt) - Date.parse(started.policy.startedAt),
    7 * 86400000,
  );
  assert.equal(started.plan.provisional, false);
  assert.ok(started.deliverables.every((d) => d.fixedAt));
});

test('동시 시작 요청은 하나의 시작 시각과 하나의 기한만 확정한다', async () => {
  const { projectId, state } = await draftTeam('race', 'racemate');
  const both = await Promise.all([
    post('race', 'start', state.sprint.revision, { projectId }),
    post('race', 'start', state.sprint.revision, { projectId }),
  ]);
  assert.deepEqual(
    both.map((r) => r.status).sort(),
    [200, 409],
  );
  const after = await read('race', projectId);
  assert.equal(after.lifecycle, 'active');
  const again = await post('race', 'start', after.sprint.revision, {
    projectId,
  });
  assert.equal(again.status, 400);
  // 중복 시작은 기한을 다시 계산하지 않는다.
  const final = await read('race', projectId);
  assert.equal(final.policy.deadlineAt, after.policy.deadlineAt);
  assert.equal(final.policy.startedAt, after.policy.startedAt);
});

test('시작한 뒤에는 팀장도 목표와 최종 기한을 바꿀 수 없다', async () => {
  const { projectId, state } = await startedTeam('fixed', 'fixedmate');
  const edit = await post('fixed', 'editGoal', state.sprint.revision, {
    projectId,
    ...goalFields,
    goal: '몰래 줄인 목표',
  });
  assert.equal(edit.status, 400);
  assert.match((await edit.json()).error, /진행 중인 프로젝트/);
  const after = await read('fixed', projectId);
  assert.equal(after.agreement.goal, goalFields.goal);
  assert.equal(after.policy.deadlineAt, state.policy.deadlineAt);
  assert.equal(after.sprint.revision, state.sprint.revision);
});

test('마감 이후에는 실제 저장 시점에서 모든 변경이 거절된다', async () => {
  const { projectId, state } = await startedTeam('clock', 'clockmate');
  const withTask = await change('clock', projectId, 'createTask', state, {
    title: '핵심 흐름 구현',
    person: 0,
    remaining: 4,
    dependsOn: [],
  });
  // 요청 시작 시점에는 마감 전이지만, 실제 쓰기 직전에 마감이 지난 경우.
  globalThis.__BEFORE_WRITE = () =>
    db
      .prepare('UPDATE project_policy SET deadline_at=? WHERE project_id=?')
      .run('2000-01-01T00:00:00.000Z', projectId);
  const late = await post('clock', 'checkin', withTask.sprint.revision, {
    projectId,
    taskId: 1,
    note: '마감 직후 도착한 저장',
    remaining: 2,
  });
  assert.equal(late.status, 409);
  globalThis.__BEFORE_WRITE = null;
  const after = await read('clock', projectId);
  assert.equal(after.lifecycle, 'expired');
  assert.equal(after.sprint.revision, withTask.sprint.revision);
  assert.equal(after.sprint.tasks[0].remaining, 4);
  assert.equal(after.checkins.length, 0);
  assert.deepEqual(after.events, withTask.events);
  // 이후 요청은 시작 시점 검사에서 바로 막힌다.
  for (const [action, fields] of [
    ['createTask', { title: 'x', person: 0, remaining: 1, dependsOn: [] }],
    ['task', { taskId: 1, done: true, evidence: '마감 후 완료 시도' }],
    ['finish', {}],
    ['deliverableConfirm', { deliverableId: after.deliverables[0].deliverableId, confirmed: true }],
  ]) {
    const r = await post('clock', action, after.sprint.revision, {
      projectId,
      ...fields,
    });
    assert.equal(r.status, 400, action);
    assert.match((await r.json()).error, /마감이 지난/);
  }
  // 열람과 내보내기는 유지된다.
  const exported = await scoped('clock', projectId, '&format=export');
  assert.equal(exported.status, 200);
  const dump = await exported.json();
  assert.equal(dump.lifecycle, 'expired');
  assert.equal(dump.tasks.length, 1);
  assert.equal((await scoped('outsider', projectId, '&format=export')).status, 403);
  // 내보내기에 다른 멤버의 이메일·인증 정보는 포함하지 않는다.
  assert.ok(!JSON.stringify(dump).includes('@test.local'));
});

test('완주는 보고 수가 아니라 합의 결과물 확인으로 판정한다', async () => {
  const { projectId, state } = await startedTeam('goal', 'goalmate');
  let s = await change('goal', projectId, 'createTask', state, {
    title: '끝내지 않을 관리 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
  });
  assert.equal(s.checkins.length, 0);
  assert.equal(s.completion.ready, false);
  // 체크인이 0건이어도 결과물을 모두 확인하면 완주할 수 있다.
  const early = await post('goal', 'finish', s.sprint.revision, { projectId });
  assert.equal(early.status, 400);
  assert.match((await early.json()).error, /확인되지 않은 필수 결과물/);
  for (const d of s.deliverables) {
    const confirmFirst = await post(
      'goal',
      'deliverableConfirm',
      s.sprint.revision,
      { projectId, deliverableId: d.deliverableId, confirmed: true },
    );
    // 근거 없이 확인할 수 없다.
    assert.equal(confirmFirst.status, 400);
    s = await change('goalmate', projectId, 'deliverableEvidence', s, {
      deliverableId: d.deliverableId,
      evidence: '저장소 링크와 실행 방법, 담당 구간을 적었습니다.',
    });
    s = await change('goal', projectId, 'deliverableConfirm', s, {
      deliverableId: d.deliverableId,
      confirmed: true,
    });
  }
  assert.equal(s.completion.ready, true);
  // 팀원은 완주 확인을 할 수 없다.
  assert.equal(
    (await post('goalmate', 'finish', s.sprint.revision, { projectId })).status,
    403,
  );
  const done = await change('goal', projectId, 'finish', s);
  assert.equal(done.lifecycle, 'completed');
  assert.equal(done.sprint.finished, true);
  // 결과물과 무관한 미완료 업무가 완주를 막지 않았다.
  assert.equal(done.sprint.tasks[0].done, false);
  // 완주 후에는 일반 변경이 막힌다.
  const late = await post('goal', 'createTask', done.sprint.revision, {
    projectId,
    title: '추가',
    person: 0,
    remaining: 1,
    dependsOn: [],
  });
  assert.equal(late.status, 400);
  assert.match((await late.json()).error, /완주로 확정/);
  assert.equal((await scoped('goal', projectId, '&format=export')).status, 200);
});

test('업무를 모두 끝내도 결과물 하나가 미확인이면 완주할 수 없다', async () => {
  const { projectId, state } = await startedTeam('tasksonly', 'tasksmate');
  let s = await change('tasksonly', projectId, 'createTask', state, {
    title: '전부 끝낸 업무',
    person: 0,
    remaining: 1,
    dependsOn: [],
  });
  s = await change('tasksonly', projectId, 'task', s, {
    taskId: 1,
    done: true,
    evidence: '실행 결과를 직접 확인했습니다.',
  });
  assert.ok(s.sprint.tasks.every((t) => t.done));
  s = await change('tasksonly', projectId, 'deliverableEvidence', s, {
    deliverableId: s.deliverables[0].deliverableId,
    evidence: '저장소와 실행 방법을 남겼습니다.',
  });
  s = await change('tasksonly', projectId, 'deliverableConfirm', s, {
    deliverableId: s.deliverables[0].deliverableId,
    confirmed: true,
  });
  const r = await post('tasksonly', 'finish', s.sprint.revision, { projectId });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /3분 데모 영상/);
  // 증빙을 다시 쓰면 팀장 확인이 풀린다.
  s = await change('tasksonly', projectId, 'deliverableEvidence', s, {
    deliverableId: s.deliverables[0].deliverableId,
    evidence: '증빙을 교체했습니다. 새 실행 방법 안내.',
  });
  assert.equal(s.deliverables[0].confirmed, false);
});

test('개인별 가용시간과 부가 업무 보류는 새 정책에 남지 않는다', async () => {
  const { projectId, state } = await startedTeam('common', 'commonmate');
  assert.equal(state.sprint.capacity.length, 0);
  assert.equal(state.plan.dailyHours, 8);
  assert.equal(state.plan.perPerson.length, 2);
  assert.equal(state.plan.perPerson[0].available, state.plan.perPerson[1].available);
  const created = await post('common', 'createTask', state.sprint.revision, {
    projectId,
    title: '부가 업무 시도',
    person: 0,
    remaining: 1,
    optional: true,
    dependsOn: [],
  });
  assert.equal(created.status, 400);
  assert.match((await created.json()).error, /부가 업무/);
  const s = await change('common', projectId, 'createTask', state, {
    title: '필수 업무',
    person: 0,
    remaining: 1,
    dependsOn: [],
  });
  assert.equal(s.sprint.tasks[0].optional, false);
});

test('참여 중단 보고는 배정이나 기한을 바꾸지 않는다', async () => {
  const { projectId, state } = await startedTeam('leave', 'leavemate');
  let s = await change('leave', projectId, 'createTask', state, {
    title: '팀원 담당 업무',
    person: 1,
    remaining: 4,
    dependsOn: [],
  });
  // 다른 사람 대신 보고할 수 없다.
  assert.equal(
    (
      await post('leave', 'stepBack', s.sprint.revision, {
        projectId,
        userId: 'leavemate',
        note: '대신 보고',
      })
    ).status,
    403,
  );
  s = await change('leavemate', projectId, 'stepBack', s, {
    note: '개인 사정으로 남은 기간 참여가 어렵습니다.',
  });
  assert.equal(s.members[1].left_at !== null, true);
  assert.equal(s.sprint.tasks[0].person, 1);
  assert.equal(s.policy.deadlineAt, state.policy.deadlineAt);
  // 남은 팀 기준으로는 자동 배치되지 않고 위험으로 보인다.
  assert.equal(s.plan.feasible, false);
  assert.deepEqual(s.plan.unscheduled, [1]);
  // 보고한 팀원은 더 이상 변경하지 않는다.
  assert.equal(
    (
      await post('leavemate', 'checkin', s.sprint.revision, {
        projectId,
        taskId: 1,
        note: '계속 진행',
        remaining: 1,
      })
    ).status,
    403,
  );
});

test('업무 편집 권한·검증·동시 쓰기 원자성은 유지된다', async () => {
  const { projectId, state } = await startedTeam('atomic2', 'atomicmate');
  let s = await change('atomic2', projectId, 'createTask', state, {
    title: '선행 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
  });
  s = await change('atomic2', projectId, 'createTask', s, {
    title: '후행 업무',
    person: 1,
    remaining: 2,
    dependsOn: [1],
  });
  assert.equal(s.plan.starts[2], s.plan.finishes[1]);
  // 팀원은 업무를 만들거나 담당자를 바꿀 수 없다.
  for (const action of ['createTask', 'editTask'])
    assert.equal(
      (
        await post('atomicmate', action, s.sprint.revision, {
          projectId,
          taskId: 2,
          title: '무단 변경',
          person: 1,
          remaining: 1,
          dependsOn: [],
        })
      ).status,
      403,
      action,
    );
  // 비멤버는 접근 자체가 막힌다.
  assert.equal((await scoped('stranger', projectId)).status, 403);
  const before = await read('atomic2', projectId);
  for (const invalid of [
    { title: '' },
    { person: 3 },
    { remaining: 0 },
    { remaining: 0.1 },
    { dependsOn: [2] },
    { dependsOn: [1, 1] },
  ])
    assert.equal(
      (
        await post('atomic2', 'editTask', s.sprint.revision, {
          projectId,
          taskId: 2,
          title: '후행 업무',
          person: 1,
          remaining: 2,
          dependsOn: [1],
          ...invalid,
        })
      ).status,
      400,
      JSON.stringify(invalid),
    );
  assert.deepEqual((await read('atomic2', projectId)).sprint, before.sprint);
  const concurrent = await Promise.all([
    post('atomic2', 'editTask', s.sprint.revision, {
      projectId,
      taskId: 2,
      title: '선행 해제',
      person: 1,
      remaining: 2,
      dependsOn: [],
    }),
    post('atomic2', 'editTask', s.sprint.revision, {
      projectId,
      taskId: 2,
      title: '선행 유지',
      person: 1,
      remaining: 2,
      dependsOn: [1],
    }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const after = await read('atomic2', projectId);
  assert.equal(
    after.sprint.tasks[1].title === '선행 해제',
    after.sprint.tasks[1].dependsOn.length === 0,
  );
  // 담당자 본인은 상태·남은 공수를 스스로 처리한다.
  const mine = await change('atomicmate', projectId, 'taskDetails', after, {
    taskId: 2,
    status: 'in_progress',
    description: '진행 메모',
    remaining: 1.5,
  });
  assert.equal(mine.sprint.tasks[1].remaining, 1.5);
  assert.equal(
    (
      await post('atomicmate', 'taskDetails', mine.sprint.revision, {
        projectId,
        taskId: 1,
        status: 'in_progress',
        description: '남의 업무',
        remaining: 1,
      })
    ).status,
    403,
  );
});

test('저장 실패는 업무·체크인·이력을 함께 되돌린다', async () => {
  const { projectId, state } = await startedTeam('rollback2', 'rollbackmate');
  const s = await change('rollback2', projectId, 'createTask', state, {
    title: '롤백 확인 업무',
    person: 0,
    remaining: 2,
    dependsOn: [],
  });
  db.exec(
    "CREATE TRIGGER fail_checkin2 BEFORE INSERT ON sprint_checkins BEGIN SELECT RAISE(ABORT,'SQLITE test rollback'); END;",
  );
  try {
    const r = await post('rollback2', 'checkin', s.sprint.revision, {
      projectId,
      taskId: 1,
      note: '롤백될 체크인',
      remaining: 1,
    });
    assert.equal(r.status, 503);
  } finally {
    db.exec('DROP TRIGGER fail_checkin2');
  }
  const after = await read('rollback2', projectId);
  assert.equal(after.sprint.revision, s.sprint.revision);
  assert.equal(after.sprint.tasks[0].remaining, 2);
  assert.equal(after.checkins.length, 0);
  assert.deepEqual(after.events, s.events);
});

test('초대·수락·취소와 팀 인원 제한은 새 정책에서도 유지된다', async () => {
  const created = await projectRequest('teamlead', goalInput);
  const { projectId } = await created.json();
  let state = await read('teamlead', projectId);
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const r = await projectRequest('teamlead', {
      action: 'invite',
      projectId,
      revision: state.sprint.revision,
      email: `seat${i}@test.local`,
    });
    assert.equal(r.status, 201);
    tokens.push(await r.json());
    state = await read('teamlead', projectId);
  }
  // 초대만 보낸 사람은 가입 인원이 아니다.
  assert.equal(state.readiness.joined, 1);
  assert.equal(state.readiness.ready, false);
  assert.equal(
    (
      await projectRequest('outsider', {
        action: 'accept',
        token: tokens[0].token,
        agreed: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await projectRequest('seat0', {
        action: 'accept',
        token: tokens[0].token,
        agreed: false,
      })
    ).status,
    400,
  );
  const results = await Promise.all(
    [1, 2].map((i) =>
      projectRequest('seat' + i, {
        action: 'accept',
        token: tokens[i].token,
        agreed: true,
      }),
    ),
  );
  for (const [n, r] of results.entries()) {
    assert.ok([200, 409].includes(r.status));
    if (r.status === 409)
      assert.equal(
        (
          await projectRequest('seat' + (n + 1), {
            action: 'accept',
            token: tokens[n + 1].token,
            agreed: true,
          })
        ).status,
        200,
      );
  }
  assert.equal(
    (
      await projectRequest('seat0', {
        action: 'accept',
        token: tokens[0].token,
        agreed: true,
      })
    ).status,
    200,
  );
  state = await read('teamlead', projectId);
  assert.equal(state.members.length, 4);
  assert.equal(new Set(state.members.map((m) => m.person)).size, 4);
  assert.equal(state.readiness.ready, true);
  assert.equal(
    (
      await projectRequest('seat3', {
        action: 'accept',
        token: tokens[3].token,
        agreed: true,
      })
    ).status,
    400,
  );
  // 취소·만료된 초대는 수락되지 않는다.
  const extra = await projectRequest('teamlead', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'later@test.local',
  });
  const later = await extra.json();
  state = await read('teamlead', projectId);
  assert.equal(
    (
      await projectRequest('teamlead', {
        action: 'revoke',
        projectId,
        revision: state.sprint.revision,
        inviteId: later.id,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await projectRequest('later', {
        action: 'accept',
        token: later.token,
        agreed: true,
      })
    ).status,
    410,
  );
});

test('진행 중 합류한 팀원은 고정 목표에 동의만 하고 목표를 다시 열지 않는다', async () => {
  const { projectId, state } = await startedTeam('joinlate', 'joinmate');
  const invite = await projectRequest('joinlate', {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'thirdperson@test.local',
  });
  const { token } = await invite.json();
  assert.equal(
    (
      await projectRequest('thirdperson', {
        action: 'accept',
        token,
        agreed: true,
      })
    ).status,
    200,
  );
  const s = await read('thirdperson', projectId);
  assert.equal(s.me.agreedGoalVersion, s.policy.goalVersion);
  assert.equal(s.lifecycle, 'active');
  assert.equal(
    (
      await post('thirdperson', 'editGoal', s.sprint.revision, {
        projectId,
        ...goalFields,
      })
    ).status,
    400,
  );
});

test('잘못된 형식·교차 출처 요청은 쓰기 없이 거절된다', async () => {
  const { projectId, state } = await startedTeam('guard', 'guardmate');
  assert.equal(
    (
      await api.POST(
        new Request('https://test.local/api/sprint', {
          method: 'POST',
          headers: { ...headers('guard'), origin: 'https://evil.local' },
          body: '{}',
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api.POST(
        new Request('https://test.local/api/sprint', {
          method: 'POST',
          headers: { 'oai-authenticated-user-id': 'guard' },
          body: '{}',
        }),
      )
    ).status,
    415,
  );
  assert.equal(
    (await api.GET(new Request('https://test.local/api/sprint'))).status,
    401,
  );
  assert.equal((await read('guard', projectId)).sprint.revision, state.sprint.revision);
});

test('새 마이그레이션은 기존 데이터와 관계를 보존한다', () => {
  const old = new DatabaseSync(':memory:');
  try {
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files.filter((f) => f < '0005')) old.exec(readFileSync('drizzle/' + file, 'utf8'));
    old.exec(
      "INSERT INTO sprints(owner,title,start_date,deadline,updated_at) VALUES('legacy','출시','2026-09-08','2026-09-17T18:00:00+09:00','2026-09-08')",
    );
    old.exec(
      "INSERT INTO sprint_tasks(owner,id,title,person,remaining,done,evidence) VALUES('legacy',1,'기존 완료 업무',0,0,1,'실행 결과 확인')",
    );
    old.exec(
      "INSERT INTO project_details(project_id,created_by,goal,deliverables,completion_criteria,created_at) VALUES('legacy','u','기존 목표','[\"기존 결과물\"]','기존 기준','2026-09-08')",
    );
    old.exec(
      "INSERT INTO project_members(project_id,user_id,display_name,role,person,joined_at) VALUES('legacy','u','기존 팀장','owner',0,'2026-09-08')",
    );
    old.exec(
      "INSERT INTO sprint_capacity(owner,person,date,hours) VALUES('legacy',0,'2026-09-08',3)",
    );
    old.exec(readFileSync('drizzle/0005_spartan_policy.sql', 'utf8'));
    assert.deepEqual(
      { ...old.prepare('SELECT title,done,evidence FROM sprint_tasks').get() },
      { title: '기존 완료 업무', done: 1, evidence: '실행 결과 확인' },
    );
    assert.deepEqual(
      {
        ...old
          .prepare(
            'SELECT display_name,agreed_goal_version,email,left_at FROM project_members',
          )
          .get(),
      },
      {
        display_name: '기존 팀장',
        agreed_goal_version: 0,
        email: null,
        left_at: null,
      },
    );
    // 기존 결과물 텍스트와 가용시간 기록은 남는다.
    assert.equal(
      old.prepare('SELECT deliverables FROM project_details').get().deliverables,
      '["기존 결과물"]',
    );
    assert.equal(old.prepare('SELECT hours FROM sprint_capacity').get().hours, 3);
    // 기존 프로젝트에는 새 정책 행이 자동으로 생기지 않는다.
    assert.equal(
      old.prepare('SELECT count(*) AS n FROM project_policy').get().n,
      0,
    );
  } finally {
    old.close();
  }
});

// 빈 DB에도 전체 마이그레이션이 적용되는지는 이 파일 상단에서 확인한다.
process.on('exit', () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
