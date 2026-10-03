import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iso, ms, sameInstant } from '../lib/time.ts';

const AT = '2026-10-03T09:00:00.000Z';

void test('ms는 Date와 ISO 문자열을 같은 밀리초로, 빈 값은 NaN으로', () => {
  assert.equal(ms(new Date(AT)), Date.parse(AT));
  assert.equal(ms(AT), Date.parse(AT));
  assert.ok(Number.isNaN(ms(null)));
  assert.ok(Number.isNaN(ms('')));
  assert.ok(Number.isNaN(ms(undefined)));
});

void test('sameInstant는 형태가 달라도 같은 시각이면 같다', () => {
  assert.equal(sameInstant(new Date(AT), AT), true);
  assert.equal(sameInstant('2026-10-03T18:00:00+09:00', AT), true);
  assert.equal(sameInstant(new Date(AT), new Date(Date.parse(AT) + 1)), false);
  assert.equal(sameInstant(null, null), true);
  assert.equal(sameInstant(null, ''), true);
  assert.equal(sameInstant(null, AT), false);
  assert.equal(sameInstant(new Date(AT), undefined), false);
});

void test('iso는 Date와 다른 시간대 문자열을 같은 UTC ISO 문자열로', () => {
  assert.equal(iso(new Date(AT)), AT);
  assert.equal(iso('2026-10-03T18:00:00+09:00'), AT);
  assert.equal(iso(AT), AT);
});
