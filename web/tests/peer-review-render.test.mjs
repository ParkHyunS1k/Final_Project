import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// 끝난 프로젝트 홈의 동료평가 카드: 상태별 폼·결과·안내 문구.
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const outfile = join(mkdtempSync(join(cache, 'pm-peer-review-')), 'peer-review.mjs');
await build({
  entryPoints: ['components/peer-review.tsx'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  alias: { '@': process.cwd() },
});
const { PeerReviewView } = await import(pathToFileURL(outfile).href);

const NOW = Date.parse('2026-11-06T03:00:00.000Z');
const H = 3600000;
const BADGES = [
  ['finish', '7일 완주'],
  ['solo_finish', '솔로 완주'],
  ['top_contributor', '핵심 기여자'],
  ['top_communicator', '소통왕'],
  ['reviewer', '평가 완료'],
].map(([id, label]) => ({ id, label, description: label + ' 조건', earnedAt: null }));
const earned = (...ids) =>
  BADGES.map((b) => (ids.includes(b.id) ? { ...b, earnedAt: new Date(NOW - H).toISOString() } : b));
const data = (review, extra = {}) => ({
  score: null,
  grade: null,
  breakdown: [],
  badges: earned('finish'),
  ...extra,
  review: {
    status: 'open',
    opensAt: new Date(NOW - 2 * H).toISOString(),
    closesAt: new Date(NOW + 22 * H).toISOString(),
    submitted: false,
    reviewers: null,
    minReviewers: 2,
    targets: [],
    hidden: false,
    penaltyDays: null,
    ...review,
  },
});
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');
const view = (d, solo = false) =>
  renderToString(
    createElement(PeerReviewView, { data: d, now: NOW, solo, busy: false, error: '', onSubmit: () => {} }),
  );
const count = (html, re) => (html.match(re) || []).length;

void test('평가 폼: 팀원마다 세 문항 1~5 라디오, 다 채우기 전엔 제출 불가, 다음 제재 안내', () => {
  const html = view(
    data({
      targets: [
        { person: 1, displayName: '서연' },
        { person: 2, displayName: '민준' },
      ],
      penaltyDays: 7,
    }),
  );
  assert.equal(count(html, /role="radiogroup"/g), 6);
  assert.equal(count(html, /type="radio"/g), 30);
  assert.match(html, /aria-label="서연 기여도"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*제출/);
  assert.match(text(html), /24시간 안에 내지 않으면 7일 동안 새 프로젝트를 시작할 수 없어요/);
  assert.match(text(html), /22:00:00/);
  const forever = view(data({ targets: [{ person: 1, displayName: '서연' }], penaltyDays: null }));
  assert.match(text(forever), /더 이상 새 프로젝트를 시작할 수 없어요/);
});

void test('제출함: 결과가 열리는 조건 안내', () => {
  const html = view(data({ submitted: true }, { badges: earned('finish', 'reviewer') }));
  assert.match(text(html), /평가를 냈어요/);
  assert.match(text(html), /팀원 전원이 내거나/);
  assert.equal(count(html, /type="radio"/g), 0);
});

void test('결과: 등급·5점 점수·약한 문항·다음 등급까지·평가 인원, 못 받은 뱃지는 흐리게', () => {
  const html = view(
    data(
      { status: 'closed', submitted: true, reviewers: 3 },
      {
        score: 4.1,
        grade: 'A',
        breakdown: [
          { key: 'contribution', label: '기여도', average: 4.7 },
          { key: 'communication', label: '소통', average: 3.3 },
          { key: 'commitment', label: '약속 이행', average: 4.3 },
        ],
        badges: earned('finish', 'top_contributor', 'reviewer'),
      },
    ),
  );
  const t = text(html);
  assert.match(t, /4\.1 \/ 5/);
  assert.match(t, /다음 프로젝트에선 소통을 챙겨 보세요/);
  assert.match(t, /S까지 0\.7/);
  assert.match(t, /팀원 3명이 평가했어요/);
  assert.match(html, /class="peer-badge off"/);
  assert.match(html, /class="peer-badge"/);
  const best = view(
    data(
      { status: 'closed', submitted: true, reviewers: 2 },
      {
        score: 4.9,
        grade: 'S',
        breakdown: [
          { key: 'contribution', label: '기여도', average: 5 },
          { key: 'communication', label: '소통', average: 4.8 },
          { key: 'commitment', label: '약속 이행', average: 4.9 },
        ],
      },
    ),
  );
  assert.match(text(best), /세 문항 모두 4\.5 이상이에요/);
  assert.doesNotMatch(text(best), /까지 0/);
});

void test('2명 미만·가려짐·솔로', () => {
  assert.match(
    text(view(data({ status: 'closed', submitted: true, reviewers: 1 }))),
    /평가한 팀원이 2명이 안 돼 이번에는 점수가 없어요/,
  );
  assert.match(
    text(view(data({ status: 'closed', hidden: true }))),
    /평가를 내지 않아 이번 결과는 볼 수 없어요/,
  );
  const solo = view(data({ status: 'closed', reviewers: 0 }, { badges: earned('finish', 'solo_finish') }), true);
  assert.equal(count(solo, /type="radio"/g), 0);
  assert.doesNotMatch(text(solo), /2명이 안 돼|볼 수 없어요/);
  assert.match(text(solo), /솔로 완주/);
});

void test('약한 문항 안내의 조사: 받침 없으면 를', () => {
  const html = view(
    data(
      { status: 'closed', submitted: true, reviewers: 2 },
      {
        score: 3.7,
        grade: 'B',
        breakdown: [
          { key: 'contribution', label: '기여도', average: 3 },
          { key: 'communication', label: '소통', average: 4 },
          { key: 'commitment', label: '약속 이행', average: 4 },
        ],
      },
    ),
  );
  assert.match(text(html), /다음 프로젝트에선 기여도를 챙겨 보세요/);
});
