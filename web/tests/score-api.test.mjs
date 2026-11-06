// 동료평가 점수 API: 평가 기간, 1회 제출, 익명성, 계정 분리, 뱃지, 저장 시점 검사.
import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
// 테스트는 과거로 옮긴 프로젝트를 쓰므로 제재 시작 시각을 아주 이르게 둔다.
process.env.SANCTION_FROM = '2000-01-01T00:00:00Z';
import assert from 'node:assert/strict';
import { setupTestDb } from './helpers/pg-db.mjs';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { one, rows, run } = await setupTestDb();
const outfile = join(mkdtempSync(join(tmpdir(), 'projectmate-score-test-')), 'route.mjs');
await build({
  stdin: {
    contents:
      "export { GET as sprintGET, POST as sprintPOST } from './app/api/sprint/route'; export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route'; export { GET as scoreGET, POST as scorePOST } from './app/api/score/route'; export { GET as meGET } from './app/api/score/me/route'; export { POST as teamsPOST } from './app/api/teams/route';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
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

const DAY = 86400000;
const H = 3600000;
const headers = (user) => ({
  'oai-authenticated-user-id': user,
  'oai-authenticated-user-email': user + '@test.local',
  'oai-authenticated-user-full-name': user,
  'content-type': 'application/json',
  origin: 'https://test.local',
});
const projectPost = (user, body) =>
  api.projectsPOST(
    new Request('https://test.local/api/projects', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    }),
  );
async function state(user, projectId) {
  const r = await api.sprintGET(
    new Request('https://test.local/api/sprint?project=' + projectId, { headers: headers(user) }),
  );
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function act(user, projectId, action, fields = {}) {
  const s = await state(user, projectId);
  const r = await api.sprintPOST(
    new Request('https://test.local/api/sprint', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify({ action, revision: s.sprint.revision, projectId, ...fields }),
    }),
  );
  assert.equal(r.status, 200, action + ' ' + (await r.clone().text()));
  return r.json();
}
const scoreGet = (user, projectId) =>
  api.scoreGET(
    new Request(
      'https://test.local/api/score' + (projectId ? '?project=' + projectId : ''),
      { headers: user ? headers(user) : {} },
    ),
  );
async function score(user, projectId) {
  const r = await scoreGet(user, projectId);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const review = (user, projectId, reviews) =>
  api.scorePOST(
    new Request('https://test.local/api/score', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify({ action: 'review', projectId, reviews }),
    }),
  );
async function me(user) {
  const r = await api.meGET(new Request('https://test.local/api/score/me', { headers: headers(user) }));
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const goal = {
  action: 'create',
  title: '점수 스프린트',
  goal: '동료평가 점수를 확인한다',
  scope: '평가 흐름',
  completionCriteria: '평가를 제출해 점수를 본다',
  duration: 7,
  agreed: true,
};
/** 팀장 + 팀원들을 초대·수락시킨 뒤 시작한다. */
async function startedTeam(lead, mates) {
  const created = await projectPost(lead, goal);
  assert.equal(created.status, 201, await created.clone().text());
  const { projectId } = await created.json();
  for (const mate of mates) {
    const s = await state(lead, projectId);
    const invite = await projectPost(lead, {
      action: 'invite',
      projectId,
      revision: s.sprint.revision,
      email: mate + '@test.local',
    });
    assert.equal(invite.status, 201, await invite.clone().text());
    const { token } = await invite.json();
    const accepted = await projectPost(mate, {
      action: 'accept',
      token,
      agreed: true,
      goalVersion: s.policy.goalVersion,
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());
  }
  await act(lead, projectId, 'start');
  return projectId;
}
async function finish(lead, projectId) {
  await act(lead, projectId, 'deliverableEvidence', {
    deliverableId: 'd_criteria',
    evidence: '저장소와 실행 영상으로 완료 기준을 보였습니다.',
  });
  await act(lead, projectId, 'deliverableConfirm', { deliverableId: 'd_criteria', confirmed: true });
  await act(lead, projectId, 'finish');
}
/** 프로젝트의 모든 시각을 과거로 옮겨 시간 경과를 흉내 낸다. */
async function shift(projectId, ms) {
  const iv = `${Math.round(ms / 1000)} seconds`;
  await run(
    `UPDATE project_policy SET started_at=started_at-?::interval,deadline_at=deadline_at-?::interval,completed_at=completed_at-?::interval WHERE project_id=?`,
    iv,
    iv,
    iv,
    projectId,
  );
  await run(`UPDATE sprint_checkins SET created_at=created_at-?::interval WHERE owner=?`, iv, projectId);
  await run(
    `UPDATE peer_review_submissions SET created_at=created_at-?::interval WHERE project_id=?`,
    iv,
    projectId,
  );
}
const earned = (s) => s.badges.filter((b) => b.earnedAt).map((b) => b.id);
const rating = (person, c, m, k) => ({ person, contribution: c, communication: m, commitment: k });

test('완주한 팀: 기간 중 1회 제출, 익명 평균은 공개 뒤에만, 전원 제출 시 바로 공개, 참여 중단자는 제외', async () => {
  const projectId = await startedTeam('lead', ['m1', 'm2', 'm3']);
  // 진행 중에는 평가가 열리지 않는다.
  let s = await score('lead', projectId);
  assert.equal(s.review.status, 'not_open');
  assert.equal(s.score, null);
  assert.deepEqual(s.review.targets, []);
  assert.equal((await review('lead', projectId, [rating(1, 5, 5, 5)])).status, 400);
  // 참여 중단 기능은 제거됐지만(2026-10-15) 이전에 저장된 중단 기록은 존중한다.
  await run(
    "UPDATE project_members SET left_at=now(),left_note='이전 기록' WHERE project_id=? AND user_id='m3'",
    projectId,
  );
  await finish('lead', projectId);

  s = await score('lead', projectId);
  assert.equal(s.review.status, 'open');
  assert.equal(s.review.submitted, false);
  assert.equal(s.review.reviewers, null);
  assert.equal(s.review.minReviewers, 2);
  // 대상은 참여 중인 다른 팀원. 계정 ID는 내보내지 않는다.
  assert.deepEqual(s.review.targets, [
    { person: 1, displayName: 'm1' },
    { person: 2, displayName: 'm2' },
  ]);
  assert.doesNotMatch(JSON.stringify(s), /"userId"|m1@|m2@/);
  assert.deepEqual(earned(s), ['finish', 'zero_bottleneck']);

  // 대상 누락·범위 밖·중단자 대상은 거절, 아무것도 쓰지 않는다.
  for (const bad of [
    [rating(1, 5, 5, 5)],
    [rating(1, 5, 5, 5), rating(3, 5, 5, 5)],
    [rating(1, 5, 5, 5), rating(2, 6, 5, 5)],
    [rating(0, 5, 5, 5), rating(1, 5, 5, 5)],
  ])
    assert.equal((await review('lead', projectId, bad)).status, 400);
  assert.equal((await one('SELECT count(*)::int AS n FROM peer_reviews')).n, 0);
  // 참여 중단자는 평가할 수 없고 팀 뱃지도 없다.
  assert.equal((await review('m3', projectId, [rating(0, 5, 5, 5)])).status, 400);
  assert.deepEqual(earned(await score('m3', projectId)), []);

  const ok = await review('lead', projectId, [rating(1, 5, 5, 5), rating(2, 3, 3, 3)]);
  assert.equal(ok.status, 200, await ok.clone().text());
  s = await ok.json();
  assert.equal(s.review.submitted, true);
  assert.deepEqual(s.review.targets, []);
  assert.ok(earned(s).includes('reviewer'));
  // 다시 보내도 바꿀 수 없다.
  assert.equal(
    (await review('lead', projectId, [rating(1, 1, 1, 1), rating(2, 1, 1, 1)])).status,
    409,
  );
  assert.equal(
    (await review('m1', projectId, [rating(0, 5, 4, 5), rating(2, 4, 4, 4)])).status,
    200,
  );
  // 아직 m2가 내지 않았으면 점수·인원 수를 숨긴다.
  s = await score('lead', projectId);
  assert.equal(s.review.status, 'open');
  assert.equal(s.score, null);
  assert.equal(s.grade, null);
  assert.equal(s.review.reviewers, null);
  assert.equal(
    (await review('m2', projectId, [rating(0, 4, 5, 4), rating(1, 5, 4, 5)])).status,
    200,
  );

  // 참여 중인 전원이 냈으므로 24시간을 기다리지 않고 공개한다.
  s = await score('lead', projectId);
  assert.equal(s.review.status, 'closed');
  assert.equal(s.review.hidden, false);
  assert.equal(s.score, 4.5);
  assert.equal(s.grade, 'A');
  assert.equal(s.review.reviewers, 2);
  assert.deepEqual(
    s.breakdown.map((b) => [b.key, b.average]),
    [
      ['contribution', 4.5],
      ['communication', 4.5],
      ['commitment', 4.5],
    ],
  );
  assert.deepEqual(earned(s), [
    'finish',
    'zero_bottleneck',
    'top_contributor',
    'top_communicator',
    'promise_keeper',
    'reviewer',
  ]);
  // 개별 평가는 응답에 없다.
  assert.doesNotMatch(JSON.stringify(s), /"contribution":\s*[1-5][,}]/);
  const m1 = await score('m1', projectId);
  assert.equal(m1.score, 4.8);
  assert.equal(m1.grade, 'S');
  const m2 = await score('m2', projectId);
  assert.equal(m2.score, 3.5);
  assert.equal(m2.grade, 'B');
  assert.ok(!earned(m2).includes('top_contributor'));
  // 같은 기록이면 다시 조회해도 같은 점수.
  const { asOf: _a, ...again } = await score('m2', projectId);
  const { asOf: _b, ...first } = m2;
  assert.deepEqual(again, first);
  // 참여 중단자는 평가받지 않아 점수가 없다.
  assert.equal((await score('m3', projectId)).score, null);

  const summary = await me('lead');
  assert.equal(summary.totalScore, 4.5);
  assert.equal(summary.bestGrade, 'A');
  assert.equal(summary.projects, 1);
  assert.equal(summary.badges.find((b) => b.id === 'finish').count, 1);
});

test('계정 분리: 비멤버·비로그인·프로젝트 미지정', async () => {
  const projectId = await startedTeam('sep', ['sepmate']);
  assert.equal((await scoreGet('stranger', projectId)).status, 403);
  assert.equal((await review('stranger', projectId, [rating(0, 5, 5, 5)])).status, 403);
  assert.equal((await scoreGet(null, projectId)).status, 401);
  assert.equal((await scoreGet('sep', '')).status, 400);
  const bad = await api.scorePOST(
    new Request('https://test.local/api/score', {
      method: 'POST',
      headers: { ...headers('sep'), origin: 'https://evil.local' },
      body: JSON.stringify({ action: 'review', projectId, reviews: [] }),
    }),
  );
  assert.equal(bad.status, 403);
  // 다른 사람의 프로젝트는 내 요약에 섞이지 않는다.
  const stranger = await me('stranger');
  assert.equal(stranger.totalScore, 0);
  assert.equal(stranger.projects, 0);
  assert.ok(stranger.badges.every((b) => b.count === 0));
});

test('2인 팀: 서로 평가는 남지만 1명 평가라 점수는 나오지 않는다, 동시 제출은 한 번만', async () => {
  const projectId = await startedTeam('pair', ['pairmate']);
  await finish('pair', projectId);
  const [a, b] = await Promise.all([
    review('pair', projectId, [rating(1, 5, 5, 5)]),
    review('pair', projectId, [rating(1, 1, 1, 1)]),
  ]);
  assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409]);
  assert.equal(
    (await one('SELECT count(*)::int AS n FROM peer_reviews WHERE project_id=?', projectId)).n,
    1,
  );
  assert.equal((await review('pairmate', projectId, [rating(0, 5, 5, 5)])).status, 200);
  await shift(projectId, 25 * H);
  const s = await score('pairmate', projectId);
  assert.equal(s.review.reviewers, 1);
  assert.equal(s.score, null);
  assert.equal(s.grade, null);
  assert.ok(!earned(s).includes('top_contributor'));
});

test('저장 시점에 평가 기간이 끝났으면 DB 시각 검사로 거절하고 아무것도 쓰지 않는다', async () => {
  const projectId = await startedTeam('late', ['latemate']);
  await finish('late', projectId);
  globalThis.__BEFORE_WRITE_SQL = 'INSERT INTO peer_review_submissions';
  globalThis.__BEFORE_WRITE = () => shift(projectId, 8 * DAY);
  const r = await review('late', projectId, [rating(1, 5, 5, 5)]);
  assert.equal(r.status, 409);
  assert.deepEqual(
    await rows('SELECT * FROM peer_review_submissions WHERE project_id=?', projectId),
    [],
  );
  assert.deepEqual(await rows('SELECT * FROM peer_reviews WHERE project_id=?', projectId), []);
});

test('기한 종료 팀: 매일 보고는 일차당 1회, 완주 뱃지 없음, 평가는 열린다', async () => {
  const projectId = await startedTeam('daily', ['dailymate']);
  await act('daily', projectId, 'createTask', { title: '핵심 흐름', person: 0, remaining: 4, dependsOn: [] });
  // 보고를 여러 번 해도 같은 일차면 한 번으로 센다.
  for (let i = 0; i < 5; i++)
    await act('daily', projectId, 'checkin', { taskId: 1, note: '진행 ' + i, remaining: 3 });
  await shift(projectId, 7 * DAY + 3600000);
  let s = await score('daily', projectId);
  assert.equal(s.review.status, 'open');
  assert.deepEqual(earned(s), []);
  // 2~7일차 보고를 채우면 매일 보고 뱃지.
  const policy = await one('SELECT started_at FROM project_policy WHERE project_id=?', projectId);
  for (let day = 1; day < 7; day++)
    await run(
      'INSERT INTO sprint_checkins(id,owner,task_id,note,remaining,created_at) VALUES(?,?,1,?,3,?)',
      crypto.randomUUID(),
      projectId,
      day + '일차 보고',
      new Date(policy.started_at.getTime() + day * DAY + 60000).toISOString(),
    );
  s = await score('daily', projectId);
  assert.deepEqual(earned(s), ['daily_report']);
  assert.deepEqual(earned(await score('dailymate', projectId)), ['daily_report']);
});

test('솔로 완주: 솔로 뱃지, 평가할 팀원이 없다', async () => {
  const projectId = await startedTeam('alone', []);
  await finish('alone', projectId);
  const s = await score('alone', projectId);
  assert.deepEqual(earned(s), ['finish', 'solo_finish', 'zero_bottleneck']);
  assert.deepEqual(s.review.targets, []);
  const r = await review('alone', projectId, []);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /평가할 팀원/);
});

