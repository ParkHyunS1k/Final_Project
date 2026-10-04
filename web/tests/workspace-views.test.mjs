import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, '../app/workspace/page.tsx'), 'utf8');

// 이전 규칙(legacy) 프로젝트는 plan이 없다. 업무 메뉴와 변경안 검토는 plan 없이도 열려야 한다(예전 ai 탭 대체).
void test('업무 메뉴 블록은 plan 유무로 통째로 막지 않고, plan이 없으면 변경안 검토를 연다', () => {
  assert.ok(!pageSource.includes("tab === 'tasks' && plan &&"), '업무 메뉴 전체가 plan으로 막혀 있다');
  assert.match(pageSource, /\{tab === 'tasks' && \(/);
  assert.match(pageSource, /reviewing \|\| !plan \?/);
});
