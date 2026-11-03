import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORDS,
  SCOPE_LEVELS,
  DEFAULT_LEVEL,
  roll,
  createBody,
  scopeText,
  levelOf,
} from '../lib/idea-dice.ts';

function seeded(n: number) {
  return () => (n = (n * 1103515245 + 12345) % 2147483648) / 2147483648;
}

void test('단어 목록은 중복 없이 140~160개, 공백 없는 단어', () => {
  assert.equal(new Set(WORDS).size, WORDS.length);
  assert.ok(WORDS.length >= 140 && WORDS.length <= 160, String(WORDS.length));
  assert.ok(WORDS.every((w) => w && !/\s/.test(w)));
});

void test('처음 굴리면 서로 다른 단어 3개', () => {
  for (let s = 1; s <= 200; s++) {
    const w = roll(['', '', ''], [false, false, false], seeded(s));
    assert.equal(w.length, 3);
    assert.equal(new Set(w).size, 3);
    assert.ok(w.every((x) => WORDS.includes(x)));
  }
});

void test('다시 굴리면 잠긴 칸은 그대로, 안 잠긴 칸은 이전과 다르고 셋이 모두 다르다', () => {
  for (let s = 1; s <= 200; s++) {
    const before = roll(['', '', ''], [false, false, false], seeded(s));
    const after = roll(before, [true, false, false], seeded(s + 999));
    assert.equal(after[0], before[0]);
    assert.notEqual(after[1], before[1]);
    assert.notEqual(after[2], before[2]);
    assert.equal(new Set(after).size, 3);
  }
});

void test('모두 잠그면 그대로', () => {
  assert.deepEqual(roll(['고양이', '영수증', '지도'], [true, true, true]), [
    '고양이',
    '영수증',
    '지도',
  ]);
});

void test('단계는 핵심 기능·MVP·테스트·데모·배포', () => {
  assert.deepEqual(
    SCOPE_LEVELS.map((l) => l.name),
    ['핵심 기능', 'MVP', '테스트', '데모', '배포'],
  );
  assert.equal(DEFAULT_LEVEL, 2);
});

void test('아이디어를 비우면 단어 조합이 이름과 목표가 된다(공백만 입력 포함)', () => {
  for (const idea of ['', '   ']) {
    const b = createBody({ words: ['고양이', '영수증', '지도'], idea, level: 2, agreed: true });
    assert.equal(b.title, '고양이 · 영수증 · 지도');
    assert.equal(b.goal, "'고양이·영수증·지도' 조합에서 떠올린 서비스를 7일 안에 만든다");
  }
});

void test('아이디어를 적으면 그 한 줄이 이름과 목표, 100자 초과는 이름만 자른다', () => {
  const b = createBody({
    words: ['a', 'b', 'c'],
    idea: '  집사끼리 영수증 나누는 지도  ',
    level: 3,
    agreed: false,
  });
  assert.equal(b.title, '집사끼리 영수증 나누는 지도');
  assert.equal(b.goal, '집사끼리 영수증 나누는 지도');
  assert.equal(b.agreed, false);
  const long = '가'.repeat(150);
  const c = createBody({ words: ['a', 'b', 'c'], idea: long, level: 2, agreed: true });
  assert.equal(c.title.length, 100);
  assert.equal(c.goal, long);
});

void test('범위·완료 기준은 단계 문장, 결과물은 보내지 않고 모든 단계가 서버 제한 안', () => {
  for (let level = 1; level <= 5; level++) {
    const b = createBody({ words: ['고양이', '영수증', '지도'], idea: '', level, agreed: true });
    const l = SCOPE_LEVELS[level - 1];
    assert.equal(b.scope, `[${l.name}] ${l.scope}`);
    assert.equal(b.scope, scopeText(level));
    assert.equal(b.completionCriteria, l.criteria);
    assert.equal(b.duration, 7);
    assert.equal(b.action, 'create');
    assert.ok(!('deliverables' in b));
    assert.ok(b.title.length <= 100 && b.goal.length <= 1000 && b.scope.length <= 2000);
  }
});

void test('levelOf는 접두어로 단계를 찾고, 없거나 모르면 MVP', () => {
  for (let level = 1; level <= 5; level++) assert.equal(levelOf(scopeText(level)), level);
  assert.equal(levelOf('직접 쓴 범위'), 2);
  assert.equal(levelOf('[없는단계] 문장'), 2);
});
