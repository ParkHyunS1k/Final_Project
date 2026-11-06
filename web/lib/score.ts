// 동료평가 점수·등급·뱃지 규칙. 서버 기록만 읽는 순수 계산이며 저장하지 않는다.
// 규칙 근거: docs/superpowers/specs/2026-10-20-peer-score-badges-design.md (2026-10-20),
// 기간·척도·등급·공개·제재는 docs/superpowers/specs/2026-11-06-peer-review-ui-design.md (2026-11-06)
// 개인 점수는 동료평가만 쓴다. 체크인·변경 기록에는 작성자가 없어 개인 활동 점수로 쓰지 않는다.
import { PolicyError, type Lifecycle } from './sprint-policy.ts';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
/** 프로젝트가 끝난 뒤 평가를 받는 기간(사용자 결정 2026-11-06, 이전 7일). */
export const REVIEW_HOURS = 24;
/**
 * 이 시각 이후에 끝난 프로젝트만 미제출 제재·결과 숨김을 적용한다. 평가 화면이 생기기 전에 끝난
 * 프로젝트는 낼 방법이 없었다. 배포 시각보다 늦어야 한다. 테스트는 SANCTION_FROM 환경변수로 바꾼다.
 */
export const SANCTION_FROM = new Date(process.env.SANCTION_FROM || '2026-11-09T00:00:00+09:00');
/** 미제출 1회째·2회째 금지 일수. 3회째부터 영구. */
export const PENALTY_DAYS = [7, 30] as const;
/** 이 인원보다 적게 평가하면 누가 몇 점을 줬는지 드러나므로 점수를 보여주지 않는다. */
export const MIN_REVIEWERS = 2;
/** 매일 보고 뱃지에 필요한 최소 일차. 하루 안에 시작·완주해 받는 것을 막는다. */
export const MIN_REPORT_DAYS = 3;
/** 동료평가 개인 뱃지 기준(문항 평균). */
export const PEER_BADGE_AVERAGE = 4.5;

export const ITEMS = [
  { key: 'contribution', label: '기여도' },
  { key: 'communication', label: '소통' },
  { key: 'commitment', label: '약속 이행' },
] as const;
export type ItemKey = (typeof ITEMS)[number]['key'];
export type Rating = Record<ItemKey, number>;
export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function gradeOf(score: number | null): Grade | null {
  if (score === null) return null;
  for (const [grade, min] of GRADE_FLOORS) if (score >= min) return grade;
  return 'D';
}
/** 등급 하한(반올림한 5점 점수). 사용자 결정 2026-11-06. */
const GRADE_FLOORS: [Grade, number][] = [
  ['S', 4.8],
  ['A', 4.0],
  ['B', 3.0],
  ['C', 2.0],
];

/** 바로 위 등급과 남은 점수. S면 null. */
export function nextGrade(score: number): { grade: Grade; gap: number } | null {
  const above = GRADE_FLOORS.filter(([, min]) => min > score).at(-1);
  return above ? { grade: above[0], gap: round1(above[1] - score) } : null;
}

/** 가장 낮은 문항(같으면 앞 문항). 세 문항 모두 개인 뱃지 기준 이상이면 null. */
export function weakestItem<T extends { average: number }>(breakdown: T[]): T | null {
  if (breakdown.every((b) => b.average >= PEER_BADGE_AVERAGE)) return null;
  return breakdown.reduce((low, b) => (b.average < low.average ? b : low));
}

/** 받은 평가 → 점수. 평가 기간이 끝나고 MIN_REVIEWERS명 이상일 때만 공개한다. */
export function peerScore(ratings: Rating[], closed: boolean) {
  const reviewers = ratings.length;
  if (!closed || reviewers < MIN_REVIEWERS)
    return { score: null, grade: null, breakdown: [], averages: null, reviewers };
  const averages = Object.fromEntries(
    ITEMS.map(({ key }) => [key, ratings.reduce((sum, r) => sum + r[key], 0) / reviewers]),
  ) as Rating;
  const mean = ITEMS.reduce((sum, { key }) => sum + averages[key], 0) / ITEMS.length;
  const score = round1(mean);
  return {
    score,
    grade: gradeOf(score),
    breakdown: ITEMS.map(({ key, label }) => ({ key, label, average: round1(averages[key]) })),
    averages,
    reviewers,
  };
}

