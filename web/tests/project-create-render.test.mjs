import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 만들기 화면을 서버 렌더링해 주사위·슬라이더 구성과 결과물 입력이 없는지 확인한다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-create-')), 'project-create.mjs');
await build({
  entryPoints: ['components/project-create.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { ProjectCreate } = await import(pathToFileURL(outfile).href);

void test('만들기 화면: 단어 3개·잠금 3개·주사위, 3단계 슬라이더 기본 검증까지, 결과물 입력 없음', () => {
  const html = renderToString(createElement(ProjectCreate, { onSubmit: async () => true }));
  assert.equal((html.match(/class="dice-word"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label="[^"]+ 고정"/g) ?? []).length, 3);
  assert.match(html, /다시 굴리기/);
  assert.match(html, /type="range"[^>]*min="1"[^>]*max="3"/);
  assert.match(html, /value="2"/);
  const names = ['핵심만', '검증까지', '확장까지'];
  let at = -1;
  for (const n of names) {
    const i = html.indexOf(n, at + 1);
    assert.ok(i > at, n);
    at = i;
  }
  assert.match(html, /팀 밖 사람 3명에게 써보게 하고 가장 큰 불편 하나를 고친다/);
  assert.match(html, /혼자서도 시작할 수 있어요/);
  assert.match(html, /maxLength="100"|maxlength="100"/);
  assert.doesNotMatch(html, /name="deliverables"|필수 결과물/);
  // 템플릿처럼 혼자/팀을 고른다. 기본은 혼자, 공개 체크는 팀일 때만.
  // 기본 단계(검증까지)의 누적 체크리스트와 항목 수를 보여준다.
  assert.match(html, /<ol class="hub-task-preview">/);
  assert.match(html, /팀 밖 사람 3명에게 써보게 하기/);
  assert.match(html, /5(<!-- -->)?개 할 일/);
  assert.match(html, /어떻게 시작할까요\?/);
  assert.match(html, /<input[^>]*type="radio"[^>]*checked=""[^>]*\/>혼자 시작/);
  assert.match(html, /팀으로 시작/);
  assert.doesNotMatch(html, /팀 찾기에 공개하고 모집하기/);
});

void test('동료평가 미제출로 금지 중이면 만들기 버튼을 끄고 언제까지인지 알린다', () => {
  const html = renderToString(
    createElement(ProjectCreate, {
      onSubmit: async () => true,
      restriction: { until: '2026-11-13T05:00:00Z', permanent: false, misses: 1 },
    }),
  );
  assert.match(html, /까지 새 프로젝트를 만들 수 없습니다/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>프로젝트 만들기/);
});
