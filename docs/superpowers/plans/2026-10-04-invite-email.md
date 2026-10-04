# 초대 링크 이메일 발송(Gmail SMTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀장이 초대를 만들거나 다시 보내면 초대받은 이메일로 초대 링크가 Gmail SMTP로 발송되고, 실패해도 초대와 링크는 그대로 쓸 수 있다.

**Architecture:** 초대 저장(기존 `save` 트랜잭션) 뒤에 `lib/invite-email.ts`의 `deliverInvite`가 메일을 보내고 결과만 초대 행에 기록한다. 전송기는 `lib/email.ts`의 새 `inviteSender`(nodemailer, Gmail)이며 마감 독촉용 `senderFrom`과 분리한다. 다시 보내기는 같은 초대 행의 토큰을 바꾸고, 발송 한도는 `save`의 `guard` 조건으로 같은 트랜잭션에서 지킨다.

**Tech Stack:** Next.js 16, Postgres(PGlite 테스트), drizzle-kit, nodemailer, node:test + esbuild 번들 테스트.

**Spec:** `docs/superpowers/specs/2026-10-04-invite-email-design.md`

## Global Constraints

- 작업 브랜치 `invite-email`(`phs`=`main` `0e59c12` 기준). 머지 전 Supabase에 마이그레이션 `0001` 적용.
- 비밀값(`.env.local`, 앱 비밀번호)을 출력·커밋·로그하지 않는다. 서버 로그에는 실패 코드만.
- 발송 한도: 초대 하나당 발송 시도 3회(`INVITE_SEND_LIMIT = 3`), 직전 발송 후 1분 이내 재발송 금지(429).
- 링크 = `<요청 origin>/workspace?invite=<token>`. origin은 `new URL(request.url).origin`. 요청 본문 값은 쓰지 않는다.
- 응답 `email`: `'sent' | 'failed' | 'off'`.
- 마감 독촉 전송기 `senderFrom`은 바꾸지 않는다(Resend 전용 유지).
- 최소 범위, 포매터 실행 금지. 커밋 끝줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 메일 발송 뒤 결과 기록(UPDATE)이 DB 오류로 실패하면 초대·메일은 이미 끝났는데 응답이 503이 된다 → `deliverInvite`가 기록 실패를 로그만 남기고 상태를 돌려준다(Task 2 테스트: 기록 단계에서 DB가 던져도 `'sent'` 반환).
2. 앱 비밀번호를 Google 화면 그대로(4자리씩 공백) 붙여넣으면 인증 실패 → `inviteSender`가 공백을 제거한다(Task 2 테스트: 공백 포함 키로도 전송기 생성, 비밀번호 비교는 실제 접속이 필요해 생성만 확인).
3. 다시 보내기를 동시에 두 번 누르면 한도를 넘거나 토큰이 둘 다 유효해질 수 있다 → 버전 CAS + guard로 한 건만 성공, `email_sends`는 1만 증가(Task 3 테스트).
4. 사용자 입력(프로젝트 이름·팀장 이름)의 줄바꿈이 메일 제목에 들어가면 헤더가 깨진다 → 제목·첫 줄의 CR/LF를 공백으로(Task 2 테스트).
5. 기존 초대 테스트(api·auth 등 6개 파일)는 발송 설정이 없는 환경이라 `'off'` 경로를 탄다. 이 경로가 기존 흐름(201·토큰·수락)을 바꾸면 안 된다 → Task 3에서 전체 `npm test`로 확인.

---

### Task 1: 초대 메일 상태 열과 마이그레이션 0001

**Files:**
- Modify: `web/db/schema.ts` (`project_invites` 열 3개)
- Create: `web/db/migrations/0001_invite_email.sql`, `web/db/migrations/meta/0001_snapshot.json`(drizzle-kit 생성), Modify: `web/db/migrations/meta/_journal.json`(생성)
- Test: `web/tests/db.test.ts`

**Interfaces:**
- Produces: `project_invites.email_status text NULL`, `email_sent_at timestamptz NULL`, `email_sends integer NOT NULL DEFAULT 0`

- [ ] **Step 1: 실패하는 테스트 작성** — `web/tests/db.test.ts` 끝에 추가:

