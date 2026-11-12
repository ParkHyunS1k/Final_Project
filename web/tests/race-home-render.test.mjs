import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 홈 카운트다운·체크인 현황·캘린더 칩을 서버 렌더링해 구성과 상태별 표시를 확인한다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-race-home-')), 'race-home.mjs');
await build({
  entryPoints: ['components/race-home.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { FocusCountdown, TeamCheckins, DeadlineCalendar } = await import(
  pathToFileURL(outfile).href
);

const layerFile = join(mkdtempSync(join(cache, 'pm-tension-')), 'tension-layer.mjs');
await build({
  entryPoints: ['components/tension-layer.tsx'],
  outfile: layerFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { TensionLayer } = await import(pathToFileURL(layerFile).href);

const clockFile = join(mkdtempSync(join(cache, 'pm-clock-')), 'race-clock.mjs');
await build({
  entryPoints: ['components/race-clock.tsx'],
  outfile: clockFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { RaceClock } = await import(pathToFileURL(clockFile).href);
const css = readFileSync('app/globals.css', 'utf8');
const rule = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, selector);
  return css.slice(at, css.indexOf('}', at));
};

const NOW = Date.parse('2026-11-02T03:00:00.000Z');
const H = 3600000;
const task = (id, person, title, dueMs, over = {}) => ({
  id,
  person,
  title,
  dueAt: dueMs == null ? null : new Date(dueMs).toISOString(),
  done: false,
  deferred: false,
  dependsOn: [],
  remaining: 4,
  ...over,
});
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');
const focus = (tasks) =>
  renderToString(createElement(FocusCountdown, { tasks, person: 0, now: NOW }));

void test('카운트다운: 업무명 + 마감까지, timer 역할, 아래 작은 글씨 없음', () => {
  const html = focus([task(1, 0, 'DB 구축', NOW + 2 * H), task(2, 0, '다른 일', NOW + 5 * H)]);
  assert.match(text(html), /DB 구축 마감까지/);
  assert.match(text(html), /02:00:00/);
  assert.match(html, /role="timer"/);
  assert.doesNotMatch(text(html), /다음:|다른 일|\d+\/\d+ \d+:\d+ 마감/);
});

void test('카운트다운: 지난 마감은 마감 초과와 + 시간', () => {
  const t = text(focus([task(1, 0, 'DB 구축', NOW - H)]));
  assert.match(t, /DB 구축 마감 초과/);
  assert.match(t, /\+01:00:00/);
});

void test('카운트다운: 대기 중 문구 3가지', () => {
  assert.match(text(focus([task(1, 0, 'A', NOW + H, { done: true })])), /내 업무 모두 완료 · 대기 중/);
  assert.match(text(focus([task(1, 0, 'A', null)])), /마감이 정해진 내 업무 없음 · 대기 중/);
  assert.match(text(focus([task(1, 1, 'A', NOW + H)])), /배정된 내 업무 없음 · 대기 중/);
});

void test('체크인 현황: 참여 중인 팀원만, 지금 업무와 오늘 보고 여부, 내 줄 표시', () => {
  const members = [
    { display_name: '도윤', person: 0, left_at: null },
    { display_name: '서연', person: 1, left_at: null },
    { display_name: '나감', person: 2, left_at: '2026-11-01T00:00:00.000Z' },
  ];
  const tasks = [task(1, 0, 'DB 구축', NOW + H), task(2, 1, '화면 시안', NOW + 2 * H)];
  const checkins = [{ task_id: 1, created_at: new Date(NOW - 60000).toISOString() }];
  const html = renderToString(
    createElement(TeamCheckins, { members, me: { person: 0 }, tasks, checkins, now: NOW, active: true }),
  );
  const rows = html.split('race-checkin-row').slice(1).map(text);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /도윤.*나.*DB 구축.*오늘 체크인 완료/);
  assert.match(rows[1], /서연.*화면 시안.*아직 체크인 안 함/);
});

void test('체크인 현황: 지금 업무는 카운트다운과 같이 마감이 가장 가까운 업무', () => {
  const members = [{ display_name: '도윤', person: 0, left_at: null }];
  const tasks = [task(1, 0, '먼 업무', NOW + 100 * H), task(2, 0, '가까운 업무', NOW + H)];
  const t = text(
    renderToString(
      createElement(TeamCheckins, { members, me: { person: 0 }, tasks, checkins: [], now: NOW, active: true }),
    ),
  );
  assert.match(t, /가까운 업무/);
  assert.doesNotMatch(t, /먼 업무/);
});

void test('체크인 현황: 진행 중이 아니면 체크인 여부 배지를 보여주지 않는다', () => {
  const members = [{ display_name: '도윤', person: 0, left_at: null }];
  const t = text(
    renderToString(
      createElement(TeamCheckins, { members, me: { person: 0 }, tasks: [], checkins: [], now: NOW, active: false }),
    ),
  );
  assert.doesNotMatch(t, /체크인 안 함|체크인 완료/);
});

void test('캘린더: 진행 중에만 칩 단계, 오늘 aria-current, 병목 표시 없음', () => {
  const tasks = [
    task(1, 0, 'A', NOW + 5 * H),
    task(2, 0, 'B', NOW + 30 * 60000),
    task(3, 0, 'C', NOW + 20 * H),
  ];
  const props = {
    startedAt: new Date(NOW - H).toISOString(),
    deadline: new Date(NOW - H + 168 * H).toISOString(),
    now: NOW,
    tasks,
    people: [{ name: '도윤' }],
    onPlan: () => {},
  };
  const on = renderToString(createElement(DeadlineCalendar, { ...props, active: true }));
  assert.match(on, /chip-critical/);
  assert.match(on, /chip-final/);
  assert.match(on, /chip-heat/);
  assert.equal((on.match(/aria-current="date"/g) ?? []).length, 1);
  assert.doesNotMatch(on, /병목/);
  const off = renderToString(createElement(DeadlineCalendar, { ...props, active: false }));
  assert.doesNotMatch(off, /chip-|마감 지남/);
});

const layer = (lifecycle, tasks) =>
  renderToString(
    createElement(TensionLayer, {
      lifecycle,
      asOf: new Date(NOW).toISOString(),
      tasks,
      person: 0,
    }),
  );

void test('긴장 레이어: 내 업무 마감 기준 단계, 장식이라 스크린리더에서 숨김', () => {
  const html = layer('active', [task(1, 0, 'A', NOW + 20 * H), task(2, 1, '남의 업무', NOW + 60000)]);
  assert.match(html, /tension-critical/);
  assert.doesNotMatch(html, /tension-final/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /--tint:0\.\d+/);
});

void test('긴장 레이어: 여유·대기 중·진행 중이 아닐 때는 아무것도 없다', () => {
  assert.equal(layer('active', [task(1, 0, 'A', NOW + 100 * H)]), '');
  assert.equal(layer('active', [task(1, 0, 'A', NOW + H, { done: true })]), '');
  for (const s of ['draft', 'completed', 'expired', 'legacy'])
    assert.equal(layer(s, [task(1, 0, 'A', NOW + 60000)]), '');
});

void test('끝난 프로젝트: 상단 시계와 캘린더 현재 막대가 움직이지 않는다', () => {
  const clock = renderToString(
    createElement(RaceClock, {
      lifecycle: 'expired',
      deadline: new Date(NOW - H).toISOString(),
      asOf: new Date(NOW).toISOString(),
      durationDays: 7,
      onZero: () => {},
    }),
  );
  assert.match(text(clock), /기한 종료/);
  assert.doesNotMatch(clock, /critical/);
  const props = {
    startedAt: new Date(NOW - H).toISOString(),
    deadline: new Date(NOW - H + 168 * H).toISOString(),
    now: NOW,
    tasks: [],
    people: [],
    onPlan: () => {},
  };
  assert.doesNotMatch(renderToString(createElement(DeadlineCalendar, { ...props, active: false })), /calendar-now/);
  assert.match(renderToString(createElement(DeadlineCalendar, { ...props, active: true })), /calendar-now/);
});

void test('캘린더 칩: 마감 초과는 빨강, 완료는 취소선', () => {
  assert.match(rule('.deadline-card.late'), /--red-/);
  assert.doesNotMatch(rule('.deadline-card.late'), /--heat-/);
  assert.match(rule('.deadline-card.done .deadline-title'), /line-through/);
});

// 홈 시안 v9(2026-11-09): 마감 정해진 내 업무가 없으면 프로젝트 마감까지 세고, 상단 시계에 이름표를 붙인다.
void test('카운트다운: 마감 정해진 내 업무가 없으면 프로젝트 마감까지 센다', () => {
  const html = renderToString(
    createElement(FocusCountdown, {
      tasks: [task(1, 0, 'A', null)],
      person: 0,
      now: NOW,
      deadline: new Date(NOW + 3 * H).toISOString(),
    }),
  );
  assert.match(text(html), /프로젝트 마감까지/);
  assert.match(text(html), /03:00:00/);
  assert.match(html, /role="timer"/);
  assert.doesNotMatch(text(html), /대기 중/);
});

void test('상단 시계: 진행 중이면 프로젝트 마감 이름표를 붙인다', () => {
  const clock = renderToString(
    createElement(RaceClock, {
      lifecycle: 'active',
      deadline: new Date(NOW + 5 * H).toISOString(),
      asOf: new Date(NOW).toISOString(),
      durationDays: 7,
      onZero: () => {},
    }),
  );
  assert.match(text(clock), /프로젝트 마감/);
  assert.match(text(clock), /05:00:00/);
});

void test('시안 v7대로: 체크인 안내 문장과 캘린더의 마감 미정 링크가 없다', () => {
  const members = [{ display_name: '도윤', person: 0, left_at: null }];
  const checks = text(
    renderToString(
      createElement(TeamCheckins, { members, me: { person: 0 }, tasks: [], checkins: [], now: NOW, active: true }),
    ),
  );
  assert.doesNotMatch(checks, /하루 한 번/);
  const cal = text(
    renderToString(
      createElement(DeadlineCalendar, {
        startedAt: new Date(NOW - H).toISOString(),
        deadline: new Date(NOW - H + 168 * H).toISOString(),
        now: NOW,
        tasks: [task(1, 0, 'A', null)],
        people: [{ name: '도윤' }],
        onPlan: () => {},
        active: true,
      }),
    ),
  );
  assert.doesNotMatch(cal, /마감 미정/);
});

// 2026-11-12 피드백: 큰 카운트다운은 0.01초 단위까지 보인다.
void test('카운트다운: 큰 숫자는 0.01초 단위까지 보인다', () => {
  assert.match(text(focus([task(1, 0, 'DB 구축', NOW + 2 * H + 1500)])), /02:00:01\.50/);
  const project = renderToString(
    createElement(FocusCountdown, {
      tasks: [],
      person: 0,
      now: NOW,
      deadline: new Date(NOW + 3 * H).toISOString(),
    }),
  );
  assert.match(text(project), /03:00:00\.00/);
});
