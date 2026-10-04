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
