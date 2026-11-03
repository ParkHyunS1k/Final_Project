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

void test('만들기 화면: 단어 3개·잠금 3개·주사위, 5단계 슬라이더 기본 MVP, 결과물 입력 없음', () => {
  const html = renderToString(createElement(ProjectCreate, { onSubmit: async () => true }));
  assert.equal((html.match(/class="dice-word"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label="[^"]+ 고정"/g) ?? []).length, 3);
  assert.match(html, /다시 굴리기/);
  assert.match(html, /type="range"[^>]*min="1"[^>]*max="5"/);
  assert.match(html, /value="2"/);
  const names = ['핵심 기능', 'MVP', '테스트', '데모', '배포'];
  let at = -1;
  for (const n of names) {
    const i = html.indexOf(n, at + 1);
    assert.ok(i > at, n);
    at = i;
  }
  assert.match(html, /사용자가 들어와서 목적을 이루고 나가는 흐름 하나를 완성한다/);
  assert.match(html, /혼자서도 시작할 수 있어요/);
  assert.match(html, /maxLength="100"|maxlength="100"/);
  assert.doesNotMatch(html, /name="deliverables"|필수 결과물/);
});
