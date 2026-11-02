import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
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
    createElement(TeamCheckins, { members, me: { person: 0 }, tasks, checkins, now: NOW }),
  );
  const rows = html.split('race-checkin-row').slice(1).map(text);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /도윤.*나.*DB 구축.*오늘 체크인 완료/);
  assert.match(rows[1], /서연.*화면 시안.*아직 체크인 안 함/);
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
