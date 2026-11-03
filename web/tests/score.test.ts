import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES,
  badgeList,
  gradeOf,
  parseReviews,
  peerScore,
  reportDays,
  reviewWindow,
  summarize,
} from '../lib/score.ts';

const DAY = 86400000;
const t0 = new Date('2026-10-01T00:00:00.000Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const r = (contribution: number, communication: number, commitment: number) => ({
  contribution,
  communication,
  commitment,
});

void test('등급 경계: S 90, A 75, B 60, 그 아래 C, 점수 없으면 null', () => {
  assert.equal(gradeOf(100), 'S');
  assert.equal(gradeOf(90), 'S');
  assert.equal(gradeOf(89.9), 'A');
  assert.equal(gradeOf(75), 'A');
  assert.equal(gradeOf(74.9), 'B');
  assert.equal(gradeOf(60), 'B');
  assert.equal(gradeOf(59.9), 'C');
  assert.equal(gradeOf(20), 'C');
  assert.equal(gradeOf(null), null);
});

void test('점수 = 세 문항 평균의 평균 × 20, 평가 기간이 끝나고 2명 이상일 때만', () => {
  const two = [r(5, 4, 5), r(4, 5, 4)];
  const s = peerScore(two, true);
  // 문항 평균 4.5, 4.5, 4.5 → 90
  assert.equal(s.score, 90);
  assert.equal(s.grade, 'S');
  assert.equal(s.reviewers, 2);
  assert.deepEqual(
    s.breakdown.map((b) => b.key),
    ['contribution', 'communication', 'commitment'],
  );
  assert.deepEqual(
    s.breakdown.map((b) => b.points),
    [30, 30, 30],
  );
  // 경계 바로 아래: 평균 40/9 → 88.9 → A
  const below = peerScore([r(5, 5, 5), r(4, 4, 4), r(5, 4, 4)], true);
  assert.equal(below.score, 88.9);
  assert.equal(below.grade, 'A');
  assert.equal(peerScore([r(1, 1, 1), r(1, 1, 1)], true).score, 20);
  assert.equal(peerScore([r(1, 1, 1), r(1, 1, 1)], true).grade, 'C');
  // 기간 중이거나 1명뿐이면 숨긴다.
  for (const hidden of [peerScore(two, false), peerScore([r(5, 5, 5)], true), peerScore([], true)]) {
    assert.equal(hidden.score, null);
    assert.equal(hidden.grade, null);
    assert.equal(hidden.averages, null);
    assert.deepEqual(hidden.breakdown, []);
  }
});

void test('같은 평가 기록이면 순서와 관계없이 같은 점수', () => {
  const list = [r(5, 3, 4), r(2, 4, 5), r(3, 3, 3)];
  const a = peerScore(list, true);
  const b = peerScore([...list].reverse(), true);
  assert.deepEqual(a, b);
  assert.equal(a.score, Math.round(((10 / 3 + 10 / 3 + 4) / 3) * 20 * 10) / 10);
});

void test('평가 기간: 끝난 시각부터 7일, 준비·진행 중과 이전 규칙은 열리지 않는다', () => {
  assert.equal(reviewWindow(null, at(1)).status, 'not_open');
  assert.equal(
    reviewWindow({ lifecycle: 'draft', deadlineAt: null, completedAt: null }, at(1)).status,
    'not_open',
  );
  const active = { lifecycle: 'active' as const, deadlineAt: at(7), completedAt: null };
  assert.equal(reviewWindow(active, at(6.9)).status, 'not_open');
  // 저장 상태가 active여도 기한이 지나면 기한 종료로 보고 연다.
  const expired = reviewWindow(active, at(7));
  assert.equal(expired.status, 'open');
  assert.deepEqual(expired.opensAt, at(7));
  assert.deepEqual(expired.closesAt, at(14));
  assert.equal(reviewWindow(active, at(13.99)).status, 'open');
  assert.equal(reviewWindow(active, at(14)).status, 'closed');
  const done = { lifecycle: 'completed' as const, deadlineAt: at(7), completedAt: at(3) };
  assert.equal(reviewWindow(done, at(3)).status, 'open');
  assert.equal(reviewWindow(done, at(9.99)).status, 'open');
  assert.equal(reviewWindow(done, at(10)).status, 'closed');
});

void test('매일 보고: 일차마다 1회만 센다, 보고 반복으로 늘지 않는다', () => {
  const many = Array.from({ length: 30 }, (_, i) => new Date(t0.getTime() + i * 60000));
  assert.deepEqual(reportDays(t0, at(7), many), { required: 7, reported: 1 });
  const daily = [0.1, 1.2, 2.5, 3.9, 4.1, 5.5, 6.99].map(at);
  assert.deepEqual(reportDays(t0, at(7), daily), { required: 7, reported: 7 });
  // 3.5일 만에 완주하면 4일차까지 필요하다. 범위 밖 보고는 세지 않는다.
  assert.deepEqual(reportDays(t0, at(3.5), [at(-1), at(0.5), at(1.5), at(2.5), at(3.2), at(5)]), {
    required: 4,
    reported: 4,
  });
});

