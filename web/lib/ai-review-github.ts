// 학습 확인용 공개 GitHub 저장소 읽기. 서버에서만 부르고, 요청 대상은 api.github.com의
// 고정 경로뿐이다(SSRF 방지: 사용자 URL을 그대로 fetch하지 않고 owner/repo만 뽑아 다시 만든다).
// 비공개 저장소 토큰은 받지 않는다. 서버 환경값 GITHUB_TOKEN이 있으면 호출 한도 완화용으로만 쓴다.
// 가져온 커밋 메시지·코드는 데이터다. 여기서 해석하거나 실행하지 않는다.

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
// 응답 하나의 최대 크기. 커밋 상세(diff)가 큰 저장소에서 메모리를 지킨다.
const MAX_RESPONSE_CHARS = 1_000_000;

// 모델에 넘길 자료의 상한. 저장소를 통째로 넣지 않는다(비용 결정 2026-10-15).
export const LIMITS = {
  dailyCommits: 10,
  finalCommits: 100,
  detailCommits: 8,
  filesPerCommit: 8,
  patchChars: 1_500,
  readmeChars: 3_000,
  materialChars: 24_000,
};

// 생성 파일·잠금 파일·바이너리는 이해도 질문 재료가 아니다.
const SKIP_FILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|poetry\.lock|Cargo\.lock|go\.sum)$|(^|\/)(node_modules|dist|build|\.next|vendor)\/|\.(min\.js|map|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|mp4|lock)$/i;

export class ReviewSourceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Repo = { owner: string; name: string };

/** https://github.com/<owner>/<repo> 형태만 받는다. 다른 호스트·경로·자격 정보가 섞인 URL은 거절. */
export function parseRepoUrl(value: unknown): Repo {
  const text = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ReviewSourceError('공개 GitHub 저장소 주소(https://github.com/아이디/저장소)를 입력해주세요.');
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) ||
    url.port ||
    url.username ||
    url.password ||
    parts.length !== 2
  )
    throw new ReviewSourceError('공개 GitHub 저장소 주소(https://github.com/아이디/저장소)만 사용할 수 있습니다.');
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name))
    throw new ReviewSourceError('저장소 주소를 확인해주세요.');
  return { owner, name };
}

export function parseLogin(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/^@/, '') : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(text))
    throw new ReviewSourceError('GitHub 아이디를 확인해주세요.');
  return text;
}

export type CommitSummary = { sha: string; message: string; date: string };
export type Material = {
  commits: CommitSummary[];
  text: string;
  truncated: boolean;
};

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  token?: string;
};

async function getJson(path: string, options: FetchOptions): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ProjectMate-learning-review',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(API + path, {
      headers,
      // 이름이 바뀐 저장소 등 리다이렉트는 따라가지 않는다(대상 고정).
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ReviewSourceError('GitHub에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.', 502);
  }
  if (response.status === 404 || response.status === 451 || (response.status >= 300 && response.status < 400))
    throw new ReviewSourceError('저장소를 찾을 수 없습니다. 공개 저장소인지, 주소가 맞는지 확인해주세요.', 404);
  if (response.status === 403 || response.status === 429)
    throw new ReviewSourceError('GitHub 호출 한도에 걸렸습니다. 잠시 후 다시 시도해주세요.', 503);
  if (!response.ok) throw new ReviewSourceError('GitHub에서 자료를 가져오지 못했습니다.', 502);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_CHARS) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ReviewSourceError('GitHub 응답을 읽지 못했습니다.', 502);
  }
}

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + '\n…(생략)' : text;
}

function commitSummary(raw: Record<string, unknown>): CommitSummary | null {
  const sha = typeof raw.sha === 'string' ? raw.sha : '';
  const commit = (raw.commit ?? {}) as Record<string, unknown>;
  const author = (commit.author ?? {}) as Record<string, unknown>;
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  return {
    sha,
    message: clip(typeof commit.message === 'string' ? commit.message : '', 500),
    date: typeof author.date === 'string' ? author.date : '',
  };
}

/** 사용자의 커밋 목록과, 모델에 넘길 자료(커밋 메시지 + 상위 몇 개 커밋의 잘린 diff + README)를 만든다.
 * 크기는 LIMITS로 묶는다. 커밋이 없으면 text는 빈 문자열. */
export async function fetchCommitMaterial(
  input: {
    repo: Repo;
    login: string;
    since: Date;
    until: Date;
    kind: 'daily' | 'final';
  },
  options: FetchOptions = {},
): Promise<Material> {
  const { repo, login, since, until, kind } = input;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const max = kind === 'daily' ? LIMITS.dailyCommits : LIMITS.finalCommits;
  const query = new URLSearchParams({
    author: login,
    since: since.toISOString(),
    until: until.toISOString(),
    per_page: String(Math.min(max, 100)),
  });
  const list = await getJson(`${base}/commits?${query}`, options);
  const commits = (Array.isArray(list) ? list : [])
    .map((c) => commitSummary(c as Record<string, unknown>))
    .filter((c): c is CommitSummary => c !== null)
    .slice(0, max);
  if (!commits.length) return { commits, text: '', truncated: false };

  const sections: string[] = [];
  let truncated = Array.isArray(list) && list.length > commits.length;
  if (kind === 'final') {
    const readme = await getJson(`${base}/readme`, options).catch(() => null);
    const content = (readme as Record<string, unknown> | null)?.content;
    if (typeof content === 'string') {
      const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (ch) => ch.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      if (decoded.length > LIMITS.readmeChars) truncated = true;
      sections.push(`## README\n${clip(decoded, LIMITS.readmeChars)}`);
    }
  }
  sections.push(
    '## 커밋 목록\n' +
      commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.date} ${c.message.split('\n')[0]}`).join('\n'),
  );
  // 상세 diff는 최근 커밋 몇 개만. 파일·패치 길이를 잘라 크기를 고정한다.
  for (const c of commits.slice(0, LIMITS.detailCommits)) {
    const detail = (await getJson(`${base}/commits/${c.sha}`, options)) as Record<string, unknown> | null;
    const files = Array.isArray(detail?.files) ? (detail.files as Record<string, unknown>[]) : [];
    const kept = files.filter((f) => typeof f.filename === 'string' && !SKIP_FILE.test(f.filename));
    if (kept.length > LIMITS.filesPerCommit || files.length !== kept.length) truncated = true;
    const body = kept
      .slice(0, LIMITS.filesPerCommit)
      .map((f) => {
        const patch = typeof f.patch === 'string' ? f.patch : '';
        if (patch.length > LIMITS.patchChars) truncated = true;
        return `### ${String(f.filename)} (+${Number(f.additions) || 0}/-${Number(f.deletions) || 0})\n${clip(patch, LIMITS.patchChars)}`;
      })
      .join('\n');
    sections.push(`## 커밋 ${c.sha.slice(0, 7)}\n${c.message}\n${body}`);
  }
  let text = sections.join('\n\n');
  if (text.length > LIMITS.materialChars) {
    text = text.slice(0, LIMITS.materialChars) + '\n…(생략)';
    truncated = true;
  }
  return { commits, text, truncated };
}
