# 홈 화면 긴장감(업무 마감 카운트다운) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 진행 중 프로젝트에서 내 업무 마감을 초 단위로 크게 세고, 마감이 가까울수록 작업 화면이 붉어지며 직전에는 깜빡이게 하고, 홈 아래쪽을 팀원 체크인 현황 | 회의 제안으로 바꾼다.

**Architecture:** 판단은 `web/lib/race.ts`의 순수 함수(`focusTask`, `tension`, `chipStage`, `focusClock`, `waitReason`, `checkedInToday`)가 하고, 화면은 서버 기준 시각(`useServerNow`)으로 이 함수를 부른다. 1초마다 다시 그리는 범위를 줄이려고 배경·테두리는 `page.tsx`에 클래스를 다는 대신 독립 컴포넌트 `TensionLayer`로 둔다(스펙의 '본문에 클래스' 대신). 서버·API·DB는 바꾸지 않는다.

**Tech Stack:** Next.js(web/, 새 버전 — `web/AGENTS.md` 참고), React 19, lucide-react, plain CSS(`app/globals.css`), node:test + `--experimental-strip-types`, esbuild 렌더 테스트.

**Spec:** `docs/superpowers/specs/2026-10-29-race-tension-design.md`

## Global Constraints

- 서버 파일(`web/app/api/**`, `web/lib/projects.ts`, `web/lib/sprint-store.ts`, `web/lib/sprint-policy.ts`, `web/db/**`) 수정 금지.
- 시각 판단은 `useServerNow(asOf)`/`asOf` 기준. 렌더 중 `Date.now()` 금지.
- 깜빡임은 테두리·큰 숫자·칩에만, 초당 1회. `prefers-reduced-motion`은 기존 전역 규칙에 맡긴다(별도 분기 없음).
- 색은 기존 토큰(`--gray-*`, `--heat-*`, `--red-*`, `--good`)만, 다크·라이트 모두.
- 린트는 작업 시작 시 `npm run lint`의 `error` 줄 수보다 늘지 않는다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 작업 폴더: `/Users/parkhyunsik/wt/race-tension`(브랜치 `feat/race-tension`). 명령은 `web/`에서. 시작 전 `npm ci`.

## Review Focus

- 페이지를 켜 둔 채 마감이 지남 → 재조회 없이 1초 안에 `마감 초과 +00:00:0x`로 바뀌고 깜빡임이 멈춘다. → Task 1(`tension`·`focusClock` 경계) + Task 4 확인.
- 팀장이 남의 업무를 많이 맡긴 경우 → 카운트다운은 내 업무만 센다. 남의 마감 때문에 내 화면이 붉어지지 않는다. → Task 1 테스트, Task 3 렌더 테스트.
- 큰 숫자가 3자리 시간(`167:59:59`)이거나 업무명이 길 때 375px → 가로 스크롤 없이 줄바꿈·축소. → Task 2 CSS + Task 4 확인.
- 효과 레이어가 클릭을 막거나 글자를 가림 → 버튼·입력·대화상자가 평소대로 동작하고 다크·라이트 모두 읽힌다. → Task 3 CSS(`pointer-events:none`) + Task 4 확인.
- 완주·기한 종료로 바뀌는 순간 → 깜빡임·배경·칩 색이 모두 사라진다. → Task 2·3 렌더 테스트.

---

### Task 1: 긴장 판단 순수 함수

**Files:**
- Modify: `web/lib/race.ts`(추가, `sprintPulse` 삭제 — 호출처가 Task 2에서 사라짐)
- Test: `web/tests/race.test.ts`(`sprintPulse` 테스트 4개 삭제)

`sprintPulse` 삭제는 Task 2의 `race-home.tsx` 변경과 함께 빌드가 맞으므로 **Task 2 커밋에서** 지운다. 이 Task에서는 추가만 한다.

**Interfaces:**
- Produces(`lib/race.ts`):
  - `type FocusTask = RaceTask & { dueAt: string | null }`
  - `focusTask<T extends FocusTask>(tasks: T[], person: number): T | null`
  - `waitReason(tasks: FocusTask[], person: number): 'done' | 'undated' | 'unassigned'`
  - `type TensionStage = 'idle' | 'calm' | 'heat' | 'critical' | 'final' | 'over'`
  - `tension(msLeft: number | null): { stage: TensionStage; tint: number }`
  - `chipStage(msLeft: number): 'calm' | 'heat' | 'critical' | 'final' | 'over'`
  - `focusClock(msLeft: number): string`
  - `checkedInToday(checkins: { task_id: number; created_at: string }[], tasks: { id: number; person: number }[], person: number, nowMs: number): boolean`

