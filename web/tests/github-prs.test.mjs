// PR과 업무 연결(2026-11-14): 가짜 GitHub fetch로 번호 매칭·상태·제안 규칙·API 권한을 검사한다.
// 실제 GitHub는 부르지 않는다.
import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupTestDb } from './helpers/pg-db.mjs';
const { run } = await setupTestDb();
const outfile = join(mkdtempSync(join(tmpdir(), 'projectmate-prs-test-')), 'route.mjs');
await build({
  stdin: {
    contents: [
      "export { taskRef, branchName, taskIdsIn, toPull, prSuggestion, summarizeChecks, summarizeReviews, stalledHours } from './lib/github-prs';",
      "export { readSprint, bumpTaskVersion } from './lib/sprint-store';",
      "export { setProjectRepo } from './lib/project-repo';",
      "export { POST as projectsPOST } from './app/api/projects/route';",
      "export { GET as prsGET } from './app/api/github-prs/route';",
      "export { useGithub } from './lib/ai-review-runtime';",
    ].join(' '),
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
        b.onResolve({ filter: /^\.\/db$/ }, () => ({ path: 'd1', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export function database(){return globalThis.__TEST_DB}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);

// ---- 순수 규칙 ----
test('업무 번호는 PM-번호, 브랜치 이름은 pm-번호-영문 슬러그', () => {
  assert.equal(api.taskRef(12), 'PM-12');
  assert.equal(api.branchName(12, 'Login 화면 만들기!'), 'pm-12-login');
  assert.equal(api.branchName(3, '검색 결과 정렬'), 'pm-3');
  assert.equal(api.branchName(7, 'Fix  the API   bug'), 'pm-7-fix-the-api-bug');
});

test('PR 제목·브랜치에서 PM-번호를 대소문자 없이 찾고, 다른 글자에 붙은 것은 무시한다', () => {
  assert.deepEqual(api.taskIdsIn('feat: PM-12 로그인 (pm-3)', 'pm-12-login'), [12, 3]);
  assert.deepEqual(api.taskIdsIn('apm-12 테스트', 'feature/xpm-5'), []);
  assert.deepEqual(api.taskIdsIn('PM-123', ''), [123]);
  assert.deepEqual(api.taskIdsIn('정리', 'PM-4_cleanup'), [4]);
  // 번호 바로 뒤에 영문자가 붙으면 다른 낱말이다.
  assert.deepEqual(api.taskIdsIn('PM-12abc', 'feature/pm-34fix'), []);
});

const pr = (number, over = {}) => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  merged_at: null,
  html_url: `https://github.com/team/app/pull/${number}`,
  user: { login: 'alice' },
  head: { ref: `pm-1-work` },
  ...over,
});

test('PR 상태는 열림·머지됨·닫힘으로 나눈다', () => {
  assert.equal(api.toPull(pr(1)).state, 'open');
  assert.equal(api.toPull(pr(2, { state: 'closed', merged_at: '2026-11-14T00:00:00Z' })).state, 'merged');
  assert.equal(api.toPull(pr(3, { state: 'closed' })).state, 'closed');
  assert.equal(api.toPull({ title: '번호 없음' }), null);
});

test('제안: 시작 전 업무에 열린 PR이면 진행 중, 열린 PR 없이 머지된 PR이 있으면 완료', () => {
  const p = (state) => ({ number: 1, title: 't', state, branch: 'b', author: 'a', url: 'u' });
  const todo = { done: false, status: 'todo' };
  const doing = { done: false, status: 'in_progress' };
  assert.equal(api.prSuggestion(todo, [p('open')]), 'start');
  assert.equal(api.prSuggestion(doing, [p('open')]), null);
  assert.equal(api.prSuggestion(doing, [p('merged')]), 'complete');
  assert.equal(api.prSuggestion(todo, [p('merged'), p('closed')]), 'complete');
  // 모든 PR이 머지돼야 완료를 제안한다.
  assert.equal(api.prSuggestion(doing, [p('merged'), p('open')]), null);
  assert.equal(api.prSuggestion(doing, [p('closed')]), null);
  assert.equal(api.prSuggestion({ done: true, status: 'done' }, [p('merged')]), null);
  assert.equal(api.prSuggestion(doing, []), null);
});

// ---- 2026-11-14 개발 현황: CI·리뷰·멈춘 업무 ----
test('PR에 마지막 커밋 sha와 수정 시각을 담는다(sha 형식이 아니면 비운다)', () => {
  const p = api.toPull(pr(4, { head: { ref: 'pm-1-x', sha: 'a'.repeat(40) }, updated_at: '2026-11-14T02:00:00Z' }));
  assert.equal(p.sha, 'a'.repeat(40));
  assert.equal(p.updatedAt, '2026-11-14T02:00:00Z');
  assert.equal(api.toPull(pr(5, { head: { ref: 'x', sha: '../etc' } })).sha, '');
});

test('CI 요약: 실패가 하나라도 있으면 실패, 끝나지 않은 게 있으면 진행 중, 아무것도 없으면 CI 없음', () => {
  const run = (status, conclusion) => ({ status, conclusion });
  const none = { state: 'pending', total_count: 0 };
  assert.equal(api.summarizeChecks([], none), 'none');
  assert.equal(api.summarizeChecks([run('completed', 'success'), run('completed', 'skipped')], none), 'success');
  assert.equal(api.summarizeChecks([run('completed', 'success'), run('completed', 'failure')], none), 'failure');
  assert.equal(api.summarizeChecks([run('completed', 'timed_out')], none), 'failure');
  assert.equal(api.summarizeChecks([run('in_progress', null)], none), 'pending');
  assert.equal(api.summarizeChecks([run('in_progress', null), run('completed', 'failure')], none), 'failure');
  // 커밋 상태(Vercel 등)도 본다.
  assert.equal(api.summarizeChecks([], { state: 'success', total_count: 1 }), 'success');
  assert.equal(api.summarizeChecks([run('completed', 'success')], { state: 'error', total_count: 1 }), 'failure');
  assert.equal(api.summarizeChecks([run('completed', 'success')], { state: 'pending', total_count: 1 }), 'pending');
});

test('리뷰 요약: 사람마다 마지막 판단만 보고, 수정 요청이 남아 있으면 수정 요청', () => {
  const r = (login, state) => ({ user: { login }, state });
  assert.equal(api.summarizeReviews([]), 'none');
  assert.equal(api.summarizeReviews([r('a', 'COMMENTED')]), 'none');
  assert.equal(api.summarizeReviews([r('a', 'CHANGES_REQUESTED'), r('a', 'APPROVED')]), 'approved');
  assert.equal(api.summarizeReviews([r('a', 'APPROVED'), r('b', 'CHANGES_REQUESTED')]), 'changes_requested');
  // 의견만 남긴 리뷰는 앞선 판단을 지우지 않는다.
  assert.equal(api.summarizeReviews([r('a', 'APPROVED'), r('a', 'COMMENTED')]), 'approved');
});

test('제안: 머지된 PR의 CI가 실패했으면 완료 대신 확인 필요', () => {
  const p = (number, state) => ({ number, title: 't', state, branch: 'b', author: 'a', url: 'u', sha: '', updatedAt: '' });
  const doing = { done: false, status: 'in_progress' };
  assert.equal(api.prSuggestion(doing, [p(1, 'merged')], { 1: 'failure' }), 'ci_failed');
  assert.equal(api.prSuggestion(doing, [p(1, 'merged')], { 1: 'success' }), 'complete');
  assert.equal(api.prSuggestion(doing, [p(1, 'merged')], { 1: 'pending' }), 'complete');
  assert.equal(api.prSuggestion(doing, [p(1, 'merged'), p(2, 'closed')], { 2: 'failure' }), 'complete');
});

test('멈춘 업무: 진행 중인데 업무 변경과 연결 PR 수정이 12시간 넘게 없으면 몇 시간째인지 돌려준다', () => {
  const t = { done: false, status: 'in_progress', touchedAt: '2026-11-14T00:00:00.000Z' };
  const pulls = [{ updatedAt: '2026-11-14T03:00:00Z' }];
  assert.equal(api.stalledHours(t, pulls, '2026-11-14T15:00:00Z'), 12);
  assert.equal(api.stalledHours(t, pulls, '2026-11-14T14:59:00Z'), null);
  assert.equal(api.stalledHours(t, [], '2026-11-15T00:00:00Z'), 24);
  assert.equal(api.stalledHours({ ...t, status: 'todo' }, [], '2026-11-16T00:00:00Z'), null);
  assert.equal(api.stalledHours({ ...t, done: true }, [], '2026-11-16T00:00:00Z'), null);
  // 마지막 활동 시각을 모르면 표시하지 않는다.
  assert.equal(api.stalledHours({ ...t, touchedAt: null }, [], '2026-11-16T00:00:00Z'), null);
});

// ---- /api/github-prs ----
function headers(user) {
  return {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@test.local',
    'content-type': 'application/json',
    origin: 'https://test.local',
  };
}
async function json(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
async function project(owner) {
  const r = await api.projectsPOST(
    new Request('https://test.local/api/projects', {
      method: 'POST',
      headers: headers(owner),
      body: JSON.stringify({
        action: 'create',
        title: 'PR 스프린트',
        goal: '앱 출시',
        scope: '목록',
        completionCriteria: '시연',
        duration: 7,
        agreed: true,
      }),
    }),
  );
  const { projectId } = await json(r, 201);
  for (const [id, title] of [[1, '로그인'], [2, '검색']])
    await run('INSERT INTO sprint_tasks(owner,id,title,person,remaining) VALUES(?,?,?,0,2)', projectId, id, title);
  return projectId;
}
function fakeGithub(pulls, { pageSize = 25, huge = false } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = new URL(String(url));
      if (u.pathname === '/repos/team/app') return Response.json({ private: false, visibility: 'public' });
      if (u.pathname === '/repos/team/app/pulls') {
        if (huge) return new Response('[' + '"x",'.repeat(300_000) + '"x"]', { status: 200 });
        const page = Number(u.searchParams.get('page') ?? 1);
        return Response.json(pulls.slice((page - 1) * pageSize, page * pageSize));
      }
      return new Response('{}', { status: 404 });
    },
  };
}
const get = (user, projectId) =>
  api.prsGET(new Request(`https://test.local/api/github-prs?project=${encodeURIComponent(projectId)}`, { headers: headers(user) }));

test('저장소가 없으면 GitHub를 부르지 않고 빈 연결을 돌려준다', async () => {
  const projectId = await project('p-none');
  const gh = fakeGithub([]);
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const body = await json(await get('p-none', projectId), 200);
  assert.equal(body.repo, null);
  assert.deepEqual(body.links, {});
  assert.equal(gh.calls.length, 0);
});

test('팀원은 업무별 연결 PR을 보고, 없는 업무 번호는 버린다. 팀원이 아니면 거절', async () => {
  const projectId = await project('p-owner');
  await run(
    "INSERT INTO project_members(project_id,user_id,display_name,role,person,joined_at,agreed_at,agreed_goal_version) VALUES(?,?,?,'member',1,now(),now(),1)",
    projectId,
    'p-mate',
    '팀원',
  );
  await api.setProjectRepo(projectId, 'p-owner', { owner: 'team', name: 'app' }, 0, new Date());
  const gh = fakeGithub([
    pr(10, { title: 'PM-1 로그인 화면' }),
    pr(11, { title: '검색', head: { ref: 'pm-2-search' }, state: 'closed', merged_at: '2026-11-14T01:00:00Z' }),
    pr(12, { title: 'PM-99 없는 업무', head: { ref: 'main' } }),
  ]);
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const body = await json(await get('p-mate', projectId), 200);
  assert.equal(body.repo.url, 'https://github.com/team/app');
  assert.deepEqual(Object.keys(body.links).sort(), ['1', '2']);
  assert.deepEqual(body.links['1'].map((p) => [p.number, p.state]), [[10, 'open']]);
  assert.deepEqual(body.links['2'].map((p) => [p.number, p.state]), [[11, 'merged']]);
  assert.ok(gh.calls.some((u) => u.includes('/pulls?') && u.includes('state=all')));
  await json(await get('stranger', projectId), 403);
});

test('PR 목록은 나눠 받아 뒤쪽 페이지의 PR도 연결하고, 응답이 너무 크면 빈 목록이 아니라 오류로 알린다', async () => {
  const projectId = await project('p-page');
  await api.setProjectRepo(projectId, 'p-page', { owner: 'team', name: 'app' }, 0, new Date());
  const many = Array.from({ length: 30 }, (_, i) => pr(100 + i, { title: '기타', head: { ref: 'main' } }));
  many.push(pr(200, { title: 'PM-2 검색' }));
  let gh = fakeGithub(many);
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const body = await json(await get('p-page', projectId), 200);
  assert.deepEqual(body.links['2'].map((p) => p.number), [200]);
  assert.ok(gh.calls.some((u) => u.includes('page=2')));
  gh = fakeGithub([], { huge: true });
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const failed = await json(await get('p-page', projectId), 502);
  assert.match(failed.error, /PR 목록/);
});

test('업무를 바꾸면(체크인·상태 변경) 마지막 변경 시각이 갱신되고, 새 업무는 만든 시각을 갖는다', async () => {
  const projectId = await project('p-touch');
  const before = await api.readSprint(projectId);
  assert.ok(before.tasks[0].touchedAt instanceof Date);
  await run("UPDATE sprint_tasks SET touched_at='2026-01-01T00:00:00Z' WHERE owner=?", projectId);
  await run("UPDATE sprints SET mutation='m-touch' WHERE owner=?", projectId);
  await globalThis.__TEST_DB.batch([api.bumpTaskVersion(projectId, 'm-touch', 1)]);
  const after = await api.readSprint(projectId);
  assert.ok(after.tasks.find((t) => t.id === 1).touchedAt.getTime() > Date.parse('2026-06-01'));
  assert.equal(after.tasks.find((t) => t.id === 2).touchedAt.toISOString(), '2026-01-01T00:00:00.000Z');
});

function detailGithub({ hugeChecks = false, many = false } = {}) {
  const calls = [];
  const sha = 'b'.repeat(40);
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = new URL(String(url));
      const path = u.pathname;
      if (path === '/repos/team/app') return Response.json({ private: false, visibility: 'public' });
      if (path === '/repos/team/app/pulls/10')
        return Response.json(pr(10, { title: 'PM-1 로그인', head: { ref: 'pm-1-login', sha }, updated_at: '2026-11-14T01:00:00Z' }));
      const page = Number(u.searchParams.get('page') ?? 1);
      if (many && path === `/repos/team/app/commits/${sha}/check-runs`)
        return Response.json({
          total_count: 101,
          check_runs: page === 1 ? Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' })) : [{ status: 'completed', conclusion: 'failure' }],
        });
      if (many && path === '/repos/team/app/pulls/10/reviews')
        return Response.json(
          page === 1 ? Array.from({ length: 100 }, () => ({ user: { login: 'bob' }, state: 'APPROVED' })) : [{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED' }],
        );
      if (path === `/repos/team/app/commits/${sha}/check-runs` && hugeChecks)
        return new Response('{"check_runs":[' + '"x",'.repeat(300_000) + '"x"]}', { status: 200 });
      if (path === `/repos/team/app/commits/${sha}/check-runs`)
        return Response.json({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] });
      if (path === `/repos/team/app/commits/${sha}/status`) return Response.json({ state: 'pending', total_count: 0 });
      if (path === '/repos/team/app/pulls/10/reviews') return Response.json([{ user: { login: 'bob' }, state: 'APPROVED' }]);
      if (path === '/repos/team/app/pulls/10/commits')
        return Response.json(
          Array.from({ length: 7 }, (_, i) => ({
            sha: String(i).repeat(40),
            author: { login: 'alice' },
            commit: { message: `커밋 ${i}\n\n본문`, author: { name: 'Alice', date: `2026-11-14T0${i}:00:00Z` } },
          })),
        );
      return new Response('{}', { status: 404 });
    },
  };
}
const detail = (user, projectId, pulls) =>
  api.prsGET(
    new Request(`https://test.local/api/github-prs?project=${encodeURIComponent(projectId)}&pulls=${pulls}`, { headers: headers(user) }),
  );

test('개발 현황: 고른 PR의 CI·리뷰·최근 커밋 5개를 돌려준다. 팀원만, PR은 3개까지', async () => {
  const projectId = await project('p-detail');
  await api.setProjectRepo(projectId, 'p-detail', { owner: 'team', name: 'app' }, 0, new Date());
  const gh = detailGithub();
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const body = await json(await detail('p-detail', projectId, '10'), 200);
  const d = body.details['10'];
  assert.equal(d.checks, 'failure');
  assert.equal(d.review, 'approved');
  assert.deepEqual(d.commits.map((c) => c.message), ['커밋 6', '커밋 5', '커밋 4', '커밋 3', '커밋 2']);
  assert.equal(d.commits[0].author, 'alice');
  assert.ok(!gh.calls.some((u) => u.includes('/pulls?')), 'PR 목록은 다시 받지 않는다');
  await json(await detail('stranger', projectId, '10'), 403);
  await json(await detail('p-detail', projectId, '1,2,3,4'), 400);
  await json(await detail('p-detail', projectId, 'abc'), 400);
});

test('개발 현황: CI 응답이 너무 커서 못 읽으면 통과로 보이지 않고 오류로 알린다', async () => {
  const projectId = await project('p-huge');
  await api.setProjectRepo(projectId, 'p-huge', { owner: 'team', name: 'app' }, 0, new Date());
  api.useGithub({ fetchImpl: detailGithub({ hugeChecks: true }).fetchImpl });
  const body = await json(await detail('p-huge', projectId, '10'), 502);
  assert.match(body.error, /CI/);
});

test('PR 목록 응답에 서버 시각을 담는다(멈춤 판정은 PR을 읽은 시각 기준)', async () => {
  const projectId = await project('p-clock');
  await api.setProjectRepo(projectId, 'p-clock', { owner: 'team', name: 'app' }, 0, new Date());
  api.useGithub({ fetchImpl: fakeGithub([]).fetchImpl });
  const body = await json(await get('p-clock', projectId), 200);
  assert.ok(!Number.isNaN(Date.parse(body.asOf)));
});

test('개발 현황: 체크·리뷰가 100개를 넘으면 다음 페이지까지 읽어 뒤쪽 실패·수정 요청을 놓치지 않는다', async () => {
  const projectId = await project('p-many');
  await api.setProjectRepo(projectId, 'p-many', { owner: 'team', name: 'app' }, 0, new Date());
  const gh = detailGithub({ many: true });
  api.useGithub({ fetchImpl: gh.fetchImpl });
  const body = await json(await detail('p-many', projectId, '10'), 200);
  assert.equal(body.details['10'].checks, 'failure');
  assert.equal(body.details['10'].review, 'changes_requested');
  assert.ok(gh.calls.some((u) => u.includes('check-runs') && u.includes('page=2')));
  assert.ok(gh.calls.some((u) => u.includes('/reviews') && u.includes('page=2')));
});