test('병목이 남은 채 완주하면 병목 0 뱃지가 없다', async () => {
  const projectId = await startedTeam('neck', []);
  // 남은 예산(7일 × 8h = 56h)을 넘는 업무.
  await act('neck', projectId, 'createTask', { title: '너무 큰 업무', person: 0, remaining: 100, dependsOn: [] });
  await finish('neck', projectId);
  assert.deepEqual(earned(await score('neck', projectId)), ['finish', 'solo_finish']);
});

// ── 미제출 제재 (2026-11-06) ──
const sprintRaw = async (user, projectId, action, fields = {}) => {
  const s = await state(user, projectId);
  return api.sprintPOST(
    new Request('https://test.local/api/sprint', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify({ action, revision: s.sprint.revision, projectId, ...fields }),
    }),
  );
};
const teamsPost = (user, body) =>
  api.teamsPOST(
    new Request('https://test.local/api/teams', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    }),
  );
async function projectsOf(user) {
  const r = await api.projectsGET(new Request('https://test.local/api/projects', { headers: headers(user) }));
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function draft(user) {
  const r = await projectPost(user, goal);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).projectId;
}
async function listed(user) {
  const projectId = await draft(user);
  const s = await state(user, projectId);
  const r = await projectPost(user, { action: 'setListed', projectId, revision: s.sprint.revision, listed: true });
  assert.equal(r.status, 200, await r.clone().text());
  return projectId;
}
/** 3인 팀이 완주하고 lead·a만 평가를 낸 뒤 25시간이 지난다. b는 미제출 1회. */
async function missedBy(lead, a, b) {
  const projectId = await startedTeam(lead, [a, b]);
  await finish(lead, projectId);
  assert.equal((await review(lead, projectId, [rating(1, 5, 5, 5), rating(2, 5, 5, 5)])).status, 200);
  assert.equal((await review(a, projectId, [rating(0, 5, 5, 5), rating(2, 5, 5, 5)])).status, 200);
  await shift(projectId, 25 * H);
  return projectId;
}

