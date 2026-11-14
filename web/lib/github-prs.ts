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
  /** 마지막 커밋. CI 결과를 찾을 때 쓴다. */
  sha: string;
  updatedAt: string;
};
export type Checks = 'success' | 'failure' | 'pending' | 'none';
export type Review = 'approved' | 'changes_requested' | 'none';
export type PullCommit = { sha: string; message: string; author: string; date: string };
export type PullDetail = { number: number; checks: Checks; review: Review; commits: PullCommit[] };

// PR 목록 응답에는 본문이 들어 있어 커질 수 있다. 작게 나눠 받는다(최근 수정 100개까지).
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const REF = /(?<![A-Za-z0-9])pm-(\d{1,6})(?![A-Za-z0-9])/gi;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA = /^[0-9a-f]{40}$/i;
/** 진행 중 업무가 이 시간 넘게 아무 활동이 없으면 '멈춤'(사용자 결정 2026-11-14). */
export const STALL_HOURS = 12;
/** 업무 상세에서 한 번에 개발 현황을 읽는 PR 수. GitHub 호출 한도 때문에 작게 둔다. */
export const DETAIL_MAX_PULLS = 3;
const MAX_DETAIL_PAGES = 5;

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
    sha: typeof head.sha === 'string' && SHA.test(head.sha) ? head.sha : '',
    updatedAt: typeof raw.updated_at === 'string' && !Number.isNaN(Date.parse(raw.updated_at)) ? raw.updated_at : '',
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
 * - ci_failed: complete 조건이지만 머지된 PR 중 CI가 실패한 것이 있다(아직 모르면 complete).
 */
