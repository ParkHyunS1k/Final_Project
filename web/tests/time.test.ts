import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ms, sameInstant } from '../lib/time.ts';

const iso = '2026-10-03T09:00:00.000Z';

void test('ms는 Date와 ISO 문자열을 같은 밀리초로, 빈 값은 NaN으로', () => {
  assert.equal(ms(new Date(iso)), Date.parse(iso));
  assert.equal(ms(iso), Date.parse(iso));
  assert.ok(Number.isNaN(ms(null)));
  assert.ok(Number.isNaN(ms('')));
  assert.ok(Number.isNaN(ms(undefined)));
});

void test('sameInstant는 형태가 달라도 같은 시각이면 같다', () => {
  assert.equal(sameInstant(new Date(iso), iso), true);
  assert.equal(sameInstant('2026-10-03T18:00:00+09:00', iso), true);
  assert.equal(sameInstant(new Date(iso), new Date(Date.parse(iso) + 1)), false);
  assert.equal(sameInstant(null, null), true);
  assert.equal(sameInstant(null, ''), true);
  assert.equal(sameInstant(null, iso), false);
  assert.equal(sameInstant(new Date(iso), undefined), false);
});