const ended = {
  completedAt: at(5),
  endedAt: at(5),
  closesAt: at(12),
  active: true,
  solo: false,
  daily: { required: 5, reported: 5 },
  zeroBottleneck: true,
  averages: { contribution: 4.5, communication: 4.4, commitment: 5 },
  reviewedAt: at(6),
};
const earned = (facts: Parameters<typeof badgeList>[0]) =>
  badgeList(facts)
    .filter((b) => b.earnedAt)
    .map((b) => b.id);

void test('뱃지 조건: 완주·솔로·매일 보고·병목 0·동료평가·평가 완료', () => {
  assert.deepEqual(
    badgeList(ended).map((b) => b.id),
    BADGES.map((b) => b.id),
  );
  assert.deepEqual(earned(ended), [
    'finish',
    'daily_report',
    'zero_bottleneck',
    'top_contributor',
    'promise_keeper',
    'reviewer',
  ]);
  const byId = Object.fromEntries(badgeList(ended).map((b) => [b.id, b.earnedAt]));
  assert.deepEqual(byId.finish, at(5));
  assert.deepEqual(byId.top_contributor, at(12));
  assert.deepEqual(byId.reviewer, at(6));
  assert.deepEqual(earned({ ...ended, solo: true, averages: null, reviewedAt: null }), [
    'finish',
    'solo_finish',
    'daily_report',
    'zero_bottleneck',
  ]);
  // 기한 종료: 완주 뱃지 없음, 매일 보고는 받을 수 있다.
  assert.deepEqual(
    earned({
      ...ended,
      completedAt: null,
      endedAt: at(7),
      zeroBottleneck: true,
      daily: { required: 7, reported: 7 },
      averages: null,
      reviewedAt: null,
    }),
    ['daily_report'],
  );
  // 하루를 빼먹거나, 일차가 3개 미만이면 매일 보고 없음.
  assert.ok(!earned({ ...ended, daily: { required: 5, reported: 4 } }).includes('daily_report'));
  assert.ok(!earned({ ...ended, daily: { required: 2, reported: 2 } }).includes('daily_report'));
  assert.ok(earned({ ...ended, daily: { required: 3, reported: 3 } }).includes('daily_report'));
  // 참여 중단한 사람은 팀 뱃지를 받지 않는다.
  assert.deepEqual(earned({ ...ended, active: false, averages: null, reviewedAt: null }), []);
  // 끝나지 않은 프로젝트는 아무것도 없다.
  assert.deepEqual(
    earned({ ...ended, completedAt: null, endedAt: null, averages: null, reviewedAt: null }),
    [],
  );
});

void test('평가 입력: 대상 전원을 한 번씩, 1~5 정수만', () => {
  const ok = parseReviews(
    [
      { person: 1, contribution: 5, communication: 1, commitment: 3 },
      { person: 2, contribution: 2, communication: 4, commitment: 5 },
    ],
    [2, 1],
  );
  assert.deepEqual(
    ok.map((x) => x.person),
    [1, 2],
  );
  const bad: unknown[] = [
    [
      { person: '1', contribution: 5, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    null,
    'x',
    [],
    [{ person: 1, contribution: 5, communication: 1, commitment: 3 }],
    [
      { person: 1, contribution: 5, communication: 1, commitment: 3 },
      { person: 1, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: 5, communication: 1, commitment: 3 },
      { person: 9, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: 6, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: 0, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: 4.5, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: '5', communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
  ];
  for (const value of bad) assert.throws(() => parseReviews(value, [1, 2]), /평가/);
  assert.throws(() => parseReviews([], []), /평가할 팀원/);
});

void test('내 기록 요약: 확정 점수 합·최고 등급·뱃지별 처음 받은 시각과 횟수', () => {
  const badge = (id: string, earnedAt: Date | null) => ({
    ...BADGES.find((b) => b.id === id)!,
    earnedAt,
  });
  const me = summarize([
    { score: 80, grade: 'A', badges: [badge('finish', at(5)), badge('reviewer', null)] },
    { score: null, grade: null, badges: [badge('finish', at(2)), badge('reviewer', at(3))] },
    { score: 91.5, grade: 'S', badges: [badge('finish', null)] },
  ]);
  assert.equal(me.totalScore, 171.5);
  assert.equal(me.bestGrade, 'S');
  assert.equal(me.projects, 2);
  const finish = me.badges.find((b) => b.id === 'finish')!;
  assert.deepEqual(finish.earnedAt, at(2));
  assert.equal(finish.count, 2);
  const solo = me.badges.find((b) => b.id === 'solo_finish')!;
  assert.equal(solo.earnedAt, null);
  assert.equal(solo.count, 0);
  const empty = summarize([]);
  assert.equal(empty.totalScore, 0);
  assert.equal(empty.bestGrade, null);
  assert.equal(empty.badges.length, BADGES.length);
});
