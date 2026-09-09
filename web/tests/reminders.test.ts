import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  futureStages,
  groupBatches,
  idempotencyKey,
  PROJECT_STAGES,
  selectDue,
  TASK_STAGES,
  type DueItem,
} from '../lib/reminders.ts';

// 확정 규칙 예시: 마감 2026-09-20 18:00 KST = 2026-09-20T09:00:00Z
const due = '2026-09-20T09:00:00.000Z';
const kst = (iso: string) =>
  new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16);

test('업무는 2시간·1시간·30분 전, 프로젝트는 48·24·2·1·0.5시간 전이다', () => {
  assert.deepEqual([...TASK_STAGES], [120, 60, 30]);
  assert.deepEqual([...PROJECT_STAGES], [2880, 1440, 120, 60, 30]);
});

test('업무 마감 18:00이면 같은 날 16:00·17:00·17:30에 예약된다', () => {
  const stages = futureStages('task', due, new Date('2026-09-19T00:00:00Z'));
  assert.deepEqual(
    stages.map((s) => kst(s.scheduledAt)),
    ['2026-09-20T16:00', '2026-09-20T17:00', '2026-09-20T17:30'],
  );
});

test('프로젝트 마감 18:00이면 9/18 18:00, 9/19 18:00, 당일 16:00·17:00·17:30이다', () => {
  const stages = futureStages('project', due, new Date('2026-09-17T00:00:00Z'));
  assert.deepEqual(
    stages.map((s) => kst(s.scheduledAt)),
    [
      '2026-09-18T18:00',
      '2026-09-19T18:00',
      '2026-09-20T16:00',
      '2026-09-20T17:00',
      '2026-09-20T17:30',
    ],
  );
});

test('이미 지난 단계는 소급 생성하지 않고 미래 단계만 예약한다', () => {
  // 9/20 16:30에 마감을 18:00으로 새로 확정하면 17:00·17:30만 생성한다.
  const stages = futureStages('task', due, new Date('2026-09-20T07:30:00Z'));
  assert.deepEqual(
    stages.map((s) => kst(s.scheduledAt)),
    ['2026-09-20T17:00', '2026-09-20T17:30'],
  );
});

test('예정 시각이 정확히 현재와 같은 단계는 새로 예약하지 않는다', () => {
  // 16:00(=120분 전)이 정확히 현재면 그 단계는 만들지 않고 17:00·17:30만 남는다.
  const stages = futureStages('task', due, new Date('2026-09-20T07:00:00Z'));
  assert.deepEqual(
    stages.map((s) => s.stage),
    [60, 30],
  );
});

function item(over: Partial<DueItem>): DueItem {
  return {
    id: 'i' + (over.stage ?? 0),
    projectId: 'p',
    deadlineVersion: 1,
    kind: 'task',
    taskId: 1,
    userId: 'u1',
    stage: 60,
    dueAt: due,
    scheduledAt: new Date(Date.parse(due) - 60 * 60000).toISOString(),
    ...over,
  };
}

test('밀린 단계가 여럿이면 같은 대상의 가장 최근 단계만 보낸다', () => {
  // 16:00·17:00 예약을 실행기 장애로 17:20에 처리하는 경우.
  const items = [
    item({ stage: 120, scheduledAt: '2026-09-20T07:00:00.000Z' }),
    item({ stage: 60, scheduledAt: '2026-09-20T08:00:00.000Z' }),
  ];
  const { send, skip } = selectDue(items, new Date('2026-09-20T08:20:00.000Z'));
  assert.deepEqual(
    send.map((s) => s.stage),
    [60],
  );
  assert.deepEqual(
    skip.map((s) => s.item.stage),
    [120],
  );
  assert.match(skip[0].reason, /건너뜀/);
});

test('대상 마감이 지났으면 아무것도 보내지 않는다', () => {
  const items = [item({ stage: 120 }), item({ stage: 60 })];
  const { send, skip } = selectDue(items, new Date('2026-09-20T09:30:00.000Z'));
  assert.equal(send.length, 0);
  assert.equal(skip.length, 2);
  assert.ok(skip.every((s) => /마감이 지나/.test(s.reason)));
});

test('마감과 정확히 같은 시각에는 발송하지 않는다', () => {
  const { send } = selectDue([item({ stage: 30 })], new Date(due));
  assert.equal(send.length, 0);
});

test('다른 대상의 같은 시점 알림은 함께 남는다', () => {
  const at = '2026-09-20T08:00:00.000Z';
  const items = [
    item({ id: 'a', taskId: 1, scheduledAt: at }),
    item({ id: 'b', taskId: 2, scheduledAt: at }),
    item({ id: 'c', kind: 'project', taskId: -1, scheduledAt: at }),
  ];
  const { send } = selectDue(items, new Date('2026-09-20T08:05:00.000Z'));
  assert.equal(send.length, 3);
});

test('같은 수신자·같은 예정 시각만 한 통으로 묶는다', () => {
  const early = '2026-09-20T07:00:00.000Z';
  const late = '2026-09-20T08:00:00.000Z';
  const groups = groupBatches([
    item({ id: 'a', taskId: 1, scheduledAt: late }),
    item({ id: 'b', kind: 'project', taskId: -1, scheduledAt: late }),
    // 다른 예정 시각은 처리 시각이 같아졌다는 이유만으로 합치지 않는다.
    item({ id: 'c', taskId: 2, scheduledAt: early }),
    // 다른 수신자는 각자의 주소로 따로 보낸다.
    item({ id: 'd', userId: 'u2', taskId: 3, scheduledAt: late }),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => [g.userId, g.scheduledAt, g.items.length]),
    [
      ['u1', early, 1],
      ['u1', late, 2],
      ['u2', late, 1],
    ],
  );
});

test('전송 식별자는 재시도에도 같다', () => {
  assert.equal(
    idempotencyKey('p', 'u', due),
    idempotencyKey('p', 'u', due),
  );
  assert.notEqual(idempotencyKey('p', 'u', due), idempotencyKey('p', 'u2', due));
});

test('잘못된 마감 값은 예약하지 않고 오류를 낸다', () => {
  assert.throws(() => futureStages('task', 'not-a-date', new Date()));
});