- [ ] **Step 1: 실패하는 테스트 작성**(`tests/race.test.ts`에 추가, import 목록에도 추가)

```ts
const H = 3600000;
const ft = (id: number, person: number, dueAt: string | null, over: Partial<RaceTask> = {}) => ({
  id, person, dueAt, done: false, deferred: false, dependsOn: [], ...over,
});

void test('focusTask: 내 미완료·마감 있는 업무 중 가장 이른 마감, 지난 마감 포함', () => {
  const tasks = [
    ft(1, 0, '2026-11-05T00:00:00.000Z'),
    ft(2, 0, '2026-11-03T00:00:00.000Z'),
    ft(3, 1, '2026-11-01T00:00:00.000Z'), // 남의 업무
    ft(4, 0, '2026-11-01T00:00:00.000Z', { done: true }),
    ft(5, 0, '2026-11-01T00:00:00.000Z', { deferred: true }),
    ft(6, 0, null),
  ];
  assert.equal(focusTask(tasks, 0)?.id, 2);
  assert.equal(focusTask(tasks, 2), null);
  assert.equal(focusTask([ft(7, 0, '2020-01-01T00:00:00.000Z'), ...tasks], 0)?.id, 7);
});
void test('waitReason: 배정 없음·마감 미정만 남음·모두 완료', () => {
  assert.equal(waitReason([ft(1, 1, null)], 0), 'unassigned');
  assert.equal(waitReason([ft(1, 0, null, { deferred: true })], 0), 'unassigned');
  assert.equal(waitReason([ft(1, 0, null)], 0), 'undated');
  assert.equal(waitReason([ft(1, 0, '2026-11-05T00:00:00.000Z', { done: true })], 0), 'done');
});
void test('tension: 구간 경계', () => {
  assert.deepEqual(tension(null), { stage: 'idle', tint: 0 });
  assert.deepEqual(tension(NaN), { stage: 'idle', tint: 0 });
  assert.deepEqual(tension(73 * H), { stage: 'calm', tint: 0 });
  assert.equal(tension(72 * H).stage, 'heat');
  assert.equal(tension(24 * H + 1).stage, 'heat');
  assert.equal(tension(24 * H).stage, 'critical');
  assert.equal(tension(H + 1).stage, 'critical');
  assert.equal(tension(H).stage, 'final');
  assert.equal(tension(1).stage, 'final');
  assert.deepEqual(tension(0), { stage: 'over', tint: 1 });
  assert.deepEqual(tension(-5 * H), { stage: 'over', tint: 1 });
});
void test('tension: 붉은 기는 (1 - 남은/72h)^1.4로 마감에 가까울수록 진해진다', () => {
  assert.ok(Math.abs(tension(48 * H).tint - Math.pow(1 / 3, 1.4)) < 1e-9);
  assert.ok(tension(48 * H).tint < tension(24 * H).tint);
  assert.ok(tension(24 * H).tint < tension(H).tint);
  assert.equal(tension(72 * H).tint, 0);
});
void test('chipStage: 칩은 24h 주황, 6h 빨강, 1h 깜빡, 지나면 초과', () => {
  assert.equal(chipStage(24 * H + 1), 'calm');
  assert.equal(chipStage(24 * H), 'heat');
  assert.equal(chipStage(6 * H + 1), 'heat');
  assert.equal(chipStage(6 * H), 'critical');
  assert.equal(chipStage(H), 'final');
  assert.equal(chipStage(0), 'over');
});
void test('focusClock: 24시간 넘어도 시간 단위, 초과는 + 와 지난 시간', () => {
  assert.equal(focusClock(52 * H + 10 * 60000 + 3000), '52:10:03');
  assert.equal(focusClock(168 * H - 1000), '167:59:59');
  assert.equal(focusClock(0), '+00:00:00');
  assert.equal(focusClock(-(2 * H + 13 * 60000 + 5000)), '+02:13:05');
});
void test('checkedInToday: 담당자 기준, KST 날짜가 같을 때만', () => {
  const tasks = [{ id: 1, person: 0 }, { id: 2, person: 1 }];
  const now = Date.parse('2026-11-02T15:30:00.000Z'); // KST 11/3 00:30
  const at = (task_id: number, created_at: string) => [{ task_id, created_at }];
  assert.equal(checkedInToday(at(1, '2026-11-02T15:00:00.000Z'), tasks, 0, now), true); // KST 11/3 00:00
  assert.equal(checkedInToday(at(1, '2026-11-02T14:59:59.000Z'), tasks, 0, now), false); // KST 11/2 23:59
  assert.equal(checkedInToday(at(2, '2026-11-02T15:10:00.000Z'), tasks, 0, now), false); // 다른 사람 업무
  assert.equal(checkedInToday(at(9, '2026-11-02T15:10:00.000Z'), tasks, 0, now), false); // 없는 업무
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/race.test.ts` → import 오류로 FAIL.

