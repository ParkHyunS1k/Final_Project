import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seed,
  schedule,
  recovery,
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
test('recovery drops only optional work and becomes feasible', () => {
  const s = seed(now);
  s.tasks[3].remaining = 30;
  const p = recovery(s, now);
  assert.ok(p);
  assert.deepEqual(p.deferIds, [4]);
  assert.equal(p.before.feasible, false);
  assert.equal(p.after.feasible, true);
});
test('cannot promise recovery when required work alone is impossible', () => {
  const s = seed(now);
  s.tasks[1].remaining = 100;
  assert.equal(recovery(s, now), null);
});
test('optional predecessor of core work cannot be deferred', () => {
  const s = small();
  s.tasks[0].optional = true;
  s.tasks[0].remaining = 3;
  assert.equal(recovery(s, now), null);
});
test('invalid hours rejected, including NaN and fractional slots', () => {
  for (const h of [NaN, Infinity, -1, 201, 0.1, '2'])
    assert.throws(() => validateHours(h));
  assert.equal(validateHours(0), 0);
});