export type ReviewStatus = 'not_open' | 'open' | 'closed';
/**
 * 끝난 시각(완주 시각, 없으면 최종 기한)부터 REVIEW_HOURS시간. 서버 시각 기준.
 * 결과 공개(closed)는 마감 시각과 전원 제출 시각(allSubmittedAt) 중 빠른 쪽. closesAt은 그대로 둔다.
 */
export function reviewWindow(
  policy: { lifecycle: Lifecycle; deadlineAt: Date | null; completedAt: Date | null } | null,
  now: Date,
  allSubmittedAt: Date | null = null,
): { status: ReviewStatus; opensAt: Date | null; closesAt: Date | null; revealedAt: Date | null } {
  const end = endedAt(policy, now);
  if (!end) return { status: 'not_open', opensAt: null, closesAt: null, revealedAt: null };
  const closesAt = new Date(end.getTime() + REVIEW_HOURS * HOUR_MS);
  const reveal =
    allSubmittedAt && allSubmittedAt.getTime() < closesAt.getTime() ? allSubmittedAt : closesAt;
  const closed = now.getTime() >= reveal.getTime();
  return { status: closed ? 'closed' : 'open', opensAt: end, closesAt, revealedAt: closed ? reveal : null };
}

/** 공개 뒤에도 내 결과를 가린다: 평가할 대상이 있었는데 내지 않았고, 제재 시작 뒤에 끝난 프로젝트. */
export function resultHidden(
  f: { closed: boolean; hadTargets: boolean; reviewedAt: Date | null; endedAt: Date | null },
  from: Date = SANCTION_FROM,
) {
  return Boolean(
    f.closed && f.hadTargets && !f.reviewedAt && f.endedAt && f.endedAt.getTime() >= from.getTime(),
  );
}

export type DutyRow = {
  projectId: string;
  lifecycle: Lifecycle | null;
  deadlineAt: Date | null;
  completedAt: Date | null;
  /** 참여 중인 다른 멤버 수. */
  others: number;
  submitted: boolean;
};
/** 내 평가 의무: 아직 낼 수 있는 프로젝트와, 시간이 지나 미제출이 된 프로젝트의 평가 마감 시각. */
export function dutiesFrom(rows: DutyRow[], now: Date, from: Date = SANCTION_FROM) {
  const pending: string[] = [];
  const missCloses: Date[] = [];
  for (const row of rows) {
    const end = row.lifecycle ? endedAt({ ...row, lifecycle: row.lifecycle }, now) : null;
    if (!end || row.others < 1 || row.submitted) continue;
    const closes = new Date(end.getTime() + REVIEW_HOURS * HOUR_MS);
    if (now.getTime() < closes.getTime()) pending.push(row.projectId);
    else if (end.getTime() >= from.getTime()) missCloses.push(closes);
  }
  return { pending, missCloses };
}

export type Restriction = { until: Date | null; permanent: boolean; misses: number };
/** 화면이 받는 금지 상태(GET /api/projects). */
export type RestrictionView = { until: string | null; permanent: boolean; misses: number };
/** 미제출 마감 시각들 → 지금의 금지. k번째 미제출은 그 마감부터 PENALTY_DAYS[k]일, 3번째부터 영구. */
export function restrictionOf(missCloses: Date[], now: Date): Restriction | null {
  const sorted = [...missCloses].sort((a, b) => a.getTime() - b.getTime());
  let end = -Infinity;
  sorted.forEach((c, i) => {
    const until = i < PENALTY_DAYS.length ? c.getTime() + PENALTY_DAYS[i] * DAY_MS : Infinity;
    if (c.getTime() <= now.getTime() && now.getTime() < until) end = Math.max(end, until);
  });
  if (end === -Infinity) return null;
  return {
    until: end === Infinity ? null : new Date(end),
    permanent: end === Infinity,
    misses: sorted.length,
  };
}

