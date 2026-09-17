import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProjectMutationAllowed,
  deadlineFrom,
  effectiveLifecycle,
  PolicyError,
  startReadiness,
  type Actor,
  type Policy,
} from '../lib/sprint-policy.ts';

const started = '2026-09-09T05:23:00.000Z';
const deadline = '2026-09-16T05:23:00.000Z';
function policy(over: Partial<Policy> = {}): Policy {
  return {
    projectId: 'p_1',
    lifecycle: 'active',
    goalVersion: 2,
    durationDays: 7,
    dailyHours: 8,
    startedAt: started,
    deadlineAt: deadline,
    completedAt: null,
    ...over,
  };
}
function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 'u1',
    role: 'owner',
    person: 0,
    agreedGoalVersion: 2,
    leftAt: null,
    ...over,
  };
}
function allow(over: Parameters<typeof assertProjectMutationAllowed>[0]) {
  return assertProjectMutationAllowed(over);
}

test('마감은 시작 시각 + 선택한 일수다 (마지막 날 18시 고정이 아니다)', () => {
  assert.equal(deadlineFrom(new Date(started), 7), deadline);
  assert.equal(deadlineFrom(new Date(started), 10), '2026-09-19T05:23:00.000Z');
});

test('저장된 상태가 진행 중이어도 마감에 도달하면 유효 상태는 종료다', () => {
  const p = policy();
  assert.equal(effectiveLifecycle(p, new Date(Date.parse(deadline) - 1)), 'active');
  // 서버 시각이 정확히 마감과 같은 경우도 종료다.
  assert.equal(effectiveLifecycle(p, new Date(deadline)), 'expired');
  assert.equal(effectiveLifecycle(p, new Date(Date.parse(deadline) + 1)), 'expired');
});

test('완주·이전 규칙 기록은 시계와 무관하게 상태를 유지한다', () => {
  assert.equal(
    effectiveLifecycle(policy({ lifecycle: 'completed' }), new Date(deadline)),
    'completed',
  );
  assert.equal(effectiveLifecycle(null, new Date()), 'legacy');
});

test('마감 경계에서 모든 사용자 변경이 거절된다', () => {
  const at = new Date(deadline);
  for (const action of [
    'createTask',
    'editTask',
    'taskDetails',
    'checkin',
    'task',
    'deliverableEvidence',
    'deliverableConfirm',
    'finish',
    'invite',
    'applyChanges',
    'revertChanges',
  ])
    assert.throws(
      () => allow({ policy: policy(), actor: actor(), action, now: at }),
      PolicyError,
      action,
    );
});

test('마감 1초 전에는 같은 변경이 허용된다', () => {
  const at = new Date(Date.parse(deadline) - 1000);
  assert.equal(
    allow({ policy: policy(), actor: actor(), action: 'createTask', now: at }),
    'active',
  );
});

test('이전 규칙 기록에는 어떤 사용자 변경도 허용하지 않는다', () => {
  for (const action of ['createTask', 'checkin', 'finish', 'start'])
    assert.throws(
      () => allow({ policy: null, actor: actor(), action, now: new Date() }),
      PolicyError,
    );
});

test('시작 후에는 팀장도 목표를 편집할 수 없다', () => {
  const now = new Date(started);
  assert.throws(
    () => allow({ policy: policy(), actor: actor(), action: 'editGoal', now }),
    /진행 중인 프로젝트/,
  );
  assert.equal(
    allow({
      policy: policy({ lifecycle: 'draft', startedAt: null, deadlineAt: null }),
      actor: actor(),
      action: 'editGoal',
      now,
    }),
    'draft',
  );
});

test('준비 상태에서는 완주 확인을 할 수 없다', () => {
  assert.throws(
    () =>
      allow({
        policy: policy({ lifecycle: 'draft', deadlineAt: null }),
        actor: actor(),
        action: 'finish',
        now: new Date(started),
      }),
    /시작하지 않은/,
  );
});

