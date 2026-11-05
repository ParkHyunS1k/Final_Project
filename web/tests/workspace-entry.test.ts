import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceEntry } from '../lib/workspace-entry.ts';

const draft = { id: 'p_draft', lifecycle: 'draft' };
const active = { id: 'p_active', lifecycle: 'active' };
const done = { id: 'p_done', lifecycle: 'completed' };

void test('진행 중인 스프린트가 있으면 create=1이어도 만들기 대신 그 프로젝트를 연다', () => {
  assert.deepEqual(workspaceEntry('?create=1', [done, active, draft]), {
    invite: '',
    browsing: false,
    selected: 'p_active',
  });
});

void test('준비 중인 프로젝트만 있으면 create=1이어도 그 프로젝트를 연다', () => {
  assert.deepEqual(workspaceEntry('?create=1', [done, draft]), {
    invite: '',
    browsing: false,
    selected: 'p_draft',
  });
});

void test('진행·준비 중인 프로젝트가 없으면 만들기 대신 팀 찾기를 연다', () => {
  const expired = { id: 'p_expired', lifecycle: 'expired' };
  assert.equal(workspaceEntry('?create=1', [done, expired]).browsing, true);
  assert.equal(workspaceEntry('?create=1', []).browsing, true);
  assert.equal(workspaceEntry('', [done]).browsing, true);
  assert.equal(workspaceEntry('', []).browsing, true);
});

void test('teams=1은 열린 프로젝트가 있어도 팀 찾기를 연다', () => {
  assert.equal(workspaceEntry('?teams=1', [active]).browsing, true);
});

void test('주소의 project와 invite가 진행 중 스프린트보다 우선한다', () => {
  assert.equal(workspaceEntry('?project=p_done', [active, done]).selected, 'p_done');
  assert.equal(workspaceEntry('?project=p_done', [done]).browsing, false);
  const invited = workspaceEntry('?invite=tok&teams=1', []);
  assert.equal(invited.invite, 'tok');
  assert.equal(invited.browsing, false);
});

void test('열린 프로젝트가 없어도 프로젝트 선택 메뉴에는 최근 프로젝트를 둔다', () => {
  assert.equal(workspaceEntry('', [done]).selected, 'p_done');
  assert.equal(workspaceEntry('', []).selected, '');
});
