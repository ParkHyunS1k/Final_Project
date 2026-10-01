import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneProgress,
  stepAt,
  frameAt,
  raceClock,
} from '../lib/landing-race.mjs';

test('pinned and unpinned scenes both map scroll into 0..1', () => {
  assert.equal(sceneProgress(100, 2000, 800, 800), 0);
  assert.equal(sceneProgress(-600, 2000, 800, 800), 0.5);
  assert.equal(sceneProgress(-5000, 2000, 800, 800), 1);
  // 고정하지 않은 모바일 장면: 화면 아래에서 들어올 때부터 켜진다.
  assert.equal(sceneProgress(800, 900, 900, 800), 0);
  assert.equal(sceneProgress(200, 900, 900, 800), 1);
});

test('steps start dark, reach the last beat and stay bounded', () => {
  assert.equal(stepAt(0, 4), 0);
  assert.equal(stepAt(0.5, 4), 2);
  assert.equal(stepAt(1, 4), 4);
  assert.equal(stepAt(NaN, 4), 0);
});

test('video frame never passes the end and ignores unloaded media', () => {
  assert.equal(frameAt(1, 5.06), 5);
  assert.equal(frameAt(2, 5.06), 5);
  assert.equal(frameAt(0.5, NaN), 0);
});

test('race clock runs from 168h on day 1 down to the finish time on day 6', () => {
  assert.deepEqual(raceClock(0), { day: 1, text: '168:00:00' });
  assert.deepEqual(raceClock(-1), { day: 1, text: '168:00:00' });
  assert.deepEqual(raceClock(1), { day: 6, text: '31:04:12' });
  assert.deepEqual(raceClock(5), { day: 6, text: '31:04:12' });
  assert.equal(raceClock(0.5).day, 3);
});

import { featureAt, cursorAt } from '../lib/landing-race.mjs';

test('feature list splits progress into items and stays on the last item', () => {
  assert.deepEqual(featureAt(0, 3), { item: 0, t: 0 });
  assert.deepEqual(featureAt(0.5, 3), { item: 1, t: 0.5 });
  assert.deepEqual(featureAt(1, 3), { item: 2, t: 1 });
  assert.deepEqual(featureAt(-2, 3), { item: 0, t: 0 });
});

test('cursor eases between keys and presses briefly at press keys', () => {
  const keys = [
    { t: 0, x: 0, y: 0 },
    { t: 0.5, x: 100, y: 50, press: true },
    { t: 1, x: 100, y: 50 },
  ];
  assert.deepEqual(cursorAt(0, keys), { x: 0, y: 0, press: false });
  assert.deepEqual(cursorAt(0.25, keys), { x: 50, y: 25, press: false });
  assert.equal(cursorAt(0.52, keys).press, true);
  assert.equal(cursorAt(0.6, keys).press, false);
  assert.deepEqual(cursorAt(2, keys), { x: 100, y: 50, press: false });
});

import { rollAt } from '../lib/landing-race.mjs';

test('rolling number climbs, holds, then rolls to the next segment', () => {
  const segs = [
    [0, 2, 0.35, 0.5],
    [2, -1, 0.68, 0.8],
  ];
  assert.equal(rollAt(0, segs), 0);
  assert.equal(rollAt(0.5, segs), 2);
  assert.equal(rollAt(0.6, segs), 2);
  assert.equal(rollAt(0.74, segs), 1);
  assert.equal(rollAt(1, segs), -1);
  assert.equal(rollAt(0.5, []), 0);
});

test('구현되지 않은 진단·팀 매칭·증명 장면은 준비 중이라고 밝힌다', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync('components/landing-page.tsx', 'utf8');
  for (const id of ['diagnose', 'match', 'proof']) {
    const start = page.indexOf(`id="${id}"`);
    assert.ok(start > 0, id);
    const head = page.slice(start, page.indexOf('</h2>', start));
    assert.match(head, /준비 중/, id);
  }
});