test('미제출 1회: 7일 동안 만들기·초대 수락·참여 신청·시작이 403, 진행 중 프로젝트 작업은 된다, 7일 뒤 풀린다', async () => {
  // 제재 전에 b가 만들어 둔 준비 프로젝트와 진행 중인 솔로 프로젝트.
  const own = await draft('x1b');
  const running = await startedTeam('x1b', []);
  const projectId = await missedBy('x1lead', 'x1a', 'x1b');

  const mine = await projectsOf('x1b');
  assert.equal(mine.restriction.misses, 1);
  assert.equal(mine.restriction.permanent, false);
  assert.ok(Date.parse(mine.restriction.until) > Date.now() + 6 * DAY);
  assert.deepEqual(mine.reviewPending, []);
  assert.equal((await projectsOf('x1a')).restriction, null);

  const created = await projectPost('x1b', goal);
  assert.equal(created.status, 403);
  assert.match((await created.json()).error, /까지 새 프로젝트를 만들 수 없습니다/);

  const host = await listed('x1host');
  const hs = await state('x1host', host);
  const invite = await projectPost('x1host', { action: 'invite', projectId: host, revision: hs.sprint.revision, email: 'x1b@test.local' });
  assert.equal(invite.status, 201, await invite.clone().text());
  const accepted = await projectPost('x1b', { action: 'accept', token: (await invite.json()).token, agreed: true, goalVersion: hs.policy.goalVersion });
  assert.equal(accepted.status, 403);
  assert.match((await accepted.json()).error, /초대를 수락할 수 없습니다/);

  const request = await teamsPost('x1b', { action: 'request', projectId: host, goalVersion: hs.policy.goalVersion, agreed: true });
  assert.equal(request.status, 403);
  assert.match((await request.json()).error, /참여 신청할 수 없습니다/);

  const start = await sprintRaw('x1b', own, 'start');
  assert.equal(start.status, 403);
  assert.match((await start.json()).error, /스프린트를 시작할 수 없습니다/);

  // 이미 진행 중인 프로젝트의 작업은 막지 않는다.
  assert.equal((await sprintRaw('x1b', running, 'createTask', { title: '계속', person: 0, remaining: 2, dependsOn: [] })).status, 200);

  // 마감에서 7일이 지나면 풀린다.
  await shift(projectId, 7 * DAY);
  assert.equal((await projectsOf('x1b')).restriction, null);
  assert.equal((await projectPost('x1b', goal)).status, 201);
});

