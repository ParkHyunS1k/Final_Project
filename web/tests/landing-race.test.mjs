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
