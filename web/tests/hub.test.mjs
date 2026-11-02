import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setupTestDb } from './helpers/pg-db.mjs';
process.env.AUTH_DEV_HEADERS = '1';
delete process.env.OPENAI_API_KEY;
const db = await setupTestDb();
const out = join(mkdtempSync(join(tmpdir(), 'hub-test-')), 'api.mjs');
await build({
  stdin: {
    contents: `export {GET,POST} from './app/api/hub/route'; export {GET as sprintGET,POST as sprintPOST} from './app/api/sprint/route'; export {GET as careerGET,POST as careerPOST} from './app/api/career/route'; export {POST as projectPOST} from './app/api/projects/route'; export {GET as teamsGET,POST as teamsPOST} from './app/api/teams/route'; export {TEMPLATES,scopedTemplate} from './lib/career/catalog'; export {learningStats,safeLink} from './lib/hub'; export {appDestination} from './lib/app-navigation';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'memory-db',
      setup(b) {
        b.onResolve({ filter: /^\.\/db$/ }, () => ({
          path: 'db',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export function database(){return globalThis.__TEST_DB}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(out).href);
after(async () => {
  await globalThis.__TEST_DB.close();
});
const headers = (user) => ({
  'content-type': 'application/json',
  origin: 'https://test.local',
  ...(user
    ? {
        'oai-authenticated-user-id': user,
        'oai-authenticated-user-email': user + '@test.local',
      }
    : {}),
});
const req = (user, body, path = '/api/hub', extra = {}) =>
  new Request('https://test.local' + path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { ...headers(user), ...extra },
  });
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const post = (user, body) => api.POST(req(user, body));
const read = async (user) => json(await api.GET(req(user)));
const state = async (user, id) =>
  json(await api.sprintGET(req(user, null, '/api/sprint?project=' + id)));
const team = async (user, id) =>
  json(await api.careerGET(req(user, null, '/api/career?project=' + id)));
const createBody = (over = {}) => ({
  action: 'createTemplate',
  templateId: 'search-api',
  scopeLevel: 1,
  mode: 'solo',
  listed: false,
  agreed: true,
  requestId: crypto.randomUUID(),
  ...over,
});
async function create(user, over) {
  return (await json(await post(user, createBody(over)), 201)).projectId;
}
async function sprint(user, id, action, fields = {}, status = 200) {
  const s = await state(user, id);
  return json(
    await api.sprintPOST(
      req(user, {
        action,
        projectId: id,
        revision: s.sprint.revision,
        ...fields,
      }),
    ),
    status,
  );
}

test('랜딩은 루트에 남고 기존 링크는 하나의 앱으로 이동한다', () => {
  const root = readFileSync('app/page.tsx', 'utf8');
  assert.match(root, /return <LandingPage/);
  assert.doesNotMatch(root, /<Workspace/);
  assert.equal(
    api.appDestination({ invite: 'a&b', view: 'tasks' }, 'work'),
    '/app?tab=work&invite=a%26b&view=tasks',
  );
  assert.match(
    readFileSync('app/workspace/page.tsx', 'utf8'),
    /redirect\(appDestination/,
  );
  assert.match(
    readFileSync('app/career/page.tsx', 'utf8'),
    /redirect\(appDestination/,
  );
});
test('20개 템플릿의 모든 범위는 유효한 역할과 닫힌 비순환 의존관계를 가진다', () => {
  assert.equal(api.TEMPLATES.length, 20);
  assert.equal(new Set(api.TEMPLATES.map((t) => t.id)).size, 20);
  for (const template of api.TEMPLATES) {
    let previous = 0;
    for (const level of [1, 2, 3]) {
      const scoped = api.scopedTemplate(template, level);
      assert.ok(scoped.tasks.length >= previous);
      previous = scoped.tasks.length;
      const keys = new Set(scoped.tasks.map((t) => t.key));
      const visit = (key, path = []) => {
        assert.ok(!path.includes(key), 'cycle');
        const t = scoped.tasks.find((t) => t.key === key);
        assert.ok(t);
        for (const d of t.dependsOn) visit(d, [...path, key]);
      };
      for (const task of scoped.tasks) {
        assert.ok(task.dependsOn.every((d) => keys.has(d)));
        assert.ok(scoped.roles.some((r) => r.id === task.role));
        visit(task.key);
      }
    }
    assert.equal(previous, template.tasks.length);
  }
});
test('인증과 출처 검사로 무단 쓰기를 차단한다', async () => {
  await json(await api.GET(req(null)), 401);
  await json(await post(null, createBody()), 401);
  await json(
    await api.POST(
      req('guard', createBody(), '/api/hub', { origin: 'https://other.local' }),
    ),
    403,
  );
  await json(await post('guard', createBody({ scopeLevel: 4 })), 400);
  await json(await post('guard', createBody({ agreed: false })), 400);
});
test('이력서 없이 생성하고 재시도·동시 제출해도 같은 프로젝트 한 개만 생긴다', async () => {
  const body = createBody();
  const values = await Promise.all([post('solo', body), post('solo', body)]);
  const a = await json(values[0], 201),
    b = await json(values[1], 201);
  assert.equal(a.projectId, b.projectId);
  const s = await state('solo', a.projectId);
  assert.equal(s.sprint.tasks.length, 2);
  assert.equal(s.policy.minMembers, 1);
  assert.equal(s.policy.completionMode, 'tasks');
  assert.deepEqual(s.deliverables, []);
  assert.equal(s.agreement.completion_criteria, '');
  assert.equal(s.readiness.ready, true);
  assert.equal((await read('solo')).projects.length, 1);
  assert.equal(
    (
      await db.one(
        'SELECT profile_id FROM career_project_links WHERE project_id=?',
        a.projectId,
      )
    ).profile_id,
    null,
  );
});
test('솔로 시작·업무 근거·완료가 실제 API로 연결된다', async () => {
  const id = await create('finish');
  assert.equal((await sprint('finish', id, 'start')).lifecycle, 'active');
  await sprint('finish', id, 'finish', {}, 400);
  for (const task of (await state('finish', id)).sprint.tasks)
    await sprint('finish', id, 'task', {
      taskId: task.id,
      done: true,
      evidence: '합성 테스트: 구현 코드와 검증 기록',
    });
  assert.equal((await state('finish', id)).completion.ready, true);
  assert.equal((await sprint('finish', id, 'finish')).lifecycle, 'completed');
  await sprint(
    'finish',
    id,
    'task',
    { taskId: 1, done: false, remaining: 2 },
    400,
  );
});
test('범위를 줄인 계획으로 역할안을 적용해도 제외했던 업무가 다시 생기지 않는다', async () => {
  const id = await create('roles', { scopeLevel: 1 });
  let s = await team('roles', id);
  assert.equal(s.template.tasks.length, 2);
  await json(
    await api.careerPOST(
      req('roles', {
        action: 'recommendRoles',
        projectId: id,
        revision: s.revision,
      }),
    ),
    201,
  );
  s = await team('roles', id);
  await json(
    await api.careerPOST(
      req('roles', {
        action: 'applyRoles',
        projectId: id,
        revision: s.revision,
        proposalId: s.proposal.id,
        approved: true,
        assignments: s.template.roles.map((r) => ({ role: r.id, person: 0 })),
      }),
    ),
  );
  assert.equal((await state('roles', id)).sprint.tasks.length, 2);
});
test('공개 동의한 모집 팀만 홈에 보이고 이력서·개인 자료는 노출하지 않는다', async () => {
  const publicId = await create('public-owner', { mode: 'team', listed: true });
  const privateId = await create('private-owner', {
    mode: 'team',
    listed: false,
  });
  const soloId = await create('private-solo', { mode: 'solo', listed: true });
  await json(
    await post('public-owner', {
      action: 'saveRecord',
      kind: 'portfolio',
      id: crypto.randomUUID(),
      title: '비공개 자료',
      text: 'NEVER_PUBLIC_SECRET',
      url: '',
    }),
  );
  const viewer = await read('viewer');
  assert.ok(viewer.directory.some((p) => p.project_id === publicId));
  assert.ok(
    !viewer.directory.some((p) => [privateId, soloId].includes(p.project_id)),
  );
  assert.deepEqual(viewer.records, []);
  assert.ok(!JSON.stringify(viewer).includes('NEVER_PUBLIC_SECRET'));
  await json(
    await api.sprintGET(req('viewer', null, '/api/sprint?project=' + publicId)),
    403,
  );
});
test('관심 전달은 이름 공유 동의를 요구하고 멤버십이나 프로젝트 접근권한을 만들지 않는다', async () => {
  const id = await create('interest-owner', { mode: 'team', listed: true });
  await json(
    await post('interested', { action: 'interest', projectId: id }),
    400,
  );
  await json(
    await post('interested', {
      action: 'interest',
      projectId: id,
      consent: true,
    }),
  );
  await json(
    await post('interested', {
      action: 'interest',
      projectId: id,
      consent: true,
    }),
  );
  assert.equal(
    (await read('interest-owner')).interests.filter((i) => i.project_id === id)
      .length,
    1,
  );
  assert.equal((await read('observer')).interests.length, 0);
  assert.equal(
    await db.one(
      'SELECT user_id FROM project_members WHERE project_id=? AND user_id=?',
      id,
      'interested',
    ),
    null,
  );
});
test('비공개 전환은 팀장만 가능하고 새 관심 요청과 만료 팀 노출을 차단한다', async () => {
  const id = await create('listing-owner', { mode: 'team', listed: true });
  await json(
    await post('other', {
      action: 'listing',
      projectId: id,
      listed: false,
      revision: 0,
    }),
    403,
  );
  await json(
    await post('listing-owner', {
      action: 'listing',
      projectId: id,
      listed: false,
      revision: 99,
    }),
    409,
  );
  await json(
    await post('listing-owner', {
      action: 'listing',
      projectId: id,
      listed: false,
      revision: 0,
    }),
  );
  await json(
    await post('someone', { action: 'interest', projectId: id, consent: true }),
    409,
  );
  assert.ok(
    !(await read('someone')).directory.some((p) => p.project_id === id),
  );
  await db.run('UPDATE hub_projects SET listed=true WHERE project_id=?', id);
  await db.run(
    "UPDATE project_policy SET lifecycle='active',deadline_at=now()-interval '1 day' WHERE project_id=?",
    id,
  );
  assert.ok(
    !(await read('someone')).directory.some((p) => p.project_id === id),
  );
});
test('관심 요청에서 실제 초대·본인 목표 동의·합류까지 연결하며 토큰은 본인만 읽는다', async () => {
  const id = await create('recruit-owner', { mode: 'team', listed: true });
  await json(
    await post('recruit-mate', {
      action: 'interest',
      projectId: id,
      consent: true,
    }),
  );
  await json(
    await post('intruder', {
      action: 'inviteInterested',
      projectId: id,
      userId: 'recruit-mate',
      revision: 0,
    }),
    403,
  );
  await json(
    await post('recruit-owner', {
      action: 'inviteInterested',
      projectId: id,
      userId: 'recruit-mate',
      revision: 0,
    }),
  );
  const invitation = (await read('recruit-mate')).invitations.find(
    (i) => i.project_id === id,
  );
  assert.ok(invitation?.token);
  assert.deepEqual((await read('intruder')).invitations, []);
  assert.ok(
    !JSON.stringify((await read('intruder')).directory).includes(
      invitation.token,
    ),
  );
  assert.ok(
    !JSON.stringify((await read('recruit-owner')).interests).includes(
      invitation.token,
    ),
  );
  await json(
    await api.projectPOST(
      req('recruit-mate', {
        action: 'accept',
        token: invitation.token,
        agreed: true,
        goalVersion: 1,
      }),
    ),
  );
  assert.equal((await state('recruit-mate', id)).members.length, 2);
  assert.deepEqual((await read('recruit-mate')).invitations, []);
});
test('초대 저장 직전 권한 변경은 실제 초대와 관심 요청 갱신을 함께 거절한다', async () => {
  const id = await create('invite-race-owner', { mode: 'team', listed: true });
  await json(
    await post('invite-race-mate', {
      action: 'interest',
      projectId: id,
      consent: true,
    }),
  );
  globalThis.__BEFORE_WRITE_SQL = 'UPDATE sprints SET revision';
  globalThis.__BEFORE_WRITE = () =>
    db.run("UPDATE project_members SET role='member' WHERE project_id=?", id);
  await json(
    await post('invite-race-owner', {
      action: 'inviteInterested',
      projectId: id,
      userId: 'invite-race-mate',
      revision: 0,
    }),
    409,
  );
  assert.equal(
    (
      await db.one(
        'SELECT invitation FROM hub_interests WHERE project_id=?',
        id,
      )
    ).invitation,
    null,
  );
  assert.equal(
    (await db.rows('SELECT id FROM project_invites WHERE project_id=?', id))
      .length,
    0,
  );
});
test('저장 직전 팀장 권한이 철회되면 공개 상태를 바꾸지 못한다', async () => {
  const id = await create('race-owner', { mode: 'team', listed: false });
  globalThis.__BEFORE_WRITE_SQL = 'UPDATE hub_projects';
  globalThis.__BEFORE_WRITE = () =>
    db.run("UPDATE project_members SET role='member' WHERE project_id=?", id);
  await json(
    await post('race-owner', {
      action: 'listing',
      projectId: id,
      listed: true,
      revision: 0,
    }),
    409,
  );
  assert.equal(
    (await db.one('SELECT listed FROM hub_projects WHERE project_id=?', id))
      .listed,
    false,
  );
});
test('포트폴리오·공고는 계정별로 저장되며 같은 기록을 수정할 수 있다', async () => {
  const id = crypto.randomUUID();
  await json(
    await post('records', {
      action: 'saveRecord',
      kind: 'portfolio',
      id,
      title: '내 구현',
      text: 'Python으로 구현한 나의 기여',
      url: 'https://github.com/example/demo',
    }),
  );
  await json(
    await post('records', {
      action: 'saveRecord',
      kind: 'portfolio',
      id,
      title: '수정 제목',
      text: '수정 본문',
      url: '',
    }),
  );
  assert.equal((await read('records')).records.length, 1);
  assert.equal((await read('records')).records[0].payload.title, '수정 제목');
  assert.deepEqual((await read('records-other')).records, []);
  await json(
    await post('records', {
      action: 'saveRecord',
      kind: 'job',
      id: crypto.randomUUID(),
      title: '관심 공고',
      text: 'Docker 경험 우대',
      url: 'javascript:alert(1)',
    }),
    400,
  );
  assert.throws(() => api.safeLink('https://user:password@example.com'));
});
test('같은 날 체크인을 여러 번 하거나 쉬기로 바꿔도 점수가 부풀지 않는다', async () => {
  await json(
    await post('checkin', {
      action: 'checkin',
      status: 'studied',
      skills: ['python'],
    }),
  );
  await json(
    await post('checkin', {
      action: 'checkin',
      status: 'studied',
      skills: ['sql'],
    }),
  );
  let user = await read('checkin');
  assert.equal(user.records.length, 1);
  assert.equal(user.stats.points, 10);
  assert.equal(user.stats.streak, 1);
  await json(
    await post('checkin', { action: 'checkin', status: 'rest', skills: [] }),
  );
  user = await read('checkin');
  assert.equal(user.stats.points, 0);
  assert.equal(user.stats.streak, 0);
  await json(
    await post('checkin', {
      action: 'checkin',
      status: 'studied',
      skills: ['unknown'],
    }),
    400,
  );
});
test('연속 학습은 한국 날짜 경계를 사용하고 유효 경험만 점수 인자로 받는다', () => {
  const records = ['2026-10-06', '2026-10-07', '2026-10-08'].map((day) => ({
    id: 'checkin:' + day,
    kind: 'checkin',
    payload: { status: 'studied' },
  }));
  const s = api.learningStats(records, 1, new Date('2026-10-08T15:00:01Z'));
  assert.equal(s.streak, 3);
  assert.equal(s.points, 60);
  assert.ok(s.badges.includes('3일 연속 학습'));
  assert.equal(
    api.learningStats(records, 0, new Date('2026-10-09T15:00:01Z')).streak,
    0,
  );
});

test('old team and create links open the unified app destinations', () => {
  assert.equal(api.appDestination({ teams: '1' }, 'work'), '/app?tab=teams');
  assert.equal(api.appDestination({ create: '1' }, 'work'), '/app?tab=create');
  assert.equal(
    api.appDestination({ teams: '1', invite: 'token' }, 'work'),
    '/app?tab=work&invite=token',
  );
});

test('template teams share listing state and support main participation approval', async () => {
  const owner = 'merged-template-owner',
    applicant = 'merged-template-applicant';
  const id = await create(owner, { mode: 'team', listed: true });
  const listed = await json(
    await api.teamsGET(req(applicant, null, '/api/teams')),
  );
  assert.ok(listed.teams.some((t) => t.projectId === id));
  const application = await json(
    await api.teamsPOST(
      req(
        applicant,
        {
          action: 'request',
          projectId: id,
          goalVersion: 1,
          agreed: true,
        },
        '/api/teams',
      ),
    ),
    201,
  );
  const before = await state(owner, id);
  await json(
    await api.projectPOST(
      req(
        owner,
        {
          action: 'decideJoin',
          projectId: id,
          revision: before.sprint.revision,
          requestId: application.requestId,
          approve: true,
        },
        '/api/projects',
      ),
    ),
  );
  assert.equal((await state(applicant, id)).me.role, 'member');
  assert.ok(await db.one('SELECT user_id FROM project_members WHERE project_id=? AND user_id=?', id, applicant));
  const after = await state(owner, id);
  await json(
    await api.projectPOST(
      req(
        owner,
        {
          action: 'setListed',
          projectId: id,
          revision: after.sprint.revision,
          listed: false,
        },
        '/api/projects',
      ),
    ),
  );
  assert.ok(
    !(await read('merged-visitor')).directory.some((t) => t.project_id === id),
  );
  assert.equal(
    (await read(owner)).settings.find((t) => t.project_id === id).listed,
    false,
  );
  assert.equal(
    (await db.one('SELECT listed FROM hub_projects WHERE project_id=?', id))
      .listed,
    false,
  );
});

test('main projects appear on the unified home and can still start solo', async () => {
  const owner = 'merged-main-owner';
  const { projectId: id } = await json(
    await api.projectPOST(
      req(
        owner,
        {
          action: 'create',
          title: 'Shared main project',
          goal: 'Build a working service',
          scope: 'Core API',
          completionCriteria: 'Verify the API response',
          duration: 7,
          agreed: true,
        },
        '/api/projects',
      ),
    ),
    201,
  );
  await json(
    await api.projectPOST(
      req(
        owner,
        {
          action: 'setListed',
          projectId: id,
          revision: 0,
          listed: true,
        },
        '/api/projects',
      ),
    ),
  );
  const card = (await read('merged-main-visitor')).directory.find(
    (t) => t.project_id === id,
  );
  assert.ok(card);
  assert.equal(card.template, null);
  assert.equal(card.goal, 'Build a working service');
  const started = await sprint(owner, id, 'start');
  assert.equal(started.lifecycle, 'active');
});