```ts
void test('초대 메일 상태 열: email_status·email_sent_at은 비워둘 수 있고 email_sends 기본값은 0', async () => {
  const db = openPglite();
  await migrate(db);
  const cols = await db
    .prepare(
      "SELECT column_name AS c, is_nullable AS n, column_default AS d FROM information_schema.columns WHERE table_name='project_invites' AND column_name IN ('email_status','email_sent_at','email_sends') ORDER BY column_name",
    )
    .all<{ c: string; n: string; d: string | null }>();
  assert.deepEqual(
    cols.results.map((r) => [r.c, r.n, r.d]),
    [
      ['email_sends', 'NO', '0'],
      ['email_sent_at', 'YES', null],
      ['email_status', 'YES', null],
    ],
  );
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd web && node --experimental-strip-types --test --test-name-pattern='초대 메일 상태 열' tests/db.test.ts` / Expected: FAIL(`actual: []`).

- [ ] **Step 3: 구현** — `web/db/schema.ts`의 `project_invites` 정의에서 `createdAt: timestamp('created_at', tz).notNull(),` 다음 줄에 추가:

```ts
    // 초대 메일 발송 결과('sent'|'failed'|'off'), 마지막 시도 시각, 시도 횟수(다시 보내기 한도).
    emailStatus: text('email_status'),
    emailSentAt: timestamp('email_sent_at', tz),
    emailSends: integer('email_sends').notNull().default(0),
```

Run: `cd web && npx drizzle-kit generate --name invite_email` / Expected: `db/migrations/0001_invite_email.sql` 생성, 내용은 `ALTER TABLE "project_invites" ADD COLUMN …` 3줄뿐(RLS·다른 테이블 변경 없음). `cat`으로 확인한다.

- [ ] **Step 4: 통과 확인** — Run: `cd web && node --experimental-strip-types --test tests/db.test.ts tests/schema-migrations.test.mjs` / Expected: PASS(db 13개, schema-migrations 1개).

- [ ] **Step 5: 커밋**

```bash
git add web/db/schema.ts web/db/migrations web/tests/db.test.ts
git commit -m "feat: 초대 메일 상태 열(마이그레이션 0001)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gmail 전송기와 초대 메일 만들기·보내기

**Files:**
- Modify: `web/package.json`, `web/package-lock.json` (`nodemailer`, `@types/nodemailer`)
- Modify: `web/lib/email.ts` (`inviteSender` 추가, 맨 위 주석 갱신)
- Create: `web/lib/invite-email.ts`
- Create: `web/tests/invite-email.test.mjs`, Modify: `web/package.json` test 스크립트 끝에 `tests/invite-email.test.mjs` 추가

**Interfaces:**
- Consumes: Task 1 열
- Produces:
  - `inviteSender(env: EmailEnv): Sender | null` (`lib/email.ts`)
  - `type InviteMail = { inviteId: string; sends: number; to: string; token: string; origin: string; projectTitle: string; inviter: string; expiresAt: Date }`
  - `inviteMessage(i: InviteMail): Message`, `deliverInvite(i: InviteMail): Promise<'sent'|'failed'|'off'>`, `useInviteSender(next: Sender | null | undefined): void`, `INVITE_SEND_LIMIT = 3` (`lib/invite-email.ts`)

- [ ] **Step 1: 의존성** — Run: `cd web && npm install nodemailer && npm install -D @types/nodemailer` / Expected: 설치 성공, `package.json`에 두 줄.

- [ ] **Step 2: 실패하는 테스트 작성** — `web/tests/invite-email.test.mjs` 생성:

```js
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
```

- [ ] **Step 3: 실패 확인** — Run: `cd web && node --experimental-strip-types --test tests/invite-email.test.mjs` / Expected: FAIL — 번들 단계 `Could not resolve "./lib/invite-email"`(또는 `No matching export`).

- [ ] **Step 4: 구현** — `web/lib/email.ts` 맨 위 두 줄 주석을 다음으로 바꾼다:

```ts
// 이메일 전송 경계. 마감 독촉(senderFrom)은 Resend 전용으로 남아 있으나 제품에서 쓰지 않는다(2026-10-04).
// 초대 링크 메일은 inviteSender(Gmail SMTP)로 보낸다. 자격 정보가 없으면 보내지 않는다.
```

같은 파일 맨 위 import로 `import nodemailer from 'nodemailer';`를 넣고, 파일 끝에 추가:

```ts
/**
 * 초대 링크 메일 전송기(Gmail SMTP). 제공자·발신 주소·앱 비밀번호가 모두 있을 때만 만들고,
 * 없으면 null(보내지 않음). 마감 독촉의 senderFrom과 분리해 Gmail 설정이 독촉 발송을 켜지 않게 한다.
 */