- [ ] **Step 3: `lib/race.ts`에 구현**
  - `tension`: `msLeft`가 null/NaN이면 idle. `≤0` over(tint 1), `≤1h` final, `≤24h` critical, `≤72h` heat, 그 외 calm(tint 0). tint는 스펙 공식.
  - `focusClock`: `msLeft > 0`이면 기존 `countdown(msLeft).text`, 아니면 `'+' + countdown(-msLeft).text`.
  - `checkedInToday`: KST 날짜는 `seoulTime(iso).slice(0, 10)`, `now`는 `new Date(nowMs).toISOString()`로 넘긴다. 함수 위에 주석: `// ponytail: 서버 상태의 checkins는 프로젝트 전체 최근 20건. 하루 20건을 넘으면 이른 보고가 빠진다. 필요하면 서버에서 멤버별 마지막 보고 시각을 내려준다.`
  - `waitReason`: `person`이 맞고 `!deferred`인 업무가 없으면 unassigned, 그중 미완료가 있으면 undated, 아니면 done.

- [ ] **Step 4: 통과 확인** — 같은 명령 → 전부 pass.

- [ ] **Step 5: 커밋** — `feat: 업무 마감 카운트다운·긴장 단계·오늘 체크인 판단 함수`

### Task 2: 홈 재구성(카운트다운·캘린더·체크인 현황)

**Files:**
- Modify: `web/components/race-home.tsx`, `web/components/deadline-calendar.tsx`, `web/app/workspace/page.tsx`(home 블록), `web/app/globals.css`, `web/lib/race.ts`·`web/tests/race.test.ts`(`sprintPulse` 삭제), `web/package.json`(테스트 목록)
- Test: `web/tests/race-home-render.test.mjs`(`team-directory-render.test.mjs`와 같은 esbuild→renderToString 방식, entry `components/race-home.tsx`)

**Interfaces:**
- Consumes: Task 1 전부, 기존 `laneTask`, `dueLabel`.
- Produces(`components/race-home.tsx`):
  - `FocusCountdown(props: { tasks: Task[]; person: number; now: number }): JSX.Element`
  - `TeamCheckins(props: { members: ProjectMeta['members']; me: ProjectMeta['me']; tasks: Task[]; checkins: { task_id: number; created_at: string }[]; now: number }): JSX.Element`
  - `RaceHome` props에서 `plan` 삭제. 나머지 동일.
- `DeadlineCalendar` props: `bottlenecks` 삭제, `active: boolean` 추가.

- [ ] **Step 1: 실패하는 렌더 테스트 작성**

