// GitHub 이슈 가져오기(2026-11-09). 공개 저장소의 열린 이슈를 고정 경로로 읽고, 고른 이슈를 AI 변경안용 원문으로 묶는다.
// 이슈 제목·본문은 팀원이 아닌 사람도 쓸 수 있는 데이터다. 지시로 실행하지 않고, 원문 감싸기 태그는 무력화한다.
import {
  assertPublicRepo,
  getJson,
  repoPath,
  ReviewSourceError,
  type FetchOptions,
  type Repo,
} from './ai-review-github';
import { MAX_SOURCE } from './source-documents';
import { PolicyError } from './sprint-policy';

export type GithubIssue = {
  number: number;
  title: string;
  body: string;
  author: string;
  assignees: string[];
  labels: string[];
  url: string;
};
export type IssueSpan = {
  issueNumber: number;
  start: number;
  end: number;
  authorLogin: string;
  authorIsMember: boolean;
};

const LIST_SIZE = 50;
const MAX_PICK = 20;
const BODY_CHARS = 2_000;
// 원문 끝 잘림 표시 자리.
const NOTE_RESERVE = 60;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function login(v: unknown) {
  const s = typeof v === 'string' ? v : '';
  return LOGIN.test(s) ? s : '';
}
function toIssue(raw: Record<string, unknown>, withBody: boolean): GithubIssue | null {
  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const user = (raw.user ?? {}) as Record<string, unknown>;
  return {
    number,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: withBody && typeof raw.body === 'string' ? raw.body : '',
    author: login(user.login),
    assignees: (Array.isArray(raw.assignees) ? raw.assignees : [])
      .map((a) => login((a as Record<string, unknown>)?.login))
      .filter(Boolean),
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>)?.name))
      .filter((l): l is string => typeof l === 'string'),
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
  };
}

/** 열린 이슈 목록(최근 수정 순 50개). PR은 뺀다. 본문은 넣지 않는다. */
export async function listOpenIssues(repo: Repo, options: FetchOptions): Promise<GithubIssue[]> {
  await assertPublicRepo(repo, options);
  const query = new URLSearchParams({
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: String(LIST_SIZE),
  });
  const list = await getJson(`${repoPath(repo)}/issues?${query}`, options);
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object' && !(r as Record<string, unknown>).pull_request)
    .map((r) => toIssue(r as Record<string, unknown>, false))
    .filter((i): i is GithubIssue => i !== null);
}

export type Excluded = { number: number; reason: 'closed' | 'pull_request' | 'missing' };

/** 고른 번호를 GitHub에서 다시 읽는다. 화면이 보낸 제목·본문은 쓰지 않는다. */
export async function fetchIssuesByNumber(
  repo: Repo,
  numbers: number[],
  options: FetchOptions,
): Promise<{ issues: GithubIssue[]; excluded: Excluded[] }> {
  await assertPublicRepo(repo, options);
  const issues: GithubIssue[] = [];
  const excluded: Excluded[] = [];
  // ponytail: 번호마다 순서대로 한 번씩(최대 20회). 느리면 병렬로.
  for (const number of numbers) {
    let raw: Record<string, unknown> | null;
    try {
      raw = (await getJson(`${repoPath(repo)}/issues/${number}`, options)) as Record<string, unknown> | null;
    } catch (e) {
      if (e instanceof ReviewSourceError && e.status === 404) raw = null;
      else throw e;
    }
    const issue = raw && toIssue(raw, true);
    if (!raw || !issue || issue.number !== number) excluded.push({ number, reason: 'missing' });
    else if (raw.pull_request) excluded.push({ number, reason: 'pull_request' });
    else if (raw.state !== 'open') excluded.push({ number, reason: 'closed' });
    else issues.push(issue);
  }
  return { issues, excluded };
}

export function parseIssueNumbers(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const ok = list.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1);
  const unique = [...new Set(list as number[])];
  if (!Array.isArray(value) || !ok || unique.length < 1 || unique.length > MAX_PICK)
    throw new PolicyError(`가져올 이슈를 1~${MAX_PICK}개 골라주세요.`);
  return unique;
}

