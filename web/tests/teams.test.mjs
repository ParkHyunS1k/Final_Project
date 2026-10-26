// 공개 팀 목록·참여 신청·팀장 승인(2026-10-15). 설계: docs/superpowers/specs/2026-10-15-team-list-join-design.md
import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
import assert from 'node:assert/strict';
import { setupTestDb } from './helpers/pg-db.mjs';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { one, run, rows } = await setupTestDb();
const outfile = join(mkdtempSync(join(tmpdir(), 'projectmate-teams-test-')), 'route.mjs');
await build({
  stdin: {
    contents:
      "export { GET as sprintGET, POST as sprintPOST } from './app/api/sprint/route'; export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route'; export { GET as teamsGET, POST as teamsPOST } from './app/api/teams/route';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // 앱의 ./db를 setupTestDb가 만든 globalThis.__TEST_DB로 바꾼다(api.test.mjs와 같다).
  plugins: [
    {
      name: 'test-db',
      setup(b) {
        b.onResolve({ filter: /^\.\/db$/ }, () => ({ path: 'db', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export function database(){return globalThis.__TEST_DB}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);

function headers(user) {
  return {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@test.local',
    'content-type': 'application/json',
    origin: 'https://test.local',
  };
}
const postTo = (fn, url) => (user, body) =>
  fn(new Request('https://test.local' + url, { method: 'POST', headers: headers(user), body: JSON.stringify(body) }));
const projects = postTo((r) => api.projectsPOST(r), '/api/projects');
const teamsPost = postTo((r) => api.teamsPOST(r), '/api/teams');
const sprint = postTo((r) => api.sprintPOST(r), '/api/sprint');
async function json(r, status) {
  const text = await r.text();
  assert.equal(r.status, status, text);
  return JSON.parse(text);
}
async function teams(user) {
  return json(await api.teamsGET(new Request('https://test.local/api/teams', { headers: headers(user) })), 200);
}
async function state(user, projectId) {
  return json(
    await api.sprintGET(new Request('https://test.local/api/sprint?project=' + projectId, { headers: headers(user) })),
    200,
  );
}
const goalFields = {
  title: '공개 팀 스프린트',
  goal: '동네 가게 예약 페이지를 출시한다',
  scope: '예약 폼, 확인 화면',
  completionCriteria: '실제 예약 1건을 받아 보인다',
  duration: 7,
  agreed: true,
};
async function create(owner, over = {}) {
  return (await json(await projects(owner, { action: 'create', ...goalFields, ...over }), 201)).projectId;
}
async function listed(owner, over) {
  const projectId = await create(owner, over);
  const s = await state(owner, projectId);
  await json(await projects(owner, { action: 'setListed', projectId, revision: s.sprint.revision, listed: true }), 200);
  return projectId;
}
async function ask(user, projectId, goalVersion = 1) {
  return teamsPost(user, { action: 'request', projectId, goalVersion, agreed: true });
}
async function decide(owner, projectId, requestId, approve) {
  const s = await state(owner, projectId);
  return projects(owner, { action: 'decideJoin', projectId, revision: s.sprint.revision, requestId, approve });
}

test('새 프로젝트는 비공개라 목록에 없고, 팀장이 공개하면 다른 사용자에게만 보인다', async () => {
  const projectId = await create('t-owner');
  assert.equal((await state('t-owner', projectId)).listed, false);
  assert.ok(!(await teams('t-viewer')).teams.some((t) => t.projectId === projectId));
  // 비공개 팀은 존재 여부도 알리지 않는다.
  assert.equal((await ask('t-viewer', projectId)).status, 404);
  const s = await state('t-owner', projectId);
  await json(await projects('t-owner', { action: 'setListed', projectId, revision: s.sprint.revision, listed: true }), 200);
  const after = await state('t-owner', projectId);
  assert.equal(after.listed, true);
  const team = (await teams('t-viewer')).teams.find((t) => t.projectId === projectId);
  assert.deepEqual(
    { ...team, startedAt: null },
    {
      projectId,
      title: goalFields.title,
      goal: goalFields.goal,
      scope: goalFields.scope,
      completionCriteria: goalFields.completionCriteria,
      lifecycle: 'draft',
      goalVersion: 1,
      members: 1,
      maxMembers: 4,
      startedAt: null,
      deadlineAt: null,
      joinUntil: null,
      joinable: true,
      requested: false,
    },
  );
  // 팀원 이름·이메일·사용자 ID는 응답 어디에도 없다.
  const raw = JSON.stringify(await teams('t-viewer'));
  assert.doesNotMatch(raw, /t-owner/);
  // 내가 속한 팀은 목록에서 뺀다.
  assert.ok(!(await teams('t-owner')).teams.some((t) => t.projectId === projectId));
  const log = await rows("SELECT detail FROM sprint_events WHERE owner=? AND action='set_listed'", projectId);
  assert.equal(log.length, 1);
});

test('신청 → 팀장 승인으로 합류하고, 같은 신청은 한 번만 쌓인다', async () => {
  const projectId = await listed('j-owner');
  const first = await json(await ask('j-mate', projectId), 201);
  assert.equal(first.status, 'pending');
  // 다시 눌러도 같은 신청을 돌려준다.
  assert.equal((await json(await ask('j-mate', projectId), 201)).requestId, first.requestId);
  const listing = await teams('j-mate');
  assert.equal(listing.teams.find((t) => t.projectId === projectId).joinable, false);
  assert.equal(listing.teams.find((t) => t.projectId === projectId).requested, true);
  assert.equal(listing.requests[0].status, 'pending');
  // 신청만으로는 프로젝트를 볼 수 없다.
  const denied = await api.sprintGET(
    new Request('https://test.local/api/sprint?project=' + projectId, { headers: headers('j-mate') }),
  );
  assert.equal(denied.status, 403);
  const owner = await state('j-owner', projectId);
  assert.deepEqual(owner.joinRequests.map((r) => [r.id, r.display_name]), [[first.requestId, 'j-mate']]);
  await json(await decide('j-owner', projectId, first.requestId, true), 200);
  const joined = await state('j-mate', projectId);
  assert.equal(joined.me.role, 'member');
  assert.equal(joined.me.agreedGoalVersion, 1);
  assert.equal(joined.readiness.ready, true);
  assert.equal((await state('j-owner', projectId)).joinRequests.length, 0);
  assert.ok(!(await teams('j-mate')).teams.some((t) => t.projectId === projectId));
  assert.equal((await teams('j-mate')).requests[0].status, 'approved');
  const log = await rows("SELECT detail FROM sprint_events WHERE owner=? AND action='approve_join'", projectId);
  assert.match(log[0].detail, /j-mate/);
  // 이미 처리한 신청은 다시 처리하지 않는다.
  assert.equal((await decide('j-owner', projectId, first.requestId, false)).status, 409);
  assert.equal((await ask('j-mate', projectId)).status, 400);
});

test('팀원은 공개 설정·승인을 못 하고, 다른 팀의 신청은 처리할 수 없다', async () => {
  const projectId = await listed('p-owner');
  const mate = await json(await ask('p-mate', projectId), 201);
  await json(await decide('p-owner', projectId, mate.requestId, true), 200);
  const other = await json(await ask('p-other', projectId), 201);
  const s = await state('p-mate', projectId);
  assert.equal((await projects('p-mate', { action: 'setListed', projectId, revision: s.sprint.revision, listed: false })).status, 403);
  assert.equal(
    (await projects('p-mate', { action: 'decideJoin', projectId, revision: s.sprint.revision, requestId: other.requestId, approve: true })).status,
    403,
  );
  // 팀원 화면에는 신청자 목록이 없다.
  assert.deepEqual(s.joinRequests, []);
  const elsewhere = await create('p-owner2');
  assert.equal((await decide('p-owner2', elsewhere, other.requestId, true)).status, 404);
  // 오래된 버전으로 보낸 공개 설정은 거절된다.
  const stale = await projects('p-owner', { action: 'setListed', projectId, revision: s.sprint.revision - 1, listed: false });
  assert.equal(stale.status, 409);
});

test('목표 버전이 바뀌었으면 신청은 최신 목표를 돌려주고, 승인된 사람은 재동의해야 한다', async () => {
  const projectId = await listed('g-owner');
  const early = await json(await ask('g-early', projectId), 201);
  const s = await state('g-owner', projectId);
  await json(await sprint('g-owner', { action: 'editGoal', projectId, revision: s.sprint.revision, ...goalFields, goal: '바뀐 목표' }), 200);
  const changed = await json(await ask('g-late', projectId, 1), 409);
  assert.equal(changed.details.goal, '바뀐 목표');
  assert.equal(changed.details.goalVersion, 2);
  await json(await ask('g-late', projectId, 2), 201);
  // v1에 동의한 신청을 승인하면 들어오되 최신 목표 재동의 전에는 시작할 수 없다.
  await json(await decide('g-owner', projectId, early.requestId, true), 200);
  const after = await state('g-owner', projectId);
  assert.equal(after.readiness.ready, false);
  assert.match(after.readiness.missing.join(' '), /최신 목표 미동의: g-early/);
});

test('진행 중 팀은 시작 후 24시간 안에만 목록·신청·승인이 열린다', async () => {
  const projectId = await listed('w-owner');
  const pending = await json(await ask('w-mate', projectId), 201);
  const s = await state('w-owner', projectId);
  await json(await sprint('w-owner', { action: 'start', projectId, revision: s.sprint.revision }), 200);
  const open = (await teams('w-viewer')).teams.find((t) => t.projectId === projectId);
  assert.equal(open.lifecycle, 'active');
  assert.equal(Date.parse(open.joinUntil) - Date.parse(open.startedAt), 24 * 3600000);
  await run(
    "UPDATE project_policy SET started_at=now()-interval '25 hours',deadline_at=now()+interval '6 days' WHERE project_id=?",
    projectId,
  );
  assert.ok(!(await teams('w-viewer')).teams.some((t) => t.projectId === projectId));
  assert.equal((await ask('w-viewer', projectId)).status, 410);
  assert.equal((await decide('w-owner', projectId, pending.requestId, true)).status, 410);
  // 거절은 언제든 정리할 수 있다.
  await json(await decide('w-owner', projectId, pending.requestId, false), 200);
  assert.equal((await one('SELECT status FROM project_join_requests WHERE id=?', pending.requestId)).status, 'rejected');
  assert.equal(await one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', projectId, 'w-mate'), null);
});

test('완주·종료된 팀은 목록에 없고 신청도 거절된다', async () => {
  for (const [owner, sql] of [
    ['e-owner1', "UPDATE project_policy SET lifecycle='completed' WHERE project_id=?"],
    ['e-owner2', "UPDATE project_policy SET lifecycle='active',started_at=now()-interval '2 hours',deadline_at=now()-interval '1 minute' WHERE project_id=?"],
  ]) {
    const projectId = await listed(owner);
    await run(sql, projectId);
    assert.ok(!(await teams('e-viewer')).teams.some((t) => t.projectId === projectId));
    assert.equal((await ask('e-viewer', projectId)).status, 410);
  }
});

test('4명이 차면 신청·승인이 거절되고, 동시 승인에서도 4명을 넘지 않는다', async () => {
  const projectId = await listed('c-owner');
  for (const u of ['c-1', 'c-2']) {
    const r = await json(await ask(u, projectId), 201);
    await json(await decide('c-owner', projectId, r.requestId, true), 200);
  }
  const a = await json(await ask('c-a', projectId), 201);
  const b = await json(await ask('c-b', projectId), 201);
  const s = await state('c-owner', projectId);
  // 첫 승인이 저장되기 직전에 다른 승인이 먼저 끝난다.
  globalThis.__BEFORE_WRITE = async () => {
    await json(await decide('c-owner', projectId, b.requestId, true), 200);
  };
  const raced = await projects('c-owner', { action: 'decideJoin', projectId, revision: s.sprint.revision, requestId: a.requestId, approve: true });
  globalThis.__BEFORE_WRITE = null;
  assert.equal(raced.status, 409);
  assert.equal((await one('SELECT count(*)::int AS n FROM project_members WHERE project_id=?', projectId)).n, 4);
  assert.equal((await one('SELECT status FROM project_join_requests WHERE id=?', a.requestId)).status, 'pending');
  assert.equal((await decide('c-owner', projectId, a.requestId, true)).status, 400);
  assert.equal((await teams('c-z')).teams.find((t) => t.projectId === projectId).joinable, false);
  assert.equal((await ask('c-z', projectId)).status, 400);
});

test('신청자는 대기 신청을 취소하고, 거절된 뒤 다시 신청할 수 있으며, 대기 신청은 5개까지다', async () => {
  const projectId = await listed('x-owner');
  const r = await json(await ask('x-mate', projectId), 201);
  // 남의 신청은 취소할 수 없다.
  assert.equal((await teamsPost('x-other', { action: 'cancel', requestId: r.requestId })).status, 404);
  await json(await teamsPost('x-mate', { action: 'cancel', requestId: r.requestId }), 200);
  assert.equal((await state('x-owner', projectId)).joinRequests.length, 0);
  const again = await json(await ask('x-mate', projectId), 201);
  await json(await decide('x-owner', projectId, again.requestId, false), 200);
  assert.equal(await one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', projectId, 'x-mate'), null);
  assert.equal((await teams('x-mate')).requests[0].status, 'rejected');
  await json(await ask('x-mate', projectId), 201);
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await listed('x-host' + i));
  for (const id of many.slice(0, 4)) await json(await ask('x-mate', id), 201);
  assert.equal((await ask('x-mate', many[4])).status, 429);
});

test('형식이 틀리거나 교차 출처·로그인 없는 신청은 쓰기 없이 거절된다', async () => {
  const projectId = await listed('f-owner');
  assert.equal((await teamsPost('f-mate', { action: 'request', projectId, goalVersion: 1 })).status, 400);
  assert.equal((await teamsPost('f-mate', { action: 'request', projectId, agreed: true })).status, 400);
  const cross = await api.teamsPOST(
    new Request('https://test.local/api/teams', {
      method: 'POST',
      headers: { ...headers('f-mate'), origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'request', projectId, goalVersion: 1, agreed: true }),
    }),
  );
  assert.equal(cross.status, 403);
  assert.equal((await api.teamsGET(new Request('https://test.local/api/teams'))).status, 401);
  assert.equal((await one('SELECT count(*)::int AS n FROM project_join_requests WHERE project_id=?', projectId)).n, 0);
});

test('끝난 팀의 대기 신청은 expired로 보이고 대기 한도에서 빠진다', async () => {
  const hosts = [];
  for (let i = 0; i < 6; i++) hosts.push(await listed('q-host' + i));
  for (const id of hosts.slice(0, 5)) await json(await ask('q-mate', id), 201);
  assert.equal((await ask('q-mate', hosts[5])).status, 429);
  await run("UPDATE project_policy SET lifecycle='completed' WHERE project_id=?", hosts[0]);
  const mine = (await teams('q-mate')).requests;
  assert.equal(mine.find((r) => r.projectId === hosts[0]).status, 'expired');
  await json(await ask('q-mate', hosts[5]), 201);
});

test('승인 저장 직전에 신청자가 취소하면 승인도 팀원 추가도 기록도 남지 않는다', async () => {
  const projectId = await listed('k-owner');
  const r = await json(await ask('k-mate', projectId), 201);
  const s = await state('k-owner', projectId);
  globalThis.__BEFORE_WRITE = async () => {
    await json(await teamsPost('k-mate', { action: 'cancel', requestId: r.requestId }), 200);
  };
  const raced = await projects('k-owner', { action: 'decideJoin', projectId, revision: s.sprint.revision, requestId: r.requestId, approve: true });
  globalThis.__BEFORE_WRITE = null;
  assert.equal(raced.status, 409);
  assert.equal((await one('SELECT status FROM project_join_requests WHERE id=?', r.requestId)).status, 'cancelled');
  assert.equal(await one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', projectId, 'k-mate'), null);
  assert.equal((await rows("SELECT 1 FROM sprint_events WHERE owner=? AND action='approve_join'", projectId)).length, 0);
});

test('거절된 비회원 신청자의 이름은 팀원의 상태 조회·내보내기 어디에도 남지 않는다', async () => {
  const projectId = await listed('n-owner');
  const mate = await json(await ask('n-mate', projectId), 201);
  await json(await decide('n-owner', projectId, mate.requestId, true), 200);
  const outsider = await json(await ask('n-outsider', projectId), 201);
  await json(await decide('n-owner', projectId, outsider.requestId, false), 200);
  const seen = await state('n-mate', projectId);
  assert.deepEqual(seen.joinRequests, []);
  assert.ok(seen.events.some((e) => e.action === 'reject_join'));
  assert.doesNotMatch(JSON.stringify(seen), /n-outsider/);
  const exported = await json(
    await api.sprintGET(
      new Request('https://test.local/api/sprint?project=' + projectId + '&format=export', { headers: headers('n-mate') }),
    ),
    200,
  );
  assert.ok(exported.events.some((e) => e.action === 'reject_join'));
  assert.doesNotMatch(JSON.stringify(exported), /n-outsider/);
});

test('팀장이 참여 중단하면 신청을 처리할 사람이 없으므로 목록에서 빠지고 신청도 거절된다', async () => {
  const projectId = await listed('o-owner');
  // 참여 중단 보고 기능은 #15에서 제거된다. 그 전에 남은 중단 기록을 DB에 직접 만든다.
  await run("UPDATE project_members SET left_at=now(),left_note='이전 기록' WHERE project_id=? AND user_id=?", projectId, 'o-owner');
  assert.ok(!(await teams('o-viewer')).teams.some((t) => t.projectId === projectId));
  assert.equal((await ask('o-viewer', projectId)).status, 410);
});

test('한 팀의 대기 신청은 20건까지다', async () => {
  const projectId = await listed('m-owner');
  for (let i = 0; i < 20; i++) await json(await ask('m-user' + i, projectId), 201);
  assert.equal((await teams('m-late')).teams.find((t) => t.projectId === projectId).joinable, false);
  assert.equal((await ask('m-late', projectId)).status, 429);
  assert.equal((await state('m-owner', projectId)).joinRequests.length, 20);
});

test('신청 뒤 팀이 비공개로 바뀌어도 신청자는 내 신청에서 취소해 한도를 되찾는다', async () => {
  const projectId = await listed('h-owner');
  const r = await json(await ask('h-mate', projectId), 201);
  const s = await state('h-owner', projectId);
  await json(await projects('h-owner', { action: 'setListed', projectId, revision: s.sprint.revision, listed: false }), 200);
  const mine = await teams('h-mate');
  assert.ok(!mine.teams.some((t) => t.projectId === projectId));
  assert.equal(mine.requests.find((x) => x.requestId === r.requestId).status, 'pending');
  await json(await teamsPost('h-mate', { action: 'cancel', requestId: r.requestId }), 200);
  assert.equal((await teams('h-mate')).requests.find((x) => x.requestId === r.requestId).status, 'cancelled');
});
