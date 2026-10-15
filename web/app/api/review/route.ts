// 학습 확인 API(2026-10-15). 화면 설계 전이라 API만 있다.
// - daily: 진행 중 프로젝트에서 그날(KST) 내 GitHub 커밋을 근거로 하루 1회 질문 → 답 → 채점.
// - final: 완주·기한 종료 뒤 프로젝트 기간 전체 내 커밋을 근거로 한 번.
// 건너뛰어도 감점하지 않는다(표시만). 기록은 본인만 본다.
// 공개 GitHub 저장소만, 서버가 api.github.com 고정 경로로만 가져온다(lib/ai-review-github.ts).
import { identity, AuthUnavailable, member, AccessError, type MemberRow } from '@/lib/projects';
import { readPolicy, database } from '@/lib/sprint-store';
import { effectiveLifecycle, PolicyError } from '@/lib/sprint-policy';
import {
  DAILY_REVIEW_LIMIT,
  fakeReviewModel,
  prepareQuestions,
  reviewAvailable,
  validateAnswers,
  validateGrade,
  type ReviewKind,
  type ReviewModel,
} from '@/lib/ai-review';
import { reviewModelFromEnv } from '@/lib/ai-review-live';
import {
  fetchCommitMaterial,
  parseLogin,
  parseRepoUrl,
  ReviewSourceError,
  type FetchOptions,
} from '@/lib/ai-review-github';
import {
  findReview,
  insertReview,
  kstDay,
  kstDayStart,
  listOwnReviews,
  readLink,
  readOwnReview,
  refundQuota,
  saveAnswer,
  saveLink,
  takeQuota,
  usedQuota,
  type ReviewLink,
  type ReviewRow,
} from '@/lib/ai-review-store';
export const dynamic = 'force-dynamic';
// 압축+질문 두 번의 모델 호출(각 최대 40초)과 GitHub 읽기를 더한 여유.
export const maxDuration = 90;

let model: ReviewModel = reviewModelFromEnv(process.env) ?? fakeReviewModel();
// 서버의 GitHub 토큰(선택)은 호출 한도 완화용. 사용자 토큰은 받지 않는다.
let github: FetchOptions = { token: process.env.GITHUB_TOKEN?.trim() || undefined };
export function useReviewModel(next: ReviewModel) {
  model = next;
}
export function useGithub(next: FetchOptions) {
  github = next;
}

