// 동료평가 미제출 제재. 기록을 따로 두지 않고 끝난 프로젝트와 제출 기록을 비교해 계산한다.
// 규칙: lib/score.ts (dutiesFrom·restrictionOf), 근거: docs/superpowers/specs/2026-11-06-peer-review-ui-design.md
// ./projects를 import하지 않는다(projects가 이 파일을 쓴다).
import { database } from './sprint-store';
import { PolicyError, type Lifecycle } from './sprint-policy';
import { dutiesFrom, restrictionMessage, restrictionOf } from './score';

/** 내 평가 의무: 지금의 금지, 아직 낼 수 있는 프로젝트, 지금까지의 미제출 횟수. */
export async function reviewDuties(userId: string, now: Date) {
  const rows = await database()
    .prepare(
      'SELECT m.project_id,p.lifecycle,p.deadline_at,p.completed_at,' +
        '(SELECT count(*)::int FROM project_members o WHERE o.project_id=m.project_id AND o.left_at IS NULL AND o.user_id<>m.user_id) AS others,' +
        'EXISTS(SELECT 1 FROM peer_review_submissions r WHERE r.project_id=m.project_id AND r.reviewer_id=m.user_id) AS submitted ' +
        'FROM project_members m JOIN project_policy p ON p.project_id=m.project_id WHERE m.user_id=? AND m.left_at IS NULL',
    )
    .bind(userId)
    .all<{
      project_id: string;
      lifecycle: Lifecycle | null;
      deadline_at: Date | null;
      completed_at: Date | null;
      others: number;
      submitted: boolean;
    }>();
  const { pending, missCloses } = dutiesFrom(
    rows.results.map((r) => ({
      projectId: r.project_id,
      lifecycle: r.lifecycle,
      deadlineAt: r.deadline_at ? new Date(r.deadline_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
      others: Number(r.others),
      submitted: Boolean(r.submitted),
    })),
    now,
  );
  return { restriction: restrictionOf(missCloses, now), pending, misses: missCloses.length };
}

/**
 * 금지 중이면 403. doing 예: '새 프로젝트를 만들'.
 * ponytail: 저장 트랜잭션 밖에서 검사한다. 검사와 저장 사이에 평가 기간이 끝나는 경합은 막지 않는다.
 * 막아야 하면 저장 SQL에 같은 조건을 넣는다.
 */
export async function assertNotRestricted(userId: string, now: Date, doing: string) {
  const { restriction } = await reviewDuties(userId, now);
  if (restriction) throw new PolicyError(restrictionMessage(restriction, doing), 403);
}