/** 지금까지 misses번 미제출한 사람이 한 번 더 내지 않으면 받을 금지 일수. null은 영구. */
export function penaltyDays(misses: number): number | null {
  return PENALTY_DAYS[misses] ?? null;
}

/** 금지 안내 문구. 서버 거절과 화면 안내가 같은 문장을 쓴다. doing 예: '새 프로젝트를 만들'. */
export function restrictionMessage(
  r: { until: Date | string | null; permanent: boolean; misses: number },
  doing: string,
) {
  if (r.permanent || !r.until)
    return `동료평가를 ${r.misses}번 내지 않아 더 이상 ${doing} 수 없습니다.`;
  const when = new Date(r.until).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `동료평가를 내지 않아 ${when}까지 ${doing} 수 없습니다.`;
}

/** 프로젝트가 끝난 시각. 끝나지 않았거나 이전 규칙 기록이면 null. */
export function endedAt(
  policy: { lifecycle: Lifecycle; deadlineAt: Date | null; completedAt: Date | null } | null,
  now: Date,
) {
  if (!policy) return null;
  if (policy.lifecycle === 'completed') return policy.completedAt;
  if (
    (policy.lifecycle === 'active' || policy.lifecycle === 'expired') &&
    policy.deadlineAt &&
    now.getTime() >= policy.deadlineAt.getTime()
  )
    return policy.deadlineAt;
  return null;
}

/** 시작~종료의 일차(24시간 단위) 수와 보고가 1건 이상 있는 일차 수. 같은 일차의 보고는 한 번만 센다. */
export function reportDays(startedAt: Date, endAt: Date, times: Date[]) {
  const start = startedAt.getTime();
  const end = endAt.getTime();
  const required = Math.max(1, Math.ceil((end - start) / DAY_MS));
  const days = new Set<number>();
  for (const t of times) {
    const ms = t.getTime();
    if (ms < start || ms > end) continue;
    days.add(Math.min(required - 1, Math.floor((ms - start) / DAY_MS)));
  }
  return { required, reported: days.size };
}

export const BADGES = [
  { id: 'finish', label: '7일 완주', description: '기한 안에 프로젝트를 완주했다.' },
  { id: 'solo_finish', label: '솔로 완주', description: '혼자서 프로젝트를 완주했다.' },
  {
    id: 'daily_report',
    label: '매일 진행 보고',
    description: `팀이 스프린트의 모든 날에 진행 보고를 남겼다(${MIN_REPORT_DAYS}일 이상).`,
  },
  {
    id: 'zero_bottleneck',
    label: '병목 0으로 완주',
    description: '완주할 때 마감 안에 배치되지 않은 업무가 없었다.',
  },
  {
    id: 'top_contributor',
    label: '핵심 기여자',
    description: `동료평가 기여도 평균 ${PEER_BADGE_AVERAGE} 이상.`,
  },
  {
    id: 'top_communicator',
    label: '소통왕',
    description: `동료평가 소통 평균 ${PEER_BADGE_AVERAGE} 이상.`,
  },
  {
    id: 'promise_keeper',
    label: '약속 지킴이',
    description: `동료평가 약속 이행 평균 ${PEER_BADGE_AVERAGE} 이상.`,
  },
  { id: 'reviewer', label: '평가 완료', description: '팀원 동료평가를 제출했다.' },
] as const;
export type BadgeId = (typeof BADGES)[number]['id'];
export type Badge = { id: BadgeId; label: string; description: string; earnedAt: Date | null };

export type BadgeFacts = {
  /** 완주 시각. 기한 종료면 null. */
  completedAt: Date | null;
  /** 끝난 시각(완주 또는 기한). 진행 중이면 null. */
  endedAt: Date | null;
  /** 결과가 공개된 시각(마감 또는 전원 제출). 개인 뱃지의 받은 시각. */
  revealedAt: Date | null;
  /** 참여 중단하지 않은 멤버인가. */
  active: boolean;
  /** 가입한 멤버가 1명인가. */
  solo: boolean;
  daily: { required: number; reported: number };
  zeroBottleneck: boolean;
  /** 평가 기간이 끝나고 공개된 문항 평균. 아니면 null. */
  averages: Rating | null;
  /** 내가 동료평가를 제출한 시각. */
  reviewedAt: Date | null;
};