test('제재 중인 사람의 참여 신청은 승인할 수 없고, 팀장 화면에 restricted로 보인다', async () => {
  const host = await listed('x2host');
  const hs = await state('x2host', host);
  // 제재 전에 넣어 둔 신청.
  assert.equal((await teamsPost('x2b', { action: 'request', projectId: host, goalVersion: hs.policy.goalVersion, agreed: true })).status, 201);
  await missedBy('x2lead', 'x2a', 'x2b');
  const s = await state('x2host', host);
  assert.equal(s.joinRequests.length, 1);
  assert.equal(s.joinRequests[0].restricted, true);
  assert.equal(s.joinRequests[0].user_id, undefined);
  const approve = await projectPost('x2host', { action: 'decideJoin', projectId: host, revision: s.sprint.revision, requestId: s.joinRequests[0].id, approve: true });
  assert.equal(approve.status, 403);
  assert.match((await approve.json()).error, /지금 팀에 참여할 수 없습니다/);
  const reject = await projectPost('x2host', { action: 'decideJoin', projectId: host, revision: s.sprint.revision, requestId: s.joinRequests[0].id, approve: false });
  assert.equal(reject.status, 200, await reject.clone().text());
});

test('솔로·2인 팀 미제출과 제출자', async () => {
  const solo = await startedTeam('x3solo', []);
  await finish('x3solo', solo);
  await shift(solo, 25 * H);
  assert.equal((await projectsOf('x3solo')).restriction, null);

  const pair = await startedTeam('x3pair', ['x3mate']);
  await finish('x3pair', pair);
  assert.equal((await review('x3pair', pair, [rating(1, 5, 5, 5)])).status, 200);
  await shift(pair, 25 * H);
  assert.equal((await projectsOf('x3mate')).restriction.misses, 1);
  assert.equal((await projectsOf('x3pair')).restriction, null);
});