```js
const NOW = Date.parse('2026-11-02T03:00:00.000Z');
const H = 3600000;
const task = (id, person, title, dueMs, over = {}) => ({
  id, person, title, dueAt: dueMs == null ? null : new Date(dueMs).toISOString(),
  done: false, deferred: false, dependsOn: [], remaining: 4, ...over,
});
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '');

void test('카운트다운: 업무명 + 마감까지, timer 역할, 아래 작은 글씨 없음', () => {
  const html = renderToString(createElement(FocusCountdown, { tasks: [task(1, 0, 'DB 구축', NOW + 2 * H)], person: 0, now: NOW }));
  assert.match(text(html), /DB 구축 마감까지/);
  assert.match(text(html), /02:00:00/);
  assert.match(html, /role="timer"/);
  assert.doesNotMatch(text(html), /다음:|\d+\/\d+ \d+:\d+ 마감/);
});
void test('카운트다운: 지난 마감은 마감 초과와 + 시간', () => {
  const t = text(renderToString(createElement(FocusCountdown, { tasks: [task(1, 0, 'DB 구축', NOW - H)], person: 0, now: NOW })));
  assert.match(t, /DB 구축 마감 초과/);
  assert.match(t, /\+01:00:00/);
});
void test('카운트다운: 대기 중 문구 3가지', () => {
  const t = (tasks) => text(renderToString(createElement(FocusCountdown, { tasks, person: 0, now: NOW })));
  assert.match(t([task(1, 0, 'A', NOW + H, { done: true })]), /내 업무 모두 완료 · 대기 중/);
  assert.match(t([task(1, 0, 'A', null)]), /마감이 정해진 내 업무 없음 · 대기 중/);
  assert.match(t([task(1, 1, 'A', NOW + H)]), /배정된 내 업무 없음 · 대기 중/);
});
void test('체크인 현황: 참여 중인 팀원만, 지금 업무와 오늘 보고 여부, 내 줄 표시', () => {
  const members = [
    { display_name: '도윤', person: 0, left_at: null },
    { display_name: '서연', person: 1, left_at: null },
    { display_name: '나감', person: 2, left_at: '2026-11-01T00:00:00.000Z' },
  ];
  const tasks = [task(1, 0, 'DB 구축', NOW + H), task(2, 1, '화면 시안', NOW + 2 * H)];
  const checkins = [{ task_id: 1, created_at: new Date(NOW - 60000).toISOString() }];
  const html = renderToString(createElement(TeamCheckins, { members, me: { person: 0 }, tasks, checkins, now: NOW }));
  const rows = html.split('race-checkin-row').slice(1).map(text);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /도윤.*나.*DB 구축.*오늘 체크인 완료/);
  assert.match(rows[1], /서연.*화면 시안.*아직 체크인 안 함/);
});
void test('캘린더: 진행 중에만 칩 단계, 오늘 aria-current, 병목 표시 없음', () => {
  const start = new Date(NOW - H).toISOString();
  const deadline = new Date(NOW - H + 168 * H).toISOString();
  const tasks = [task(1, 0, 'A', NOW + 5 * H), task(2, 0, 'B', NOW + 30 * 60000), task(3, 0, 'C', NOW + 20 * H)];
  const props = { startedAt: start, deadline, now: NOW, tasks, people: [{ name: '도윤' }], onPlan: () => {} };
  const on = renderToString(createElement(DeadlineCalendar, { ...props, active: true }));
  assert.match(on, /chip-critical/);
  assert.match(on, /chip-final/);
  assert.match(on, /chip-heat/);
  assert.equal((on.match(/aria-current="date"/g) ?? []).length, 1);
  assert.doesNotMatch(on, /병목/);
  const off = renderToString(createElement(DeadlineCalendar, { ...props, active: false }));
  assert.doesNotMatch(off, /chip-|마감 지남/);
});
```

