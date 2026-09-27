// 회의 제안 계산기(web/lib/meeting-suggestions.ts) 단위 테스트.
// lib은 번들러 기준 확장자 없는 상대 경로를 쓰므로, 기존 테스트(change-guardrails.test.mjs)와
// 같은 방식으로 esbuild로 번들해서 import한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'projectmate-meeting-suggestions-'));
const outfile = join(dir, 'meeting-suggestions.mjs');
await build({
  entryPoints: ['lib/meeting-suggestions.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { meetingSuggestions } = await import(pathToFileURL(outfile).href);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-09-14T09:00:00.000Z');

function emptyPlan(overrides = {}) {
  return {
    feasible: true,
    needed: 0,
    available: 0,
    overBy: 0,
    unscheduled: [],
    starts: {},
    finishes: {},
    perPerson: [],
    from: NOW.toISOString(),
    until: NOW.toISOString(),
    dailyHours: 8,
    provisional: false,
    ...overrides,
  };
}

const members = [
  { person: 0, displayName: '현식' },
  { person: 1, displayName: '지민' },
  { person: 2, displayName: '수빈' },
];

test('1. 아무 문제 없는 계획 → 빈 배열', () => {
  const result = meetingSuggestions([], emptyPlan(), members, NOW);
  assert.deepEqual(result, []);
});

test('2. 한 사람 공수 초과 → rebalance 1건, 근거에 초과 시간 포함', () => {
  const tasks = [{ id: 1, person: 0, remaining: 20, done: false, dependsOn: [] }];
  const p = emptyPlan({
    perPerson: [
      { person: 0, needed: 20, available: 10, finish: null },
      { person: 1, needed: 5, available: 10, finish: null },
    ],
  });
  const result = meetingSuggestions(tasks, p, members, NOW);
  const rebalance = result.filter((r) => r.kind === 'rebalance');
  assert.equal(rebalance.length, 1);
  assert.equal(rebalance[0].suggestedAt, NOW.toISOString());
  assert.match(rebalance[0].reason, /10/);
  assert.match(rebalance[0].reason, /현식/);
});

test('3. unscheduled 존재 → scope 1건', () => {
  const tasks = [{ id: 5, person: 1, remaining: 4, done: false, dependsOn: [] }];
  const p = emptyPlan({ unscheduled: [5] });
  const result = meetingSuggestions(tasks, p, members, NOW);
  const scope = result.filter((r) => r.kind === 'scope');
  assert.equal(scope.length, 1);
  assert.deepEqual(scope[0].taskIds, [5]);
  assert.match(scope[0].reason, /1건/);
});

test('4. 담당자가 다른 두 업무의 의존 → handoff 1건, suggestedAt은 선행 업무 finishes 값과 일치', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 4, done: false, dependsOn: [] },
    { id: 2, person: 1, remaining: 4, done: false, dependsOn: [1] },
  ];
  const finishA = '2026-09-15T00:00:00.000Z';
  const p = emptyPlan({ finishes: { 1: finishA } });
  const result = meetingSuggestions(tasks, p, members, NOW);
  const handoff = result.filter((r) => r.kind === 'handoff');
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].suggestedAt, finishA);
  assert.deepEqual(handoff[0].taskIds, [1, 2]);
  assert.deepEqual(handoff[0].people, [0, 1]);
});

test('5. 같은 담당자끼리의 의존 → handoff 없음', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 4, done: false, dependsOn: [] },
    { id: 2, person: 0, remaining: 4, done: false, dependsOn: [1] },
  ];
  const p = emptyPlan({ finishes: { 1: '2026-09-15T00:00:00.000Z' } });
  const result = meetingSuggestions(tasks, p, members, NOW);
  assert.equal(result.filter((r) => r.kind === 'handoff').length, 0);
});

test('6. 선행 2개 이상인 업무 → integration 1건', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 4, done: false, dependsOn: [] },
    { id: 2, person: 1, remaining: 4, done: false, dependsOn: [] },
    { id: 3, person: 2, remaining: 4, done: false, dependsOn: [1, 2] },
  ];
  const startAt = '2026-09-16T00:00:00.000Z';
  const p = emptyPlan({ starts: { 3: startAt } });
  const result = meetingSuggestions(tasks, p, members, NOW);
  const integration = result.filter((r) => r.kind === 'integration');
  assert.equal(integration.length, 1);
  assert.equal(integration[0].id, 'integration:3');
  assert.equal(integration[0].suggestedAt, startAt);
  assert.deepEqual(integration[0].taskIds, [1, 2, 3]);
});

