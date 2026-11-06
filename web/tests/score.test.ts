import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES,
  badgeList,
  dutiesFrom,
  gradeOf,
  nextGrade,
  parseReviews,
  peerScore,
  penaltyDays,
  reportDays,
  restrictionMessage,
  restrictionOf,
  resultHidden,
  reviewWindow,
  summarize,
  weakestItem,
} from '../lib/score.ts';

const DAY = 86400000;
const H = 3600000;
const t0 = new Date('2026-10-01T00:00:00.000Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const r = (contribution: number, communication: number, commitment: number) => ({
  contribution,
  communication,
  commitment,
});


void test('등급 5점제: S 4.8, A 4.0, B 3.0, C 2.0, 그 아래 D', () => {
  for (const [s, g] of [
    [5, 'S'],
    [4.8, 'S'],
    [4.7, 'A'],
    [4.0, 'A'],
    [3.9, 'B'],
    [3.0, 'B'],
    [2.9, 'C'],
    [2.0, 'C'],
    [1.9, 'D'],
    [1.0, 'D'],
  ] as const)
    assert.equal(gradeOf(s), g);
  assert.equal(gradeOf(null), null);
});

void test('점수 = 세 문항 평균의 평균, 소수 첫째 자리 반올림, 2명 이상·공개 뒤에만', () => {
  const s = peerScore([r(5, 3, 4), r(4, 4, 5), r(5, 3, 4)], true);
  assert.equal(s.score, 4.1);
  assert.equal(s.grade, 'A');
  assert.equal(s.reviewers, 3);
  assert.deepEqual(
    s.breakdown.map((b) => [b.key, b.average]),
    [
      ['contribution', 4.7],
      ['communication', 3.3],
      ['commitment', 4.3],
    ],
  );
  // 평균 4.75 → 4.8로 반올림해 S
  const edge = peerScore([r(5, 5, 5), r(5, 5, 4), r(5, 5, 4), r(5, 5, 4)], true);
  assert.equal(edge.score, 4.8);
  assert.equal(edge.grade, 'S');
  assert.equal(peerScore([r(1, 1, 1), r(1, 1, 1)], true).score, 1);
  assert.equal(peerScore([r(1, 1, 1), r(1, 1, 1)], true).grade, 'D');
  for (const hidden of [
    peerScore([r(5, 5, 5), r(5, 5, 5)], false),
    peerScore([r(5, 5, 5)], true),
    peerScore([], true),
  ]) {
    assert.equal(hidden.score, null);
    assert.equal(hidden.grade, null);
    assert.equal(hidden.averages, null);
    assert.deepEqual(hidden.breakdown, []);
  }
});

void test('같은 평가 기록이면 순서와 관계없이 같은 점수', () => {
  const list = [r(5, 3, 4), r(2, 4, 5), r(3, 3, 3)];
  assert.deepEqual(peerScore(list, true), peerScore([...list].reverse(), true));
});

void test('평가 기간: 끝난 시각부터 24시간, 준비·진행 중과 이전 규칙은 열리지 않는다', () => {
  assert.equal(reviewWindow(null, at(1)).status, 'not_open');
  assert.equal(
    reviewWindow({ lifecycle: 'draft', deadlineAt: null, completedAt: null }, at(1)).status,
    'not_open',
  );
  const active = { lifecycle: 'active' as const, deadlineAt: at(7), completedAt: null };
  assert.equal(reviewWindow(active, at(6.9)).status, 'not_open');
  const expired = reviewWindow(active, at(7));
  assert.equal(expired.status, 'open');
  assert.deepEqual(expired.opensAt, at(7));
  assert.deepEqual(expired.closesAt, at(8));
  assert.equal(expired.revealedAt, null);
  const done = { lifecycle: 'completed' as const, deadlineAt: at(7), completedAt: at(3) };
  const plus = (ms: number) => new Date(at(3).getTime() + ms);
  assert.equal(reviewWindow(done, plus(24 * H - 1)).status, 'open');
  const end = reviewWindow(done, plus(24 * H));
  assert.equal(end.status, 'closed');
  assert.deepEqual(end.revealedAt, plus(24 * H));
});

void test('전원이 제출하면 24시간 전에도 공개, 마감 시각은 그대로', () => {
  const done = { lifecycle: 'completed' as const, deadlineAt: at(7), completedAt: at(3) };
  const plus = (ms: number) => new Date(at(3).getTime() + ms);
  const early = reviewWindow(done, plus(2 * H), plus(H));
  assert.equal(early.status, 'closed');
  assert.deepEqual(early.closesAt, plus(24 * H));
  assert.deepEqual(early.revealedAt, plus(H));
});

void test('결과 숨김: 공개 뒤, 평가할 대상이 있었고, 안 냈고, SANCTION_FROM 이후에 끝났을 때만', () => {
  const f = { closed: true, hadTargets: true, reviewedAt: null, endedAt: at(5) };
  assert.equal(resultHidden(f, at(1)), true);
  assert.equal(resultHidden(f, at(6)), false);
  assert.equal(resultHidden({ ...f, reviewedAt: at(5) }, at(1)), false);
  assert.equal(resultHidden({ ...f, hadTargets: false }, at(1)), false);
  assert.equal(resultHidden({ ...f, closed: false }, at(1)), false);
});