test('평가 기간 중이면 reviewPending에 그 프로젝트가 있다', async () => {
  const projectId = await startedTeam('x4lead', ['x4mate']);
  assert.deepEqual((await projectsOf('x4mate')).reviewPending, []);
  await finish('x4lead', projectId);
  assert.deepEqual((await projectsOf('x4mate')).reviewPending, [projectId]);
  assert.equal((await review('x4mate', projectId, [rating(0, 5, 5, 5)])).status, 200);
  assert.deepEqual((await projectsOf('x4mate')).reviewPending, []);
});

// ── 24시간 기간·조기 공개·결과 숨김 (2026-11-06) ──
test('24시간이 지나면 제출을 거절한다', async () => {
  const projectId = await startedTeam('y1lead', ['y1mate']);
  await finish('y1lead', projectId);
  await shift(projectId, 25 * H);
  const r = await review('y1lead', projectId, [rating(1, 5, 5, 5)]);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /기간이 끝났습니다/);
});

test('전원이 제출하면 24시간 전에도 점수가 열린다', async () => {
  const projectId = await startedTeam('y2lead', ['y2a', 'y2b']);
  await finish('y2lead', projectId);
  await review('y2lead', projectId, [rating(1, 4, 4, 4), rating(2, 4, 4, 4)]);
  await review('y2a', projectId, [rating(0, 5, 5, 5), rating(2, 3, 3, 3)]);
  assert.equal((await score('y2lead', projectId)).review.status, 'open');
  await review('y2b', projectId, [rating(0, 4, 4, 4), rating(1, 2, 2, 2)]);
  const s = await score('y2lead', projectId);
  assert.equal(s.review.status, 'closed');
  assert.equal(s.score, 4.5);
  assert.equal(s.review.reviewers, 2);
});

