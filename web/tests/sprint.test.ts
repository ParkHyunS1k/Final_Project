import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seed,
  schedule,
  plan,
  validateHours,
  type Sprint,
} from '../lib/sprint.ts';
const now = new Date('2026-09-08T09:00:00+09:00');
function small(): Sprint {
  const s = seed(now);
  s.deadline = '2026-09-08T11:00:00+09:00';
  s.capacity = s.capacity.filter((c) => c.date === '2026-09-08');
  s.tasks = [
    {
      id: 1,
      title: 'A',
      person: 0,
      remaining: 1,
      optional: false,
      deferred: false,
      done: false,
      evidence: '',
      dependsOn: [],
    },
    {
      id: 2,
      title: 'B',
      person: 0,
      remaining: 1,
      optional: false,
      deferred: false,
      done: false,
      evidence: '',
      dependsOn: [1],
    },
  ];
  return s;
}
test('two dependent one-hour tasks fit in the same two-hour day', () => {
  const p = schedule(small(), now);
  assert.equal(p.feasible, true);
  assert.equal(p.finishes[2], '2026-09-08 11:00');
});
test('zero availability never invents working time', () => {
  const s = small();
  s.capacity = s.capacity.map((c) => ({ ...c, hours: 0 }));
  assert.equal(schedule(s, now).feasible, false);
  assert.equal(schedule(s, now).available, 0);
});
test('exact deadline excludes slots finishing later', () => {
  const s = small();
  s.deadline = '2026-09-08T10:30:00+09:00';
  assert.equal(schedule(s, now).feasible, false);
});
test('elapsed time is not reused', () =>
  assert.equal(
    schedule(small(), new Date('2026-09-08T10:00:00+09:00')).feasible,
    false,
  ));
test('remaining effort changes the schedule', () => {
  const s = small();
  s.tasks[0].remaining = 1.5;
  assert.equal(schedule(s, now).feasible, false);
});
test('completed predecessor consumes no new time', () => {
  const s = small();
  s.tasks[0].done = true;
  assert.equal(schedule(s, now).finishes[2], '2026-09-08 10:00');
});
test('invalid hours rejected, including NaN and fractional slots', () => {
  for (const h of [NaN, Infinity, -1, 201, 0.1, '2'])
    assert.throws(() => validateHours(h));
  assert.equal(validateHours(0), 0);
});

// ---------------------------------------------------------------------------
// 공통 공수 모델 (사용자 확정 규칙). 기존 recovery() 테스트 3개는 함께 삭제했다.
// 근거: 목표 축소·부가 업무 보류는 제품 규칙에서 제거되었고 recovery()도 삭제했다.
// (docs/superpowers/plans/2026-09-09-a-sprint-policy.md A4/A5)
// ---------------------------------------------------------------------------
const from = new Date('2026-09-09T00:00:00Z');
const until = new Date('2026-09-16T00:00:00Z'); // 시작 시각 + 7일
function work(id: number, person: number, remaining: number, dependsOn: number[] = []) {
  return { id, person, remaining, done: false, dependsOn };
}
test('하루 8시간 가정은 담당자마다 동일하게 적용된다', () => {
  const p = plan([work(1, 0, 8), work(2, 1, 8)], [0, 1], {
    now: from,
    from,
    until,
  });
  assert.equal(p.perPerson[0].available, p.perPerson[1].available);
  assert.equal(p.perPerson[0].available, 7 * 8);
  assert.equal(p.available, 7 * 8 * 2);
  assert.equal(p.needed, 16);
  assert.equal(p.feasible, true);
});
test('8시간 업무는 만 하루 뒤에 끝난다', () => {
  const p = plan([work(1, 0, 8)], [0], { now: from, from, until });
  assert.equal(p.finishes[1], '2026-09-10T00:00:00.000Z');
});
test('후행 업무는 선행 업무보다 먼저 끝나지 않는다', () => {
  const p = plan([work(1, 0, 8), work(2, 1, 4, [1])], [0, 1], {
    now: from,
    from,
    until,
  });
  assert.ok(Date.parse(p.finishes[2]) > Date.parse(p.finishes[1]));
  assert.equal(p.starts[2], p.finishes[1]);
});
test('한 담당자의 업무는 겹치지 않고 이어서 배치된다', () => {
  const p = plan([work(1, 0, 8), work(2, 0, 8)], [0], {
    now: from,
    from,
    until,
  });
  assert.equal(p.starts[2], p.finishes[1]);
  assert.equal(p.finishes[2], '2026-09-11T00:00:00.000Z');
});
test('남은 예산을 넘으면 목표를 줄이지 않고 위험으로 표시한다', () => {
  const p = plan([work(1, 0, 80)], [0], { now: from, from, until });
  assert.equal(p.feasible, false);
  assert.deepEqual(p.unscheduled, [1]);
  assert.equal(p.needed, 80);
  assert.equal(p.available, 56);
  assert.equal(p.overBy, 24);
});
test('완료한 선행 업무는 새로 시간을 쓰지 않는다', () => {
  const p = plan(
    [{ ...work(1, 0, 8), done: true }, work(2, 0, 8, [1])],
    [0],
    { now: from, from, until },
  );
  assert.equal(p.needed, 8);
  assert.equal(p.finishes[2], '2026-09-10T00:00:00.000Z');
});
test('이미 지난 시간은 남은 예산에서 제외된다', () => {
  const p = plan([work(1, 0, 8)], [0], {
    now: new Date('2026-09-12T00:00:00Z'),
    from,
    until,
  });
  assert.equal(p.available, 4 * 8);
  assert.equal(p.from, '2026-09-12T00:00:00.000Z');
});
test('순환 의존관계는 배치하지 않는다', () => {
  const p = plan([work(1, 0, 1, [2]), work(2, 0, 1, [1])], [0], {
    now: from,
    from,
    until,
  });
  assert.equal(p.feasible, false);
  assert.deepEqual(p.unscheduled.sort(), [1, 2]);
});
test('참여 중단한 담당자의 업무는 자동 재배정하지 않고 미배치로 남는다', () => {
  const p = plan([work(1, 1, 4)], [0], { now: from, from, until });
  assert.equal(p.feasible, false);
  assert.deepEqual(p.unscheduled, [1]);
});