export function inviteSender(env: EmailEnv): Sender | null {
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const from = (env.EMAIL_FROM ?? '').trim();
  // Google은 앱 비밀번호를 4자리씩 띄워 보여준다.
  const key = (env.EMAIL_API_KEY ?? '').replace(/\s+/g, '');
  if (provider !== 'gmail' || !from || !key) return null;
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass: key },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  return {
    name: 'gmail',
    live: true,
    async send(m) {
      try {
        const info = await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
        return { status: 'sent', provider: 'gmail', messageId: info.messageId ?? null };
      } catch (e) {
        // 비밀번호·본문이 섞일 수 있는 원문 대신 오류 코드만 남긴다.
        return { status: 'failed', provider: 'gmail', error: String((e as { code?: unknown }).code ?? 'error') };
      }
    },
  };
}
```

`web/lib/invite-email.ts` 생성:

```ts
// 초대 링크 메일. 초대 저장(트랜잭션)이 끝난 뒤 보내고 결과만 초대 행에 기록한다.
// 발송·기록이 실패해도 초대는 그대로이며 링크는 화면에서 직접 전달할 수 있다.
import { database } from './db';
import { inviteSender, type Message, type Sender } from './email';

export const INVITE_SEND_LIMIT = 3;
export type InviteEmailStatus = 'sent' | 'failed' | 'off';
export type InviteMail = {
  inviteId: string;
  sends: number;
  to: string;
  token: string;
  origin: string;
  projectTitle: string;
  inviter: string;
  expiresAt: Date;
};

