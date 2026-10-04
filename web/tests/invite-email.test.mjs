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
      "export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route'; export { GET as sprintGET } from './app/api/sprint/route'; export { useInviteSender, inviteMessage, deliverInvite } from './lib/invite-email'; export { inviteSender } from './lib/email';",
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
