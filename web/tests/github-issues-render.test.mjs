import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// GitHub 이슈 고르기 화면과 팀원 아님 경고를 서버 렌더링해 확인한다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-github-issues-')), 'github-issues.mjs');
await build({
  entryPoints: ['components/github-issues.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { GithubIssuePicker, NonMemberBanner, initialChecked } = await import(pathToFileURL(outfile).href);
const noop = () => {};
const item = (number, over = {}) => ({
  number,
  title: `이슈 ${number}`,
  author: 'alice',
  authorIsMember: true,
  assignees: [],
  labels: [],
  url: `https://github.com/team/app/issues/${number}`,
  imported: false,
  ...over,
});

void test('initialChecked: 이미 가져온 이슈만 해제, 팀원 아님은 체크', () => {
  assert.deepEqual(initialChecked([item(1), item(2, { authorIsMember: false }), item(3, { imported: true })]), {
    1: true,
    2: true,
    3: false,
  });
});

void test('피커: 팀원 아님·이미 가져옴 배지와 고른 개수 버튼', () => {
  const issues = [item(1), item(2, { authorIsMember: false, author: 'stranger' }), item(3, { imported: true })];
  const html = renderToString(
    createElement(GithubIssuePicker, { issues, checked: initialChecked(issues), busy: false, onToggle: noop, onImport: noop }),
  );
  assert.match(html, /팀원 아님/);
  assert.match(html, /이미 가져옴/);
  assert.match(html, /#2/);
  assert.match(html, /2개 가져오기<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>2개 가져오기/);
});

void test('피커: 아무것도 고르지 않으면 가져오기 버튼이 꺼진다', () => {
  const html = renderToString(
    createElement(GithubIssuePicker, { issues: [item(1)], checked: { 1: false }, busy: false, onToggle: noop, onImport: noop }),
  );
  assert.match(html, /<button[^>]*disabled[^>]*>0개 가져오기<\/button>/);
});

void test('배너: 팀원 아닌 작성자가 있으면 문구, 없으면 아무것도 없다', () => {
  const html = renderToString(
    createElement(NonMemberBanner, {
      spans: [
        { authorLogin: 'a', authorIsMember: false },
        { authorLogin: 'alice', authorIsMember: true },
        { authorLogin: 'b', authorIsMember: false },
        { authorLogin: 'a', authorIsMember: false },
      ],
    }),
  );
  assert.match(html, /팀원이 아닌 사람이 쓴 이슈 3건이 포함되어 있습니다 \(@a, @b\)/);
  assert.equal(renderToString(createElement(NonMemberBanner, { spans: [{ authorLogin: 'alice', authorIsMember: true }] })), '');
});
