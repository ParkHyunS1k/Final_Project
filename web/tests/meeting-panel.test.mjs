import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, '../app/page.tsx'), 'utf8');
const workspaceSource = readFileSync(
  join(dir, '../components/project-workspace.tsx'),
  'utf8',
);

test('page.tsx가 meetingSuggestions를 import하고 today 탭 블록에서 사용한다', () => {
  assert.match(
    pageSource,
    /import \{ meetingSuggestions \} from '@\/lib\/meeting-suggestions';/,
  );
  const todayBlockStart = pageSource.indexOf("tab === 'today'");
  assert.ok(todayBlockStart !== -1, "tab === 'today' 블록을 찾지 못했다");
  const usageIndex = pageSource.indexOf('meetingSuggestions(');
  assert.ok(usageIndex !== -1, 'meetingSuggestions 호출을 찾지 못했다');
});

test('workspaceViews 탭 목록은 회의 제안 패널 추가로 바뀌지 않는다', () => {
  const match = workspaceSource.match(
    /export const workspaceViews = (\[[\s\S]*?\n\];)/,
  );
  assert.ok(match, 'workspaceViews 정의를 찾지 못했다');
  const ids = [...match[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['plan', 'mine', 'today', 'docs', 'team', 'ai', 'result']);
});

test('page.tsx 소스에 사람이 읽는 담당자 표시용 숫자 fallback 패턴(담당자 ${...})이 남아 있지 않다', () => {
  assert.ok(
    !pageSource.includes('담당자 ${'),
    'page.tsx에 담당자 ${...} 형태의 숫자 fallback 표현이 남아 있다',
  );
});