`DeadlineCalendar`는 `race-home.tsx`에서 `export { DeadlineCalendar }`로 함께 내보내 테스트에서 쓴다.

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/race-home-render.test.mjs` → FAIL.

- [ ] **Step 3: `FocusCountdown` 구현**
  - `focusTask` → 있으면 `msLeft = Date.parse(dueAt) - now`, `tension(msLeft).stage`, `focusClock(msLeft)`. 초 자리는 `<span className="focus-sec" key={sec}>`로 분리해 바뀔 때만 애니메이션.
  - 문구: over면 `{title} 마감 초과`, 아니면 `{title} 마감까지`. 업무명 `<em>`. 숫자 `<div className={'focus-clock ' + stage} role="timer">`.
  - 없으면 회색 `focus-clock idle` '대기 중', 문구는 `waitReason`에 따라 `내 업무 모두 완료 · 대기 중` / `마감이 정해진 내 업무 없음 · 대기 중` / `배정된 내 업무 없음 · 대기 중`.

- [ ] **Step 4: `RaceHome` 정리** — 큰 숫자 3개, 병목 알림, 팀 레인, `sprintPulse`, `plan` 삭제. 구성: `tasks.length === 0`이면 기존 `업무가 아직 없습니다` 안내 + [업무로 이동](뒤 문장은 "업무와 담당자를 등록하면 마감까지 남은 시간을 셉니다."로), 아니면 `lifecycle === 'active'`일 때 `FocusCountdown`. 그 아래 `DeadlineCalendar active={lifecycle === 'active'}`.

- [ ] **Step 5: `DeadlineCalendar` 수정** — 오늘 칸 `aria-current="date"`. 칩: `t.done`이면 `done`, `active`일 때만 `chipStage(Date.parse(t.dueAt!) - now)`로 `over`→기존 `late`(문구 '마감 지남' 포함), `heat|critical|final`→`chip-*`. `active`가 false면 `late`도 없음. `blocked`·`bottlenecks` 삭제(`Flag`는 최종 기한에 계속 사용).

- [ ] **Step 6: `TeamCheckins` 구현 + `page.tsx` home 블록** — `.race-below`의 첫 칸을 `TeamCheckins`(제목 `팀원 체크인 현황`, 부제 `오늘(KST) 진행 보고 기준`), 둘째 칸을 기존 회의 제안 블록으로. '최근 진행 보고' 블록 삭제. 줄 구성: 이름(내 줄은 `<small> 나</small>`) · `laneTask` 제목 + `dueLabel`(없으면 `진행 중인 업무 없음`) · 배지 `오늘 체크인 완료`(`--good`) / `아직 체크인 안 함`(`--red-*`). 줄 className에 `race-checkin-row` 포함. 목록 아래 작은 안내 `하루 한 번 진행 보고로 완료·남은 일·막힘을 남겨주세요. 보고가 없어도 완주 판정에는 영향을 주지 않습니다.` `now`는 `Date.parse(state.asOf)`. 준비 중 홈도 같은 두 칸을 쓴다(스펙 '최근 진행 보고 대체'에 맞춤).

- [ ] **Step 7: CSS** — 추가: `.focus-hero`(가운데 정렬), `.focus-label em`(`--heat-*`), `.focus-clock`(`font-size: clamp(44px, 11vw, 88px)`, tabular-nums, 900, `overflow-wrap:anywhere`), `.focus-clock.heat|critical|final|over|idle`, `.focus-clock.final` 깜빡(`steps` 1초), `.focus-sec` 떨어지는 애니메이션 250ms, `.deadline-card.chip-heat|chip-critical|chip-final`, 체크인 줄·배지. 삭제: `race-home`에서 안 쓰게 된 `.race-stats`, `.race-stat*`, `.race-lanes`, `.race-lane*`, `.race-meter`, `.race-hours`, `.race-label`, `.deadline-card.blocked*`와 관련 미디어쿼리(지우기 전 `grep`으로 다른 사용처 확인, `.race-tag`·`.race-alert.calm`은 유지).

- [ ] **Step 8: `sprintPulse`와 테스트 4개 삭제, `package.json` 테스트 목록에 `tests/race-home-render.test.mjs` 추가**

- [ ] **Step 9: 통과 확인** — `npx tsc --noEmit -p .` 오류 없음, `node --experimental-strip-types --test tests/race.test.ts tests/race-home-render.test.mjs tests/meeting-panel.test.mjs tests/workspace-views.test.mjs tests/theme-tokens.test.mjs` 전부 pass.

- [ ] **Step 10: 커밋** — `feat: 홈을 업무 마감 카운트다운·캘린더·체크인 현황 구성으로 교체`

### Task 3: 배경·테두리 긴장 레이어

**Files:**
- Create: `web/components/tension-layer.tsx`(`'use client'`)
- Modify: `web/app/workspace/page.tsx`, `web/app/globals.css`
- Test: `web/tests/race-home-render.test.mjs`에 추가(별도 entry로 한 번 더 번들)

**Interfaces:**
- Consumes: Task 1 `focusTask`, `tension`. 기존 `useServerNow`.
- Produces: `TensionLayer(props: { lifecycle: Lifecycle; asOf: string; tasks: Task[]; person: number }): JSX.Element | null`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
const layer = (lifecycle, tasks) => renderToString(createElement(TensionLayer, {
  lifecycle, asOf: new Date(NOW).toISOString(), tasks, person: 0,
}));
void test('긴장 레이어: 내 업무 마감 기준 단계, 장식이라 스크린리더에서 숨김', () => {
  const html = layer('active', [task(1, 0, 'A', NOW + 20 * H), task(2, 1, '남의 업무', NOW + 60000)]);
  assert.match(html, /tension-critical/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /--tint:0\.\d+/);
});
void test('긴장 레이어: 여유·대기 중·진행 중이 아닐 때는 아무것도 없다', () => {
  assert.equal(layer('active', [task(1, 0, 'A', NOW + 100 * H)]), '');
  assert.equal(layer('active', [task(1, 0, 'A', NOW + H, { done: true })]), '');
  for (const s of ['draft', 'completed', 'expired', 'legacy'])
    assert.equal(layer(s, [task(1, 0, 'A', NOW + 60000)]), '');
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/race-home-render.test.mjs` → FAIL.

