import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 팀 찾기 '내 신청' 목록을 서버 렌더링해 버튼 구성을 확인한다. 패키지는 node_modules에서 읽는다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-teams-')), 'team-directory.mjs');
await build({
  entryPoints: ['components/team-directory.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { MyRequests } = await import(pathToFileURL(outfile).href);
const at = '2026-10-15T03:50:00.000Z';

void test('공개 카드가 없어도 대기 중인 내 신청에는 취소 버튼이 있고, 처리된 신청에는 없다', () => {
  const html = renderToString(
    createElement(MyRequests, {
      busy: false,
      onCancel: () => {},
      requests: [
        { requestId: 'jr_1', projectId: 'p_hidden', title: '비공개로 바뀐 팀', status: 'pending', createdAt: at },
        { requestId: 'jr_2', projectId: 'p_ok', title: '승인된 팀', status: 'approved', createdAt: at },
        { requestId: 'jr_3', projectId: 'p_no', title: '거절된 팀', status: 'rejected', createdAt: at },
      ],
    }),
  );
  const rows = html.split('<li>').slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /비공개로 바뀐 팀[\s\S]*팀장 확인 대기[\s\S]*<button[^>]*>신청 취소<\/button>/);
  assert.doesNotMatch(rows[1] + rows[2], /신청 취소/);
  assert.match(html, /href="\/workspace\?project=p_ok"/);
});
