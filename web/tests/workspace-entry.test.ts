import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceEntry } from '../lib/workspace-entry.ts';

const draft = { id: 'p_draft', lifecycle: 'draft' };
const active = { id: 'p_active', lifecycle: 'active' };
const done = { id: 'p_done', lifecycle: 'completed' };

void test('진행 중인 스프린트가 있으면 create=1이어도 만들기 대신 그 프로젝트를 연다', () => {
  assert.deepEqual(workspaceEntry('?create=1', [done, active, draft]), {
    invite: '',
    creating: false,
    selected: 'p_active',
  });
});

void test('준비 중인 프로젝트만 있으면 create=1이어도 그 프로젝트를 연다', () => {
  assert.deepEqual(workspaceEntry('?create=1', [done, draft]), {
    invite: '',
    creating: false,
    selected: 'p_draft',
  });
});

void test('완주·기한 종료 프로젝트만 있으면 create=1은 만들기 화면을 연다', () => {
  const expired = { id: 'p_expired', lifecycle: 'expired' };
  assert.equal(workspaceEntry('?create=1', [done, expired]).creating, true);
  assert.equal(workspaceEntry('?create=1', []).creating, true);
});

void test('주소의 project와 invite가 진행 중 스프린트보다 우선한다', () => {
  assert.equal(workspaceEntry('?project=p_done', [active, done]).selected, 'p_done');
  const invited = workspaceEntry('?invite=tok&create=1', []);
  assert.equal(invited.invite, 'tok');
  assert.equal(invited.creating, false);
});

void test('열린 프로젝트가 없으면 최근 프로젝트를 고른다', () => {
  assert.equal(workspaceEntry('', [done]).selected, 'p_done');
  assert.equal(workspaceEntry('', []).selected, '');
});
