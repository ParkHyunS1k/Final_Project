// 집중 스프린트 운영 규칙. 준비/진행/종료 상태와 모든 사용자 변경의 공통 검사를 소유한다.
// 규칙 근거: docs/superpowers/specs/2026-09-09-spartan-sprint-design.md
export const DURATIONS = [7, 8, 9, 10] as const;
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 4;
export const DAILY_HOURS = 8;

// legacy: 새 규칙 이전에 만들어진 기록. 자동 전환하지 않고 열람·내보내기만 유지한다.
export type Lifecycle = 'legacy' | 'draft' | 'active' | 'completed' | 'expired';

export type Policy = {
  projectId: string;
  lifecycle: Lifecycle;
  goalVersion: number;
  durationDays: number;
  dailyHours: number;
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
};

export type Actor = {
  userId: string;
  role: string;
  person: number;
  agreedGoalVersion: number;
  leftAt: string | null;
};

export class PolicyError extends Error {
  // strip-only 타입스크립트 실행을 위해 파라미터 프로퍼티를 쓰지 않는다.
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function policyRow(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  return {
    projectId: String(row.project_id),
    lifecycle: String(row.lifecycle) as Lifecycle,
    goalVersion: Number(row.goal_version),
    durationDays: Number(row.duration_days),
    dailyHours: Number(row.daily_hours),
    startedAt: (row.started_at as string | null) ?? null,
    deadlineAt: (row.deadline_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  } satisfies Policy;
}

// 저장된 상태가 진행 중이어도 서버 시각이 마감에 도달했으면 유효 상태는 종료다.
// 종료 처리 작업이 늦어져도 쓰기가 열리지 않는다.
export function effectiveLifecycle(policy: Policy | null, now: Date): Lifecycle {
  if (!policy) return 'legacy';
  if (policy.lifecycle !== 'active') return policy.lifecycle;
  if (policy.deadlineAt && now.getTime() >= Date.parse(policy.deadlineAt))
    return 'expired';
  return 'active';
}

// 시작 시각 + 선택한 일수. 사용자 확정 규칙(2026-09-09): 마지막 날 18시 고정이 아니다.
export function deadlineFrom(startedAt: Date, durationDays: number) {
  return new Date(
    startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

export function assertDuration(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !DURATIONS.includes(value as (typeof DURATIONS)[number])
  )
    throw new PolicyError('스프린트 기간은 7~10일 중에서 선택해주세요.');
  return value;
}

// 담당자 본인만, 팀장만, 멤버 누구나 중 어느 권한인지.
type Scope = 'owner' | 'assignee' | 'member' | 'self';
type Rule = { scope: Scope; states: Lifecycle[] };

// 모든 사용자 변경 진입점의 정책 목록. 여기에 없는 action은 거절한다.
export const RULES: Record<string, Rule> = {
  // 준비 단계 합의
  editGoal: { scope: 'owner', states: ['draft'] },
  agreeGoal: { scope: 'member', states: ['draft', 'active'] },
  start: { scope: 'owner', states: ['draft'] },
  // 초대와 멤버십
  invite: { scope: 'owner', states: ['draft', 'active'] },
  revokeInvite: { scope: 'owner', states: ['draft', 'active'] },
  acceptInvite: { scope: 'member', states: ['draft', 'active'] },
  stepBack: { scope: 'self', states: ['draft', 'active'] },
  // 업무
  createTask: { scope: 'owner', states: ['draft', 'active'] },
  editTask: { scope: 'owner', states: ['draft', 'active'] },
  taskDetails: { scope: 'assignee', states: ['draft', 'active'] },
  checkin: { scope: 'assignee', states: ['draft', 'active'] },
  task: { scope: 'assignee', states: ['draft', 'active'] },
  // 결과물
  deliverableEvidence: { scope: 'member', states: ['draft', 'active'] },
  deliverableConfirm: { scope: 'owner', states: ['draft', 'active'] },
  finish: { scope: 'owner', states: ['active'] },
  // AI 변경안 (C)
  createSource: { scope: 'member', states: ['draft', 'active'] },
  createProposal: { scope: 'member', states: ['draft', 'active'] },
  applyChanges: { scope: 'member', states: ['draft', 'active'] },
  revertChanges: { scope: 'member', states: ['draft', 'active'] },
};

// 목표·최종 기한은 시작 뒤 어떤 경로로도 바꿀 수 없다. 되돌리기·AI 승인도 같다.
export const FIXED_AFTER_START = ['goal', 'scope', 'completionCriteria', 'deliverables', 'deadline'];

function stateMessage(state: Lifecycle) {
  if (state === 'legacy')
    return '이전 규칙으로 만든 기록입니다. 열람과 내보내기만 할 수 있습니다.';
  if (state === 'completed')
    return '완주로 확정한 스프린트입니다. 열람과 내보내기만 할 수 있습니다.';
  if (state === 'expired')
    return '마감이 지난 스프린트입니다. 열람과 내보내기만 할 수 있습니다.';
  if (state === 'draft') return '아직 시작하지 않은 프로젝트입니다.';
  return '진행 중인 프로젝트에서는 할 수 없습니다.';
}

/**
 * 프로젝트 상태, 사용자 권한, 요청 action, 현재 서버 시각을 함께 검사한다.
 * 통과하면 유효 상태를 돌려주고, 실패하면 PolicyError를 던진다.
 * `assigneePerson`은 assignee 범위 action에서 대상 업무의 담당자 번호다.
 */
export function assertProjectMutationAllowed({
  policy,
  actor,
  action,
  now,
  assigneePerson,
  targetUserId,
}: {
  policy: Policy | null;
  actor: Actor;
  action: string;
  now: Date;
  assigneePerson?: number;
  targetUserId?: string;
}): Lifecycle {
  const state = effectiveLifecycle(policy, now);
  const rule = RULES[action];
  if (!rule) throw new PolicyError('지원하지 않는 작업입니다.');
  if (!rule.states.includes(state)) throw new PolicyError(stateMessage(state));
  if (actor.leftAt && action !== 'agreeGoal')
    throw new PolicyError('참여 중단을 보고한 팀원은 변경할 수 없습니다.', 403);
  // 고정 목표에 동의하지 않은 사람은 어떤 변경도 하지 않고 읽기만 한다.
  // 권한 범위 검사보다 먼저 본다: 동의 전에는 본인 업무 여부도 따지지 않는다.
  if (
    action !== 'agreeGoal' &&
    action !== 'acceptInvite' &&
    policy &&
    actor.agreedGoalVersion !== policy.goalVersion
  )
    throw new PolicyError('최신 목표와 완료 기준을 먼저 확인해주세요.');
  if (rule.scope === 'owner' && actor.role !== 'owner')
    throw new PolicyError('팀장만 실행할 수 있습니다.', 403);
  if (rule.scope === 'self' && targetUserId && targetUserId !== actor.userId)
    throw new PolicyError('본인만 보고할 수 있습니다.', 403);
  if (
    rule.scope === 'assignee' &&
    actor.role !== 'owner' &&
    assigneePerson !== actor.person
  )
    throw new PolicyError('본인의 업무만 변경할 수 있습니다.', 403);
  return state;
}

export type StartCheck = {
  ready: boolean;
  joined: number;
  agreed: number;
  missing: string[];
};

// 시작 자격: 팀장 권한, 실제 가입한 최소 2명, 현재 멤버 전원의 최신 목표 동의.
// 초대만 보낸 사람은 가입 인원으로 세지 않는다.
export function startReadiness(
  members: { agreedGoalVersion: number; displayName: string; leftAt: string | null }[],
  goalVersion: number,
  deliverables: number,
): StartCheck {
  const active = members.filter((m) => !m.leftAt);
  const agreed = active.filter((m) => m.agreedGoalVersion === goalVersion);
  const missing: string[] = [];
  if (active.length < MIN_MEMBERS)
    missing.push(`가입한 팀원이 ${MIN_MEMBERS}명 이상이어야 합니다.`);
  if (agreed.length !== active.length)
    missing.push(
      `최신 목표 미동의: ${active
        .filter((m) => m.agreedGoalVersion !== goalVersion)
        .map((m) => m.displayName)
        .join(', ')}`,
    );
  if (!deliverables) missing.push('필수 결과물이 최소 1개 필요합니다.');
  return {
    ready: !missing.length,
    joined: active.length,
    agreed: agreed.length,
    missing,
  };
}