function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function failure(error: unknown) {
  if (error instanceof AccessError || error instanceof PolicyError || error instanceof ReviewSourceError)
    return reply({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return reply({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  if (error instanceof Error && !/database|binding/i.test(error.message))
    return reply({ error: error.message }, 400);
  console.error('learning review request failed', error);
  return reply({ error: '처리하지 못했습니다.' }, 503);
}

function publicReview(r: ReviewRow) {
  return {
    reviewId: r.reviewId,
    kind: r.kind,
    day: r.day,
    status: r.status,
    repo: r.repo,
    commitCount: r.commitCount,
    questions: r.questions,
    answers: r.answers,
    feedback: r.feedback,
    gaps: r.gaps,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
  };
}
function linkView(link: ReviewLink | null) {
  return link
    ? { repoUrl: `https://github.com/${link.repoOwner}/${link.repoName}`, githubLogin: link.githubLogin }
    : null;
}
function activeMember(me: MemberRow) {
  if (me.left_at) throw new PolicyError('프로젝트를 떠난 뒤에는 학습 확인을 할 수 없습니다.', 403);
}
// 최종 확인 기간: 시작~(완주 시각 또는 최종 기한). 하루 칸은 프로젝트 끝날로 고정해 한 번만 만든다.
function finalWindow(policy: Awaited<ReturnType<typeof readPolicy>>) {
  const until = policy?.completedAt ?? policy?.deadlineAt ?? null;
  if (!policy?.startedAt || !until) throw new PolicyError('시작한 프로젝트만 최종 확인을 할 수 있습니다.');
  return { since: policy.startedAt, until, day: kstDay(until) };
}

export async function GET(request: Request) {
  const user = await identity(request);
  if (user instanceof AuthUnavailable) return reply({ error: user.message }, user.status);
  if (!user) return reply({ error: '로그인이 필요합니다.' }, 401);
  try {
    const projectId = new URL(request.url).searchParams.get('project') ?? '';
    const me = await member(projectId, user);
    const now = new Date();
    const day = kstDay(now);
    const policy = await readPolicy(projectId);
    const lifecycle = effectiveLifecycle(policy, now);
    const history = await listOwnReviews(projectId, user.id);
    const todays = history.find((r) => r.kind === 'daily' && r.day === day) ?? null;
    const finalRow = history.find((r) => r.kind === 'final') ?? null;
    return reply({
      link: linkView(await readLink(projectId, user.id)),
      today: {
        // 진행 중인 프로젝트의 현재 멤버에게만 하루 1회 확인이 걸린다. 건너뛰어도 표시만 한다.
        due: lifecycle === 'active' && !me.left_at,
        done: todays?.status === 'answered',
        status: todays?.status ?? 'none',
        reviewId: todays?.reviewId ?? null,
      },
      final: {
        available: (lifecycle === 'completed' || lifecycle === 'expired') && !me.left_at,
        done: finalRow?.status === 'answered',
        status: finalRow?.status ?? 'none',
        reviewId: finalRow?.reviewId ?? null,
      },
      history: history.map(publicReview),
      quota: { limit: DAILY_REVIEW_LIMIT, used: await usedQuota(user.id, day) },
      aiAvailable: reviewAvailable(model),
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
  if (origin && origin !== new URL(request.url).origin)
    return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  const raw = await request.text();
  if (raw.length > 20000) return reply({ error: '요청이 너무 큽니다.' }, 413);
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const action = String(b.action);
    const now = new Date();
    if (action === 'answer') return await answer(user.id, b, now);
    const projectId = typeof b.projectId === 'string' ? b.projectId : '';
    const me = await member(projectId, user);
    activeMember(me);
    if (action === 'link') {
      const link = linkInput(b.repoUrl ?? b.sourceUrl, b.githubLogin);
      if (!(await saveLink(projectId, user.id, link, now)))
        throw new PolicyError('프로젝트를 떠난 뒤에는 학습 확인을 할 수 없습니다.', 403);
      return reply({ link: linkView(link) });
    }
    if (action === 'start' || action === 'final')
      return await start(projectId, user.id, action === 'start' ? 'daily' : 'final', b, now);
    throw new PolicyError('지원하지 않는 작업입니다.');
  } catch (e) {
    return failure(e);
  }
}

function linkInput(repoUrl: unknown, login: unknown): ReviewLink {
  const repo = parseRepoUrl(repoUrl);
  return { repoOwner: repo.owner, repoName: repo.name, githubLogin: parseLogin(login) };
}

async function start(
  projectId: string,
  userId: string,
  kind: ReviewKind,
  b: Record<string, unknown>,
  now: Date,
) {
  const policy = await readPolicy(projectId);
  const lifecycle = effectiveLifecycle(policy, now);
  let window: { since: Date; until: Date; day: string };
  if (kind === 'daily') {
    if (lifecycle !== 'active')
      throw new PolicyError('오늘의 확인은 진행 중인 프로젝트에서만 할 수 있습니다.', 409);
    window = { since: kstDayStart(now), until: now, day: kstDay(now) };
  } else {
    if (lifecycle !== 'completed' && lifecycle !== 'expired')
      throw new PolicyError('최종 확인은 완주하거나 기한이 끝난 뒤에 열립니다.', 409);
    window = finalWindow(policy);
  }
  // 요청에 저장소·아이디가 있으면 먼저 등록한다(화면이 한 번에 보낼 수 있게).
  if (b.sourceUrl !== undefined || b.repoUrl !== undefined || b.githubLogin !== undefined) {
    const link = linkInput(b.sourceUrl ?? b.repoUrl, b.githubLogin);
    if (!(await saveLink(projectId, userId, link, now)))
      throw new PolicyError('프로젝트를 떠난 뒤에는 학습 확인을 할 수 없습니다.', 403);
  }
  // 이미 만든 확인은 다시 만들지 않는다(재전송·새로고침은 같은 질문).
  const existing = await findReview(projectId, userId, kind, window.day);
  if (existing?.status === 'answered')
    throw new PolicyError(kind === 'daily' ? '오늘 확인을 이미 마쳤습니다.' : '최종 확인을 이미 마쳤습니다.', 409);
  if (existing) return reply({ ...startView(existing), repeated: true });
  const link = await readLink(projectId, userId);
  if (!link) throw new PolicyError('공개 GitHub 저장소와 내 GitHub 아이디를 먼저 등록해주세요.');
  if (!reviewAvailable(model)) return reply({ error: 'AI 학습 확인은 준비 중입니다.' }, 503);

  // 하루 한도 한 칸을 먼저 잡고, 커밋 없음·GitHub 실패·모델 실패면 돌려준다.
  const quotaDay = kstDay(now);
  if (!(await takeQuota(userId, quotaDay, DAILY_REVIEW_LIMIT)))
    return reply(
      { error: `학습 확인은 하루 ${DAILY_REVIEW_LIMIT}회까지 만들 수 있습니다(한국 시간 0시에 초기화).` },
      429,
    );
  let kept = false;
  try {
    const material = await fetchCommitMaterial(
      {
        repo: { owner: link.repoOwner, name: link.repoName },
        login: link.githubLogin,
        since: window.since,
        until: window.until,
        kind,
      },
      github,
    );
    if (!material.commits.length)
      // AI를 부르지 않는다. 기록도 남기지 않아 커밋한 뒤 다시 시도할 수 있다.
      return reply({ status: 'no_commits', kind, questions: [], commitCount: 0 });
    const goal = await readGoal(projectId);
    let prepared: Awaited<ReturnType<typeof prepareQuestions>>;
    try {
      prepared = await prepareQuestions(model, { kind, material: material.text, goal });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'AI 학습 확인을 만들지 못했습니다.';
      return reply({ error: message }, 502);
    }
    const id = 'lr_' + crypto.randomUUID();
    const written = await insertReview({
      id,
      projectId,
      userId,
      kind,
      day: window.day,
      repo: `${link.repoOwner}/${link.repoName}`,
      githubLogin: link.githubLogin,
      commits: material.commits,
      digest: prepared.digest,
      questions: prepared.questions,
      model: model.name,
      now,
    });
    if (!written) {
      // 동시 요청이 먼저 저장했거나 그사이 프로젝트를 떠났다.
      const other = await findReview(projectId, userId, kind, window.day);
      if (!other) throw new PolicyError('프로젝트를 떠난 뒤에는 학습 확인을 할 수 없습니다.', 403);
      return reply({ ...startView(other), repeated: true });
    }
    kept = true;
    return reply(
      {
        reviewId: id,
        kind,
        status: 'asked',
        questions: prepared.questions,
        commitCount: material.commits.length,
        truncated: material.truncated,
      },
      201,
    );
  } finally {
    if (!kept) await refundQuota(userId, quotaDay);
  }
}

function startView(r: ReviewRow) {
  return { reviewId: r.reviewId, kind: r.kind, status: r.status, questions: r.questions, commitCount: r.commitCount };
}

async function readGoal(projectId: string) {
  const r = await database()
    .prepare('SELECT goal FROM project_details WHERE project_id=?')
    .bind(projectId)
    .first<{ goal: string }>();
  return r?.goal ?? '';
}

async function answer(userId: string, b: Record<string, unknown>, now: Date) {
  const reviewId = typeof b.reviewId === 'string' ? b.reviewId : '';
  const found = await readOwnReview(reviewId, userId);
  if (!found) return reply({ error: '학습 확인을 찾을 수 없습니다.' }, 404);
  // 멤버십을 다시 확인한다(떠난 뒤에는 답하지 않는다).
  const current = await database()
    .prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND left_at IS NULL')
    .bind(found.projectId, userId)
    .first();
  if (!current) throw new AccessError();
  if (found.row.status !== 'asked') throw new PolicyError('이미 답한 학습 확인입니다.', 409);
  const answers = validateAnswers(b.answers, found.row.questions);
  if (!reviewAvailable(model)) return reply({ error: 'AI 학습 확인은 준비 중입니다.' }, 503);
  let grade: ReturnType<typeof validateGrade>;
  try {
    grade = validateGrade(
      await model.grade({ digest: found.digest, questions: found.row.questions, answers }),
      found.row.questions,
      answers,
    );
  } catch (e) {
    // 채점 실패는 답을 저장하지 않는다. 같은 확인에 다시 답할 수 있다.
    return reply({ error: e instanceof Error ? e.message : 'AI 채점에 실패했습니다.' }, 502);
  }
  if (!(await saveAnswer(reviewId, userId, { ...grade, answers, now })))
    throw new PolicyError('이미 답한 학습 확인입니다.', 409);
  return reply({ reviewId, feedback: grade.feedback, gaps: grade.gaps });
}
