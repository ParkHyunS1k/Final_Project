# 동료평가 화면·규칙 변경 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 끝난 프로젝트 홈에서 동료평가를 내고, 내 점수(5점제)·등급·문항 평균·뱃지를 '다음엔 이걸 챙기자' 형태로 보게 하며, 24시간 안에 내지 않으면 새 프로젝트를 막는다.

**Architecture:** 규칙은 전부 `web/lib/score.ts`의 순수 함수에 둔다. 여기에는 점수, 등급, 기간, 결과 숨김, 미제출 판정, 제재 기간, 화면 문구가 들어간다. 서버 쪽은 두 파일로 나눈다.
- `web/lib/sanction.ts`(새 파일): 내 프로젝트들의 평가 의무를 SQL 한 번으로 읽어 제재 여부를 판정한다. 만들기·수락·신청·시작·승인 경로가 이 파일을 부른다.
- `web/lib/score-store.ts`: 24시간 기간, 전원 제출 시 조기 공개, 결과 숨김을 반영한다.

화면은 두 곳에 붙는다. `PeerReviewCard`(새 파일)는 끝난 프로젝트 홈의 맨 위에 붙는다. 제재 안내는 기존 만들기·팀 찾기·시작 버튼에 붙는다. 새 테이블은 만들지 않고 마이그레이션도 하지 않는다.

**Tech Stack:** Next.js(web/, `web/AGENTS.md` 참고), React 19, Postgres(운영 Supabase, 테스트 PGlite), plain CSS(`app/globals.css`), node:test + `--experimental-strip-types`, esbuild 렌더 테스트.

**Spec:** `docs/superpowers/specs/2026-11-06-peer-review-ui-design.md` (이전 규칙: `docs/superpowers/specs/2026-10-20-peer-score-badges-design.md`)

## Global Constraints

- 평가 기간은 프로젝트가 끝난 시각부터 **24시간**이다. SQL에서는 `interval '24 hours'`로 쓴다.
- 점수는 세 문항 평균의 평균이다. **소수 첫째 자리에서 반올림**하며 범위는 1.0~5.0이다. ×20을 하지 않는다.
- 등급은 반올림한 점수로 매긴다. **S ≥ 4.8, A ≥ 4.0, B ≥ 3.0, C ≥ 2.0, 그 밖은 D**다. 계정 단위로 보면, 공개된 점수가 하나도 없는 사람의 `bestGrade`는 `'E'`다.
- 점수 공개 조건과 개인 뱃지 기준은 그대로 둔다. 공개하려면 평가자가 2명 이상이어야 하고(`MIN_REVIEWERS = 2`), 개인 뱃지는 문항 평균 4.5 이상이다.
- 제재 기간은 미제출 1회째 **7일**, 2회째 **30일**, 3회째부터 **영구**다. 각 기간은 해당 프로젝트의 평가 마감 시각(closesAt)부터 센다.
- 제재 중에는 다섯 가지를 403으로 막는다.
  - 새 프로젝트 만들기
  - 초대 수락
  - 참여 신청
  - 준비 상태 프로젝트 시작(팀장 기준)
  - 제재 중인 사람의 참여 신청 승인
- 제재 중에도 이미 진행 중인 프로젝트의 작업은 막지 않는다.
- `SANCTION_FROM` 이전에 끝난 프로젝트는 미제출로 세지 않고 결과도 숨기지 않는다.
- 시각은 서버 기준으로 판단한다. 화면은 `useServerNow(asOf)`로 시각을 얻고, 렌더 중에 `Date.now()`를 쓰지 않는다. 사용자에게 보이는 시각은 `Asia/Seoul`로 표시한다.
- 익명성을 지킨다. 다른 사람의 계정 ID, 점수, 개별 평가는 응답에 넣지 않는다.
- 색은 기존 토큰(`--gray-*`, `--heat-*`, `--red-*`, `--good`)만 쓴다. 다크 모드와 라이트 모드를 모두 확인한다.
- 린트는 작업을 시작할 때 `npm run lint`에서 `error` 줄 수를 기록해 두고, 그보다 늘어나면 안 된다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 작업 폴더는 `/Users/parkhyunsik/wt/peer-review`(브랜치 `feat/peer-review-ui`)다. 명령은 `web/`에서 실행하고, 시작 전에 `npm ci`를 한다.

## Review Focus

| 상황 | 기대 동작 | 담당 Task |
|---|---|---|
| 배포 직후 이전 규칙으로 끝난 프로젝트 | 결과를 숨기지 않고 미제출로 세지 않는다. | Task 1 (`resultHidden`·`dutiesFrom`에 `from` 경계 테스트) |
| 마감 시각과 정확히 같은 순간 | `closed`가 되고 제출을 거절한다. 24시간 − 1ms 시점은 `open`이다. | Task 1 |
| 참여를 중단한 사람(`left_at`)이 있는 팀 | 중단자는 전원 제출 판정과 미제출 판정에서 빠진다. | Task 3 API 테스트 |
| 제재 중에 이미 진행 중인 프로젝트 | 체크인과 업무 저장은 200이다. | Task 2 API 테스트 |
| 2인 팀에서 평가를 내지 않은 사람 | 점수는 원래 나오지 않지만 평가할 대상이 있었으므로 미제출 1회다. 솔로는 미제출이 아니다. | Task 2 API 테스트 |

