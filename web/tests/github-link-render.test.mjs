import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 마이페이지 GitHub 연결 카드를 서버 렌더링해 상태별 버튼과 문구를 확인한다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-github-link-')), 'github-link.mjs');
await build({
  entryPoints: ['components/github-link.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { GithubLinkCard } = await import(pathToFileURL(outfile).href);
const noop = () => {};
const render = (props) =>
  renderToString(createElement(GithubLinkCard, { busy: false, error: '', onLink: noop, onUnlink: noop, ...props }));

void test('연결 전: GitHub 연결 버튼과 학습 확인 안내가 있고 해제 버튼은 없다', () => {
  const html = render({ account: null });
  assert.match(html, /GitHub 연결<\/button>/);
  assert.match(html, /학습 확인은 GitHub를 연결해야 시작할 수 있어요/);
  // Supabase GitHub 공급자는 기본으로 user:email을 요청한다. 공개 프로필만 읽는다고 쓰지 않는다.
  assert.match(html, /프로필과 이메일 주소/);
  assert.doesNotMatch(html, /공개 프로필만/);
  assert.doesNotMatch(html, /연결 해제/);
});

void test('연결됨: @아이디와 연결 해제 버튼이 있고 연결 버튼은 없다', () => {
  const html = render({ account: { login: 'octo' } });
  assert.match(html, /@octo/);
  assert.match(html, /연결 해제<\/button>/);
  assert.doesNotMatch(html, /GitHub 연결<\/button>/);
});

void test('오류 문구는 alert 영역에 나온다', () => {
  const html = render({ account: null, error: '이미 다른 계정에 연결된 GitHub입니다.' });
  assert.match(html, /role="alert"[^>]*>이미 다른 계정에 연결된 GitHub입니다\./);
});