test('팀원은 팀장 권한 작업을 실행할 수 없고 본인 업무만 바꾼다', () => {
  const now = new Date(started);
  const worker = actor({ userId: 'u2', role: 'member', person: 1 });
  for (const action of ['createTask', 'editTask', 'deliverableConfirm', 'finish'])
    assert.throws(
      () => allow({ policy: policy(), actor: worker, action, now }),
      /팀장만/,
      action,
    );
  assert.throws(
    () =>
      allow({
        policy: policy({ lifecycle: 'draft', startedAt: null, deadlineAt: null }),
        actor: worker,
        action: 'start',
        now,
      }),
    /팀장만/,
  );
  assert.throws(
    () =>
      allow({
        policy: policy(),
        actor: worker,
        action: 'task',
        now,
        assigneePerson: 0,
      }),
    /본인의 업무만/,
  );
  assert.equal(
    allow({
      policy: policy(),
      actor: worker,
      action: 'task',
      now,
      assigneePerson: 1,
    }),
    'active',
  );
  // 팀장은 팀원 업무의 상태도 처리할 수 있다.
  assert.equal(
    allow({
      policy: policy(),
      actor: actor(),
      action: 'task',
      now,
      assigneePerson: 1,
    }),
    'active',
  );
});

test('최신 목표에 동의하지 않은 사람은 읽기만 하고, 동의는 할 수 있다', () => {
  const now = new Date(started);
  const stale = actor({ role: 'member', person: 1, agreedGoalVersion: 1 });
  assert.throws(
    () =>
      allow({
        policy: policy(),
        actor: stale,
        action: 'checkin',
        now,
        assigneePerson: 1,
      }),
    /최신 목표/,
  );
  assert.equal(
    allow({ policy: policy(), actor: stale, action: 'agreeGoal', now }),
    'active',
  );
});

test('참여 중단을 보고한 팀원은 목표 동의 외 변경을 하지 않는다', () => {
  const now = new Date(started);
  const gone = actor({ role: 'member', person: 1, leftAt: started });
  assert.throws(
    () =>
      allow({
        policy: policy(),
        actor: gone,
        action: 'checkin',
        now,
        assigneePerson: 1,
      }),
    /참여 중단/,
  );
});

test('참여 중단 보고는 본인만 할 수 있다', () => {
  const now = new Date(started);
  assert.throws(
    () =>
      allow({
        policy: policy(),
        actor: actor(),
        action: 'stepBack',
        now,
        targetUserId: 'other',
      }),
    /본인만/,
  );
});

test('정책 목록에 없는 action은 거절한다', () => {
  assert.throws(
    () =>
      allow({
        policy: policy(),
        actor: actor(),
        action: 'capacity',
        now: new Date(started),
      }),
    /지원하지 않는/,
  );
  for (const action of ['propose', 'approve', 'reject', 'join'])
    assert.throws(
      () =>
        allow({
          policy: policy(),
          actor: actor(),
          action,
          now: new Date(started),
        }),
      /지원하지 않는/,
      action,
    );
});

test('시작 자격: 최소 2명 가입과 전원 최신 목표 동의', () => {
  const solo = [{ agreedGoalVersion: 2, displayName: '팀장', leftAt: null }];
  assert.equal(startReadiness(solo, 2, 1).ready, false);
  const stale = [
    { agreedGoalVersion: 2, displayName: '팀장', leftAt: null },
    { agreedGoalVersion: 1, displayName: '팀원', leftAt: null },
  ];
  const check = startReadiness(stale, 2, 1);
  assert.equal(check.ready, false);
  assert.equal(check.joined, 2);
  assert.equal(check.agreed, 1);
  assert.ok(check.missing.join(' ').includes('팀원'));
  const ready = stale.map((m) => ({ ...m, agreedGoalVersion: 2 }));
  assert.equal(startReadiness(ready, 2, 1).ready, true);
  // 결과물이 없으면 시작할 수 없다.
  assert.equal(startReadiness(ready, 2, 0).ready, false);
  // 참여 중단자는 인원으로 세지 않는다.
  assert.equal(
    startReadiness(
      [...ready, { agreedGoalVersion: 0, displayName: '나감', leftAt: started }],
      2,
      1,
    ).ready,
    true,
  );
  assert.equal(
    startReadiness(
      [ready[0], { ...ready[1], leftAt: started }],
      2,
      1,
    ).ready,
    false,
  );
});