---

### Task 1: 점수·등급·기간·제재 순수 규칙

**Files:**
- Modify: `web/lib/score.ts`
- Test: `web/tests/score.test.ts` (기존 등급·점수·기간·요약 테스트를 새 기준으로 고친다)

**Interfaces:**
- Produces (`web/lib/score.ts`):
  - `REVIEW_HOURS = 24` (`REVIEW_DAYS`를 대체)
  - `SANCTION_FROM: Date`: `new Date(process.env.SANCTION_FROM || '2026-11-09T00:00:00+09:00')`. 실제 값은 Task 6에서 배포일로 정한다.
  - `type Grade = 'S'|'A'|'B'|'C'|'D'`
  - `gradeOf(score: number|null): Grade|null`
  - `peerScore(ratings: Rating[], closed: boolean)`: 반환은 `{ score: number|null, grade, breakdown: { key: ItemKey; label: string; average: number }[], averages: Rating|null, reviewers }`
  - `reviewWindow(policy, now, allSubmittedAt: Date|null = null)`: 반환은 `{ status, opensAt, closesAt, revealedAt: Date|null }`
  - `resultHidden(f: { closed: boolean; hadTargets: boolean; reviewedAt: Date|null; endedAt: Date|null }, from = SANCTION_FROM): boolean`
  - `type DutyRow = { projectId: string; lifecycle: Lifecycle|null; deadlineAt: Date|null; completedAt: Date|null; others: number; submitted: boolean }`
  - `dutiesFrom(rows: DutyRow[], now: Date, from = SANCTION_FROM): { pending: string[]; missCloses: Date[] }`
  - `type Restriction = { until: Date|null; permanent: boolean; misses: number }`
  - `restrictionOf(missCloses: Date[], now: Date): Restriction|null`
  - `penaltyDays(misses: number): number|null`: 다음에 미제출하면 받을 제재 일수다. `null`은 영구다.
  - `restrictionMessage(r: { until: Date|string|null; permanent: boolean; misses: number }, doing: string): string`
  - `nextGrade(score: number): { grade: Grade; gap: number }|null`
  - `weakestItem(breakdown): { key; label; average }|null`
  - `BadgeFacts.closesAt`의 이름을 `revealedAt`으로 바꾼다. 개인 뱃지의 earnedAt에 이 값을 쓴다.
  - `summarize(...).bestGrade: Grade|'E'`

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`tests/score.test.ts`. 기존 `at(days)` 도우미를 쓰고, 시간 단위는 `H = 3600000`)

