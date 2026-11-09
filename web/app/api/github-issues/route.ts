// GitHub 이슈 가져오기(2026-11-09). 팀장만 저장소를 등록·변경하고, 열린 이슈 중 고른 것만 원문으로 가져온다.
// 가져온 원문은 기존 AI 변경안 흐름(/api/change-proposals)에 그대로 들어간다. 이슈 텍스트는 데이터다.
import { identity, AuthUnavailable, member, actorOf, AccessError } from '@/lib/projects';
import { readPolicy, database } from '@/lib/sprint-store';
import { assertProjectMutationAllowed, PolicyError } from '@/lib/sprint-policy';
import { parseRepoUrl, assertPublicRepo, ReviewSourceError } from '@/lib/ai-review-github';
import { github } from '@/lib/ai-review-runtime';
import { buildIssueSource, fetchIssuesByNumber, listOpenIssues, parseIssueNumbers } from '@/lib/github-issues';
import {
  createIssueSource,
  importedIssueNumbers,
  readProjectRepo,
  setProjectRepo,
  type ProjectRepo,
} from '@/lib/project-repo';
export const dynamic = 'force-dynamic';
// 고른 이슈 20개를 하나씩 다시 읽는 시간.
export const maxDuration = 60;

function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function failure(error: unknown) {
  if (error instanceof AccessError || error instanceof PolicyError || error instanceof ReviewSourceError)
    return reply({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  console.error('github issues request failed', error);
  return reply({ error: '처리하지 못했습니다.' }, 503);
}
function repoView(r: ProjectRepo | null) {
  return r && { owner: r.owner, name: r.name, version: r.version, url: `https://github.com/${r.owner}/${r.name}` };
}
async function requireRepo(projectId: string) {
  const repo = await readProjectRepo(projectId);
  if (!repo) throw new PolicyError('프로젝트 저장소를 먼저 등록해주세요.', 404);
  return repo;
}
// 현재 멤버 중 GitHub를 연결한 사람. 이슈 작성자 팀원 판정에 쓴다.
async function memberLogins(projectId: string) {
  const r = await database()
    .prepare(
      'SELECT g.login,m.display_name FROM project_members m JOIN github_accounts g ON g.user_id=m.user_id WHERE m.project_id=? AND m.left_at IS NULL',
    )
    .bind(projectId)
    .all();
  return r.results.map((x) => ({ login: String(x.login), displayName: String(x.display_name) }));
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project') ?? '';
    const me = await member(projectId, user);
    if (url.searchParams.get('list') !== '1') {
      return reply({
        repo: repoView(await readProjectRepo(projectId)),
        canManage: me.role === 'owner' && !me.left_at,
      });
    }
    assertProjectMutationAllowed({
      policy: await readPolicy(projectId),
      actor: actorOf(me),
      action: 'importIssues',
      now: new Date(),
    });
    const repo = await requireRepo(projectId);
    const issues = await listOpenIssues(repo, github);
    const logins = new Set((await memberLogins(projectId)).map((m) => m.login.toLowerCase()));
    const imported = await importedIssueNumbers(projectId, `${repo.owner}/${repo.name}`, null);
    return reply({
      // 가져오기 요청이 이 목록을 만든 저장소에 묶이도록 version을 함께 돌려준다.
      repoVersion: repo.version,
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title,
        author: i.author,
        authorIsMember: Boolean(i.author) && logins.has(i.author.toLowerCase()),
        assignees: i.assignees,
        labels: i.labels,
        url: i.url,
        imported: imported.has(i.number),
      })),
    });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 5000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const projectId = typeof b.projectId === 'string' ? b.projectId : '';
    const action = String(b.action);
    if (action !== 'setRepo' && action !== 'import') throw new PolicyError('지원하지 않는 작업입니다.');
    const me = await member(projectId, user);
    const now = new Date();
    assertProjectMutationAllowed({
      policy: await readPolicy(projectId),
      actor: actorOf(me),
      action: action === 'setRepo' ? 'setRepo' : 'importIssues',
      now,
    });
    if (action === 'setRepo') {
      const repo = parseRepoUrl(b.repoUrl);
      const version = typeof b.version === 'number' && Number.isInteger(b.version) && b.version >= 0 ? b.version : -1;
      if (version < 0) throw new PolicyError('저장소 버전이 필요합니다.');
      await assertPublicRepo(repo, github);
      return reply({ repo: repoView(await setProjectRepo(projectId, user.id, repo, version, now)) });
    }
    // 화면이 보낸 제목·본문은 쓰지 않는다. 번호만 받아 GitHub에서 다시 읽는다.
    const numbers = parseIssueNumbers(b.numbers);
    const repoVersion = typeof b.repoVersion === 'number' && Number.isInteger(b.repoVersion) ? b.repoVersion : 0;
    if (repoVersion < 1) throw new PolicyError('이슈 목록을 다시 불러와 주세요.');
    const repo = await requireRepo(projectId);
    // 이슈 번호는 저장소마다 다르다. 목록을 본 뒤 저장소가 바뀌었으면 다른 저장소의 이슈를 가져오지 않는다.
    if (repo.version !== repoVersion)
      throw new PolicyError('저장소가 바뀌었습니다. 이슈 목록을 다시 불러와 주세요.', 409);
    const { issues, excluded } = await fetchIssuesByNumber(repo, numbers, github);
    if (!issues.length) return reply({ sourceId: null, excluded, error: '가져올 수 있는 이슈가 없습니다.' });
    const built = buildIssueSource(issues, await memberLogins(projectId));
    const repoName = `${repo.owner}/${repo.name}`;
    const sourceId = await createIssueSource(
      projectId,
      user.id,
      { body: built.body, origin: `GitHub ${repoName} 이슈`, repo: repoName },
      built.spans,
      now,
    );
    if (!sourceId)
      throw new PolicyError('저장하는 사이에 프로젝트가 종료되었거나 팀장 권한이 바뀌었습니다. 최신 상태를 확인해주세요.', 403);
    return reply({ sourceId, included: built.included, total: built.total, excluded }, 201);
  } catch (e) {
    return failure(e);
  }
}
