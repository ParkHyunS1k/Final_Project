// 동료평가 점수 API: 평가 기간, 1회 제출, 익명성, 계정 분리, 뱃지, 저장 시점 검사.
import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
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
      "export { GET as sprintGET, POST as sprintPOST } from './app/api/sprint/route'; export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route'; export { GET as scoreGET, POST as scorePOST } from './app/api/score/route'; export { GET as meGET } from './app/api/score/me/route';",
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

test('완주한 팀: 기간 중 1회 제출, 익명 평균은 마감 뒤에만, 참여 중단자는 제외', async () => {
  const projectId = await startedTeam('lead', ['m1', 'm2', 'm3']);
  // 진행 중에는 평가가 열리지 않는다.
  let s = await score('lead', projectId);
  assert.equal(s.review.status, 'not_open');
  assert.equal(s.score, null);
  assert.deepEqual(s.review.targets, []);
  assert.equal((await review('lead', projectId, [rating(1, 5, 5, 5)])).status, 400);
  await act('m3', projectId, 'stepBack', { note: '개인 사정으로 중단합니다.' });
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
  assert.equal(
    (await review('m2', projectId, [rating(0, 4, 5, 4), rating(1, 5, 4, 5)])).status,
    200,
  );
  // 기간 중에는 2명이 평가했어도 점수·인원 수를 숨긴다.
  s = await score('lead', projectId);
  assert.equal(s.score, null);
  assert.equal(s.grade, null);
  assert.equal(s.review.reviewers, null);

  await shift(projectId, 8 * DAY);
  s = await score('lead', projectId);
  assert.equal(s.review.status, 'closed');
  assert.equal(s.score, 90);
  assert.equal(s.grade, 'S');
  assert.equal(s.review.reviewers, 2);
  assert.deepEqual(
    s.breakdown.map((b) => [b.key, b.points]),
    [
      ['contribution', 30],
      ['communication', 30],
      ['commitment', 30],
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
  assert.equal(m1.score, 96.7);
  assert.equal(m1.grade, 'S');
  const m2 = await score('m2', projectId);
  assert.equal(m2.score, 70);
  assert.equal(m2.grade, 'B');
  assert.ok(!earned(m2).includes('top_contributor'));
  // 같은 기록이면 다시 조회해도 같은 점수.
  assert.deepEqual(await score('m2', projectId), m2);
  // 참여 중단자는 평가받지 않아 점수가 없다.
  assert.equal((await score('m3', projectId)).score, null);

  const summary = await me('lead');
  assert.equal(summary.totalScore, 90);
  assert.equal(summary.bestGrade, 'S');
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
  await shift(projectId, 8 * DAY);
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
