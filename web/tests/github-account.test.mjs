// GitHub 계정 연결(/api/github): Supabase 신원은 가짜 source로 넣는다. 실제 Supabase는 부르지 않는다.
import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupTestDb } from './helpers/pg-db.mjs';
const { one, rows, run } = await setupTestDb();
const outfile = join(mkdtempSync(join(tmpdir(), 'projectmate-github-test-')), 'route.mjs');
await build({
  stdin: {
    contents:
      "export { POST as githubPOST } from './app/api/github/route'; export { useGithubIdentitySource, githubFromSupabaseUser, readGithubAccount, githubIdentitySource } from './lib/github-account'; export { AuthUnavailable } from './lib/auth'; export { GET as sprintGET } from './app/api/sprint/route'; export { POST as projectsPOST } from './app/api/projects/route'; export { GET as teamsGET, POST as teamsPOST } from './app/api/teams/route';",
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
const defaultSource = api.githubIdentitySource;

// 사용자별 가짜 Supabase 신원. 값이 'down'이면 조회 실패.
const gh = new Map();
api.useGithubIdentitySource(async (r) => {
  const v = gh.get(r.headers.get('oai-authenticated-user-id'));
  if (v === 'down') throw new api.AuthUnavailable();
  return v ?? null;
});

function headers(user, extra = {}) {
  return {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@test.local',
    'content-type': 'application/json',
    origin: 'https://test.local',
    ...extra,
  };
}
const sync = (user, body = { action: 'sync' }, extra) =>
  api.githubPOST(
    new Request('https://test.local/api/github', { method: 'POST', headers: headers(user, extra), body: JSON.stringify(body) }),
  );
async function json(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
const events = (user) => rows('SELECT action FROM github_link_events WHERE user_id=? ORDER BY created_at,id', user);

test('연결 → sync → 재조회: Supabase 신원의 아이디가 저장되고 본문의 아이디는 무시한다', async () => {
  gh.set('alice', { githubId: '101', login: 'alice-gh' });
  const body = await json(await sync('alice', { action: 'sync', login: 'evil', githubId: '999' }), 200);
  assert.equal(body.github.login, 'alice-gh');
  assert.ok(body.github.linkedAt);
  const saved = await api.readGithubAccount('alice');
  assert.equal(saved.githubId, '101');
  assert.equal(saved.login, 'alice-gh');
  assert.deepEqual((await events('alice')).map((e) => e.action), ['link']);
  // 다시 sync해도 기록이 늘지 않는다.
  await json(await sync('alice'), 200);
  assert.equal((await events('alice')).length, 1);
});

test('Supabase에서 해제되면 sync가 행을 지우고 unlink를 남긴다', async () => {
  gh.set('carol', { githubId: '301', login: 'carol-gh' });
  await json(await sync('carol'), 200);
  gh.delete('carol');
  const body = await json(await sync('carol'), 200);
  assert.equal(body.github, null);
  assert.equal(await api.readGithubAccount('carol'), null);
  assert.deepEqual((await events('carol')).map((e) => e.action), ['link', 'unlink']);
});

test('다른 사용자의 옛 행과 같은 GitHub면 새 사용자에게 넘긴다', async () => {
  gh.set('dave', { githubId: '401', login: 'shared-gh' });
  await json(await sync('dave'), 200);
  // dave는 Supabase에서 해제하고 sync 없이 떠났다. erin이 같은 GitHub를 연결했다.
  gh.delete('dave');
  gh.set('erin', { githubId: '401', login: 'shared-gh' });
  const body = await json(await sync('erin'), 200);
  assert.equal(body.github.login, 'shared-gh');
  assert.equal(await api.readGithubAccount('dave'), null);
  assert.equal((await api.readGithubAccount('erin')).githubId, '401');
  assert.deepEqual((await events('dave')).map((e) => e.action), ['link', 'transfer_out']);
  assert.deepEqual((await events('erin')).map((e) => e.action), ['link']);
});

test('GitHub 신원이 없는 사용자의 sync는 남의 연결을 건드리지 않는다', async () => {
  gh.set('frank', { githubId: '501', login: 'frank-gh' });
  await json(await sync('frank'), 200);
  assert.equal((await json(await sync('grace'), 200)).github, null);
  assert.equal((await api.readGithubAccount('frank')).githubId, '501');
});

test('아이디만 바뀌면 같은 행의 login만 갱신하고 기록을 남기지 않는다', async () => {
  gh.set('heidi', { githubId: '601', login: 'heidi-old' });
  await json(await sync('heidi'), 200);
  const before = await one('SELECT linked_at FROM github_accounts WHERE user_id=?', 'heidi');
  gh.set('heidi', { githubId: '601', login: 'heidi-new' });
  assert.equal((await json(await sync('heidi'), 200)).github.login, 'heidi-new');
  const after = await one('SELECT linked_at FROM github_accounts WHERE user_id=?', 'heidi');
  assert.equal(after.linked_at.getTime(), before.linked_at.getTime());
  assert.equal((await events('heidi')).length, 1);
});

test('Supabase 조회 실패는 503이고 기존 연결을 유지한다', async () => {
  gh.set('ivan', { githubId: '701', login: 'ivan-gh' });
  await json(await sync('ivan'), 200);
  gh.set('ivan', 'down');
  await json(await sync('ivan'), 503);
  assert.equal((await api.readGithubAccount('ivan')).login, 'ivan-gh');
  assert.equal((await events('ivan')).length, 1);
});

test('githubFromSupabaseUser: GitHub 신원이 없으면 null, 아이디가 비거나 틀리면 실패', () => {
  assert.equal(api.githubFromSupabaseUser({ identities: [{ provider: 'google' }] }), null);
  // identities 배열이 없는 응답은 '연결 없음'이 아니라 읽기 실패다(행을 지우면 안 된다).
  assert.throws(() => api.githubFromSupabaseUser({}), api.AuthUnavailable);
  assert.throws(() => api.githubFromSupabaseUser(null), api.AuthUnavailable);
  assert.equal(api.githubFromSupabaseUser({ identities: [] }), null);
  assert.deepEqual(
    api.githubFromSupabaseUser({
      identities: [{ provider: 'github', id: 'x', identity_data: { provider_id: '5', user_name: 'octo-cat' } }],
    }),
    { githubId: '5', login: 'octo-cat' },
  );
  assert.deepEqual(
    api.githubFromSupabaseUser({
      identities: [{ provider: 'github', id: '6', identity_data: { preferred_username: 'octo' } }],
    }),
    { githubId: '6', login: 'octo' },
  );
  for (const user_name of ['', 'bad name', '-dash'])
    assert.throws(
      () =>
        api.githubFromSupabaseUser({
          identities: [{ provider: 'github', id: '7', identity_data: { provider_id: '7', user_name } }],
        }),
      api.AuthUnavailable,
    );
});

test('기본 source: Bearer가 없으면 null, Supabase가 401이면 AuthUnavailable', async () => {
  const realFetch = globalThis.fetch;
  const env = { url: process.env.SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  const calls = [];
  process.env.SUPABASE_URL = 'https://sb.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 401 });
  };
  try {
    assert.equal(await defaultSource(new Request('https://test.local/api/github')), null);
    assert.equal(calls.length, 0);
    await assert.rejects(
      defaultSource(new Request('https://test.local/api/github', { headers: { authorization: 'Bearer tok' } })),
      api.AuthUnavailable,
    );
    assert.equal(calls[0].url, 'https://sb.test/auth/v1/user');
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok');
    assert.equal(new Headers(calls[0].init.headers).get('apikey'), 'anon');
    // 200인데 본문이 깨지면 연결 해제가 아니라 조회 실패.
    globalThis.fetch = async () => new Response('{"identities":', { status: 200 });
    await assert.rejects(
      defaultSource(new Request('https://test.local/api/github', { headers: { authorization: 'Bearer tok' } })),
      api.AuthUnavailable,
    );
  } finally {
    globalThis.fetch = realFetch;
    if (env.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = env.url;
    if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
  }
});

test('다른 origin·JSON 아님·모르는 action은 거절한다', async () => {
  await json(await sync('alice', { action: 'sync' }, { origin: 'https://evil.test' }), 403);
  await json(await sync('alice', { action: 'sync' }, { 'content-type': 'text/plain' }), 415);
  await json(await sync('alice', { action: 'link' }), 400);
});

// 두 사람 팀: 팀장이 공개 → 팀원이 참여 신청 → 팀장 승인.
const postTo = (fn, url) => (user, body) =>
  fn(new Request('https://test.local' + url, { method: 'POST', headers: headers(user), body: JSON.stringify(body) }));
const projects = postTo((r) => api.projectsPOST(r), '/api/projects');
const teamsPost = postTo((r) => api.teamsPOST(r), '/api/teams');
const state = async (user, projectId) =>
  json(await api.sprintGET(new Request('https://test.local/api/sprint?project=' + projectId, { headers: headers(user) })), 200);
async function pairProject(owner, mate) {
  const projectId = (
    await json(
      await projects(owner, {
        action: 'create',
        title: 'GitHub 팀',
        goal: '예약 페이지를 출시한다',
        scope: '예약 폼',
        completionCriteria: '예약 1건',
        duration: 7,
        agreed: true,
      }),
      201,
    )
  ).projectId;
  let s = await state(owner, projectId);
  await json(await projects(owner, { action: 'setListed', projectId, revision: s.sprint.revision, listed: true }), 200);
  await json(await teamsPost(mate, { action: 'request', projectId, goalVersion: 1, agreed: true }), 201);
  s = await state(owner, projectId);
  await json(
    await projects(owner, { action: 'decideJoin', projectId, revision: s.sprint.revision, requestId: s.joinRequests[0].id, approve: true }),
    200,
  );
  return projectId;
}
const login = (s, name) => s.members.find((m) => m.display_name === name).github_login;

test('같은 프로젝트 팀원은 서로의 GitHub 아이디를 본다', async () => {
  const projectId = await pairProject('p-owner', 'p-mate');
  gh.set('p-mate', { githubId: '801', login: 'mate-gh' });
  await json(await sync('p-mate'), 200);
  const s = await state('p-owner', projectId);
  assert.equal(login(s, 'p-mate'), 'mate-gh');
  assert.equal(login(s, 'p-owner'), null);
});

test('나간 멤버가 보는 프로젝트 상태에는 GitHub 아이디가 없다', async () => {
  const projectId = await pairProject('l-owner', 'l-mate');
  gh.set('l-owner', { githubId: '811', login: 'owner-gh' });
  gh.set('l-mate', { githubId: '812', login: 'left-gh' });
  await json(await sync('l-owner'), 200);
  await json(await sync('l-mate'), 200);
  await run('UPDATE project_members SET left_at=now() WHERE project_id=? AND user_id=?', projectId, 'l-mate');
  const left = await state('l-mate', projectId);
  assert.ok(left.members.every((m) => m.github_login === null));
  assert.equal(login(await state('l-owner', projectId), 'l-mate'), 'left-gh');
});

test('공개 팀 목록에는 GitHub 아이디가 없다', async () => {
  const projectId = await pairProject('v-owner', 'v-mate');
  gh.set('v-owner', { githubId: '821', login: 'visible-gh' });
  await json(await sync('v-owner'), 200);
  const list = await json(await api.teamsGET(new Request('https://test.local/api/teams', { headers: headers('v-viewer') })), 200);
  assert.ok(list.teams.some((t) => t.projectId === projectId));
  assert.doesNotMatch(JSON.stringify(list), /github_?login|visible-gh/i);
});
