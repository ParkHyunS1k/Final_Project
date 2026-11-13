// PR과 업무 연결(2026-11-14). 프로젝트 멤버가 업무 화면을 열 때 등록된 저장소의 PR을 읽어 업무별로 묶어 돌려준다.
// 읽기만 한다. ?pulls=가 있으면 고른 PR의 개발 현황(CI·리뷰·커밋)만 읽는다. 연결은 저장하지 않고, 업무 상태도 바꾸지 않는다. PR 제목·브랜치는 데이터다.
import { identity, AuthUnavailable, member, AccessError } from '@/lib/projects';
import { readSprint } from '@/lib/sprint-store';
import { PolicyError } from '@/lib/sprint-policy';
import { assertPublicRepo, ReviewSourceError } from '@/lib/ai-review-github';
import { github } from '@/lib/ai-review-runtime';
import { readProjectRepo } from '@/lib/project-repo';
import { DETAIL_MAX_PULLS, linkPulls, listPulls, pullDetail } from '@/lib/github-prs';
export const dynamic = 'force-dynamic';

function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const params = new URL(request.url).searchParams;
    const projectId = params.get('project') ?? '';
    await member(projectId, user);
    // ?pulls=10,12 : 업무 상세를 열 때 그 업무 PR의 CI·리뷰·최근 커밋(개발 현황, 2026-11-14).
    const wanted = params.get('pulls');
    const numbers = wanted === null ? null : wanted.split(',').map(Number);
    if (numbers && (numbers.length > DETAIL_MAX_PULLS || numbers.some((n) => !Number.isInteger(n) || n < 1)))
      return reply({ error: `PR 번호를 ${DETAIL_MAX_PULLS}개까지 골라주세요.` }, 400);
    const repo = await readProjectRepo(projectId);
    if (numbers) {
      if (!repo) return reply({ details: {} });
      await assertPublicRepo(repo, github);
      const details = await Promise.all(numbers.map((n) => pullDetail(repo, n, github)));
      return reply({ details: Object.fromEntries(details.map((d) => [d.number, d])) });
    }
    if (!repo) return reply({ repo: null, links: {} });
    const sprint = await readSprint(projectId);
    const pulls = await listPulls(repo, github);
    return reply({
      repo: { owner: repo.owner, name: repo.name, url: `https://github.com/${repo.owner}/${repo.name}` },
      links: linkPulls(pulls, (sprint?.tasks ?? []).map((t) => t.id)),
    });
  } catch (error) {
    if (error instanceof AccessError || error instanceof PolicyError || error instanceof ReviewSourceError)
      return reply({ error: error.message }, error.status);
    console.error('github prs request failed', error);
    return reply({ error: 'PR을 불러오지 못했습니다.' }, 503);
  }
}