// <source>, </ source > 등 원문 감싸기 태그를 무력화한다.
function defuse(text: string) {
  return text.replace(/<(?=\s*\/?\s*source)/gi, '‹');
}
function oneLine(text: string) {
  return defuse(text).replace(/\s+/g, ' ').trim();
}
function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + '\n…(생략)' : text;
}

/** 고른 이슈를 원문 하나로 묶고 이슈별 위치를 돌려준다. 팀원 판정은 연결된 GitHub 아이디(대소문자 무시). */
export function buildIssueSource(
  issues: GithubIssue[],
  members: { login: string; displayName: string }[],
): { body: string; spans: IssueSpan[]; included: number; total: number } {
  const byLogin = new Map(members.map((m) => [m.login.toLowerCase(), m.displayName]));
  let body = '';
  const spans: IssueSpan[] = [];
  for (const issue of issues) {
    const member = issue.author ? byLogin.get(issue.author.toLowerCase()) : undefined;
    const who = issue.author ? `@${issue.author}` : '(알 수 없음)';
    const meta = [
      `작성자: ${who} (${member !== undefined ? `팀원: ${oneLine(member)}` : '팀원 아님'})`,
      issue.assignees.length ? `담당자: ${issue.assignees.map((a) => '@' + a).join(', ')}` : '',
      issue.labels.length ? `라벨: ${issue.labels.map(oneLine).join(', ')}` : '',
    ].filter(Boolean);
    const block = [
      `[GitHub 이슈 #${issue.number}] ${oneLine(issue.title)}`,
      meta.join(' · '),
      issue.url,
      '---',
      clip(defuse(issue.body), BODY_CHARS),
    ].join('\n');
    const start = body ? body.length + 2 : 0;
    if (start + block.length + NOTE_RESERVE > MAX_SOURCE) break;
    body = body ? body + '\n\n' + block : block;
    spans.push({
      issueNumber: issue.number,
      start,
      end: start + block.length,
      authorLogin: issue.author,
      authorIsMember: member !== undefined,
    });
  }
  if (spans.length < issues.length) body += `\n\n(이슈 ${issues.length}건 중 ${spans.length}건만 포함)`;
  return { body, spans, included: spans.length, total: issues.length };
}

const NON_MEMBER = '팀원이 아닌 사람이 쓴 이슈';

// 인용문이 원문에 나오는 모든 위치. 같은 문장이 여러 이슈에 있으면 모두 본다.
function occurrences(body: string, evidence: { start: number; end: number; quote?: string }) {
  const at = [{ start: evidence.start, end: evidence.end }];
  const quote = evidence.quote ?? '';
  if (!quote) return at;
  for (let i = body.indexOf(quote); i >= 0; i = body.indexOf(quote, i + 1))
    if (i !== evidence.start) at.push({ start: i, end: i + quote.length });
  return at;
}

/** 근거 위치로 이슈를 찾아 경고를 붙인다. 승인은 막지 않는다(표시만). */
export function issueWarnings<
  T extends { kind: string; evidence: { start: number; end: number; quote?: string } | null; needsReview: string },
>(changes: T[], spans: IssueSpan[], imported: Set<number>, body: string): T[] {
  return changes.map((c) => {
    if (!c.evidence) return c;
    const places = occurrences(body, c.evidence);
    const hit = spans.filter((s) => places.some((p) => p.start < s.end && p.end > s.start));
    const notes = c.needsReview ? [c.needsReview] : [];
    if (hit.some((s) => !s.authorIsMember)) notes.push(NON_MEMBER);
    if (c.kind === 'createTask')
      for (const s of hit) if (imported.has(s.issueNumber)) notes.push(`이미 가져온 이슈일 수 있음 (#${s.issueNumber})`);
    return { ...c, needsReview: notes.join(' · ') };
  });
}