export function prSuggestion(
  task: { done: boolean; status?: string | null },
  pulls: Pull[],
  checks: Record<number, Checks> = {},
) {
  if (task.done || !pulls.length) return null;
  const open = pulls.some((p) => p.state === 'open');
  if (open) return (task.status ?? 'todo') === 'todo' ? ('start' as const) : null;
  const merged = pulls.filter((p) => p.state === 'merged');
  if (!merged.length) return null;
  return merged.some((p) => checks[p.number] === 'failure') ? ('ci_failed' as const) : ('complete' as const);
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
/** GitHub 체크(Actions 등)와 커밋 상태(Vercel 등)를 하나로 요약한다. 실패 > 진행 중 > 통과. */
export function summarizeChecks(runs: unknown[], status: unknown): Checks {
  const combined = (status ?? {}) as Record<string, unknown>;
  const hasStatus = Number(combined.total_count ?? 0) > 0;
  const rows = runs.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (!rows.length && !hasStatus) return 'none';
  if (rows.some((r) => FAILED.has(String(r.conclusion))) || (hasStatus && ['failure', 'error'].includes(String(combined.state))))
    return 'failure';
  if (rows.some((r) => r.status !== 'completed') || (hasStatus && combined.state !== 'success')) return 'pending';
  return 'success';
}

/** 사람마다 마지막 승인·수정 요청만 본다. 의견(COMMENTED)은 판단을 바꾸지 않는다. */
export function summarizeReviews(reviews: unknown[]): Review {
  const last = new Map<string, string>();
  for (const r of reviews) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const login = field(row.user, 'login');
    const state = String(row.state);
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') last.set(login, state);
  }
  const states = [...last.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  return states.includes('APPROVED') ? 'approved' : 'none';
}

/**
 * 멈춘 업무. 진행 중인데 업무 변경(체크인·상태·상세)과 연결 PR 수정 중 가장 최근 것이
 * STALL_HOURS 넘게 지났으면 지난 시간(시)을, 아니면 null. 마지막 활동을 모르면 null.
 */
export function stalledHours(
  task: { done: boolean; status?: string | null; touchedAt?: string | Date | null },
  pulls: { updatedAt?: string }[],
  now: string | Date,
) {
  if (task.done || task.status !== 'in_progress') return null;
  const times = [task.touchedAt, ...pulls.map((p) => p.updatedAt)]
    .map((v) => (v ? new Date(v).getTime() : NaN))
    .filter((v) => !Number.isNaN(v));
  if (!times.length) return null;
  const hours = Math.floor((new Date(now).getTime() - Math.max(...times)) / 3_600_000);
  return hours >= STALL_HOURS ? hours : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const field = (v: unknown, key: string) => str(((v ?? {}) as Record<string, unknown>)[key]);

function firstLine(text: unknown) {
  return (typeof text === 'string' ? text.split('\n')[0] : '').slice(0, 120);
}

/** 업무 상세를 열 때 PR 하나의 CI·리뷰·최근 커밋 5개를 읽는다(GitHub 호출 5번). */
export async function pullDetail(repo: Repo, number: number, options: FetchOptions): Promise<PullDetail> {
  const base = repoPath(repo);
  const raw = (await getJson(`${base}/pulls/${number}`, options)) as Record<string, unknown> | null;
  const pull = raw && typeof raw === 'object' ? toPull(raw) : null;
  if (!pull) throw new ReviewSourceError('PR을 찾을 수 없습니다.', 404);
  const list = async (path: string) => {
    const value = await getJson(path, options);
    return Array.isArray(value) ? value : [];
  };
  // 크기 초과(null)를 '체크 없음'으로 읽으면 실패한 CI가 통과로 보인다. 오류로 알린다.
  const required = async (path: string) => {
    const value = await getJson(path, options);
    if (value === null)
      throw new ReviewSourceError('CI 결과가 너무 커서 불러오지 못했습니다. GitHub에서 확인해주세요.', 502);
    return value;
  };
  // 체크·리뷰는 뒤쪽에 실패·수정 요청이 있을 수 있어 끝까지 읽는다(최대 MAX_DETAIL_PAGES쪽, 넘으면 오류).
  const allPages = async (path: string, pick: (v: unknown) => { rows: unknown[]; total?: number }) => {
    const rows: unknown[] = [];
    for (let page = 1; page <= MAX_DETAIL_PAGES; page++) {
      const got = pick(await required(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
      rows.push(...got.rows);
      const done = got.total !== undefined ? rows.length >= got.total : got.rows.length < 100;
      if (done || !got.rows.length) return rows;
    }
    throw new ReviewSourceError('CI·리뷰 기록이 너무 많아 불러오지 못했습니다. GitHub에서 확인해주세요.', 502);
  };
  const [runs, status, reviews, commits] = await Promise.all([
    pull.sha
      ? allPages(`${base}/commits/${pull.sha}/check-runs`, (v) => {
          const o = (v ?? {}) as Record<string, unknown>;
          return { rows: Array.isArray(o.check_runs) ? o.check_runs : [], total: Number(o.total_count ?? 0) };
        })
      : [],
    pull.sha ? required(`${base}/commits/${pull.sha}/status`) : null,
    allPages(`${base}/pulls/${number}/reviews`, (v) => ({ rows: Array.isArray(v) ? v : [] })),
    // ponytail: 첫 100개 커밋 중 마지막 5개. 100개 넘는 PR은 최신 커밋을 놓친다, 필요하면 마지막 페이지를 받는다.
    list(`${base}/pulls/${number}/commits?per_page=100`),
  ]);
  return {
    number,
    checks: summarizeChecks(runs, status),
    review: summarizeReviews(reviews),
    commits: commits
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .slice(-5)
      .reverse()
      .map((c) => {
        const commit = (c.commit ?? {}) as Record<string, unknown>;
        const login = field(c.author, 'login');
        const date = field(commit.author, 'date');
        return {
          sha: typeof c.sha === 'string' && SHA.test(c.sha) ? c.sha : '',
          message: firstLine(commit.message),
          author: LOGIN.test(login) ? login : '',
          date: Number.isNaN(Date.parse(date)) ? '' : date,
        };
      }),
  };
}
