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
      "export { taskRef, branchName, taskIdsIn, toPull, prSuggestion } from './lib/github-prs';",
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
function fakeGithub(pulls) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path === '/repos/team/app') return Response.json({ private: false, visibility: 'public' });
      if (path === '/repos/team/app/pulls') return Response.json(pulls);
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