test('별 반 개(0.5점) 평가가 저장되고 점수에 그대로 반영된다', async () => {
  const projectId = await startedTeam('h1lead', ['h1a', 'h1b']);
  await finish('h1lead', projectId);
  assert.equal((await review('h1lead', projectId, [rating(1, 3.5, 4.5, 2.5), rating(2, 4, 4, 4)])).status, 200);
  await review('h1a', projectId, [rating(0, 4, 4, 4), rating(2, 4, 4, 4)]);
  await review('h1b', projectId, [rating(0, 4, 4, 4), rating(1, 0.5, 5, 4)]);
  const s = await score('h1a', projectId);
  assert.equal(s.review.status, 'closed');
  assert.deepEqual(
    s.breakdown.map((b) => b.average),
    [2, 4.8, 3.3],
  );
  assert.equal(s.score, 3.3);
});

test('내지 않은 사람은 결과가 가려지고 팀 뱃지는 보인다', async () => {
  const projectId = await startedTeam('y3lead', ['y3a', 'y3b', 'y3c']);
  await finish('y3lead', projectId);
  const all = (me) => [0, 1, 2, 3].filter((p) => p !== me).map((p) => rating(p, 5, 5, 5));
  for (const [user, person] of [['y3lead', 0], ['y3a', 1], ['y3b', 2]])
    assert.equal((await review(user, projectId, all(person))).status, 200);
  await shift(projectId, 25 * H);
  const lazy = await score('y3c', projectId);
  assert.equal(lazy.review.status, 'closed');
  assert.equal(lazy.review.hidden, true);
  assert.equal(lazy.score, null);
  assert.equal(lazy.grade, null);
  assert.equal(lazy.review.reviewers, null);
  assert.ok(earned(lazy).includes('finish'));
  assert.ok(!earned(lazy).includes('top_contributor'));
  const done = await score('y3a', projectId);
  assert.equal(done.review.hidden, false);
  assert.equal(done.score, 5);
  // 가려진 프로젝트는 내 기록에서도 세지 않는다.
  const summary = await me('y3c');
  assert.equal(summary.projects, 0);
  assert.equal(summary.bestGrade, 'E');
});

test('참여 중단자는 전원 제출 판정에서 빠진다', async () => {
  const projectId = await startedTeam('y4lead', ['y4a', 'y4b', 'y4gone']);
  await run("UPDATE project_members SET left_at=now() WHERE project_id=? AND user_id='y4gone'", projectId);
  await finish('y4lead', projectId);
  const all = (me) => [0, 1, 2].filter((p) => p !== me).map((p) => rating(p, 4, 4, 4));
  for (const [user, person] of [['y4lead', 0], ['y4a', 1], ['y4b', 2]])
    assert.equal((await review(user, projectId, all(person))).status, 200);
  assert.equal((await score('y4lead', projectId)).review.status, 'closed');
});

test('평가 폼에 다음 제재 일수를 준다', async () => {
  const projectId = await startedTeam('y5lead', ['y5mate']);
  await finish('y5lead', projectId);
  assert.equal((await score('y5mate', projectId)).review.penaltyDays, 7);
  await review('y5mate', projectId, [rating(0, 5, 5, 5)]);
  assert.equal((await score('y5mate', projectId)).review.penaltyDays, null);
});