```ts
void test('등급 5점제: S 4.8, A 4.0, B 3.0, C 2.0, 그 아래 D', () => {
  for (const [s, g] of [[5,'S'],[4.8,'S'],[4.7,'A'],[4.0,'A'],[3.9,'B'],[3.0,'B'],[2.9,'C'],[2.0,'C'],[1.9,'D'],[1.0,'D']] as const)
    assert.equal(gradeOf(s), g);
  assert.equal(gradeOf(null), null);
});
void test('점수 = 세 문항 평균의 평균, 소수 첫째 자리 반올림', () => {
  const s = peerScore([r(5,3,4), r(4,4,5), r(5,3,4)], true);
  assert.equal(s.score, 4.1);
  assert.equal(s.grade, 'A');
  assert.deepEqual(s.breakdown.map((b) => b.average), [4.7, 3.3, 4.3]);
  // 4.75 → 4.8로 반올림해 S
  assert.equal(peerScore([r(5,5,5), r(5,5,4), r(5,5,4), r(5,5,4)], true).grade, 'S');
  assert.equal(peerScore([r(1,1,1), r(1,1,1)], true).score, 1);
  assert.equal(peerScore([r(5,5,5)], true).score, null);
  assert.equal(peerScore([r(5,5,5), r(5,5,5)], false).score, null);
});
void test('평가 기간 24시간, 전원 제출 시 일찍 공개', () => {
  const done = { lifecycle: 'completed', deadlineAt: at(7), completedAt: at(3) } as const;
  assert.equal(reviewWindow(done, new Date(at(3).getTime() + 24*H - 1)).status, 'open');
  const end = reviewWindow(done, new Date(at(3).getTime() + 24*H));
  assert.equal(end.status, 'closed');
  assert.deepEqual(end.revealedAt, new Date(at(3).getTime() + 24*H));
  const early = reviewWindow(done, new Date(at(3).getTime() + 2*H), new Date(at(3).getTime() + H));
  assert.equal(early.status, 'closed');
  assert.deepEqual(early.closesAt, new Date(at(3).getTime() + 24*H));
  assert.deepEqual(early.revealedAt, new Date(at(3).getTime() + H));
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
  const row = (projectId, completedAt, extra = {}) => ({ projectId, lifecycle: 'completed', deadlineAt: null, completedAt, others: 2, submitted: false, ...extra });
  const now = at(10);
  const d = dutiesFrom([
    row('open', new Date(now.getTime() - H)),
    row('miss', at(5)),
    row('solo', at(5), { others: 0 }),
    row('done', at(5), { submitted: true }),
    row('old', at(1)),
  ], now, at(2));
  assert.deepEqual(d.pending, ['open']);
  assert.deepEqual(d.missCloses, [new Date(at(5).getTime() + 24*H)]);
});
void test('제재: 1회 7일, 2회 30일, 3회 영구, 순서 무관', () => {
  const now = at(100);
  const ago = (days) => new Date(now.getTime() - days*24*H);
  assert.equal(restrictionOf([], now), null);
  assert.deepEqual(restrictionOf([ago(1)], now), { until: new Date(ago(1).getTime() + 7*24*H), permanent: false, misses: 1 });
  assert.equal(restrictionOf([ago(8)], now), null);
  assert.deepEqual(restrictionOf([ago(1), ago(40)], now)?.until, new Date(ago(1).getTime() + 30*24*H));
  assert.equal(restrictionOf([ago(40), ago(31)], now), null);
  assert.deepEqual(restrictionOf([ago(90), ago(80), ago(70)], now), { until: null, permanent: true, misses: 3 });
  assert.deepEqual([0,1,2,5].map(penaltyDays), [7, 30, null, null]);
});
void test('제재 문구는 서울 시각, 영구는 날짜 없이', () => {
  assert.match(restrictionMessage({ until: '2026-11-13T05:00:00Z', permanent: false, misses: 1 }, '새 프로젝트를 만들'), /11월 13일.*14:00.*까지 새 프로젝트를 만들 수 없습니다/);
  assert.match(restrictionMessage({ until: null, permanent: true, misses: 3 }, '참여 신청할'), /3번 내지 않아 더 이상 참여 신청할 수 없습니다/);
});
void test('다음 등급까지와 가장 낮은 문항', () => {
  assert.deepEqual(nextGrade(4.1), { grade: 'S', gap: 0.7 });
  assert.deepEqual(nextGrade(3.9), { grade: 'A', gap: 0.1 });
  assert.deepEqual(nextGrade(1.0), { grade: 'C', gap: 1.0 });
  assert.equal(nextGrade(4.8), null);
  const b = (c, m, k) => [{ key: 'contribution', label: '기여도', average: c }, { key: 'communication', label: '소통', average: m }, { key: 'commitment', label: '약속 이행', average: k }];
  assert.equal(weakestItem(b(4.7, 3.3, 4.3))?.label, '소통');
  assert.equal(weakestItem(b(4, 4, 5))?.label, '기여도');
  assert.equal(weakestItem(b(4.5, 4.6, 5)), null);
});
```

