import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 작업 화면 색 변수의 글자 대비(WCAG AA 4.5:1)를 라이트(:root)·다크(.dark) 모두에서 지킨다.
const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, '../app/globals.css'), 'utf8');
const pageSource = readFileSync(join(dir, '../app/workspace/page.tsx'), 'utf8');

function block(selector) {
  const start = css.indexOf('\n' + selector + ' {');
  assert.ok(start !== -1, selector + ' 블록을 찾지 못했다');
  return css.slice(start, css.indexOf('}', start));
}
function tokens(selector) {
  return Object.fromEntries(
    [...block(selector).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]),
  );
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const light = tokens(':root');
const dark = { ...light, ...tokens('.dark') };

for (const [mode, t] of [
  ['라이트', light],
  ['다크', dark],
]) {
  void test(`${mode}: 글자에 쓰는 gray-400~900은 바탕(gray-0)과 카드(gray-50) 위에서 4.5:1 이상`, () => {
    for (const step of [400, 500, 600, 700, 800, 900])
      for (const bg of ['gray-0', 'gray-50']) {
        const ratio = contrast(t['gray-' + step], t[bg]);
        assert.ok(ratio >= 4.5, `${mode} gray-${step} on ${bg} = ${ratio.toFixed(2)}`);
      }
  });
}

void test('완료 표시(.criteria-check.ok)는 글자색을 한 번만, 주황 위 진한 글자로 정한다', () => {
  const colors = [...block('.criteria-check.ok').matchAll(/\bcolor:\s*([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(colors, ['var(--heat-ink)']);
});

void test('아바타는 테마와 관계없이 밝은 바탕 + 진한 글자다', () => {
  const avatar = block('.avatar');
  assert.match(avatar, /\bcolor:\s*var\(--heat-ink\);/);
  assert.match(avatar, /background:\s*#e2e2de;/);
  assert.ok(!pageSource.includes("?? 'var(--gray-200)'"), '아바타 대체 바탕이 테마 변수(다크에서 어두움)다');
  for (const bg of ['#dedaff', '#d8efd6', '#ffe4bd', '#e2e2de'])
    assert.ok(contrast(light['heat-ink'], bg) >= 4.5, bg);
});
