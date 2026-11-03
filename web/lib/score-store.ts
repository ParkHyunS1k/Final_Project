// 동료평가 저장과 점수·뱃지 조회. 규칙은 lib/score.ts, 근거는
// docs/superpowers/specs/2026-10-20-peer-score-badges-design.md.
// 본인 결과만 돌려준다. 다른 사람의 점수·개별 평가·평가 시각은 내보내지 않는다.
import { database, readSprint, readPolicy, readMembers, currentPlan, Conflict } from './sprint-store';
import { member, listProjects, type Identity } from './projects';
import { PolicyError } from './sprint-policy';
import {
  badgeList,
  endedAt,
  MIN_REVIEWERS,
  parseReviews,
  peerScore,
  reportDays,
  reviewWindow,
  summarize,
  type Rating,
} from './score';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// 저장 시점의 DB 시각으로 평가 기간과 현재 멤버 여부를 다시 확인한다. reviewWindow와 같은 규칙.
const OPEN_WINDOW =
  "EXISTS(SELECT 1 FROM project_policy p WHERE p.project_id=? AND (" +
  "(p.lifecycle='completed' AND now() < p.completed_at + interval '7 days')" +
  " OR (p.lifecycle IN ('active','expired') AND p.deadline_at <= now() AND now() < p.deadline_at + interval '7 days')))";

async function projectScore(projectId: string, userId: string, now: Date) {
  const db = database();
  const [policy, members] = await Promise.all([readPolicy(projectId), readMembers(projectId)]);
  const window = reviewWindow(policy, now);
  const [mine, received, checkins] = await db.batch<Record<string, unknown>>([
    db
      .prepare('SELECT created_at FROM peer_review_submissions WHERE project_id=? AND reviewer_id=?')
      .bind(projectId, userId),
    // 받은 평가는 평균 계산에만 쓰고 그대로 내보내지 않는다.
    db
      .prepare(
        'SELECT contribution,communication,commitment FROM peer_reviews WHERE project_id=? AND reviewee_id=? ORDER BY reviewer_id',
      )
      .bind(projectId, userId),
    db.prepare('SELECT created_at FROM sprint_checkins WHERE owner=?').bind(projectId),
  ]);
  const me = members.find((m) => m.userId === userId);
  const active = members.filter((m) => !m.leftAt);
  const reviewedAt = (mine.results[0]?.created_at as Date | undefined) ?? null;
  const closed = window.status === 'closed';
  const ratings = received.results.map((r) => ({
    contribution: Number(r.contribution),
    communication: Number(r.communication),
    commitment: Number(r.commitment),
  })) as Rating[];
  const result = peerScore(ratings, closed);

  const end = endedAt(policy, now);
  const completedAt = policy?.lifecycle === 'completed' ? policy.completedAt : null;
  let zeroBottleneck = false;
  if (policy && completedAt) {
    // 완주 뒤에는 업무를 바꿀 수 없으므로 완주 시각 기준으로 다시 계산해도 같은 결과다.
    const s = await readSprint(projectId);
    if (s) {
      const plan = currentPlan(s, policy, members, completedAt);
      zeroBottleneck = !s.tasks.some(
        (t) => !t.deferred && !t.done && plan.unscheduled.includes(t.id),
      );
    }
  }
  const badges = badgeList({
    completedAt,
    endedAt: end,
    closesAt: window.closesAt,
    active: Boolean(me && !me.leftAt),
    solo: members.length === 1,
    daily:
      policy?.startedAt && end
        ? reportDays(
            policy.startedAt,
            end,
            checkins.results.map((r) => r.created_at as Date),
          )
        : { required: 0, reported: 0 },
    zeroBottleneck,
    averages: result.averages,
    reviewedAt,
  });
  const canReview = window.status === 'open' && !reviewedAt && Boolean(me && !me.leftAt);
  return {
    score: result.score,
    grade: result.grade,
    breakdown: result.breakdown,
    badges,
    review: {
      status: window.status,
      opensAt: iso(window.opensAt),
      closesAt: iso(window.closesAt),
      submitted: Boolean(reviewedAt),
      // 기간 중 인원 수가 바뀌는 것을 보면 누가 평가했는지 추정할 수 있어 마감 뒤에만 알린다.
      reviewers: closed ? result.reviewers : null,
      minReviewers: MIN_REVIEWERS,
      targets: canReview
        ? active
            .filter((m) => m.userId !== userId)
            .map((m) => ({ person: m.person, displayName: m.displayName }))
        : [],
    },
  };
}

function wire(s: Awaited<ReturnType<typeof projectScore>>) {
  return { ...s, badges: s.badges.map((b) => ({ ...b, earnedAt: iso(b.earnedAt) })) };
}

/** GET /api/score?project=<id>. 멤버가 아니면 AccessError. */
export async function readScore(projectId: string, user: Identity, now = new Date()) {
  await member(projectId, user);
  return wire(await projectScore(projectId, user.id, now));
}

/** GET /api/score/me. 내가 속한 프로젝트 전체의 확정 점수·최고 등급·뱃지. */
export async function readMyScore(user: Identity, now = new Date()) {
  const projects = await listProjects(user);
  const scores = [];
  for (const p of projects) scores.push(await projectScore(String(p.id), user.id, now));
  const me = summarize(scores);
  return { ...me, badges: me.badges.map((b) => ({ ...b, earnedAt: iso(b.earnedAt) })) };
}

/** POST /api/score { action: 'review' }. 평가자당 1회, 대상 전원을 한 트랜잭션으로 저장한다. */
export async function submitReview(
  projectId: string,
  user: Identity,
  reviews: unknown,
  now = new Date(),
) {
  const row = await member(projectId, user);
  if (row.left_at) throw new PolicyError('참여를 중단한 프로젝트는 평가할 수 없습니다.');
  const [policy, members] = await Promise.all([readPolicy(projectId), readMembers(projectId)]);
  const window = reviewWindow(policy, now);
  if (window.status !== 'open')
    throw new PolicyError(
      window.status === 'closed'
        ? '동료평가 기간이 끝났습니다.'
        : '동료평가는 프로젝트가 끝난 뒤에 할 수 있습니다.',
    );
  const targets = members.filter((m) => !m.leftAt && m.userId !== user.id);
  const parsed = parseReviews(
    reviews,
    targets.map((m) => m.person),
  );
  const db = database();
  const submission = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        'INSERT INTO peer_review_submissions(id,project_id,reviewer_id,created_at) SELECT ?,?,?,? WHERE ' +
          OPEN_WINDOW +
          ' AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=? AND m.user_id=? AND m.left_at IS NULL) ON CONFLICT DO NOTHING',
      )
      .bind(submission, projectId, user.id, now.toISOString(), projectId, projectId, user.id),
    ...parsed.map((r) =>
      db
        .prepare(
          'INSERT INTO peer_reviews(project_id,reviewer_id,reviewee_id,contribution,communication,commitment,submission_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM peer_review_submissions WHERE id=?)',
        )
        .bind(
          projectId,
          user.id,
          targets.find((m) => m.person === r.person)!.userId,
          r.contribution,
          r.communication,
          r.commitment,
          submission,
          submission,
        ),
    ),
  ]);
  if (result[0].meta.changes !== 1)
    throw new Conflict('이미 평가를 제출했거나 평가 기간이 끝났습니다.');
  return readScore(projectId, user, now);
}