기존 테스트도 아래처럼 고친다.
- `summarize` 테스트: 점수를 5점제로 바꾼다. 비어 있을 때와 점수가 전부 null일 때 `bestGrade === 'E'`를 기대한다. D 등급이 최고 등급이 되는 경우도 하나 넣는다.
- 뱃지 테스트: `closesAt`을 `revealedAt`으로 바꾼다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --experimental-strip-types --test tests/score.test.ts`
Expected: FAIL. 등급과 점수 값이 다르고, `dutiesFrom` 같은 export가 없다는 오류가 난다.

- [ ] **Step 3: `web/lib/score.ts`를 구현한다**

| 함수 | 구현 |
|---|---|
| `reviewWindow` | 마감 시각 `closesAt = end + 24h`. 아래 둘 중 하나면 `closed`다. `revealedAt`은 둘 중 먼저 온 시각이다. |
| | · `now ≥ closesAt` |
| | · `allSubmittedAt`이 있고 `now ≥ allSubmittedAt` |
| `dutiesFrom` | 행마다 `endedAt(row, now)`를 계산하고, 아래 경우는 건너뛴다. |
| | · `endedAt`이 없을 때 |
| | · `others < 1`일 때 |
| | · `submitted`일 때 |
| | 남은 행은 `now < end+24h`이면 `pending`, 아니면서 `end ≥ from`이면 `missCloses`에 넣는다. |
| `restrictionOf` | 아래 코드 블록 참고 |
| `penaltyDays` | `[7, 30][misses] ?? null` |
| `restrictionMessage` | 시각은 `toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })`로 표시한다. |
| | · 기간 제재: `동료평가를 내지 않아 {시각}까지 {doing} 수 없습니다.` |
| | · 영구 제재: `동료평가를 {misses}번 내지 않아 더 이상 {doing} 수 없습니다.` |
| `nextGrade` | 바로 위 등급의 하한에서 지금 점수를 뺀 값을 소수 첫째 자리로 반올림한다. |
| `weakestItem` | 세 문항이 모두 4.5 이상이면 `null`이다. 그렇지 않으면 average가 가장 낮은 문항을 고르고, 같으면 `ITEMS` 순서에서 앞의 문항을 고른다. |

`restrictionOf`:

```ts
const sorted = [...missCloses].sort((a, b) => a.getTime() - b.getTime());
let end = -Infinity;
sorted.forEach((c, i) => {
  const until = i < 2 ? c.getTime() + [7, 30][i] * DAY_MS : Infinity;
  if (c.getTime() <= now.getTime() && now.getTime() < until) end = Math.max(end, until);
});
if (end === -Infinity) return null;
return { until: end === Infinity ? null : new Date(end), permanent: end === Infinity, misses: sorted.length };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --experimental-strip-types --test tests/score.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add web/lib/score.ts web/tests/score.test.ts
git commit -m "feat: 동료평가 5점제·24시간·미제출 제재 규칙"
```

---

### Task 2: 제재 판정과 서버 차단

**Files:**
- Create: `web/lib/sanction.ts`
- Modify:
  - `web/lib/projects.ts`: `createProject`, `acceptInvite`, `projectState`의 `joinRequests`
  - `web/lib/teams.ts`: `requestJoin`, `decideJoin`
  - `web/app/api/sprint/route.ts`: `start` 분기
  - `web/app/api/projects/route.ts`: GET 응답
- Test: `web/tests/score-api.test.mjs`
  - 파일 맨 위, 번들 import보다 먼저 `process.env.SANCTION_FROM = '2000-01-01T00:00:00Z'`를 넣는다.
  - 번들에 `export { POST as teamsPOST } from './app/api/teams/route'`를 추가한다.

**Interfaces:**
- Consumes: Task 1의 `dutiesFrom`, `restrictionOf`, `restrictionMessage`, `Restriction`.
- Produces:
  - `reviewDuties(userId: string, now: Date): Promise<{ restriction: Restriction|null; pending: string[]; misses: number }>`
    - SQL 한 번으로 읽는다. 대상은 `project_members m JOIN project_policy p`이며 조건은 `m.user_id=? AND m.left_at IS NULL`이다.
    - `others`는 참여를 중단하지 않은 다른 멤버 수다.
    - `submitted`는 `EXISTS peer_review_submissions`로 구한다.
    - `misses`에는 `missCloses.length`를 넣는다.
  - `assertNotRestricted(userId: string, now: Date, doing: string): Promise<void>`: 제재 중이면 `PolicyError(restrictionMessage(...), 403)`를 던진다.
  - `GET /api/projects` 응답에 두 필드를 더한다.
    - `restriction: { until: string|null; permanent: boolean; misses: number }|null`
    - `reviewPending: string[]`
  - `projectState().joinRequests[]`에 `restricted: boolean`을 더한다. `user_id`는 내보내지 않는다.

`doing` 문구는 아래로 고정한다.

| 경로 | `doing` |
|---|---|
| `createProject` | `'새 프로젝트를 만들'` |
| `acceptInvite` | `'초대를 수락할'` |
| `requestJoin` | `'참여 신청할'` |
| `start` | `'스프린트를 시작할'` |

`decideJoin`은 승인(`approve === true`)일 때만 신청자를 검사한다. 신청자가 제재 중이면 `PolicyError('이 사람은 동료평가를 내지 않아 지금 팀에 참여할 수 없습니다.', 403)`를 던진다.

- [ ] **Step 1: 실패하는 API 테스트를 쓴다**

**`test('미제출 1회: 7일 동안 만들기·초대 수락·참여 신청·시작이 403, 진행 중 프로젝트 작업은 된다, 7일 뒤 풀린다')`**

준비:
1. 3인 팀(lead, a, b)을 `startedTeam`으로 만든다.
2. `finish`로 끝낸다.
3. lead와 a만 평가를 낸다.
4. `shift(projectId, 25*H)`로 시간을 옮긴다.

확인:
- b의 `GET /api/projects`
  - `restriction.misses === 1`
  - `restriction.permanent === false`
  - `reviewPending`이 비어 있다
- b의 `create`가 403이다. 메시지는 `/까지 새 프로젝트를 만들 수 없습니다/`에 맞는다.
- lead가 다른 프로젝트에서 b를 초대하면, b의 `accept`가 403이다.
- b의 `teamsPOST {action:'request'}`가 403이다. 대상은 lead가 공개한 준비 프로젝트다.
- b가 만들어 두었던 준비 프로젝트(제재 전에 만듦)에서 `act('start')`가 403이다. 이 준비 프로젝트는 25시간을 옮기기 전에 b가 만들어 둔다.
- b가 이미 진행 중인 다른 프로젝트에 넣은 체크인은 200이다.
- `shift`로 마감을 8일 더 과거로 옮기면 b의 `create`가 201이다.

**`test('제재 중인 사람의 참여 신청은 승인할 수 없고, 팀장 화면에 restricted로 보인다')`**

1. b가 제재받기 전에 공개 팀에 참여 신청을 해 둔다.
2. 제재가 걸린 뒤 팀장이 상태를 조회하면 `joinRequests[0].restricted === true`다.
3. `decideJoin approve:true`는 403이다.
4. `approve:false`는 200이다.

**`test('솔로·2인 팀 미제출과 제출자')`**

- 솔로가 완주하고 25시간이 지나도 `restriction`은 `null`이다.
- 2인 팀에서 한 명만 내고 25시간이 지나면, 내지 않은 사람은 `restriction.misses === 1`이다.
- 2인 팀에서 낸 사람은 `null`이다.

**`test('평가 기간 중이면 reviewPending에 그 프로젝트가 있다')`**

- 완주 직후, 내지 않은 팀원의 `reviewPending`에 `projectId`가 들어 있다.
- 제출한 뒤에는 빠진다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --experimental-strip-types --test tests/score-api.test.mjs`
Expected: FAIL. 403 대신 201·200이 나오고, `restriction`은 undefined다.