void test('평가 의무: 기간 중이면 pending, 시간으로 끝났으면 미제출, 솔로·제출·이전 규칙은 제외', () => {
  const now = at(10);
  const row = (projectId: string, completedAt: Date, extra = {}) => ({
    projectId,
    lifecycle: 'completed' as const,
    deadlineAt: null,
    completedAt,
    others: 2,
    submitted: false,
    ...extra,
  });
  const d = dutiesFrom(
    [
      row('open', new Date(now.getTime() - H)),
      row('miss', at(5)),
      row('solo', at(5), { others: 0 }),
      row('done', at(5), { submitted: true }),
      row('old', at(1)),
      { ...row('legacy', at(5)), lifecycle: null },
    ],
    now,
    at(2),
  );
  assert.deepEqual(d.pending, ['open']);
  assert.deepEqual(d.missCloses, [new Date(at(5).getTime() + 24 * H)]);
});

void test('제재: 1회 7일, 2회 30일, 3회 영구, 순서 무관', () => {
  const now = at(100);
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  assert.equal(restrictionOf([], now), null);
  assert.deepEqual(restrictionOf([ago(1)], now), {
    until: new Date(ago(1).getTime() + 7 * DAY),
    permanent: false,
    misses: 1,
  });
  assert.equal(restrictionOf([ago(7)], now), null);
  assert.equal(restrictionOf([ago(8)], now), null);
  assert.deepEqual(restrictionOf([ago(1), ago(40)], now)?.until, new Date(ago(1).getTime() + 30 * DAY));
  assert.equal(restrictionOf([ago(40), ago(31)], now), null);
  assert.deepEqual(restrictionOf([ago(90), ago(80), ago(70)], now), {
    until: null,
    permanent: true,
    misses: 3,
  });
  assert.deepEqual([0, 1, 2, 5].map(penaltyDays), [7, 30, null, null]);
});

void test('제재 문구는 서울 시각, 영구는 날짜 없이', () => {
  assert.match(
    restrictionMessage({ until: '2026-11-13T05:00:00Z', permanent: false, misses: 1 }, '새 프로젝트를 만들'),
    /11월 13일.*14:00.*까지 새 프로젝트를 만들 수 없습니다/,
  );
  assert.match(
    restrictionMessage({ until: null, permanent: true, misses: 3 }, '참여 신청할'),
    /3번 내지 않아 더 이상 참여 신청할 수 없습니다/,
  );
});

void test('다음 등급까지와 가장 낮은 문항', () => {
  assert.deepEqual(nextGrade(4.1), { grade: 'S', gap: 0.7 });
  assert.deepEqual(nextGrade(3.9), { grade: 'A', gap: 0.1 });
  assert.deepEqual(nextGrade(1.0), { grade: 'C', gap: 1.0 });
  assert.equal(nextGrade(4.8), null);
  const b = (c: number, m: number, k: number) => [
    { key: 'contribution' as const, label: '기여도', average: c },
    { key: 'communication' as const, label: '소통', average: m },
    { key: 'commitment' as const, label: '약속 이행', average: k },
  ];
  assert.equal(weakestItem(b(4.7, 3.3, 4.3))?.label, '소통');
  assert.equal(weakestItem(b(4, 4, 5))?.label, '기여도');
  assert.equal(weakestItem(b(4.5, 4.6, 5)), null);
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
  revealedAt: at(12),
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

void test('평가 입력: 대상 전원을 한 번씩, 0.5~5 사이 0.5점 단위만', () => {
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
  const half = parseReviews(
    [
      { person: 1, contribution: 4.5, communication: 0.5, commitment: 3 },
      { person: 2, contribution: 5, communication: 1.5, commitment: 2.5 },
    ],
    [1, 2],
  );
  assert.equal(half[0].contribution, 4.5);
  assert.equal(half[0].communication, 0.5);
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
      { person: 1, contribution: 4.3, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: 5.5, communication: 1, commitment: 3 },
      { person: 2, contribution: 5, communication: 1, commitment: 3 },
    ],
    [
      { person: 1, contribution: Number.NaN, communication: 1, commitment: 3 },
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
    { score: 4.1, grade: 'A', badges: [badge('finish', at(5)), badge('reviewer', null)] },
    { score: null, grade: null, badges: [badge('finish', at(2)), badge('reviewer', at(3))] },
    { score: 4.9, grade: 'S', badges: [badge('finish', null)] },
  ]);
  assert.equal(me.totalScore, 9);
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
  assert.equal(empty.bestGrade, 'E');
  assert.equal(summarize([{ score: null, grade: null, badges: [] }]).bestGrade, 'E');
  assert.equal(summarize([{ score: 1.5, grade: 'D', badges: [] }]).bestGrade, 'D');
  assert.equal(empty.badges.length, BADGES.length);
});
