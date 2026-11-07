import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 진행 보고 저장 직후 재생하는 축하 영상: 어떤 영상을 고르는지, 언제 건너뛰는지.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-celebration-')), 'celebration.mjs');
await build({
  entryPoints: ['components/checkin-celebration.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { CELEBRATIONS, celebrationFor, CheckinCelebration } = await import(pathToFileURL(outfile).href);

test('영상 6개가 모두 public/에 있다', () => {
  assert.equal(CELEBRATIONS.length, 6);
  for (const src of CELEBRATIONS) assert.ok(existsSync(join('public', src)), src);
});

test('진행 보고 저장이면 난수로 6개 중 하나를 고른다', () => {
  assert.equal(celebrationFor('checkin', false, 0), CELEBRATIONS[0]);
  assert.equal(celebrationFor('checkin', false, 0.5), CELEBRATIONS[3]);
  assert.equal(celebrationFor('checkin', false, 0.9999), CELEBRATIONS[5]);
});

test('다른 저장이나 동작 줄이기 설정이면 재생하지 않는다', () => {
  assert.equal(celebrationFor('editTask', false, 0), null);
  assert.equal(celebrationFor('checkin', true, 0), null);
});

test('소리 없이 자동 재생하는 영상을 그린다', () => {
  const html = renderToString(createElement(CheckinCelebration, { src: CELEBRATIONS[1], onDone() {} }));
  assert.match(html, /<dialog[^>]*class="celebration-dialog"/);
  assert.match(html, /<video[^>]*src="\/checkin\/2\.mp4"/);
  assert.match(html, /autoPlay|autoplay/);
  assert.match(html, /playsInline|playsinline/);
});