- [ ] **Step 3: `web/lib/sanction.ts`를 만들고 각 경로에서 호출한다**

- `sanction.ts`는 `./sprint-store`(database)와 `./sprint-policy`(PolicyError), `./score`만 import한다. `./projects`는 import하지 않는다. 순환 import를 막기 위해서다.
- 검사는 각 함수의 맨 앞, 권한 검사 바로 뒤에 둔다. 저장 트랜잭션 밖이다. 이렇게 생긴 한계는 `// ponytail:` 주석으로 남긴다. 검사와 저장 사이에 평가 기간이 끝나는 경합은 막지 않으며, 막아야 하면 저장 SQL에 같은 조건을 넣으면 된다.
- `projectState`: 팀장의 대기 신청 SELECT에 `user_id`를 더한다. 신청자마다 `reviewDuties`를 호출해(최대 20회) `restricted`를 붙이고 `user_id`는 지운다. 이 부분도 `// ponytail: 신청자 수만큼 조회, 20건 제한`으로 표시한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --experimental-strip-types --test tests/score-api.test.mjs tests/api.test.mjs tests/teams.test.mjs`
Expected: PASS. 기존 프로젝트·팀 테스트도 그대로 통과해야 한다.

- [ ] **Step 5: 커밋한다**

```bash
git add web/lib/sanction.ts web/lib/projects.ts web/lib/teams.ts web/app/api/sprint/route.ts web/app/api/projects/route.ts web/tests/score-api.test.mjs
git commit -m "feat: 동료평가 미제출 제재로 만들기·수락·신청·시작·승인 차단"
```

---

### Task 3: 점수 조회 — 24시간, 조기 공개, 결과 숨김

**Files:**
- Modify: `web/lib/score-store.ts`
- Test: `web/tests/score-api.test.mjs`. 기존 테스트에서 7일 shift는 25시간으로, ×20 점수는 5점제로 고친다.

**Interfaces:**
- Consumes:
  - Task 1의 `reviewWindow(…, allSubmittedAt)`, `resultHidden`, `penaltyDays`, `peerScore`
  - Task 2의 `reviewDuties`
- Produces (`GET/POST /api/score` 응답):
  - `score: number|null` (범위 1~5)
  - `grade: 'S'|'A'|'B'|'C'|'D'|null`
  - `breakdown: { key, label, average }[]`
  - `review`에 다음 필드를 더한다.
    - `hidden: boolean`
    - `penaltyDays: number|null`: 내가 아직 평가할 수 있을 때만 값이 있다. 그렇지 않으면 `null`이다.
  - `review.status === 'closed'`는 '결과 공개'를 뜻한다.

- [ ] **Step 1: 실패하는 API 테스트를 쓴다**

**`test('24시간이 지나면 제출을 거절한다')`**
- 완주 후 `shift(25*H)`로 시간을 옮긴다.
- `review` POST가 400이다.

**`test('전원이 제출하면 24시간 전에도 점수가 열린다')`**
- 3인 팀이 완주하고 세 명이 모두 제출한다.
- 같은 시각에 lead를 조회한다.
  - `review.status === 'closed'`
  - `score`가 1~5 사이 숫자다
  - `review.reviewers === 2`

**`test('내지 않은 사람은 결과가 가려지고 팀 뱃지는 보인다')`**
- 4인 팀이 완주하고 세 명만 제출한다. 그 뒤 `shift(25*H)`로 시간을 옮긴다.
- 내지 않은 사람을 조회한다.
  - `review.hidden === true`
  - `score === null`
  - `earned(s)`에 `'finish'`가 있다
  - `top_contributor`는 없다
- 낸 사람을 조회한다.
  - `hidden === false`
  - `score`가 숫자다

**`test('참여 중단자는 전원 제출 판정에서 빠진다')`**
- 4인 팀에서 한 명의 `left_at`을 SQL로 설정한다.
- 남은 세 명이 모두 제출하면 `status === 'closed'`다.

**`test('평가 폼에 다음 제재 일수를 준다')`**
- 미제출 기록이 없는 팀원: `review.penaltyDays === 7`
- 제출한 뒤: `penaltyDays === null`

- [ ] **Step 2: 실패를 확인한다**

Run: `node --experimental-strip-types --test tests/score-api.test.mjs`
Expected: FAIL. 기간이 아직 7일이고, `hidden`과 `penaltyDays`가 없다.

- [ ] **Step 3: `projectScore`를 고친다**

1. `OPEN_WINDOW`의 `interval '7 days'` 두 곳을 `interval '24 hours'`로 바꾼다.
2. batch에 `SELECT reviewer_id, created_at FROM peer_review_submissions WHERE project_id=?`를 더한다.
3. 전원 제출 시각 `allSubmittedAt`을 구한다.
   - 조건: 참여 중인 멤버가 2명 이상이고, 그 전원이 제출 행을 가지고 있다.
   - 값: 그 제출 행들의 가장 늦은 `created_at`.
   - 조건을 만족하지 않으면 `null`.
4. `hadTargets = 내가 참여 중 && active.length ≥ 2`로 둔다.
5. `hidden = resultHidden({ closed, hadTargets, reviewedAt, endedAt: end })`로 판정한다.
6. 점수는 `peerScore(ratings, closed && !hidden)`으로 계산한다. hidden이면 `reviewers`도 `null`로 둔다.
7. `badgeList`에는 `revealedAt: window.revealedAt`을 넘긴다.
8. `penaltyDays`는 `canReview`일 때만 `penaltyDays((await reviewDuties(userId, now)).misses)`로 구한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --experimental-strip-types --test tests/score.test.ts tests/score-api.test.mjs`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add web/lib/score-store.ts web/tests/score-api.test.mjs
git commit -m "feat: 동료평가 24시간·전원 제출 시 공개·미제출자 결과 숨김"
```

---

### Task 4: 평가 카드 (폼 + 결과)

**Files:**
- Create: `web/components/peer-review.tsx`
- Modify:
  - `web/app/workspace/page.tsx`: 홈 탭에서 `RaceHome` 위에 카드를 둔다.
  - `web/app/globals.css`
- Test: `web/tests/peer-review-render.test.mjs`(새 파일). `tests/race-home-render.test.mjs`처럼 esbuild로 번들하고 `renderToString`으로 확인한다. `package.json`의 `test` 목록에도 넣는다.

**Interfaces:**
- Consumes:
  - Task 3의 `/api/score` 응답 모양
  - Task 1의 `nextGrade`, `weakestItem`
  - `lib/race.ts`의 `tension`, `focusClock`
  - `hooks/use-server-now`의 `useServerNow`
- Produces:
  - `type ScoreData`: Task 3의 응답 모양 그대로다.
  - `PeerReviewView({ data, now, solo, busy, error, onSubmit }: { data: ScoreData; now: number; solo: boolean; busy: boolean; error: string; onSubmit: (reviews: { person: number; contribution: number; communication: number; commitment: number }[]) => void })`: 렌더만 하는 순수 컴포넌트.
  - `PeerReviewCard({ projectId, asOf, solo }: { projectId: string; asOf: string; solo: boolean })`: 아래를 맡는다.
    - `GET /api/score?project=`로 불러온다.
    - `onSubmit` 시 `window.confirm('제출하면 고칠 수 없어요.')`로 확인받은 뒤 POST한다.
    - 응답으로 다시 그린다.
    - 실패하면 메시지를 보여주고 다시 불러온다.
  - `page.tsx`는 `lifecycle === 'completed' || lifecycle === 'expired'`일 때만 카드를 렌더한다. `solo`는 참여 중인 멤버가 1명인지로 정한다.

상태별 문구는 스펙에 정해진 그대로 쓴다.

| 상태 | 판정 조건 | 문구 |
|---|---|---|
| 평가 폼 | `status==='open' && !submitted && targets.length` | 남은 시간은 `focusClock(closesAt − now)`로 표시하고, 카드 클래스는 `tension(ms).stage`로 정한다. |
| | | `penaltyDays`가 있으면 `24시간 안에 내지 않으면 {penaltyDays}일 동안 새 프로젝트를 시작할 수 없어요` |
| | | `penaltyDays`가 null이면 `24시간 안에 내지 않으면 더 이상 새 프로젝트를 시작할 수 없어요` |
| 제출함 | `status==='open' && submitted` | `평가를 냈어요. 팀원 전원이 내거나 {closesAt 서울 시각}이 되면 결과가 열려요.` |
| 결과 | `closed && score !== null` | 등급과 `{score} / 5`, 문항마다 막대와 평균을 보여준다. |
| | | 약한 문항이 있으면 `다음 프로젝트에선 {label}을 챙겨 보세요` |
| | | 약한 문항이 없으면 `세 문항 모두 4.5 이상이에요` |
| | | `nextGrade`가 있으면 `{grade}까지 {gap}` |
| | | `팀원 {reviewers}명이 평가했어요` |
| 2명 미만 | `closed && !hidden && score === null && !solo` | `평가한 팀원이 2명이 안 돼 이번에는 점수가 없어요.` |
| 숨김 | `hidden` | `평가를 내지 않아 이번 결과는 볼 수 없어요.` |
| 솔로 | `solo` | 폼과 점수 문구 없이 뱃지만 보여준다. |

- **뱃지(모든 상태 공통, 맨 아래):** 받은 뱃지는 `.peer-badge`, 못 받은 뱃지는 `.peer-badge.off`로 표시하고 각각 `description`을 붙인다.
- **폼:** 팀원마다 `<fieldset>`을 하나 두고, 문항마다 `role="radiogroup"`과 `aria-label="{팀원} {문항}"`를 단다. 그 안에 `<input type="radio">` 1~5를 둔다. 모든 칸을 채우기 전에는 제출 버튼을 `disabled`로 둔다.

- [ ] **Step 1: 실패하는 렌더 테스트를 쓴다.** 테스트는 `PeerReviewView`로 그린다.

| 테스트 | 입력 | 기대 |
|---|---|---|
| 폼 | 대상 2명 | `role="radiogroup"` 6개, radio 30개, 제출 버튼 disabled, 문구 `7일 동안 새 프로젝트를 시작할 수 없어요` |
| 폼 | `penaltyDays: null` | 문구 `더 이상 새 프로젝트를` |
| 제출함 | | 문구 `평가를 냈어요` |
| 결과 | score 4.1, grade A, breakdown [4.7, 3.3, 4.3], reviewers 3 | `4.1`, `/ 5`, `소통을 챙겨 보세요`, `S까지 0.7`, `팀원 3명이 평가했어요`. 못 받은 뱃지에 `peer-badge off` |
| 2명 미만 / 숨김 / 솔로 | 상태별 입력 | 각 문구가 나온다. 솔로는 radio 0개 |

- [ ] **Step 2: 실패를 확인한다**

Run: `node --experimental-strip-types --test tests/peer-review-render.test.mjs`
Expected: FAIL. `components/peer-review.tsx`를 resolve하지 못한다.

- [ ] **Step 3: 컴포넌트, CSS, page.tsx 배치를 구현한다**

- 기존 토큰만 쓴다.
- 375px 폭에서 radio 줄은 줄바꿈을 허용한다.

- [ ] **Step 4: 통과와 타입을 확인한다**

Run: `node --experimental-strip-types --test tests/peer-review-render.test.mjs tests/race-home-render.test.mjs && npx tsc --noEmit`
Expected: PASS, 타입 오류 0

- [ ] **Step 5: 커밋한다**

```bash
git add web/components/peer-review.tsx web/app/workspace/page.tsx web/app/globals.css web/tests/peer-review-render.test.mjs web/package.json
git commit -m "feat: 끝난 프로젝트 홈에 동료평가 폼과 내 결과 카드"
```

---

### Task 5: 제재 안내와 첫 화면

**Files:**
- Modify:
  - `web/lib/workspace-entry.ts`
  - `web/components/project-workspace.tsx`: `restriction`과 `reviewPending`을 상태로 둔다. `WorkspaceNav`에 `restriction`을 더하고, 이 값을 `ProjectCreate`와 `TeamDirectory`에 넘긴다.
  - `web/components/project-create.tsx`
  - `web/components/team-directory.tsx`: 참여 신청 버튼과 팀장 승인 버튼을 고친다.
  - `web/app/workspace/page.tsx`: '스프린트 시작' 버튼을 고친다.
- Test:
  - `web/tests/workspace-entry.test.ts`
  - `web/tests/project-create-render.test.mjs`
  - `web/tests/team-directory-render.test.mjs`

**Interfaces:**
- Consumes:
  - Task 2의 `restriction`, `reviewPending`, `joinRequests[].restricted`
  - Task 1의 `restrictionMessage`
- Produces:
  - `workspaceEntry(search, projects, pending: string[] = [])`: 주소의 `?project=`와 `?invite=`가 없을 때 프로젝트를 고르는 순서는 아래와 같다. 세 단계 모두 목록 순서대로 첫 프로젝트를 고른다.
    1. 평가 대기 프로젝트(`pending`에 든 것)
    2. 진행 중인 프로젝트
    3. 준비 중인 프로젝트
  - `type RestrictionView = { until: string|null; permanent: boolean; misses: number }`
  - `WorkspaceNav.restriction: RestrictionView|null`
  - `ProjectCreate`와 `TeamDirectory`에 prop `restriction?: RestrictionView|null`을 더한다.

| 화면 | 문구 | 막는 버튼 |
|---|---|---|
| `ProjectCreate` | `restrictionMessage(r, '새 프로젝트를 만들')` | '프로젝트 만들기' |
| `TeamDirectory` 신청 | `restrictionMessage(r, '참여 신청할')` | '참여 신청' |
| `TeamDirectory` 팀장 | 신청에 `restricted`가 있으면 그 줄에 `이 사람은 지금 참여할 수 없어요` | '승인' (거절은 그대로) |
| '스프린트 시작' | `restrictionMessage(r, '스프린트를 시작할')` | '스프린트 시작' |

- [ ] **Step 1: 실패하는 테스트를 쓴다**

**`workspaceEntry`**
- `pending=['b']`, 진행 중인 프로젝트 `a`, 끝난 프로젝트 `b` → `selected === 'b'`이고 `browsing === false`다.
- `?teams=1`이 있으면 여전히 팀 찾기를 연다.

**렌더 테스트**
- `ProjectCreate`에 `restriction={ until: '2026-11-13T05:00:00Z', permanent: false, misses: 1 }`을 주면 버튼이 `disabled`이고 `까지 새 프로젝트를 만들 수 없습니다`가 나온다.
- `TeamDirectory`의 팀장 목록에 `restricted: true`인 신청을 주면 `이 사람은 지금 참여할 수 없어요`가 나오고, 승인 버튼이 `disabled`다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --experimental-strip-types --test tests/workspace-entry.test.ts tests/project-create-render.test.mjs tests/team-directory-render.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`restriction`은 `GET /api/projects`를 처음 불러올 때 받은 값을 쓴다. 다시 불러오지 않는다. 그 사이에 상태가 바뀌어도 서버가 403과 메시지로 막는다.

- [ ] **Step 4: 통과를 확인한다**

Run: 같은 명령 + `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add web/lib/workspace-entry.ts web/components/project-workspace.tsx web/components/project-create.tsx web/components/team-directory.tsx web/app/workspace/page.tsx web/tests/workspace-entry.test.ts web/tests/project-create-render.test.mjs web/tests/team-directory-render.test.mjs
git commit -m "feat: 미제출 제재 안내와 평가 대기 프로젝트 우선 열기"
```

---

### Task 6: 배포 기준일, 문서, 전체 확인

**Files:**
- Modify:
  - `web/lib/score.ts`: `SANCTION_FROM` 기본값
  - `CLAUDE.md`: 현재 파일럿 문단의 '동료평가 기반 개인 점수·등급·뱃지(API만, 화면·공유 링크 없음)'를 고친다.
  - `docs/features.md`
  - `docs/current-sprint.md`
  - `docs/superpowers/specs/2026-10-20-peer-score-badges-design.md`: 맨 위에 '평가 기간·척도·등급·공개·제재는 2026-11-06 문서가 대체' 한 줄을 넣는다.

- [ ] **Step 1: `SANCTION_FROM` 기본값을 정한다**

PR을 머지하는 날의 다음 날 00:00 KST로 정한다. 배포 시각보다 늦어야 한다. 그래야 배포 전에 끝났지만 화면이 없어 평가를 못 낸 프로젝트를 미제출로 세지 않는다. 머지 날짜가 바뀌면 이 값도 다시 고친다.

- [ ] **Step 2: 문서를 고친다**

- **`CLAUDE.md`:** 내용을 '끝난 프로젝트 홈에서 24시간 동료평가, 5점제 개인 점수·등급(S~D, 계정 E)·뱃지 화면, 미제출 제재(7일·30일·영구)'로 바꾼다. 아직 없는 화면으로 '내 기록'이 있다는 것도 적는다.
- **`docs/features.md`, `docs/current-sprint.md`:** 같은 사실을 적고, 검증한 것과 검증하지 않은 것을 나눠 적는다.

- [ ] **Step 3: 전체를 확인한다**

Run: `npm test && npx tsc --noEmit && npm run lint 2>&1 | grep -c error && npm run build`
Expected:
- 테스트 전부 PASS
- 타입 오류 0
- 린트 error 줄 수가 시작할 때 기록한 수 이하
- 빌드 성공

- [ ] **Step 4: 로컬 브라우저에서 확인한다**

준비:
- PGlite를 쓰고 `DATABASE_URL`은 비워 둔다.
- `node scripts/dev-as.mjs`로 계정 3개를 쓴다.

확인할 것:
- 3인 팀으로 완주한다. 끝난 프로젝트 홈에 평가 폼과 카운트다운이 보인다.
- 두 명이 제출한다. 제출한 사람에게 '평가를 냈어요'가 보인다.
- SQL로 시간을 25시간 뒤로 옮긴다.
  - 제출한 사람에게는 결과 카드가 보인다.
  - 미제출자에게는 '볼 수 없어요'와 만들기 제재 안내가 보이고, 팀 찾기 신청 버튼이 꺼져 있다.
- 라이트와 다크, 375px 폭에서 각각 스크린샷을 찍는다.

- [ ] **Step 5: 커밋한다**

```bash
git add web/lib/score.ts CLAUDE.md docs/features.md docs/current-sprint.md docs/superpowers/specs/2026-10-20-peer-score-badges-design.md
git commit -m "docs: 동료평가 화면·제재 반영, 제재 기준일 설정"
```
