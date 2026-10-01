import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// --- D1 대역(tests/api.test.mjs와 같은 방식, 쓰기 직전 훅은 필요 없어 뺐다) ---
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
      return { results: st.all(...this.args), meta: { changes: 0 }, success: true };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes) }, success: true };
  }
}
globalThis.__TEST_DB = {
  prepare: (sql) => new Prepared(sql),
  async batch(statements) {
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

// --- Supabase 대역: 키 쌍과 JWKS 응답 ---
const SUPABASE = 'https://ref.supabase.test';
const JWKS_URL = SUPABASE + '/auth/v1/.well-known/jwks.json';
globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };
const { privateKey, publicKey } = await generateKeyPair('ES256');
const stranger = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
let jwksDown = false; // false | 'network' | 'http500'
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === JWKS_URL) {
    if (jwksDown === 'network') throw new TypeError('network down');
    if (jwksDown === 'http500') return new Response('oops', { status: 500 });
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};
async function token(
  { sub = 'user-a', ...claims } = {},
  { key = privateKey, iss = SUPABASE + '/auth/v1', aud = 'authenticated', exp = '1h' } = {},
) {
  return new SignJWT({
    email: 'a@test.local',
    user_metadata: { full_name: '에이' },
    app_metadata: { provider: 'google', providers: ['google'] },
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(sub)
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

// --- 라우트 번들 ---
const dir = mkdtempSync(join(tmpdir(), 'projectmate-auth-test-'));
const outfile = join(dir, 'route.mjs');
await build({
  stdin: {
    contents:
      "export { GET as sprintGET } from './app/api/sprint/route'; export { GET as projectsGET, POST as projectsPOST } from './app/api/projects/route';",
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
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'd1', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export const env=new Proxy({},{get:(_,k)=>k==="DB"?globalThis.__TEST_DB:globalThis.__TEST_ENV?.[k]});',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(outfile).href);

const bearer = (t) => ({
  authorization: 'Bearer ' + t,
  'content-type': 'application/json',
  origin: 'https://test.local',
});
const me = (headers) =>
  api.projectsGET(new Request('https://test.local/api/projects', { headers }));
const projectPost = (headers, body) =>
  api.projectsPOST(
    new Request('https://test.local/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
const sprint = (headers, id) =>
  api.sprintGET(
    new Request('https://test.local/api/sprint?project=' + encodeURIComponent(id), { headers }),
  );
const goal = {
  action: 'create',
  title: '로그인 테스트',
  goal: '토큰으로 만든 프로젝트',
  scope: '생성',
  completionCriteria: '조회된다',
  deliverables: '서비스',
  duration: 7,
  agreed: true,
};
async function createProject(t) {
  const r = await projectPost(bearer(t), goal);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).projectId;
}

// JWKS를 처음 받기 전에 실행해야 한다(jose가 받은 키를 캐시한다).
// 키 서버 장애를 401로 돌려주면 화면이 재로그인만 반복시킨다. 토큰 오류와 구분한다.
test('JWKS를 못 받으면 401이 아니라 503과 안내 문구', async () => {
  for (const mode of ['network', 'http500']) {
    jwksDown = mode;
    try {
      const r = await me(bearer(await token()));
      assert.equal(r.status, 503, mode);
      const { error } = await r.json();
      assert.match(error, /인증 서버/, mode);
      // 화면은 오류 문구에 '로그인'이 있으면 로그인 버튼을 띄운다. 장애에서는 띄우지 않는다.
      assert.doesNotMatch(error, /로그인/, mode);
    } finally {
      jwksDown = false;
    }
  }
});

test('올바른 토큰이면 토큰의 사용자로 저장하고 다시 조회된다', async () => {
  const t = await token();
  const r = await me(bearer(t));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).me, { name: '에이', email: 'a@test.local' });
  const id = await createProject(t);
  const s = await sprint(bearer(t), id);
  assert.equal(s.status, 200, await s.clone().text());
  const list = await (await me(bearer(t))).json();
  assert.ok(list.projects.some((p) => p.id === id));
});

test('검증에 실패한 토큰은 모두 401', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const bad = {
    expired: await token({}, { exp: past }),
    wrongIssuer: await token({}, { iss: 'https://evil.test/auth/v1' }),
    wrongAudience: await token({}, { aud: 'anon' }),
    strangerKey: await token({}, { key: stranger.privateKey }),
    noEmail: await token({ email: undefined }),
    // 이메일·비밀번호 가입은 이메일 소유가 검증되지 않아 초대 사칭에 쓰일 수 있다.
    emailProvider: await token({ app_metadata: { provider: 'email', providers: ['email'] } }),
    noProvider: await token({ app_metadata: undefined }),
    garbage: 'not-a-jwt',
  };
  for (const [name, t] of Object.entries(bad))
    assert.equal((await me(bearer(t))).status, 401, name);
});

test('개발 헤더는 AUTH_DEV_HEADERS=1일 때만, Bearer가 있으면 쓰지 않는다', async () => {
  const dev = {
    'oai-authenticated-user-id': 'mallory',
    'oai-authenticated-user-email': 'a@test.local',
  };
  assert.equal((await me(dev)).status, 401);
  globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE, AUTH_DEV_HEADERS: '1' };
  try {
    assert.equal((await me(dev)).status, 200);
    assert.equal((await me({ ...dev, authorization: 'Bearer not-a-jwt' })).status, 401);
  } finally {
    globalThis.__TEST_ENV = { SUPABASE_URL: SUPABASE };
  }
});

test('다른 계정의 프로젝트는 볼 수 없다', async () => {
  const id = await createProject(await token({ sub: 'owner-x', email: 'x@test.local' }));
  const other = await token({ sub: 'user-y', email: 'y@test.local' });
  assert.equal((await sprint(bearer(other), id)).status, 403);
});

test('대문자가 섞인 Google 이메일도 초대와 일치한다', async () => {
  const owner = await token({ sub: 'owner-z', email: 'z@test.local' });
  const id = await createProject(owner);
  const state = await (await sprint(bearer(owner), id)).json();
  const invite = await projectPost(bearer(owner), {
    action: 'invite',
    projectId: id,
    revision: state.sprint.revision,
    email: 'mate@test.local',
  });
  assert.equal(invite.status, 201, await invite.clone().text());
  const mate = await token({ sub: 'mate-1', email: 'Mate@Test.Local' });
  const accepted = await projectPost(bearer(mate), {
    action: 'accept',
    token: (await invite.json()).token,
    agreed: true,
    goalVersion: state.policy.goalVersion,
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
});

test('로그인 복귀 주소는 이전 OAuth 결과 파라미터를 버리고 초대·생성 정보는 남긴다', async () => {
  const out = join(dir, 'browser.mjs');
  await build({
    stdin: {
      contents: "export { returnUrl } from './lib/supabase-browser';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // 환경값이 없으면 브라우저 클라이언트를 만들지 않는다.
    define: {
      'import.meta.env.VITE_SUPABASE_URL': 'undefined',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': 'undefined',
    },
  });
  const { returnUrl } = await import(pathToFileURL(out).href);
  assert.equal(
    returnUrl(
      'https://app.test/workspace?invite=tok&error=access_denied&error_code=x&error_description=y&code=old#frag',
    ),
    'https://app.test/workspace?invite=tok',
  );
  assert.equal(
    returnUrl('https://app.test/workspace?create=1'),
    'https://app.test/workspace?create=1',
  );
});

test('화면 문구에 이전 ChatGPT 로그인 안내가 남지 않는다', () => {
  for (const file of [
    'components/landing-page.tsx',
    'components/project-workspace.tsx',
    'app/workspace/page.tsx',
    'README.md',
  ])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ChatGPT[^\n]{0,12}로그인|signin-with-chatgpt/, file);
});

test('개발 헤더 플래그는 vite 개발 서버(serve)에서만 켜고 빌드 모드와 무관하다', () => {
  const config = readFileSync('vite.config.ts', 'utf8');
  // `vite build --mode development`도 mode는 development라 산출물에 들어간다.
  assert.match(config, /if \(command === 'serve'\) liveModelVars\.AUTH_DEV_HEADERS = '1';/);
  assert.doesNotMatch(config, /mode === 'development'/);
});
