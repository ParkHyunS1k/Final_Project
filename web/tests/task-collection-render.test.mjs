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
