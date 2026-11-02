import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sprintPulse,
  countdown,
  clockOffset,
  sprintDay,
  dayProgress,
  viewFrom,
  laneTask,
  reportChoices,
  dueLabel,
  focusTask,
  waitReason,
  tension,
  chipStage,
  focusClock,
  checkedInToday,
  type RaceTask,
} from '../lib/race.ts';

function t(id: number, over: Partial<RaceTask> = {}): RaceTask {
  return { id, person: 0, done: false, deferred: false, dependsOn: [], ...over };
}
const plan = (needed: number, available: number, unscheduled: number[] = []) => ({
  needed,
  available,
  unscheduled,
});

void test('sprintPulse: 업무가 없으면 0/0, 계획이 없으면 공수·병목 0', () => {
  assert.deepEqual(sprintPulse([], null), { done: 0, total: 0, hoursOver: 0, bottlenecks: [] });
});

void test('sprintPulse: 보류 업무는 세지 않고 완료 수를 센다', () => {
  const p = sprintPulse([t(1, { done: true }), t(2), t(3, { deferred: true })], plan(4, 10));
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
});

void test('sprintPulse: 필요가 예산보다 크면 양수(초과), 작으면 음수(여유), 소수 첫째 자리', () => {
  assert.equal(sprintPulse([t(1)], plan(25.04, 16)).hoursOver, 9);
  assert.equal(sprintPulse([t(1)], plan(4, 16.33)).hoursOver, -12.3);
});

void test('sprintPulse: 병목은 unscheduled 중 완료·보류가 아닌 업무', () => {
  const p = sprintPulse(
    [t(1), t(2, { done: true }), t(3, { deferred: true }), t(4)],
    plan(10, 5, [1, 2, 3]),
  );
  assert.deepEqual(p.bottlenecks, [1]);
});

void test('countdown: 총 시간 HH:MM:SS, 100시간 이상도 그대로', () => {
  assert.equal(countdown((52 * 3600 + 14 * 60 + 8) * 1000).text, '52:14:08');
  assert.equal(countdown(168 * 3600 * 1000).text, '168:00:00');
});

void test('countdown: 72h 초과 calm, 72h 이하 heat, 24h 이하 critical', () => {
  assert.equal(countdown((72 * 3600 + 1) * 1000).level, 'calm');
  assert.equal(countdown(72 * 3600 * 1000).level, 'heat');
  assert.equal(countdown((24 * 3600 + 1) * 1000).level, 'heat');
  assert.equal(countdown(24 * 3600 * 1000).level, 'critical');
});

void test('countdown: 음수·NaN은 00:00:00에서 멈추고 over', () => {
  assert.deepEqual(countdown(-5000), { text: '00:00:00', level: 'critical', over: true });
  assert.deepEqual(countdown(Number.NaN), { text: '00:00:00', level: 'critical', over: true });
});

void test('clockOffset: 서버 시각 - 기기 시각, 잘못된 asOf면 0', () => {
  const server = '2026-10-05T00:00:00.000Z';
  assert.equal(clockOffset(server, Date.parse(server) - 90_000), 90_000);
  assert.equal(clockOffset('nope', 123), 0);
});

void test('sprintDay: 시작 직후 1일차, 24시간 뒤 2일차, 기간을 넘지 않음', () => {
  const start = '2026-10-01T10:00:00+09:00';
  const at = (h: number) => Date.parse(start) + h * 3600000;
  assert.equal(sprintDay(start, at(0), 7), 1);
  assert.equal(sprintDay(start, at(24), 7), 2);
  assert.equal(sprintDay(start, at(-5), 7), 1);
  assert.equal(sprintDay(start, at(24 * 9), 7), 7);
});

void test('dayProgress: 칸 시작 0, 12시간 0.5, 범위 밖은 0~1로 자름', () => {
  const s = '2026-10-01T00:00:00Z';
  assert.equal(dayProgress(s, Date.parse(s)), 0);
  assert.equal(dayProgress(s, Date.parse(s) + 12 * 3600000), 0.5);
  assert.equal(dayProgress(s, Date.parse(s) + 30 * 3600000), 1);
  assert.equal(dayProgress(s, Date.parse(s) - 1), 0);
});