- [ ] **Step 3: 구현** — `useServerNow(lifecycle === 'active' ? asOf : null)`, 첫 렌더는 `Date.parse(asOf)`. active가 아니거나 stage가 `idle`·`calm`이면 null. 그 외 Fragment로 `<div className="tension-tint tension-{stage}" style={{ '--tint': tint.toFixed(3) }} aria-hidden="true" />`와 `<div className="tension-edge tension-{stage}" aria-hidden="true" />`.

- [ ] **Step 4: `page.tsx` 연결** — `.work-main` 안 첫 자식으로 `{s && <TensionLayer lifecycle={lifecycle} asOf={state!.asOf} tasks={tasks} person={state!.me.person} />}`. 큰 페이지가 초마다 다시 그려지지 않도록 시각 상태를 `page.tsx`로 올리지 않는다.

- [ ] **Step 5: CSS**
  - `.workspace-body .app-shell > .work-main { isolation: isolate; }`
  - `.tension-tint { position:fixed; inset:0; z-index:-1; pointer-events:none; background: radial-gradient(ellipse at center, transparent 35%, color-mix(in srgb, var(--red-500) calc(var(--tint) * 55%), transparent) 100%), color-mix(in srgb, var(--red-500) calc(var(--tint) * 10%), transparent); }`
  - `.tension-edge { position:fixed; inset:0; z-index:30; pointer-events:none; }`
  - `.tension-edge.tension-critical` 안쪽 붉은 그림자 2.4초 숨쉬기, `.tension-final` 4px 붉은 테두리 + 안쪽 그림자 `steps` 초당 1회, `.tension-over` 같은 테두리 고정(애니메이션 없음), `.tension-heat` 없음.
  - `z-index:30`이 사이드바·대화상자(z-50)와 충돌하면 대화상자 아래로 유지.

- [ ] **Step 6: 통과 확인** — `npx tsc --noEmit -p .` 오류 없음, `npm test` 전부 pass.

- [ ] **Step 7: 커밋** — `feat: 내 업무 마감에 따라 작업 화면이 붉어지는 긴장 레이어`

### Task 4: 브라우저 확인·문서

**Files:**
- Modify: `docs/features.md`(작업 화면 설명), `docs/current-sprint.md`(맨 위 `## 2026-11-02 홈 화면 긴장감` 항목: 설계 링크, 서버 변경 없음, 테스트 수, 확인 결과)

- [ ] **Step 1: 로컬 실행** — 본 폴더 `.claude/launch.json`에 이 worktree의 `web`을 포트 3102로 띄우는 임시 설정(`DATABASE_URL=`, `DATABASE_PATH=.data/pglite-ui`, 빈 `NEXT_PUBLIC_SUPABASE_*`)을 넣고, `env DATABASE_URL= DATABASE_PATH=.data/pglite-ui node --experimental-strip-types scripts/migrate.ts` 후 `preview_start`, `node scripts/seed-ui.mjs`, `node scripts/dev-as.mjs 3110 owner 도윤 3102`, `node scripts/dev-as.mjs 3111 mate 서연 3102`. 끝나면 설정을 `git checkout`으로 되돌린다.
- [ ] **Step 2: 단계 확인** — 팀장 내 업무를 마감 100h·50h·20h·30분·90초 뒤로 만들고(`createTask`) 각각 완료해 가며 화면 확인: 여유(효과 없음) → 주황·틴트 → 빨강·숨쉬기 → 깜빡임 → 90초 업무가 재조회 없이 `마감 초과 +00:00:..`로 바뀌고 깜빡임 멈춤.
- [ ] **Step 3: 흐름 확인** — 업무 완료 시 바로 다음 업무로 넘어감, 모두 완료 시 '대기 중'과 효과 꺼짐, 진행 보고 후 체크인 배지 변경, 팀원 계정은 자기 업무 기준, 업무·프로젝트 탭에서도 틴트·테두리 유지·큰 카운트다운 없음, 완주한 시드 프로젝트에 효과 없음.
- [ ] **Step 4: 화면 상태** — 다크·라이트, 375px 가로 스크롤 없음(`167:59:59`, 긴 업무명), 버튼·대화상자 클릭 정상, 콘솔 오류 없음, 스크린샷을 남긴다.
- [ ] **Step 5: 전체 검증** — dev 서버를 끄고 `npm test`, `npm run lint`(기준 이하), `npm run build`.
- [ ] **Step 6: 문서 수정 후 커밋** — `docs: 홈 화면 긴장감 반영`
