import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 화면 컴포넌트를 서버 렌더링해 첫 화면(효과 실행 전)을 확인한다. 패키지는 node_modules에서 읽는다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-review-')), 'change-review.mjs');
await build({
  entryPoints: ['components/change-review.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
});
const { ChangeReview } = await import(pathToFileURL(outfile).href);

test('AI 사용 가능 여부를 받기 전(로딩·조회 실패)에는 붙여넣기 입력을 보여주지 않는다', () => {
  const html = renderToString(
    createElement(ChangeReview, {
      projectId: 'p1',
      revision: 0,
      tasks: [],
      members: [],
      me: { person: 1, role: 'owner', userId: 'u1', displayName: '팀장' },
      writable: true,
      onApplied: () => {},
    }),
  );
  assert.doesNotMatch(html, /id="source-body"/);
  assert.match(html, /불러오는 중/);
});