let override: Sender | null | undefined;
/** 테스트용 전송기(null = 설정 없음). undefined면 환경변수로 만든다. */
export function useInviteSender(next: Sender | null | undefined) {
  override = next;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function inviteMessage(i: InviteMail): Message {
  const inviter = oneLine(i.inviter);
  const title = oneLine(i.projectTitle);
  const link = `${i.origin}/workspace?invite=${encodeURIComponent(i.token)}`;
  const until = i.expiresAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return {
    to: i.to,
    subject: `[ProjectMate] ${inviter}님이 '${title}' 팀에 초대했습니다`,
    text: [
      `${inviter}님이 ProjectMate의 '${title}' 팀에 초대했습니다.`,
      '',
      link,
      '',
      `링크 만료: ${until} (한국 시간)`,
      '초대받은 이메일의 Google 계정으로 로그인해야 수락됩니다.',
      '모르는 초대라면 이 메일을 무시하세요.',
    ].join('\n'),
    idempotencyKey: `invite:${i.inviteId}:${i.sends}`,
  };
}

export async function deliverInvite(i: InviteMail): Promise<InviteEmailStatus> {
  const sender = override === undefined ? inviteSender(process.env) : override;
  let status: InviteEmailStatus = 'off';
  if (sender) {
    const r = await sender.send(inviteMessage(i));
    status = r.status === 'sent' ? 'sent' : 'failed';
    if (r.status !== 'sent') console.error('invite email failed', r.provider, r.error);
  }
  try {
    await database()
      .prepare('UPDATE project_invites SET email_status=? WHERE id=?')
      .bind(status, i.inviteId)
      .run();
  } catch (e) {
    // 메일은 이미 끝났다. 기록 실패로 초대 응답을 실패시키지 않는다.
    console.error('invite email status not recorded', (e as Error).message);
  }
  return status;
}
```

`web/package.json` test 스크립트 끝 `tests/change-review-render.test.mjs"` 를 `tests/change-review-render.test.mjs tests/invite-email.test.mjs"`로 바꾼다.

- [ ] **Step 5: 통과 확인** — Run: `cd web && node --experimental-strip-types --test tests/invite-email.test.mjs && npx tsc --noEmit` / Expected: PASS 3개, tsc 출력 없음. 만료 시각 형식 단언이 Node의 ko-KR 형식과 다르면 실제 출력을 보고 정규식만 고친다(Ruling 기록).

- [ ] **Step 6: 커밋**

```bash
git add web/package.json web/package-lock.json web/lib/email.ts web/lib/invite-email.ts web/tests/invite-email.test.mjs
git commit -m "feat: Gmail SMTP 초대 메일 전송기와 초대 메일 만들기·보내기

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 초대 만들기·다시 보내기에 메일 연결

**Files:**
- Modify: `web/lib/projects.ts` (`createInvite`, 새 `resendInvite`, `projectState` 초대 SELECT, import)
- Modify: `web/lib/sprint-policy.ts` (`RULES.resendInvite`)
- Modify: `web/app/api/projects/route.ts` (invite에 origin 전달, `resend` 분기, import)
- Test: `web/tests/invite-email.test.mjs`

**Interfaces:**
- Consumes: Task 2 `deliverInvite`, `INVITE_SEND_LIMIT`; Task 1 열
- Produces: `createInvite(project, user, revision, email, origin: string) → { token, expiresAt, id, email: 'sent'|'failed'|'off' }`; `resendInvite(project, user, revision, inviteId, origin) → 같은 모양`; POST `/api/projects` `{ action: 'resend', projectId, revision, inviteId }` → 200; `projectState().invites[]`에 `email_status`, `email_sent_at`, `email_sends`

- [ ] **Step 1: 실패하는 테스트 작성** — `web/tests/invite-email.test.mjs` 끝에 추가:

```js
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
```

- [ ] **Step 2: 실패 확인** — Run: `cd web && node --experimental-strip-types --test tests/invite-email.test.mjs` / Expected: 새 5개 FAIL(`body.email` undefined, resend는 400 `지원하지 않는 작업입니다.`), 앞의 3개 PASS.

- [ ] **Step 3: 구현**

`web/lib/sprint-policy.ts` `RULES`의 `revokeInvite` 다음 줄:

```ts
  resendInvite: { scope: 'owner', states: ['draft', 'active'] },
```

`web/lib/projects.ts`:
- import 추가: `import { deliverInvite, INVITE_SEND_LIMIT } from './invite-email';`
- `projectState`의 초대 SELECT를 `"SELECT id,email,expires_at,status,email_status,email_sent_at,email_sends FROM project_invites WHERE project_id=? AND ?='owner' ORDER BY created_at DESC LIMIT 20"`로 바꾼다.
- `createInvite` 시그니처 끝에 `origin: string` 매개변수를 더한다. INSERT를 다음으로 바꾼다(발급 시점에 시도 1회로 센다):

```ts
          'INSERT INTO project_invites(id,project_id,token_hash,email,expires_at,created_by,created_at,email_sends,email_sent_at) SELECT ?,owner,?,?,?,?,?,1,now() FROM sprints WHERE owner=? AND mutation=?',
```

  (bind 인자는 그대로.) `return { token, expiresAt: expires, id };`를 다음으로 바꾼다:

```ts
  const mail = await deliverInvite({
    inviteId: id,
    sends: 1,
    to: email as string,
    token,
    origin,
    projectTitle: s.title,
    inviter: me.display_name,
    expiresAt: new Date(expires),
  });
  return { token, expiresAt: expires, id, email: mail };
```

- `createInvite` 바로 아래에 추가:

```ts
/** 같은 초대에 새 링크를 발급해 다시 보낸다. 이전 링크는 즉시 무효. 한도는 저장 트랜잭션의 조건으로 지킨다. */
export async function resendInvite(
  project: string,
  user: Identity,
  revision: number,
  inviteId: unknown,
  origin: string,
) {
  const me = await member(project, user);
  assertProjectMutationAllowed({
    policy: await readPolicy(project),
    actor: actorOf(me),
    action: 'resendInvite',
    now: new Date(),
  });
  if (typeof inviteId !== 'string') throw new Error('다시 보낼 초대를 선택해주세요.');
  const invite = await database()
    .prepare('SELECT email,status,email_sends,email_sent_at FROM project_invites WHERE project_id=? AND id=?')
    .bind(project, inviteId)
    .first<{ email: string; status: string; email_sends: number; email_sent_at: Date | null }>();
  if (!invite) throw new AccessError('초대를 찾을 수 없습니다.', 404);
  if (invite.status !== 'pending') throw new Error('대기 중인 초대만 다시 보낼 수 있습니다.');
  if (invite.email_sends >= INVITE_SEND_LIMIT)
    throw new AccessError(`초대 메일은 ${INVITE_SEND_LIMIT}번까지 보낼 수 있습니다. 링크를 직접 전달해주세요.`, 429);
  if (invite.email_sent_at && Date.now() - invite.email_sent_at.getTime() < 60_000)
    throw new AccessError('1분 뒤에 다시 보낼 수 있습니다.', 429);
  const s = await readSprint(project);
  if (!s) throw new AccessError();
  if (s.revision !== revision) throw new Conflict();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await tokenHash(token);
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await save(
    project,
    s,
    'resend_invite',
    `${me.display_name} · 초대 링크 다시 발급`,
    (m) => [
      database()
        .prepare(
          "UPDATE project_invites SET token_hash=?,expires_at=?,email_sends=email_sends+1,email_sent_at=now(),email_status=NULL WHERE project_id=? AND id=? AND status='pending' AND EXISTS(SELECT 1 FROM sprints WHERE owner=? AND mutation=?)",
        )
        .bind(hash, expires, project, inviteId, project, m),
    ],
    ['draft', 'active'],
    // 읽은 뒤 저장 사이에 한도가 바뀌었으면 아무것도 쓰지 않는다(409).
    {
      sql: "EXISTS(SELECT 1 FROM project_invites i WHERE i.project_id=sprints.owner AND i.id=? AND i.status='pending' AND i.email_sends<? AND (i.email_sent_at IS NULL OR i.email_sent_at < now() - interval '1 minute'))",
      args: [inviteId, INVITE_SEND_LIMIT],
    },
  );
  const mail = await deliverInvite({
    inviteId,
    sends: invite.email_sends + 1,
    to: invite.email,
    token,
    origin,
    projectTitle: s.title,
    inviter: me.display_name,
    expiresAt: new Date(expires),
  });
  return { token, expiresAt: expires, id: inviteId, email: mail };
}
```

`web/app/api/projects/route.ts`:
- `createInvite` import 옆에 `resendInvite`를 더한다.
- invite 분기를 `await createInvite(b.projectId, user, b.revision, b.email, new URL(request.url).origin)`로 바꾼다.
- invite 분기 다음에 추가:

```ts
    if (b.action === 'resend')
      return reply(
        await resendInvite(b.projectId, user, b.revision, b.inviteId, new URL(request.url).origin),
      );
```

- [ ] **Step 4: 통과 확인** — Run: `cd web && node --experimental-strip-types --test tests/invite-email.test.mjs && npx tsc --noEmit` / Expected: PASS 8개, tsc 없음. 그다음 Run: `cd web && npm test > ../.superpowers/full-test.log 2>&1; echo test=$?; grep -E '^ℹ (tests|pass|fail)' ../.superpowers/full-test.log` / Expected: `test=0`, fail 0(Review Focus 5: 기존 초대 테스트는 `'off'` 경로로 그대로 통과).

- [ ] **Step 5: 커밋**

```bash
git add web/lib/projects.ts web/lib/sprint-policy.ts web/app/api/projects/route.ts web/tests/invite-email.test.mjs
git commit -m "feat: 초대 만들기·다시 보내기에서 초대 링크 메일 발송(한도 3회·1분)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 화면·문구·문서

**Files:**
- Modify: `web/components/project-workspace.tsx` (초대 타입, 결과 안내, 목록 상태·다시 보내기)
- Modify: `web/app/workspace/page.tsx:1072` (초대 설명)
- Modify: `docs/features.md:121-122`, `web/README.md:23`, `CLAUDE.md:15`, `web/.env.example`
- Test: `web/tests/landing-race.test.mjs`(문구 테스트에 추가)

**Interfaces:**
- Consumes: Task 3 응답 `email`, POST `resend`, `invites[].email_status|email_sent_at|email_sends`

- [ ] **Step 1: 실패하는 테스트 작성** — `web/tests/landing-race.test.mjs`의 `test('화면 문구는 보내지 않는 알림 메일을 약속하지 않는다'` 다음에 추가:

```js
test('초대 화면은 메일을 보내지 않는다고 안내하지 않는다(초대 링크 메일 발송)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['components/project-workspace.tsx', 'app/workspace/page.tsx']) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /이메일은 발송하지 않/, f);
  }
  assert.match(readFileSync('components/project-workspace.tsx', 'utf8'), /다시 보내기/);
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd web && node --experimental-strip-types --test tests/landing-race.test.mjs` / Expected: FAIL 1개(`이메일은 발송하지 않` 일치).

- [ ] **Step 3: 화면 구현** — `web/components/project-workspace.tsx`:
- `invites` 타입(122행)을 다음으로:

```ts
  invites: {
    id: string;
    email: string;
    expires_at: string;
    status: string;
    email_status: 'sent' | 'failed' | 'off' | null;
    email_sent_at: string | null;
    email_sends: number;
  }[];
```

- 초대 패널 함수(`runAction`이 있는 컴포넌트) 바로 위에 추가:

```tsx
function inviteNotice(mail: unknown, to: string, resent: boolean) {
  const head =
    mail === 'sent'
      ? `${to}로 초대 메일을 보냈습니다. 아래 링크도 직접 전달할 수 있습니다.`
      : mail === 'failed'
        ? '메일을 보내지 못했습니다. 아래 링크를 직접 전달해 주세요.'
        : '메일 발송이 설정되지 않아 보내지 않았습니다. 아래 링크를 직접 전달해 주세요.';
  return resent ? `${head} 이전 링크는 더 이상 쓸 수 없습니다.` : head;
}
const MAIL_LABEL = { sent: '메일 보냄', failed: '메일 실패', off: '메일 꺼짐' } as const;
```

- `runAction`의 `setMessage(action === 'invite' ? '초대 링크를 만들었습니다. 이메일은 발송하지 않았습니다.' : '초대를 취소했습니다.')`를 다음으로:

```tsx
      setMessage(
        action === 'revoke'
          ? '초대를 취소했습니다.'
          : inviteNotice(
              result.email,
              action === 'invite'
                ? String(extra.email ?? '')
                : (state.invites.find((i) => i.id === extra.inviteId)?.email ?? ''),
              action === 'resend',
            ),
      );
```

- 초대 목록 `<li>`에서 만료 시각 출력 뒤, `{i.status === 'pending' && (` 취소 버튼 앞에 추가:

```tsx
            {i.email_status && (
              <>
                · {MAIL_LABEL[i.email_status]}
                {i.email_status === 'sent' && i.email_sent_at
                  ? ' ' +
                    new Date(i.email_sent_at).toLocaleTimeString('ko-KR', {
                      timeZone: 'Asia/Seoul',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : ''}{' '}
              </>
            )}
            {i.status === 'pending' && i.email_sends < 3 && (
              <button
                className="btn"
                disabled={busy || !writable}
                onClick={() => void runAction('resend', { inviteId: i.id })}
              >
                다시 보내기
              </button>
            )}
```

- 같은 파일의 안내 문구 `초대 링크는 지정된 이메일의 Google 계정으로만 수락할 수 있으며 7일 뒤 만료됩니다.`를 `초대 링크를 그 이메일로 보내며, 그 이메일의 Google 계정으로만 수락할 수 있습니다. 링크는 7일 뒤 만료됩니다.`로 바꾼다.

`web/app/workspace/page.tsx` 1072행 `'팀원의 Google 계정 이메일로 초대 링크를 만듭니다. 이메일은 발송하지 않으니 링크를 직접 전달해주세요.'` → `'팀원의 Google 계정 이메일로 초대 링크를 만들어 그 주소로 보냅니다. 메일이 가지 않으면 링크를 직접 전달해주세요.'`

- [ ] **Step 4: 통과 확인** — Run: `cd web && node --experimental-strip-types --test tests/landing-race.test.mjs && npx tsc --noEmit && npx oxlint components/project-workspace.tsx app/workspace/page.tsx lib/projects.ts lib/email.ts lib/invite-email.ts` / Expected: PASS, tsc 없음, oxlint 새 오류 0.

- [ ] **Step 5: 문서**
- `docs/features.md` 121-122행 `초대 이메일 자체는 발송하지\n않는다.` → `초대 링크는 그 이메일로 발송한다(Gmail SMTP, 팀 내부용; 실패해도 초대는 유지되고 링크를 직접 전달할 수 있다, 다시 보내기는 새 링크로 3회까지·1분 간격).` (줄바꿈 폭은 주변에 맞춘다.)
- `web/README.md` 23행을 다음으로: `초대 링크는 초대받은 이메일로 발송되며(Gmail SMTP, 설정이 없으면 보내지 않고 링크만 보여준다) 그 이메일의 Google 계정으로 로그인해야 수락한다. 메일 설정: Vercel·\`.env.local\`에 \`EMAIL_PROVIDER=gmail\`, \`EMAIL_FROM\`(Gmail 주소), \`EMAIL_API_KEY\`(Google 앱 비밀번호, 비밀값).`
- `CLAUDE.md` 15행의 `이메일 지정 초대`를 `이메일 지정 초대(초대 링크 메일 발송)`로.
- `web/.env.example` 끝에 추가:

```
# 초대 링크 메일(Gmail SMTP). 셋 다 있어야 보낸다. 앱 비밀번호는 비밀값이다.
EMAIL_PROVIDER=
EMAIL_FROM=
EMAIL_API_KEY=
```

- [ ] **Step 6: 전체 검증** — Run: `cd web && npm test > ../.superpowers/full-test.log 2>&1; echo test=$?; grep -E '^ℹ (tests|pass|fail)' ../.superpowers/full-test.log; npx tsc --noEmit; echo tsc=$?; DATABASE_URL= npx next build > ../.superpowers/build.log 2>&1; echo build=$?` / Expected: `test=0` fail 0, `tsc=0`, `build=0`.

- [ ] **Step 7: 커밋**

```bash
git add web/components/project-workspace.tsx web/app/workspace/page.tsx web/tests/landing-race.test.mjs docs/features.md web/README.md CLAUDE.md web/.env.example
git commit -m "feat: 초대 메일 결과·다시 보내기 화면, 문서

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 운영 연결과 실제 발송 확인 (리뷰 후, 머지 전)

외부 시스템(Gmail, Vercel, Supabase)을 다룬다. 비밀값은 사용자가 직접 넣는다.

- [ ] **Step 1: (Claude) Supabase 마이그레이션** — Run: `cd web && set -a; . ./.env.local; set +a; node --experimental-strip-types scripts/migrate.ts` / Expected: `applied: 0001_invite_email.sql`. 값은 출력하지 않는다.
- [ ] **Step 2: (사용자) Gmail 앱 비밀번호** — Google 계정 → 보안 → 2단계 인증 켜기 → 앱 비밀번호 만들기(16자리).
- [ ] **Step 3: (사용자) Vercel 환경변수** — `EMAIL_PROVIDER=gmail`(Config), `EMAIL_FROM=<Gmail 주소>`(Config), `EMAIL_API_KEY=<앱 비밀번호>`(Secret), Production·Preview. 그다음 브랜치를 푸시하면 미리보기가 새 값으로 빌드된다.
- [ ] **Step 4: (사용자 + Claude) 미리보기 확인** — 미리보기 주소에서 팀원 이메일로 초대 → 메일 도착(스팸함 포함) → 메일 링크가 같은 미리보기 주소로 열려 수락 → 1분 뒤 다시 보내기 → 이전 링크 403(초대받은 이메일 계정으로 로그인했을 때 "초대받은 이메일의 계정으로 로그인해주세요"), 새 링크 정상. Claude는 Supabase에서 해당 초대의 `email_status`·`email_sends`만 확인한다(이메일·토큰은 출력하지 않음).
- [ ] **Step 5: (Claude) 기록** — `docs/current-sprint.md`에 결과를 적고 커밋. 실패 항목은 실패로 적는다.
