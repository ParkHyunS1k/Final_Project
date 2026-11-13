import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 업무 목록은 보드가 기본이고, 카드에 담당자와 마감(또는 예상 완료)이 보인다.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-tasks-')), 'task-collection.mjs');
await build({
  entryPoints: ['components/task-collection.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { TaskCollection } = await import(pathToFileURL(outfile).href);

const task = (id, over) => ({
  id,
  title: '업무 ' + id,
  person: 0,
  remaining: 2,
  dependsOn: [],
  done: false,
  status: 'todo',
  ...over,
});
function render() {
  return renderToString(
    createElement(TaskCollection, {
      sprint: {
        revision: 1,
        finished: false,
        people: [{ name: '도윤', role: '팀장', initial: '도', color: '#eee' }],
        tasks: [
          task(1, { dueAt: '2026-11-10T03:00:00.000Z' }),
          task(2, { status: 'in_progress', dependsOn: [1] }),
          task(3, { done: true, status: 'done' }),
        ],
      },
      plan: { finishes: { 2: '2026-11-11T01:00:00.000Z' }, unscheduled: [] },
      asOf: '2026-11-09T00:00:00.000Z',
      me: { person: 0, role: 'owner', agreedAt: '2026-11-08T00:00:00.000Z' },
      members: [{ person: 0, display_name: '도윤' }],
      checkins: [],
      busy: false,
      error: '',
      mine: false,
      mutate: async () => true,
      onEdit: () => {},
      onAdd: () => {},
    }),
  );
}

test('업무 목록은 보드가 먼저 열리고 세 열에 카드가 나뉜다', () => {
  const html = render();
  assert.match(html, /class="task-board"/);
  assert.doesNotMatch(html, /<table/);
  for (const label of ['시작 전', '진행 중', '완료'])
    assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.equal((html.match(/class="board-card(?: is-blocked)?"/g) ?? []).length, 3);
});

test('보드 카드에 담당자·마감·예상 완료·선행 작업이 보인다', () => {
  const html = render();
  assert.match(html, /도윤/);
  assert.match(html, /마감 11-10 12:00/);
  assert.match(html, /예상 완료 11-11 10:00/);
  assert.match(html, /선행 (<!-- -->)?1/);
});

// 2026-11-14 PR 연결: 카드에 업무 번호와 PR 상태, 상세 패널에 브랜치 이름과 제안.
const { PrPanel } = await import(pathToFileURL(outfile).href);
const pull = (number, state) => ({ number, title: `PR ${number}`, state, branch: `pm-1-x`, author: 'alice', url: `https://github.com/t/a/pull/${number}` });

test('보드 카드에 업무 번호와 연결된 PR 상태가 보인다', () => {
  const html = renderToString(
    createElement(TaskCollection, {
      sprint: { revision: 1, finished: false, people: [{ name: '도윤' }], tasks: [task(1, { title: 'Login 화면' })] },
      plan: { finishes: {}, unscheduled: [] },
      asOf: '2026-11-09T00:00:00.000Z',
      me: { person: 0, role: 'owner', agreedAt: '2026-11-08T00:00:00.000Z' },
      members: [{ person: 0, display_name: '도윤' }],
      checkins: [],
      busy: false,
      error: '',
      mine: false,
      mutate: async () => true,
      onEdit: () => {},
      onAdd: () => {},
      pulls: { 1: [pull(10, 'merged')] },
    }),
  );
  assert.match(html, /PM-1/);
  assert.match(html, /#(<!-- -->)?10/);
  assert.match(html, /머지됨/);
});

test('PR 패널: 브랜치 이름 복사, 열린 PR이면 진행 중 제안, 모두 머지면 완료 제안', () => {
  const t = { id: 1, title: 'Login 화면', done: false, status: 'todo' };
  const start = renderToString(createElement(PrPanel, { task: t, pulls: [pull(10, 'open')], canEdit: true, onStart: () => {}, onUseEvidence: () => {} }));
  assert.match(start, /pm-1-login/);
  assert.match(start, /진행 중으로 바꿀까요/);
  const done = renderToString(
    createElement(PrPanel, { task: { ...t, status: 'in_progress' }, pulls: [pull(10, 'merged')], canEdit: true, onStart: () => {}, onUseEvidence: () => {} }),
  );
  assert.match(done, /머지됐어요/);
  assert.doesNotMatch(done, /진행 중으로 바꿀까요/);
  const waiting = renderToString(
    createElement(PrPanel, { task: { ...t, status: 'in_progress' }, pulls: [pull(10, 'merged'), pull(11, 'open')], canEdit: true, onStart: () => {}, onUseEvidence: () => {} }),
  );
  assert.doesNotMatch(waiting, /머지됐어요/);
  const none = renderToString(createElement(PrPanel, { task: t, pulls: [], canEdit: true, onStart: () => {}, onUseEvidence: () => {} }));
  assert.match(none, /연결된 PR이 없어요/);
});
