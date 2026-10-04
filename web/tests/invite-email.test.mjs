import { test } from 'node:test';
process.env.AUTH_DEV_HEADERS = '1';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupTestDb } from './helpers/pg-db.mjs';
const { one, run } = await setupTestDb();
const outfile = join(mkdtempSync(join(tmpdir(), 'projectmate-invite-')), 'route.mjs');
await build({
  stdin: {
    contents:
      "export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route'; export { GET as sprintGET } from './app/api/sprint/route'; export { useInviteSender, inviteMessage, deliverInvite, inviteOrigin } from './lib/invite-email'; export { inviteSender } from './lib/email';",
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

function fakeSender(result = { status: 'sent', provider: 'fake', messageId: null }) {
  const log = [];
  return {
    log,
    sender: {
      name: 'fake',
      live: true,
      async send(m) {
        log.push(m);
        return result;
      },
    },
  };
}
const mail = {
  inviteId: 'inv1',
  sends: 1,
  to: 'mate@test.local',
  token: 'a'.repeat(72),
  origin: 'https://test.local',
  projectTitle: '포트폴리오\r\n스프린트',
  inviter: '김리드\n(팀장)',
  expiresAt: new Date('2026-10-11T03:00:00Z'),
};

test('Gmail 전송기는 제공자·발신 주소·앱 비밀번호가 모두 있을 때만 만든다', () => {
  assert.equal(api.inviteSender({}), null);
  assert.equal(api.inviteSender({ EMAIL_PROVIDER: 'gmail', EMAIL_FROM: 'me@gmail.com' }), null);
  assert.equal(api.inviteSender({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'me@gmail.com', EMAIL_API_KEY: 'k' }), null);
  // Google 화면처럼 4자리씩 띄운 앱 비밀번호도 받는다(공백 제거). 접속은 send 때만 한다.
  const s = api.inviteSender({ EMAIL_PROVIDER: 'Gmail', EMAIL_FROM: 'me@gmail.com', EMAIL_API_KEY: 'abcd efgh ijkl mnop' });
  assert.equal(s.name, 'gmail');
  assert.equal(s.live, true);
});

test('초대 메일: 제목·본문에 줄바꿈이 섞이지 않고 링크·만료(KST)·수락 안내가 들어간다', () => {
  const m = api.inviteMessage(mail);
  assert.equal(m.to, 'mate@test.local');
  assert.doesNotMatch(m.subject, /[\r\n]/);
  assert.equal(m.text.split('\n')[0], "김리드 (팀장)님이 ProjectMate의 '포트폴리오 스프린트' 팀에 초대했습니다.");
  assert.doesNotMatch(m.text, /\r/);
  assert.match(m.subject, /^\[ProjectMate\] 김리드 \(팀장\)님이 '포트폴리오 스프린트' 팀에 초대했습니다$/);
  assert.ok(m.text.includes('https://test.local/workspace?invite=' + 'a'.repeat(72)));
  assert.match(m.text, /2026\. 10\. 11\. .*12:00:00/);
  assert.match(m.text, /Google 계정으로 로그인해야 수락됩니다/);
  assert.equal(m.idempotencyKey, 'invite:inv1:1');
});

test('발송 결과 기록이 실패해도 보낸 결과를 돌려준다', async () => {
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  const real = globalThis.__TEST_DB;
  globalThis.__TEST_DB = { ...real, prepare: () => ({ bind: () => ({ run: async () => { throw new Error('database error: down'); } }) }) };
  try {
    assert.equal(await api.deliverInvite(mail), 'sent');
    assert.equal(fake.log.length, 1);
  } finally {
    globalThis.__TEST_DB = real;
    api.useInviteSender(undefined);
  }
});

function headers(user) {
  return {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@test.local',
    'content-type': 'application/json',
    origin: 'https://test.local',
  };
}
const projectRequest = (user, body) =>
  api.projectsPOST(new Request('https://test.local/api/projects', { method: 'POST', headers: headers(user), body: JSON.stringify(body) }));
const inviteGet = (user, token) =>
  api.projectsGET(new Request('https://test.local/api/projects?invite=' + encodeURIComponent(token), { headers: headers(user) }));
async function read(user, id) {
  const r = await api.sprintGET(new Request('https://test.local/api/sprint?project=' + encodeURIComponent(id), { headers: headers(user) }));
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const goal = {
  action: 'create',
  title: '포트폴리오 스프린트',
  goal: '공고문을 실행 계획으로 바꾸는 서비스를 출시한다',
  scope: '공고 붙여넣기, 마감일 추출, 결과 화면',
  completionCriteria: '핵심 흐름을 실제로 실행해 보인다',
  deliverables: '동작하는 서비스',
  duration: 7,
  agreed: true,
};
async function project(owner) {
  const r = await projectRequest(owner, goal);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).projectId;
}
async function invite(owner, projectId, email, extra = {}) {
  const s = await read(owner, projectId);
  return projectRequest(owner, { action: 'invite', projectId, revision: s.sprint.revision, email, ...extra });
}
async function resend(user, projectId, inviteId, revision) {
  const r = revision ?? (await read(user, projectId)).sprint.revision;
  return projectRequest(user, { action: 'resend', projectId, revision: r, inviteId });
}
const row = (id) => one('SELECT email_status,email_sends,email_sent_at,expires_at FROM project_invites WHERE id=?', id);
const age = (id) => run("UPDATE project_invites SET email_sent_at=now()-interval '2 minutes' WHERE id=?", id);

test('초대를 만들면 초대 이메일로 링크 메일 1통, 링크 주소는 요청 origin(본문 값 무시)', async () => {
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  try {
    const pid = await project('lead1');
    const r = await invite('lead1', pid, 'Mate1@Test.local', { origin: 'https://evil.example' });
    assert.equal(r.status, 201, await r.clone().text());
    const body = await r.json();
    assert.equal(body.email, 'sent');
    assert.equal(fake.log.length, 1);
    assert.equal(fake.log[0].to, 'mate1@test.local');
    assert.ok(fake.log[0].text.includes('https://test.local/workspace?invite=' + body.token));
    assert.doesNotMatch(fake.log[0].text, /evil\.example/);
    const saved = await row(body.id);
    assert.equal(saved.email_status, 'sent');
    assert.equal(saved.email_sends, 1);
    // 팀장 화면의 초대 목록에도 상태가 보인다.
    const listed = (await read('lead1', pid)).invites.find((i) => i.id === body.id);
    assert.equal(listed.email_status, 'sent');
  } finally {
    api.useInviteSender(undefined);
  }
});

test('메일이 실패하거나 설정이 없어도 초대는 201이고 링크(토큰)를 돌려준다', async () => {
  const pid = await project('lead2');
  api.useInviteSender(fakeSender({ status: 'failed', provider: 'fake', error: 'EAUTH' }).sender);
  try {
    const r = await invite('lead2', pid, 'mate2@test.local');
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.email, 'failed');
    assert.match(body.token, /^[a-f0-9-]{72}$/);
    assert.equal((await row(body.id)).email_status, 'failed');
    api.useInviteSender(null);
    const off = await (await invite('lead2', pid, 'mate3@test.local')).json();
    assert.equal(off.email, 'off');
    assert.equal((await row(off.id)).email_status, 'off');
  } finally {
    api.useInviteSender(undefined);
  }
});

test('다시 보내기: 새 링크로 메일을 보내고 이전 링크는 막히며 만료가 새로 정해진다', async () => {
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  try {
    const pid = await project('lead3');
    const first = await (await invite('lead3', pid, 'mate4@test.local')).json();
    const before = await row(first.id);
    await age(first.id);
    const r = await resend('lead3', pid, first.id);
    assert.equal(r.status, 200, await r.clone().text());
    const again = await r.json();
    assert.notEqual(again.token, first.token);
    assert.equal(again.email, 'sent');
    assert.equal(fake.log.length, 2);
    assert.ok(fake.log[1].text.includes(again.token));
    assert.equal((await inviteGet('mate4', first.token)).status, 403);
    assert.equal((await inviteGet('mate4', again.token)).status, 200);
    const after = await row(first.id);
    assert.equal(after.email_sends, 2);
    assert.ok(after.expires_at.getTime() >= before.expires_at.getTime());
    const events = (await read('lead3', pid)).events.map((e) => e.action);
    assert.ok(events.includes('resend_invite'));
  } finally {
    api.useInviteSender(undefined);
  }
});

test('다시 보내기 한도: 1분 안 재발송과 4번째 발송은 429, 동시 2건은 한 번만 반영', async () => {
  api.useInviteSender(fakeSender().sender);
  try {
    const pid = await project('lead4');
    const inv = await (await invite('lead4', pid, 'mate5@test.local')).json();
    assert.equal((await resend('lead4', pid, inv.id)).status, 429);
    await age(inv.id);
    const s = await read('lead4', pid);
    const both = await Promise.all([resend('lead4', pid, inv.id, s.sprint.revision), resend('lead4', pid, inv.id, s.sprint.revision)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await row(inv.id)).email_sends, 2);
    await age(inv.id);
    assert.equal((await resend('lead4', pid, inv.id)).status, 200);
    await age(inv.id);
    const fourth = await resend('lead4', pid, inv.id);
    assert.equal(fourth.status, 429);
    assert.match((await fourth.json()).error, /3번/);
    assert.equal((await row(inv.id)).email_sends, 3);
  } finally {
    api.useInviteSender(undefined);
  }
});

test('다시 보내기 권한·상태: 팀원은 403, 취소된 초대는 400, 오래된 버전은 409', async () => {
  api.useInviteSender(null);
  try {
    const pid = await project('lead5');
    const s0 = await read('lead5', pid);
    const mateInvite = await (await invite('lead5', pid, 'mate6@test.local')).json();
    const accepted = await projectRequest('mate6', { action: 'accept', token: mateInvite.token, agreed: true, goalVersion: s0.policy.goalVersion });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const other = await (await invite('lead5', pid, 'mate7@test.local')).json();
    await age(other.id);
    assert.equal((await resend('mate6', pid, other.id)).status, 403);
    const stale = (await read('lead5', pid)).sprint.revision - 1;
    assert.equal((await resend('lead5', pid, other.id, stale)).status, 409);
    const s = await read('lead5', pid);
    assert.equal((await projectRequest('lead5', { action: 'revoke', projectId: pid, revision: s.sprint.revision, inviteId: other.id })).status, 200);
    assert.equal((await resend('lead5', pid, other.id)).status, 400);
  } finally {
    api.useInviteSender(undefined);
  }
});

test('[I1] 이메일 칸에 주소 목록·이름 표기를 넣으면 거절하고 메일을 보내지 않는다', async () => {
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  try {
    const pid = await project('lead6');
    for (const bad of ['victim@test.local,attacker@evil.example', 'a@test.local;b@evil.example', 'Name <a@test.local>', 'a@test.local b@evil.example']) {
      const r = await invite('lead6', pid, bad);
      assert.equal(r.status, 400, bad);
    }
    assert.equal(fake.log.length, 0);
  } finally {
    api.useInviteSender(undefined);
  }
});

test('[I2] 한 사용자가 하루에 만들 수 있는 초대는 20개까지(초대→취소 반복으로 메일 한도를 넘지 못함)', async () => {
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  try {
    const pid = await project('lead7');
    for (let i = 0; i < 20; i++) {
      const r = await invite('lead7', pid, `spam${i}@test.local`);
      assert.equal(r.status, 201, await r.clone().text());
      const { id } = await r.json();
      const s = await read('lead7', pid);
      assert.equal((await projectRequest('lead7', { action: 'revoke', projectId: pid, revision: s.sprint.revision, inviteId: id })).status, 200);
    }
    const over = await invite('lead7', pid, 'spam20@test.local');
    assert.equal(over.status, 429);
    assert.equal(fake.log.length, 20);
  } finally {
    api.useInviteSender(undefined);
  }
});

test('[I3] 링크 주소는 Vercel이 알려 준 운영·브랜치 주소를 쓰고, 로컬에서만 요청 주소를 쓴다', async () => {
  assert.equal(api.inviteOrigin('https://evil.example/api/projects', { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'projectmate-x.vercel.app', VERCEL_URL: 'projectmate-abc.vercel.app' }), 'https://projectmate-x.vercel.app');
  assert.equal(api.inviteOrigin('https://evil.example/api/projects', { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'projectmate-git-b-x.vercel.app', VERCEL_URL: 'projectmate-abc.vercel.app' }), 'https://projectmate-git-b-x.vercel.app');
  assert.equal(api.inviteOrigin('https://evil.example/api/projects', { VERCEL_ENV: 'preview', VERCEL_URL: 'projectmate-abc.vercel.app' }), 'https://projectmate-abc.vercel.app');
  assert.equal(api.inviteOrigin('http://localhost:3100/api/projects', {}), 'http://localhost:3100');
  const fake = fakeSender();
  api.useInviteSender(fake.sender);
  const saved = { ...process.env };
  try {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'projectmate-x.vercel.app';
    const pid = await project('lead8');
    const r = await invite('lead8', pid, 'mate8@test.local');
    assert.equal(r.status, 201);
    assert.ok(fake.log[0].text.includes('https://projectmate-x.vercel.app/workspace?invite='));
  } finally {
    for (const k of ['VERCEL_ENV', 'VERCEL_PROJECT_PRODUCTION_URL']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    api.useInviteSender(undefined);
  }
});

test('[I4] 전송기가 응답하지 않으면 제한 시간 뒤 failed로 끝나고 초대는 남는다', async () => {
  api.useInviteSender({ name: 'hang', live: true, send: () => new Promise(() => {}) }, 50);
  try {
    const pid = await project('lead9');
    const started = Date.now();
    const r = await invite('lead9', pid, 'mate9@test.local');
    assert.equal(r.status, 201);
    assert.equal((await r.json()).email, 'failed');
    assert.ok(Date.now() - started < 5000);
  } finally {
    api.useInviteSender(undefined);
  }
});

test('[R1-I1] 하루 한도 직전에 서로 다른 프로젝트로 동시에 초대하면 한 건만 만들어지고 나머지는 429', async () => {
  api.useInviteSender(null);
  try {
    const a = await project('lead10');
    const b = await project('lead10');
    for (let i = 0; i < 19; i++) {
      const r = await invite('lead10', a, `q${i}@test.local`);
      assert.equal(r.status, 201, await r.clone().text());
      const { id } = await r.json();
      const s = await read('lead10', a);
      await projectRequest('lead10', { action: 'revoke', projectId: a, revision: s.sprint.revision, inviteId: id });
    }
    const both = await Promise.all([invite('lead10', a, 'last-a@test.local'), invite('lead10', b, 'last-b@test.local')]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 429]);
    const n = await one("SELECT count(*)::int AS n FROM project_invites WHERE created_by='lead10'");
    assert.equal(n.n, 20);
  } finally {
    api.useInviteSender(undefined);
  }
});
