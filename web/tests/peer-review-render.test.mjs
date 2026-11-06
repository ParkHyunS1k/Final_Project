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
const { PeerReviewView, ReviewCards, needsRefresh, owesReview, reviewExpired } = await import(pathToFileURL(outfile).href);

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
const view = (d, solo = false, restriction = null) =>
  renderToString(
    createElement(PeerReviewView, { data: d, solo, restriction }),
  );
const count = (html, re) => (html.match(re) || []).length;

const cards = (d, title = '동료평가 확인 스프린트') =>
  renderToString(createElement(ReviewCards, { title, data: d, now: NOW, busy: false, error: '', onSubmit: () => {} }));

void test('평가 카드: 한 번에 팀원 한 명, 세 문항 1~5, 다 고르기 전엔 다음 불가, 다음 제재 안내', () => {
  const html = cards(
    data({
      targets: [
        { person: 1, displayName: '서연' },
        { person: 2, displayName: '민준' },
      ],
      penaltyDays: 7,
    }),
  );
  const t = text(html);
  assert.equal(count(html, /role="radiogroup"/g), 3);
  // 별 다섯 개, 별마다 반 개·한 개 → 문항당 0.5~5 열 칸.
  assert.equal(count(html, /type="radio"/g), 30);
  assert.equal(count(html, /value="0.5"/g), 3);
  assert.equal(count(html, /value="5"/g), 3);
  assert.match(t, /3\.5점/);
  assert.equal(count(html, /class="peer-star"/g), 15);
  assert.match(html, /aria-label="서연 기여도"/);
  assert.doesNotMatch(t, /민준/);
  assert.match(t, /1 \/ 2/);
  assert.match(t, /동료평가 확인 스프린트/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*다음/);
  assert.doesNotMatch(t, /평가 제출/);
  assert.match(t, /24시간 안에 내지 않으면 7일 동안 새 프로젝트를 시작할 수 없어요/);
  assert.match(t, /22:00:00/);
  const last = cards(data({ targets: [{ person: 1, displayName: '서연' }], penaltyDays: null }));
  assert.match(text(last), /더 이상 새 프로젝트를 시작할 수 없어요/);
  assert.match(last, /<button[^>]*disabled=""[^>]*>[^<]*평가 제출/);
});

void test('작업 공간 홈 카드는 폼 대신 안내만 보인다(폼은 모달 카드)', () => {
  const html = view(data({ targets: [{ person: 1, displayName: '서연' }], penaltyDays: 7 }));
  assert.equal(count(html, /type="radio"/g), 0);
  assert.match(text(html), /평가 카드를 채워야 결과를 볼 수 있어요/);
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

void test('결과가 열리기 전에는 다시 불러오고, 열린 뒤에는 멈춘다', () => {
  assert.equal(needsRefresh(null), true);
  assert.equal(needsRefresh(data({ status: 'open', submitted: true })), true);
  assert.equal(needsRefresh(data({ status: 'closed' })), false);
});

void test('결과가 가려진 미제출자에게 금지 기간을 알린다', () => {
  const html = view(data({ status: 'closed', hidden: true }), false, {
    until: '2026-11-13T05:00:00Z',
    permanent: false,
    misses: 1,
  });
  assert.match(text(html), /11월 13일.*14:00.*까지 새 프로젝트를 만들 수 없습니다/);
  const forever = view(data({ status: 'closed', hidden: true }), false, { until: null, permanent: true, misses: 3 });
  assert.match(text(forever), /3번 내지 않아 더 이상 새 프로젝트를 만들 수 없습니다/);
});

void test('모달은 낼 평가가 남았을 때만: 열림·미제출·대상 있음·가려지지 않음', () => {
  const one = [{ person: 1, displayName: '서연' }];
  assert.equal(owesReview(data({ targets: one })), true);
  assert.equal(owesReview(data({ targets: one, submitted: true })), false);
  assert.equal(owesReview(data({ targets: [] })), false);
  assert.equal(owesReview(data({ targets: one, status: 'closed' })), false);
});

void test('모달은 마감 시각이 지나면 서버에 다시 묻는다(제출할 수 없어진 모달에 갇히지 않게)', () => {
  const d = data({ targets: [{ person: 1, displayName: '서연' }] });
  assert.equal(reviewExpired(d, NOW), false);
  assert.equal(reviewExpired(d, NOW + 22 * H), true);
  assert.equal(reviewExpired(d, 0), false);
});