const PEER_BADGES: Partial<Record<BadgeId, ItemKey>> = {
  top_contributor: 'contribution',
  top_communicator: 'communication',
  promise_keeper: 'commitment',
};

export function badgeList(f: BadgeFacts): Badge[] {
  const team = f.active && f.endedAt;
  const finished = team && f.completedAt;
  const when: Record<BadgeId, Date | null> = {
    finish: finished ? f.completedAt : null,
    solo_finish: finished && f.solo ? f.completedAt : null,
    daily_report:
      team &&
      f.daily.required >= MIN_REPORT_DAYS &&
      f.daily.reported >= f.daily.required
        ? f.endedAt
        : null,
    zero_bottleneck: finished && f.zeroBottleneck ? f.completedAt : null,
    top_contributor: null,
    top_communicator: null,
    promise_keeper: null,
    reviewer: f.reviewedAt,
  };
  for (const [id, key] of Object.entries(PEER_BADGES) as [BadgeId, ItemKey][])
    when[id] = f.averages && f.averages[key] >= PEER_BADGE_AVERAGE ? f.revealedAt : null;
  return BADGES.map((b) => ({ ...b, earnedAt: when[b.id] }));
}

/**
 * 요청 본문의 평가 목록. 대상 전원을 한 번씩, 문항마다 0.5~5의 0.5점 단위(별 반 개). 대상 순서로 돌려준다.
 * 대상은 프로젝트 안 번호(person)로 받는다. 화면에 다른 사람의 계정 ID를 내보내지 않는다.
 */
export function parseReviews(value: unknown, targets: number[]) {
  if (!targets.length) throw new PolicyError('평가할 팀원이 없습니다.');
  if (!Array.isArray(value) || value.length !== targets.length)
    throw new PolicyError('팀원 전원의 평가를 한 번에 보내주세요.');
  const byPerson = new Map<number, Rating>();
  for (const item of value) {
    if (!item || typeof item !== 'object')
      throw new PolicyError('평가 형식이 올바르지 않습니다.');
    const { person } = item as { person?: unknown };
    if (typeof person !== 'number' || !targets.includes(person) || byPerson.has(person))
      throw new PolicyError('평가 대상이 올바르지 않습니다.');
    const rating = {} as Rating;
    for (const { key, label } of ITEMS) {
      const n = (item as Record<string, unknown>)[key];
      if (typeof n !== 'number' || !Number.isInteger(n * 2) || n < 0.5 || n > 5)
        throw new PolicyError(`${label} 평가는 0.5~5 사이 0.5점 단위로 입력해주세요.`);
      rating[key] = n;
    }
    byPerson.set(person, rating);
  }
  return [...targets].sort((a, b) => a - b).map((person) => ({ person, ...byPerson.get(person)! }));
}

const GRADE_ORDER: Grade[] = ['S', 'A', 'B', 'C', 'D'];
/** 내 프로젝트별 결과 → 확정 점수 합, 최고 등급, 뱃지별 처음 받은 시각과 횟수. */
export function summarize(
  projects: { score: number | null; grade: Grade | null; badges: Badge[] }[],
) {
  const scored = projects.filter((p) => p.score !== null);
  const grades = scored.map((p) => p.grade).filter((g): g is Grade => g !== null);
  return {
    totalScore: round1(scored.reduce((sum, p) => sum + (p.score ?? 0), 0)),
    // 공개된 점수가 하나도 없으면 E(사용자 결정 2026-11-06).
    bestGrade: (GRADE_ORDER.find((g) => grades.includes(g)) ?? 'E') as Grade | 'E',
    projects: scored.length,
    badges: BADGES.map((b) => {
      const times = projects
        .flatMap((p) => p.badges)
        .filter((x) => x.id === b.id && x.earnedAt)
        .map((x) => x.earnedAt!.getTime());
      return {
        ...b,
        earnedAt: times.length ? new Date(Math.min(...times)) : null,
        count: times.length,
      };
    }),
  };
}
