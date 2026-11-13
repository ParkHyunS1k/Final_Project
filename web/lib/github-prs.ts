// PR과 업무 연결(2026-11-14). 프로젝트에 등록된 공개 저장소의 PR 중 제목·브랜치에 'PM-번호'가 있는 것을 그 업무에 붙인다.
// 연결은 저장하지 않고 화면을 열 때 계산한다. 상태를 자동으로 바꾸지 않고 '진행 중'·'완료' 제안만 만든다.
import {
  assertPublicRepo,
  getJson,
  repoPath,
  ReviewSourceError,
  type FetchOptions,
  type Repo,
} from './ai-review-github';

export type PullState = 'open' | 'merged' | 'closed';
export type Pull = {
  number: number;
  title: string;
  state: PullState;
  branch: string;
  author: string;
  url: string;
};

// PR 목록 응답에는 본문이 들어 있어 커질 수 있다. 작게 나눠 받는다(최근 수정 100개까지).
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const REF = /(?<![A-Za-z0-9])pm-(\d{1,6})(?![A-Za-z0-9])/gi;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** 업무 번호 표시. 프로젝트 안의 업무 id를 쓴다. */
export function taskRef(id: number) {
  return `PM-${id}`;
}

/** 복사용 브랜치 이름. 영문·숫자만 슬러그로 남긴다(한글 제목이면 번호만). */
export function branchName(id: number, title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug ? `pm-${id}-${slug}` : `pm-${id}`;
}

/** PR 제목·브랜치에 나온 업무 번호(중복 없이, 나온 순서). 다른 글자에 붙은 pm-은 무시한다. */
export function taskIdsIn(title: string, branch: string) {
  const ids: number[] = [];
  for (const text of [title, branch])
    for (const m of text.matchAll(REF)) {
      const id = Number(m[1]);
      if (!ids.includes(id)) ids.push(id);
    }
  return ids;
}

export function toPull(raw: Record<string, unknown>): Pull | null {
  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const head = (raw.head ?? {}) as Record<string, unknown>;
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const login = typeof user.login === 'string' && LOGIN.test(user.login) ? user.login : '';
  return {
    number,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
    state: raw.merged_at ? 'merged' : raw.state === 'open' ? 'open' : 'closed',
    branch: typeof head.ref === 'string' ? head.ref.slice(0, 200) : '',
    author: login,
    url: typeof raw.html_url === 'string' && raw.html_url.startsWith('https://github.com/') ? raw.html_url : '',
  };
}

/** 최근 수정된 PR 100개까지(열림·닫힘 모두). 응답이 너무 크면 빈 목록으로 숨기지 않고 오류로 알린다. */
export async function listPulls(repo: Repo, options: FetchOptions): Promise<Pull[]> {
  await assertPublicRepo(repo, options);
  const pulls: Pull[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const list = await getJson(`${repoPath(repo)}/pulls?${query}`, options);
    if (list === null)
      throw new ReviewSourceError('PR 목록이 너무 커서 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', 502);
    const rows = Array.isArray(list) ? list : [];
    for (const r of rows) {
      const p = r && typeof r === 'object' ? toPull(r as Record<string, unknown>) : null;
      if (p) pulls.push(p);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return pulls;
}

/** 업무 id별 연결 PR. 프로젝트에 없는 업무 번호는 버린다. */
export function linkPulls(pulls: Pull[], taskIds: number[]) {
  const known = new Set(taskIds);
  const links: Record<number, Pull[]> = {};
  for (const p of pulls)
    for (const id of taskIdsIn(p.title, p.branch))
      if (known.has(id)) (links[id] ??= []).push(p);
  return links;
}

/**
 * 제안 규칙. 상태를 바꾸지 않고 사람이 누르게 한다.
 * - start: 시작 전 업무에 열린 PR이 있다.
 * - complete: 열린 PR이 하나도 없고 머지된 PR이 있다(모든 PR이 머지돼야 완료).
 */
export function prSuggestion(task: { done: boolean; status?: string | null }, pulls: Pull[]) {
  if (task.done || !pulls.length) return null;
  const open = pulls.some((p) => p.state === 'open');
  if (open) return (task.status ?? 'todo') === 'todo' ? ('start' as const) : null;
  return pulls.some((p) => p.state === 'merged') ? ('complete' as const) : null;
}