void test('viewFrom: 새 메뉴는 그대로, 예전 7개는 새 메뉴로, 모르는 값은 홈', () => {
  assert.deepEqual(viewFrom('tasks'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('today'), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('team'), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('plan'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('ai'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('mine'), { view: 'tasks', mine: true });
  assert.deepEqual(viewFrom('docs'), { view: 'project', mine: false });
  assert.deepEqual(viewFrom('result'), { view: 'project', mine: false });
  assert.deepEqual(viewFrom(null), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('toString'), { view: 'home', mine: false });
});

void test('laneTask: 진행 중 상태 우선, 없으면 완료·보류 아닌 첫 업무, 없으면 null', () => {
  const tasks = [
    t(1, { person: 1, done: true }),
    t(2, { person: 1 }),
    t(3, { person: 1, status: 'in_progress' }),
    t(4, { person: 2, deferred: true }),
  ];
  assert.equal(laneTask(tasks, 1)?.id, 3);
  assert.equal(laneTask(tasks.slice(0, 2), 1)?.id, 2);
  assert.equal(laneTask(tasks, 2), null);
});

void test('reportChoices: 팀원은 자기 미완료 업무만, 팀장은 전체에서 자기 업무를 먼저 고른다', () => {
  const tasks = [t(1, { person: 0 }), t(2, { person: 1, status: 'in_progress' }), t(3, { person: 1, done: true })];
  const mate = reportChoices(tasks, { person: 1 }, false);
  assert.deepEqual(mate.open.map((x) => x.id), [2]);
  assert.equal(mate.first?.id, 2);
  const lead = reportChoices(tasks, { person: 0 }, true);
  assert.deepEqual(lead.open.map((x) => x.id), [1, 2]);
  assert.equal(lead.first?.id, 1);
  const none = reportChoices(tasks, { person: 5 }, false);
  assert.deepEqual(none, { open: [], first: null });
});

void test('dueLabel: 승인된 마감은 KST 월/일 시:분, 없으면 마감 미정', () => {
  assert.equal(dueLabel('2026-10-08T15:30:00.000Z'), '10/9 00:30 마감');
  assert.equal(dueLabel(null), '마감 미정');
  assert.equal(dueLabel(undefined), '마감 미정');
});

const H = 3600000;
const ft = (id: number, person: number, dueAt: string | null, over: Partial<RaceTask> = {}) => ({
  id,
  person,
  dueAt,
  done: false,
  deferred: false,
  dependsOn: [] as number[],
  ...over,
});

void test('focusTask: 내 미완료·마감 있는 업무 중 가장 이른 마감, 지난 마감 포함', () => {
  const tasks = [
    ft(1, 0, '2026-11-05T00:00:00.000Z'),
    ft(2, 0, '2026-11-03T00:00:00.000Z'),
    ft(3, 1, '2026-11-01T00:00:00.000Z'), // 남의 업무
    ft(4, 0, '2026-11-01T00:00:00.000Z', { done: true }),
    ft(5, 0, '2026-11-01T00:00:00.000Z', { deferred: true }),
    ft(6, 0, null),
  ];
  assert.equal(focusTask(tasks, 0)?.id, 2);
  assert.equal(focusTask(tasks, 2), null);
  assert.equal(focusTask([ft(7, 0, '2020-01-01T00:00:00.000Z'), ...tasks], 0)?.id, 7);
});

void test('waitReason: 배정 없음·마감 미정만 남음·모두 완료', () => {
  assert.equal(waitReason([ft(1, 1, null)], 0), 'unassigned');
  assert.equal(waitReason([ft(1, 0, null, { deferred: true })], 0), 'unassigned');
  assert.equal(waitReason([ft(1, 0, null)], 0), 'undated');
  assert.equal(waitReason([ft(1, 0, '2026-11-05T00:00:00.000Z', { done: true })], 0), 'done');
});

void test('tension: 구간 경계', () => {
  assert.deepEqual(tension(null), { stage: 'idle', tint: 0 });
  assert.deepEqual(tension(NaN), { stage: 'idle', tint: 0 });
  assert.deepEqual(tension(73 * H), { stage: 'calm', tint: 0 });
  assert.equal(tension(72 * H).stage, 'heat');
  assert.equal(tension(24 * H + 1).stage, 'heat');
  assert.equal(tension(24 * H).stage, 'critical');
  assert.equal(tension(H + 1).stage, 'critical');
  assert.equal(tension(H).stage, 'final');
  assert.equal(tension(1).stage, 'final');
  assert.deepEqual(tension(0), { stage: 'over', tint: 1 });
  assert.deepEqual(tension(-5 * H), { stage: 'over', tint: 1 });
});

void test('tension: 붉은 기는 (1 - 남은/72h)^1.4로 마감에 가까울수록 진해진다', () => {
  assert.ok(Math.abs(tension(48 * H).tint - Math.pow(1 / 3, 1.4)) < 1e-9);
  assert.ok(tension(48 * H).tint < tension(24 * H).tint);
  assert.ok(tension(24 * H).tint < tension(H).tint);
  assert.equal(tension(72 * H).tint, 0);
});

void test('chipStage: 칩은 24h 주황, 6h 빨강, 1h 깜빡, 지나면 초과', () => {
  assert.equal(chipStage(24 * H + 1), 'calm');
  assert.equal(chipStage(24 * H), 'heat');
  assert.equal(chipStage(6 * H + 1), 'heat');
  assert.equal(chipStage(6 * H), 'critical');
  assert.equal(chipStage(H), 'final');
  assert.equal(chipStage(0), 'over');
});

void test('focusClock: 24시간 넘어도 시간 단위, 초과는 + 와 지난 시간', () => {
  assert.equal(focusClock(52 * H + 10 * 60000 + 3000), '52:10:03');
  assert.equal(focusClock(168 * H - 1000), '167:59:59');
  assert.equal(focusClock(0), '+00:00:00');
  assert.equal(focusClock(-(2 * H + 13 * 60000 + 5000)), '+02:13:05');
});

void test('checkedInToday: 담당자 기준, KST 날짜가 같을 때만', () => {
  const tasks = [
    { id: 1, person: 0 },
    { id: 2, person: 1 },
  ];
  const now = Date.parse('2026-11-02T15:30:00.000Z'); // KST 11/3 00:30
  const at = (task_id: number, created_at: string) => [{ task_id, created_at }];
  assert.equal(checkedInToday(at(1, '2026-11-02T15:00:00.000Z'), tasks, 0, now), true); // KST 11/3 00:00
  assert.equal(checkedInToday(at(1, '2026-11-02T14:59:59.000Z'), tasks, 0, now), false); // KST 11/2 23:59
  assert.equal(checkedInToday(at(2, '2026-11-02T15:10:00.000Z'), tasks, 0, now), false); // 다른 사람 업무
  assert.equal(checkedInToday(at(9, '2026-11-02T15:10:00.000Z'), tasks, 0, now), false); // 없는 업무
});
