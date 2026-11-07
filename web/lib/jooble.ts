export type JoobleJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  snippet: string;
  salary: string;
  source: string;
  type: string;
  link: string;
  updated: string;
};

export type JoobleSearchResult = {
  totalCount: number;
  jobs: JoobleJob[];
  page: number;
  resultOnPage: number;
  keywords: string;
  location: string;
};

export class JoobleError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'JoobleError';
  }
}

function text(value: unknown, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function httpsLink(value: unknown) {
  const raw = text(value, 2000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function jobFrom(value: unknown, index: number): JoobleJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  const title = text(job.title, 200);
  const link = httpsLink(job.link);
  if (!title || !link) return null;
  return {
    id: text(job.id, 120) || `${index}:${link}`,
    title,
    company: text(job.company, 200),
    location: text(job.location, 200),
    snippet: text(job.snippet, 4000),
    salary: text(job.salary, 200),
    source: text(job.source, 200),
    type: text(job.type, 120),
    link,
    updated: text(job.updated, 80),
  };
}

export function joobleEndpoint(apiKey: string) {
  // The key issued from kr.jooble.org is paired with the Korean regional host.
  return `https://kr.jooble.org/api/${encodeURIComponent(apiKey)}`;
}

export async function searchJooble(input: {
  keywords: string;
  location: string;
  radius?: number;
  page?: number;
  resultOnPage?: number;
  companySearch?: boolean;
}): Promise<JoobleSearchResult> {
  const apiKey = process.env.JOOBLE_API_KEY?.trim();
  if (!apiKey)
    throw new JoobleError(
      // 키가 없으면 다른 AI 기능처럼 '준비 중'. 설정 위치는 사용자에게 보이지 않는다(web/.env.example).
      '공고 찾기는 준비 중이에요.',
      503,
    );

  const keywords = text(input.keywords, 120);
  const location = text(input.location, 120);
  if (keywords.length < 2)
    throw new JoobleError('검색어를 두 글자 이상 입력해주세요.', 400);
  if (!location) throw new JoobleError('근무 지역을 입력해주세요.', 400);

  const page = Math.min(10, Math.max(1, Math.floor(input.page ?? 1)));
  const resultOnPage = Math.min(
    20,
    Math.max(1, Math.floor(input.resultOnPage ?? 10)),
  );
  const radius = input.radius;
  const allowedRadius = [0, 4, 8, 16, 26, 40, 80];
  const body: Record<string, unknown> = {
    keywords,
    location,
    page: String(page),
    ResultOnPage: String(resultOnPage),
    companysearch: Boolean(input.companySearch),
  };
  if (radius !== undefined && allowedRadius.includes(radius))
    body.radius = String(radius);

  let response: Response;
  try {
    response = await fetch(joobleEndpoint(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new JoobleError(
      'Jooble에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',
      502,
    );
  }

  if (!response.ok) {
    if (response.status === 403)
      throw new JoobleError(
        'Jooble API 키가 유효하지 않거나 한국용 키가 아닙니다.',
        502,
      );
    if (response.status === 429)
      throw new JoobleError(
        'Jooble API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.',
        429,
      );
    if (response.status === 404)
      throw new JoobleError(
        'Jooble 한국 API 주소를 찾지 못했습니다. API 키 발급 지역을 확인해주세요.',
        502,
      );
    throw new JoobleError('Jooble 공고를 불러오지 못했습니다.', 502);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new JoobleError('Jooble 응답을 읽지 못했습니다.', 502);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new JoobleError('Jooble 응답 형식을 확인해주세요.', 502);
  const data = raw as Record<string, unknown>;
  const jobs = Array.isArray(data.jobs)
    ? data.jobs.map(jobFrom).filter((job): job is JoobleJob => job !== null)
    : [];
  const totalCount =
    typeof data.totalCount === 'number' && Number.isFinite(data.totalCount)
      ? Math.max(0, Math.floor(data.totalCount))
      : jobs.length;
  return { totalCount, jobs, page, resultOnPage, keywords, location };
}