test('7. 완료된 업무는 어떤 제안에도 등장하지 않음', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 0, done: true, dependsOn: [] },
    { id: 2, person: 1, remaining: 0, done: true, dependsOn: [1] }, // 완료 아니면 handoff감
    { id: 3, person: 2, remaining: 0, done: true, dependsOn: [1, 2] }, // 완료 아니면 integration감
    { id: 4, person: 77, remaining: 0, done: true, dependsOn: [] }, // 완료 아니면 assign감(멤버 아님)
  ];
  const p = emptyPlan({ finishes: { 1: '2026-09-15T00:00:00.000Z' } });
  const result = meetingSuggestions(tasks, p, members, NOW);
  assert.deepEqual(result, []);
});

test('8. 같은 입력을 두 번 호출 → 완전히 동일한 결과 (id 포함)', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 4, done: false, dependsOn: [] },
    { id: 2, person: 1, remaining: 4, done: false, dependsOn: [1] },
    { id: 3, person: 2, remaining: 4, done: false, dependsOn: [1, 2] },
    { id: 4, person: 9, remaining: 4, done: false, dependsOn: [] },
  ];
  const p = emptyPlan({
    unscheduled: [4],
    finishes: { 1: '2026-09-15T00:00:00.000Z' },
    starts: { 3: '2026-09-16T00:00:00.000Z' },
    perPerson: [{ person: 0, needed: 20, available: 10, finish: null }],
  });
  const first = meetingSuggestions(tasks, p, members, NOW);
  const second = meetingSuggestions(tasks, p, members, NOW);
  assert.deepEqual(first, second);
});

test('9. 제안 문구 어디에도 제거된 제품 규칙(범위 축소·목표 축소·기한 연장·가용시간)이 노출되지 않는다', () => {
  const tasks = [
    { id: 1, person: 0, remaining: 20, done: false, dependsOn: [] },
    { id: 2, person: 1, remaining: 4, done: false, dependsOn: [] },
    { id: 3, person: 2, remaining: 4, done: false, dependsOn: [] },
    { id: 4, person: 1, remaining: 4, done: false, dependsOn: [2, 3] },
    { id: 5, person: 9, remaining: 4, done: false, dependsOn: [] }, // 팀에 없는 담당자
  ];
  const p = emptyPlan({
    unscheduled: [5],
    perPerson: [
      { person: 0, needed: 20, available: 10, finish: null },
      { person: 1, needed: 5, available: 10, finish: null },
    ],
    starts: { 4: '2026-09-16T00:00:00.000Z' },
  });
  const result = meetingSuggestions(tasks, p, members, NOW);
  assert.ok(result.length > 0, '검증할 제안이 없다');
  const forbidden = ['범위 축소', '목표 축소', '기한 연장', '가용시간'];
  for (const sug of result) {
    for (const field of [sug.title, sug.reason, ...sug.agenda]) {
      for (const word of forbidden) {
        assert.ok(
          !field.includes(word),
          `"${field}"에 금지어 "${word}"가 포함됨 (kind=${sug.kind})`,
        );
      }
    }
  }
});

test('10. 팀에 없는 담당자를 가진 assign 제안은 사람이 읽는 필드에 내부 숫자 인덱스를 노출하지 않는다', () => {
  const tasks = [{ id: 1, person: 99, remaining: 4, done: false, dependsOn: [] }];
  const p = emptyPlan();
  const result = meetingSuggestions(tasks, p, members, NOW);
  const assign = result.find((r) => r.kind === 'assign');
  assert.ok(assign, 'assign 제안이 없다');
  const numericFallback = /담당자\s*\d+/;
  assert.ok(!numericFallback.test(assign.title), `title에 숫자 fallback 노출: ${assign.title}`);
  assert.ok(!numericFallback.test(assign.reason), `reason에 숫자 fallback 노출: ${assign.reason}`);
  for (const item of assign.agenda) {
    assert.ok(!numericFallback.test(item), `agenda에 숫자 fallback 노출: ${item}`);
  }
  // people 배열 자체는 내부 데이터이므로 숫자를 유지해도 된다.
  assert.deepEqual(assign.people, [99]);
});
