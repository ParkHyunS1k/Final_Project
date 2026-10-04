# 작업 화면 레이스 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/workspace`를 다크 기본 레이스 테마로 바꾸고, 메뉴 7개를 홈·업무·프로젝트 3개로 줄인다. 홈에는 카운트다운, Day 트랙, 큰 숫자, 병목, 팀 레인을 두고 상단에는 '진행 보고' 버튼 하나만 둔다.

**Architecture:** 서버·API·DB는 바꾸지 않는다. 계산은 순수 함수 파일 하나(`web/lib/race.ts`)에 모으고 node 테스트로 고정한다. 테마는 `<html>`의 `.dark` 클래스와 `globals.css`의 색 변수를 바꿔서 처리한다. 화면은 기존 컴포넌트를 옮겨 붙이고, 새 컴포넌트는 `RaceClock`, `RaceHome`, `ThemeToggle` 세 개만 만든다.

**Tech Stack:** Next.js(App Router, `web/`), React 19, shadcn(base-ui), lucide-react, 일반 CSS(`app/globals.css`), node:test(`--experimental-strip-types`), PGlite(로컬 확인)

**Spec:** `docs/superpowers/specs/2026-10-05-workspace-race-redesign-design.md`

## Global Constraints

- 서버, API 라우트, DB 스키마, 권한 검사, 버전 충돌 처리, 저장 흐름은 바꾸지 않는다.
- 새 의존성을 추가하지 않는다. next-themes도 쓰지 않는다.
- 랜딩(`components/landing-page.tsx`, `components/landing.css`, `.rl`)은 수정하지 않는다.
- 다크가 기본이다. 테마 값은 `localStorage['pm-theme']`(`'light'`일 때만 라이트)에만 저장하고 서버에는 저장하지 않는다.
- heat 주황은 `#ff5a1f`이다. 주황 바탕 위 글자는 `--heat-ink`(`#0b0b0c`)를 쓴다.
- 카운트다운 형식은 `HH:MM:SS`(총 시간)이다. 남은 시간이 72시간을 넘으면 기본 색, 72시간 이하면 heat, 24시간 이하면 빨강과 깜빡임이다.
- 브라우저 시계가 0이 되어도 화면이 스스로 '기한 종료'로 바꾸지 않는다. 재조회를 한 번 하고, 서버가 준 `lifecycle`을 따른다.
- 움직임은 `prefers-reduced-motion`이면 꺼진다. `globals.css`의 기존 전역 규칙(1031행 근처)이 이미 모든 animation을 끈다.
- 기존 패널의 문구와 동작(목표 합의, 초대, 변경안 검토, 결과물 근거, 완주 확인)은 위치만 옮긴다.
- 로컬 확인에 `.env.local`의 `DATABASE_URL`을 쓰면 안 된다. 이 값은 운영 Supabase DB를 가리킨다. 반드시 Task 2의 PGlite 실행 구성을 쓴다.
- `web/AGENTS.md`에 따르면 이 Next.js는 학습 데이터와 다를 수 있다. `layout.tsx`에서 `<head>` 인라인 스크립트를 쓰기 전에 `node_modules/next/dist/docs/`에서 head와 script 관련 문서를 확인한다.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다.

## Review Focus

1. **기기 시계가 틀린 사용자**: 카운트다운은 서버 `asOf` 기준으로 흘러야 한다. Task 1의 `clockOffset` 테스트로 고정한다.
2. **예전 주소로 들어온 사용자**(`?view=mine`, `ai`, `docs`, 모르는 값, `toString`): 새 메뉴로 열리고 오류가 나지 않아야 한다. Task 1의 `viewFrom` 테스트로 고정한다.
3. **브라우저 시계가 서버보다 먼저 0이 된 경우**: `00:00:00`에서 멈추고, 재조회는 한 번만 하며, 진행 보고 버튼은 서버가 종료라고 할 때까지 남아 있다. Task 1의 `countdown` 음수·NaN 테스트와 Task 5의 `fired` 참조로 처리한다.
4. **팀원 계정(팀장이 아님)**: 초대 폼과 `+ 업무`가 보이지 않고, 내 업무가 없을 때 진행 보고를 누르면 알림만 뜬다. Task 1의 `reportChoices` 테스트와 Task 8의 팀원 계정 브라우저 확인으로 처리한다.
5. **localStorage를 쓸 수 없는 환경**(시크릿 창, 차단): 다크로 열리고 전환 버튼이 오류를 내지 않아야 한다. Task 3의 try/catch로 처리하고, Task 8에서 `localStorage`를 막은 상태로 확인한다.

---

## 파일 구조

| 파일 | 역할 | 작업 |
|---|---|---|
| `web/lib/race.ts` | 순수 계산: 큰 숫자, 카운트다운, 시계 보정, 일차, 메뉴 주소, 팀 레인, 진행 보고 선택 | 새로 만듦 |
| `web/tests/race.test.ts` | 위 함수 테스트 | 새로 만듦 |
| `web/hooks/use-server-now.ts` | 서버 기준 현재 시각(1초 갱신) | 새로 만듦 |
| `web/components/theme-toggle.tsx` | 다크/라이트 전환 버튼 | 새로 만듦 |
| `web/components/race-clock.tsx` | 상단 카운트다운 | 새로 만듦 |
| `web/components/race-home.tsx` | 홈의 큰 숫자, 트랙, 병목 알림, 팀 레인 | 새로 만듦 |
| `web/scripts/dev-as.mjs` | 로컬 확인용: 개발 신원 헤더를 붙이는 프록시 | 새로 만듦 |
| `web/scripts/seed-ui.mjs` | 로컬 확인용: 진행 중·준비·완주 프로젝트 만들기 | 새로 만듦 |
| `.claude/launch.json` | PGlite 개발 서버 구성 `workspace-ui` | 수정 |
| `web/app/layout.tsx` | 그리기 전 테마 스크립트 | 수정 |
| `web/app/globals.css` | 색 변수, 다크 정의, 레이스 스타일 | 수정 |
| `web/components/project-workspace.tsx` | 메뉴 3개, 주소 변환, 프로젝트 선택 드롭다운, 테마 버튼 | 수정 |
| `web/app/workspace/page.tsx` | 상단 레이스 바, 홈·업무·프로젝트 화면 구성 | 수정 |
| `web/components/deadline-calendar.tsx` | 현재 시각 막대, 병목 깃발 | 수정 |
| `web/components/task-collection.tsx` | 병목 띠·태그 | 수정 |
| `web/tests/meeting-panel.test.mjs` | 새 메뉴 id 기준으로 갱신 | 수정 |
| `web/package.json` | `npm test`에 race 테스트 추가 | 수정 |
| `docs/features.md` 외 | 예전 메뉴 이름 갱신 | 수정 |

**스펙과 다르게 정한 점**(구현 중 확인된 사실에 맞춤):
- 스펙 7.2절의 병목 판별 조건(`!plan.finishes[id]`)은 `plan.unscheduled`로 바꾼다. `plan()`(`lib/sprint.ts`)은 마감을 넘는 업무를 `unscheduled`에 넣으면서도 `finishes`를 채운다. 그래서 기존 조건은 마감 초과 업무를 놓친다. 큰 숫자의 '병목 n건'과 같은 기준을 쓴다.
- 스펙 7.2절의 '이전 병목 id와 비교'는 CSS로 대신한다. 행에 `is-blocked` 클래스가 처음 붙을 때 animation이 한 번만 돈다. JS 상태는 쓰지 않는다.
- 스펙 5.2절의 '`visibilitychange` 재조회'는 이미 있다. `page.tsx`가 15초마다, 그리고 `focus` 때 다시 불러온다. 새로고침 버튼만 지운다.
- 스펙 5.6절의 '업무가 없으면 버튼 비활성 + 툴팁'은 `aria-disabled` + 알림으로 바꾼다. 비활성 버튼은 툴팁이 뜨지 않는 브라우저가 있다.
- Day 트랙의 '오늘 칸 꽉 채움'은 heat 18% 섞은 바탕과 위쪽 4px 띠로 바꾼다. 칸 안에 업무 마감 카드가 있어 꽉 채우면 글을 읽을 수 없다.
- 순수 함수는 `lib/sprint-pulse.ts`가 아니라 `lib/race.ts` 한 파일에 모은다.

---

### Task 1: 레이스 계산 순수 함수

**Files:**
- Create: `web/lib/race.ts`
- Create: `web/tests/race.test.ts`
- Modify: `web/package.json`(scripts.test 끝에 `tests/race.test.ts` 추가)

**Interfaces:**
- Produces:
  - `sprintPulse(tasks: RaceTask[], plan: Pick<Plan,'needed'|'available'|'unscheduled'> | null): { done: number; total: number; hoursOver: number; bottlenecks: number[] }`
  - `countdown(msLeft: number): { text: string; level: 'calm'|'heat'|'critical'; over: boolean }`
  - `clockOffset(asOf: string, deviceNow: number): number`
  - `sprintDay(startedAt: string, nowMs: number, durationDays: number): number`
  - `dayProgress(dayStart: string, nowMs: number): number` (0~1)
  - `type View = 'home'|'tasks'|'project'`, `viewFrom(param: string | null): { view: View; mine: boolean }`
  - `laneTask<T extends RaceTask>(tasks: T[], person: number): T | null`
  - `reportChoices<T extends RaceTask>(tasks: T[], me: { person: number }, owner: boolean): { open: T[]; first: T | null }`
  - `type RaceTask = { id: number; person: number; done: boolean; deferred: boolean; status?: 'todo'|'in_progress'; dependsOn: number[] }`

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/race.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sprintPulse,
  countdown,
  clockOffset,
  sprintDay,
  dayProgress,
  viewFrom,
  laneTask,
  reportChoices,
  type RaceTask,
} from '../lib/race.ts';

function t(id: number, over: Partial<RaceTask> = {}): RaceTask {
  return { id, person: 0, done: false, deferred: false, dependsOn: [], ...over };
}
const plan = (needed: number, available: number, unscheduled: number[] = []) => ({
  needed,
  available,
  unscheduled,
});

void test('sprintPulse: 업무가 없으면 0/0, 계획이 없으면 공수·병목 0', () => {
  assert.deepEqual(sprintPulse([], null), { done: 0, total: 0, hoursOver: 0, bottlenecks: [] });
});

void test('sprintPulse: 보류 업무는 세지 않고 완료 수를 센다', () => {
  const p = sprintPulse([t(1, { done: true }), t(2), t(3, { deferred: true })], plan(4, 10));
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
});

void test('sprintPulse: 필요가 예산보다 크면 양수(초과), 작으면 음수(여유), 소수 첫째 자리', () => {
  assert.equal(sprintPulse([t(1)], plan(25.04, 16)).hoursOver, 9);
  assert.equal(sprintPulse([t(1)], plan(4, 16.33)).hoursOver, -12.3);
});

void test('sprintPulse: 병목은 unscheduled 중 완료·보류가 아닌 업무', () => {
  const p = sprintPulse(
    [t(1), t(2, { done: true }), t(3, { deferred: true }), t(4)],
    plan(10, 5, [1, 2, 3]),
  );
  assert.deepEqual(p.bottlenecks, [1]);
});

void test('countdown: 총 시간 HH:MM:SS, 100시간 이상도 그대로', () => {
  assert.equal(countdown((52 * 3600 + 14 * 60 + 8) * 1000).text, '52:14:08');
  assert.equal(countdown(168 * 3600 * 1000).text, '168:00:00');
});

void test('countdown: 72h 초과 calm, 72h 이하 heat, 24h 이하 critical', () => {
  assert.equal(countdown((72 * 3600 + 1) * 1000).level, 'calm');
  assert.equal(countdown(72 * 3600 * 1000).level, 'heat');
  assert.equal(countdown((24 * 3600 + 1) * 1000).level, 'heat');
  assert.equal(countdown(24 * 3600 * 1000).level, 'critical');
});

void test('countdown: 음수·NaN은 00:00:00에서 멈추고 over', () => {
  assert.deepEqual(countdown(-5000), { text: '00:00:00', level: 'critical', over: true });
  assert.deepEqual(countdown(Number.NaN), { text: '00:00:00', level: 'critical', over: true });
});

void test('clockOffset: 서버 시각 - 기기 시각, 잘못된 asOf면 0', () => {
  const server = '2026-10-05T00:00:00.000Z';
  assert.equal(clockOffset(server, Date.parse(server) - 90_000), 90_000);
  assert.equal(clockOffset('nope', 123), 0);
});

void test('sprintDay: 시작 직후 1일차, 24시간 뒤 2일차, 기간을 넘지 않음', () => {
  const start = '2026-10-01T10:00:00+09:00';
  const at = (h: number) => Date.parse(start) + h * 3600000;
  assert.equal(sprintDay(start, at(0), 7), 1);
  assert.equal(sprintDay(start, at(24), 7), 2);
  assert.equal(sprintDay(start, at(-5), 7), 1);
  assert.equal(sprintDay(start, at(24 * 9), 7), 7);
});

void test('dayProgress: 칸 시작 0, 12시간 0.5, 범위 밖은 0~1로 자름', () => {
  const s = '2026-10-01T00:00:00Z';
  assert.equal(dayProgress(s, Date.parse(s)), 0);
  assert.equal(dayProgress(s, Date.parse(s) + 12 * 3600000), 0.5);
  assert.equal(dayProgress(s, Date.parse(s) + 30 * 3600000), 1);
  assert.equal(dayProgress(s, Date.parse(s) - 1), 0);
});

void test('viewFrom: 새 메뉴는 그대로, 예전 7개는 새 메뉴로, 모르는 값은 홈', () => {
  assert.deepEqual(viewFrom('tasks'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('today'), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('team'), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('plan'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('ai'), { view: 'tasks', mine: false });
  assert.deepEqual(viewFrom('mine'), { view: 'tasks', mine: true });
  assert.deepEqual(viewFrom('docs'), { view: 'project', mine: false });
  assert.deepEqual(viewFrom('result'), { view: 'project', mine: false });
  assert.deepEqual(viewFrom(null), { view: 'home', mine: false });
  assert.deepEqual(viewFrom('toString'), { view: 'home', mine: false });
});

void test('laneTask: 진행 중 상태 우선, 없으면 완료·보류 아닌 첫 업무, 없으면 null', () => {
  const tasks = [
    t(1, { person: 1, done: true }),
    t(2, { person: 1 }),
    t(3, { person: 1, status: 'in_progress' }),
    t(4, { person: 2, deferred: true }),
  ];
  assert.equal(laneTask(tasks, 1)?.id, 3);
  assert.equal(laneTask(tasks.slice(0, 2), 1)?.id, 2);
  assert.equal(laneTask(tasks, 2), null);
});

void test('reportChoices: 팀원은 자기 미완료 업무만, 팀장은 전체에서 자기 업무를 먼저 고른다', () => {
  const tasks = [t(1, { person: 0 }), t(2, { person: 1, status: 'in_progress' }), t(3, { person: 1, done: true })];
  const mate = reportChoices(tasks, { person: 1 }, false);
  assert.deepEqual(mate.open.map((x) => x.id), [2]);
  assert.equal(mate.first?.id, 2);
  const lead = reportChoices(tasks, { person: 0 }, true);
  assert.deepEqual(lead.open.map((x) => x.id), [1, 2]);
  assert.equal(lead.first?.id, 1);
  const none = reportChoices(tasks, { person: 5 }, false);
  assert.deepEqual(none, { open: [], first: null });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd web && node --experimental-strip-types --test tests/race.test.ts`
Expected: FAIL. `Cannot find module '../lib/race.ts'`

- [ ] **Step 3: 최소 구현 작성**

`web/lib/race.ts`:

```ts
// 작업 화면 레이스 표시용 순수 계산. 서버가 준 값(asOf·plan)만 읽고 저장하지 않는다.
import type { Plan } from './sprint.ts';

const DAY_MS = 86400000;
const HOUR_S = 3600;

export type RaceTask = {
  id: number;
  person: number;
  done: boolean;
  deferred: boolean;
  status?: 'todo' | 'in_progress';
  dependsOn: number[];
};

/** 홈 큰 숫자 3개. 보류 업무는 세지 않는다. 병목 = 마감 안에 배치되지 않은 미완료 업무(plan.unscheduled). */
export function sprintPulse(
  tasks: RaceTask[],
  plan: Pick<Plan, 'needed' | 'available' | 'unscheduled'> | null,
) {
  const counted = tasks.filter((t) => !t.deferred);
  return {
    done: counted.filter((t) => t.done).length,
    total: counted.length,
    hoursOver: plan ? Math.round((plan.needed - plan.available) * 10) / 10 : 0,
    bottlenecks: plan
      ? counted.filter((t) => !t.done && plan.unscheduled.includes(t.id)).map((t) => t.id)
      : [],
  };
}

export type ClockLevel = 'calm' | 'heat' | 'critical';
const pad = (n: number) => String(n).padStart(2, '0');
/** 남은 밀리초 → 'HH:MM:SS'(총 시간). 0 아래로 내려가지 않는다. */
export function countdown(msLeft: number): { text: string; level: ClockLevel; over: boolean } {
  const s = Number.isFinite(msLeft) ? Math.max(0, Math.floor(msLeft / 1000)) : 0;
  return {
    text: `${pad(Math.floor(s / HOUR_S))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`,
    level: s <= 24 * HOUR_S ? 'critical' : s <= 72 * HOUR_S ? 'heat' : 'calm',
    over: s === 0,
  };
}

/** 서버 시각과 기기 시계의 차이. 기기 시계가 틀려도 카운트다운은 서버 기준으로 흐른다. */
export function clockOffset(asOf: string, deviceNow: number) {
  const server = Date.parse(asOf);
  return Number.isFinite(server) ? server - deviceNow : 0;
}

/** 시작 시각부터 24시간 단위 일차(1..durationDays). */
export function sprintDay(startedAt: string, nowMs: number, durationDays: number) {
  const day = Math.floor((nowMs - Date.parse(startedAt)) / DAY_MS) + 1;
  return Math.min(durationDays, Math.max(1, day));
}

/** Day 칸 안에서 지금 위치(0~1). */
export function dayProgress(dayStart: string, nowMs: number) {
  return Math.min(1, Math.max(0, (nowMs - Date.parse(dayStart)) / DAY_MS));
}

export type View = 'home' | 'tasks' | 'project';
const VIEWS: Record<string, { view: View; mine: boolean }> = {
  home: { view: 'home', mine: false },
  tasks: { view: 'tasks', mine: false },
  project: { view: 'project', mine: false },
  // 2026-10-05 이전 메뉴 7개. 북마크·공유 링크를 새 메뉴로 연다.
  today: { view: 'home', mine: false },
  team: { view: 'home', mine: false },
  plan: { view: 'tasks', mine: false },
  ai: { view: 'tasks', mine: false },
  mine: { view: 'tasks', mine: true },
  docs: { view: 'project', mine: false },
  result: { view: 'project', mine: false },
};
/** ?view= 값을 새 메뉴로. 모르는 값은 홈. */
export function viewFrom(param: string | null) {
  return param && Object.hasOwn(VIEWS, param) ? VIEWS[param] : VIEWS.home;
}

/** 팀 레인: 그 사람이 지금 붙잡고 있는 업무. 진행 중 상태 우선, 없으면 완료·보류가 아닌 첫 업무. */
export function laneTask<T extends RaceTask>(tasks: T[], person: number): T | null {
  const open = tasks.filter((t) => t.person === person && !t.done && !t.deferred);
  return open.find((t) => t.status === 'in_progress') ?? open[0] ?? null;
}

/** 진행 보고에서 고를 수 있는 업무와 처음 고를 업무. 팀원은 자기 업무만, 팀장은 전체(자기 것 먼저). */
export function reportChoices<T extends RaceTask>(
  tasks: T[],
  me: { person: number },
  owner: boolean,
) {
  const open = tasks.filter((t) => !t.done && (owner || t.person === me.person));
  return { open, first: laneTask(open, me.person) ?? open[0] ?? null };
}
```

`web/package.json`의 `scripts.test` 문자열 끝(`tests/invite-email.test.mjs` 뒤)에 ` tests/race.test.ts`를 붙인다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd web && node --experimental-strip-types --test tests/race.test.ts`
Expected: PASS(테스트 13개). 이어서 `cd web && npm test`도 모두 PASS인지 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add web/lib/race.ts web/tests/race.test.ts web/package.json
git commit -m "feat: 작업 화면 레이스 표시용 순수 계산(카운트다운·병목·메뉴 주소)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 로컬 화면 확인 환경(PGlite + 개발 신원 프록시 + 시드)

로그인된 작업 화면을 브라우저로 확인하려면 이 환경이 필요하다. 운영 DB를 쓰지 않는다.

**Files:**
- Create: `web/scripts/dev-as.mjs`
- Create: `web/scripts/seed-ui.mjs`
- Modify: `.claude/launch.json`(구성 하나 추가)

**Interfaces:**
- Produces: 개발 서버 `http://127.0.0.1:3102`(PGlite `.data/pglite-ui`), 팀장 프록시 `http://127.0.0.1:3110`(사용자 `owner`, 이름 도윤), 팀원 프록시 `http://127.0.0.1:3111`(사용자 `mate`, 이름 서연), 시드 프로젝트 3개(진행 중 + 병목, 준비 중, 완주). 시드가 출력하는 `active=<projectId>` 줄로 주소 `/workspace?project=<id>`를 연다.

- [ ] **Step 1: 실행 구성 추가**

`.claude/launch.json`의 `configurations` 배열 끝에 추가한다. 빈 `DATABASE_URL`은 `.env.local`의 운영 DB 주소보다 우선한다(`@next/env`는 이미 설정된 값을 덮어쓰지 않는다. 2026-10-05에 확인함). 빈 `NEXT_PUBLIC_SUPABASE_*`이면 브라우저가 Bearer 토큰을 붙이지 않으므로, 서버가 개발 헤더(`.env.development`의 `AUTH_DEV_HEADERS=1`)로 신원을 읽는다.

```json
    {
      "name": "workspace-ui",
      "runtimeExecutable": "env",
      "runtimeArgs": [
        "DATABASE_URL=",
        "DATABASE_PATH=.data/pglite-ui",
        "NEXT_PUBLIC_SUPABASE_URL=",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
        "npm",
        "--prefix",
        "web",
        "run",
        "dev",
        "--",
        "--port",
        "3102"
      ],
      "port": 3102
    }
```

- [ ] **Step 2: 개발 신원 프록시 작성**

`web/scripts/dev-as.mjs`:

```js
// 로컬 화면 확인용. 브라우저 요청에 개발 신원 헤더를 붙여 next dev(AUTH_DEV_HEADERS=1)로 넘긴다.
// 운영(NODE_ENV=production)에서는 서버가 이 헤더를 무시한다(lib/auth.ts). Host·Origin은 그대로 둬 출처 검사를 통과한다.
// 사용: node scripts/dev-as.mjs <포트> <사용자 id> <표시 이름> [대상 포트=3102]
import http from 'node:http';

const [port = '3110', user = 'owner', name = '도윤', target = '3102'] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const headers = {
      ...req.headers,
      'oai-authenticated-user-id': user,
      'oai-authenticated-user-email': `${user}@test.local`,
      'oai-authenticated-user-full-name': encodeURIComponent(name),
      'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
    };
    const up = http.request(
      { host: '127.0.0.1', port: Number(target), path: req.url, method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
  })
  .listen(Number(port), '127.0.0.1', () =>
    console.log(`http://127.0.0.1:${port} → :${target} as ${user}(${name})`),
  );
```

- [ ] **Step 3: 시드 스크립트 작성**

`web/scripts/seed-ui.mjs`:

```js
// 로컬 화면 확인용 프로젝트 3개를 만든다: 진행 중(병목 1건·대기 1건), 준비 중, 완주.
// 개발 서버(AUTH_DEV_HEADERS=1, PGlite)에 직접 요청한다. 운영 DB에 쓰지 않도록 대상은 127.0.0.1만 받는다.
// 사용: node scripts/seed-ui.mjs [대상 포트=3102]
const port = process.argv[2] ?? '3102';
const base = `http://127.0.0.1:${port}`;
const who = (user, name) => ({
  'content-type': 'application/json',
  'oai-authenticated-user-id': user,
  'oai-authenticated-user-email': `${user}@test.local`,
  'oai-authenticated-user-full-name': encodeURIComponent(name),
  'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
});
const OWNER = who('owner', '도윤');
const MATE = who('mate', '서연');

async function call(path, headers, body) {
  const r = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path} ${body?.action ?? 'GET'} → ${r.status} ${data.error ?? ''}`);
  return data;
}
const read = (headers, id) => call('/api/sprint?project=' + encodeURIComponent(id), headers);
const act = (headers, state, action, fields = {}) =>
  call('/api/sprint', headers, { action, projectId: state.projectId, revision: state.sprint.revision, ...fields });

async function team(title) {
  const { projectId } = await call('/api/projects', OWNER, {
    action: 'create',
    title,
    goal: '공고문을 실행 계획으로 바꾸는 서비스를 출시한다',
    scope: '공고 붙여넣기, 마감일 추출, 결과 화면',
    completionCriteria: '핵심 흐름을 실제로 실행해 보인다',
    deliverables: '동작하는 서비스\n3분 데모 영상',
    duration: 7,
    agreed: true,
  });
  let state = await read(OWNER, projectId);
  const { token } = await call('/api/projects', OWNER, {
    action: 'invite',
    projectId,
    revision: state.sprint.revision,
    email: 'mate@test.local',
  });
  await call('/api/projects', MATE, { action: 'accept', token, agreed: true, goalVersion: state.policy.goalVersion });
  return read(OWNER, projectId);
}

const draft = await team('준비 중 스프린트');

let active = await act(OWNER, await team('취준 포트폴리오 스프린트'), 'start');
const lead = active.me.person;
const mate = active.members.find((m) => m.person !== lead).person;
const day = (n) => new Date(Date.parse(active.policy.startedAt) + n * 86400000).toISOString();
active = await act(OWNER, active, 'createTask', { title: '요구사항 정리', person: lead, remaining: 3, dependsOn: [], dueAt: day(1) });
active = await act(OWNER, active, 'createTask', { title: '메인 화면 시안', person: lead, remaining: 200, dependsOn: [], dueAt: day(4) });
active = await act(OWNER, active, 'createTask', { title: '로그인 API 연동', person: mate, remaining: 6, dependsOn: [2], dueAt: day(5) });
active = await act(OWNER, active, 'createTask', { title: '발표 자료 초안', person: mate, remaining: 5, dependsOn: [], dueAt: day(6) });
active = await act(OWNER, active, 'checkin', { taskId: 1, remaining: 1, note: '요구사항 초안 공유함' });

let done = await act(OWNER, await team('완주한 스프린트'), 'start');
for (const d of done.deliverables) {
  done = await act(OWNER, done, 'deliverableEvidence', { deliverableId: d.deliverableId, evidence: '저장소 링크와 실행 방법 정리' });
  done = await act(OWNER, done, 'deliverableConfirm', { deliverableId: d.deliverableId, confirmed: true });
}
done = await act(OWNER, done, 'finish');

console.log(`active=${active.projectId}\ndraft=${draft.projectId}\ncompleted=${done.projectId}`);
```

- [ ] **Step 4: DB 준비, 서버 실행, 시드 실행**

Run(서버를 띄우기 전에 실행한다. PGlite는 두 프로세스가 같은 파일을 동시에 쓰지 못한다):

```bash
cd web && DATABASE_URL= DATABASE_PATH=.data/pglite-ui npm run db:migrate
```

Expected: 적용한 migration 파일 이름이 출력되거나, 이미 적용돼 아무것도 없다는 출력.

그다음 `preview_start {name: "workspace-ui"}`로 서버를 띄운다. 이어서 아래를 실행한다.

```bash
cd web && node scripts/seed-ui.mjs 3102
```

Expected: `active=…`, `draft=…`, `completed=…` 세 줄이 출력된다. 출력값을 기록해 둔다.

실패하면 오류 메시지의 action 이름과 서버 메시지를 보고 고친다. 시드 요청 형식은 `tests/api.test.mjs`의 `draftTeam`·`startedTeam`과 같다. 마감(`dueAt`)이 거절되면 `dueAt`을 빼고 다시 실행한다.

- [ ] **Step 5: 프록시로 로그인된 화면 확인**

Run(각각 백그라운드로 실행):
```bash
cd web && node scripts/dev-as.mjs 3110 owner 도윤 3102
```
```bash
cd web && node scripts/dev-as.mjs 3111 mate 서연 3102
```

브라우저로 `http://127.0.0.1:3110/workspace?project=<active id>`를 연다. Expected: 지금(재설계 전) 작업 화면에 '취준 포트폴리오 스프린트'가 보인다. 메인 화면 시안은 200h라서 '계획 조정 필요'로 표시된다.

`/_next` 자원이 cross-origin으로 막혀 화면이 비면, `preview_logs`에서 `allowedDevOrigins` 경고를 확인한다. 그 경우 `web/next.config.ts`에 `allowedDevOrigins: ['127.0.0.1']`를 추가한다. 이 설정은 개발 서버에만 적용된다.

- [ ] **Step 6: 커밋**

```bash
git add .claude/launch.json web/scripts/dev-as.mjs web/scripts/seed-ui.mjs
git commit -m "chore: 로컬 PGlite로 로그인된 작업 화면을 확인하는 프록시·시드

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`next.config.ts`를 고쳤다면 같이 add한다.)

---

### Task 3: 테마(색 변수, 다크 기본, 전환 버튼)

**Files:**
- Modify: `web/app/layout.tsx`
- Modify: `web/app/globals.css:27-79`(변수 블록), 그리고 아래 표의 줄들
- Create: `web/components/theme-toggle.tsx`
- Modify: `web/components/project-workspace.tsx:301-311`(SidebarFooter)

**Interfaces:**
- Produces: CSS 변수 `--gray-0..900`, `--heat-50..900`, `--heat-ink`, `--red-50/500/700`, `--good`. 이후 Task의 CSS는 이 이름만 쓴다. `--green-*`, `--orange-*`, `--lime`은 이 Task가 끝나면 없다.
- Produces: `<ThemeToggle />`(props 없음)

- [ ] **Step 1: 그리기 전 테마 스크립트**

먼저 `node_modules/next/dist/docs/`에서 root layout의 `<head>`와 인라인 `<script>` 사용법을 찾아 아래 방식이 허용되는지 확인한다. 허용되지 않으면 문서가 권하는 방식(예: `next/script`의 `beforeInteractive`)으로 같은 스크립트를 넣는다.

`web/app/layout.tsx`의 `RootLayout`의 반환값을 다음처럼 바꾼다.

```tsx
// 그리기 전에 테마를 정해 깜빡임을 막는다. 저장값이 'light'일 때만 라이트, 읽기 실패도 다크.
const THEME_SCRIPT =
  "try{if(localStorage.getItem('pm-theme')!=='light')document.documentElement.classList.add('dark')}catch(e){document.documentElement.classList.add('dark')}";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 2: 색 변수 블록 교체**

`web/app/globals.css`에서 `:root {`(27행)부터 `.dark { … }` 블록 끝(79행)까지를 아래로 바꾼다.

```css
:root {
  /* 색 단계: 차가운 무채색 + heat 주황 강조 + 위험 빨강 + 완료 초록. 새 색은 여기서 고른다.
     .dark는 같은 이름의 단계를 뒤집어 정의하고, 의미 변수는 단계를 가리키기만 한다. */
  --gray-0: #ffffff;
  --gray-25: #fafafa;
  --gray-50: #f6f6f4;
  --gray-100: #efefec;
  --gray-200: #e2e2de;
  --gray-300: #d0d0cb;
  --gray-400: #a8a8a1;
  --gray-500: #8a8a84;
  --gray-600: #6f6f69;
  --gray-700: #55554f;
  --gray-800: #2e2e2b;
  --gray-900: #121212;
  --heat-50: #fff3ec;
  --heat-100: #ffe1d1;
  --heat-300: #ff9b6e;
  --heat-400: #ff7a45;
  --heat-500: #ff5a1f;
  --heat-600: #e0480f;
  --heat-700: #b33a0a;
  --heat-800: #8a2c06;
  --heat-900: #5c1d03;
  --heat-ink: #0b0b0c;
  --red-50: #fff0ee;
  --red-500: #e5281b;
  --red-700: #b3200f;
  --good: #1f8a4c;
  --background: var(--gray-0);
  --foreground: var(--gray-900);
  --ink: var(--gray-900);
  --primary: var(--heat-500);
  --primary-foreground: var(--heat-ink);
  --muted: var(--gray-100);
  --muted-foreground: var(--gray-600);
  --border: var(--gray-200);
  --sidebar: var(--gray-50);
  --sidebar-foreground: var(--gray-800);
  --sidebar-accent: var(--gray-100);
  --sidebar-accent-foreground: var(--gray-900);
  --sidebar-border: var(--gray-200);
  --font-sans: Arial, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
}
.dark {
  --gray-0: #0b0b0c;
  --gray-25: #0f0f11;
  --gray-50: #141416;
  --gray-100: #1c1c1f;
  --gray-200: #26262a;
  --gray-300: #34343a;
  --gray-400: #55534e;
  --gray-500: #77746d;
  --gray-600: #9a978f;
  --gray-700: #bdbab3;
  --gray-800: #dedbd4;
  --gray-900: #f4f2ee;
  --heat-50: #2b1a12;
  --heat-100: #3a2015;
  --heat-300: #c2522a;
  --heat-400: #ff7038;
  --heat-500: #ff5a1f;
  --heat-600: #ff7a45;
  --heat-700: #ff8a5c;
  --heat-800: #ffb08f;
  --heat-900: #ffd9c7;
  --red-50: #2a1111;
  --red-500: #ff3b30;
  --red-700: #ff6b61;
  --good: #3ddc84;
  color-scheme: dark;
}
```

같은 파일 `@theme inline` 블록(5~26행)의 `--radius-lg: 12px;`는 `6px`로, `--radius-md: 8px;`는 `4px`로 바꾼다.

- [ ] **Step 3: 옛 변수 이름 일괄 변경**

Run:
```bash
cd web && sed -i '' -E 's/var\(--green-(50|100|300|400|500|600|700|800|900)\)/var(--heat-\1)/g; s/var\(--orange-(50|100)\)/var(--heat-\1)/g; s/var\(--orange-200\)/var(--heat-100)/g; s/var\(--orange-(600|700)\)/var(--heat-700)/g; s/var\(--lime\)/var(--heat-500)/g' app/globals.css
grep -nE "var\(--(green|orange|lime)" app/globals.css
```
Expected: grep 출력 없음.

- [ ] **Step 4: 주황 바탕 위 글자색, 진한 버튼 고치기**

Step 3이 끝난 뒤 아래 선택자를 열어 값을 바꾼다. 줄 번호는 Step 2 때문에 밀렸을 수 있으니 선택자 이름으로 찾는다.

| 선택자 | 바꿀 것 |
|---|---|
| `.brand-icon` | `background: var(--heat-500);` 아래에 `color: var(--heat-ink);` 추가 |
| `.btn.primary` | `color: var(--heat-900);` → `color: var(--heat-ink);` |
| `.btn.primary:hover:not(:disabled)` | `background: var(--heat-300);` → `background: var(--heat-400);` |
| `.btn.dark` | `background: var(--heat-900); color: white;` → `background: var(--gray-900); color: var(--gray-0);` |
| `.btn.dark:hover:not(:disabled)` | `background: var(--heat-800);` → `background: var(--gray-800);` |
| `.agent-mark` | `background: var(--heat-900);` → `background: var(--heat-500);`, 다음 줄 `color: #d0f398;` → `color: var(--heat-ink);` |
| `.criteria-check.ok` | `background: var(--heat-500);` 아래에 `color: var(--heat-ink);` 추가 |
| `.workspace-brand > span` | `background: var(--heat-500);` 아래에 `color: var(--heat-ink);` 추가 |
| `.deadline-card.final` | `color: var(--ink);` → `color: var(--heat-ink);` |

- [ ] **Step 5: 직접 적힌 색을 변수로**

`grep -nE "#[0-9a-fA-F]{3,8}([^0-9a-zA-Z]|$)|\bwhite\b" app/globals.css`로 줄을 찾아 아래처럼 바꾼다. 맨 위 변수 블록 안의 값과 `white-space`는 건드리지 않는다.

| 지금 값(선택자) | 바꿀 값 |
|---|---|
| `outline: 3px solid #6f9746` (focus-visible) | `var(--heat-500)` |
| `color: #c3c7bf` | `var(--gray-400)` |
| `background: #dedaff` (`.avatar`) | `var(--gray-200)` |
| `background: #34492b` (`.nav-tabs … :after`) | `var(--heat-500)` |
| `color: #4d642e` | `var(--heat-700)` |
| `border-color: #e9d1a9` | `var(--heat-100)` |
| `color: #465739`, `#596a48` | `var(--gray-700)` |
| `color: #83a45e` | `var(--heat-600)` |
| `color: #748469`, `#778368`, `#6e7e5d`, `#6d7a5e` | `var(--gray-600)` |
| `border … #cddcb9`, `#cdd8bf` | `var(--gray-300)` |
| `color: #354824`, `#313d28` | `var(--gray-800)` |
| `color: #7c9263` | `var(--gray-500)` |
| `.error-notice` `border … #d49b76` / `color: #8a3f15` | `var(--red-500)` / `var(--red-700)` |
| `.workspace-shell`의 `--sidebar-*` 6줄 | 6줄 모두 삭제(맨 위 변수 블록이 정의함) |
| `.status-select.status-in_progress` `#e8eef9` / `#426590` | `var(--heat-50)` / `var(--heat-700)` |
| `.status-select.status-done` `color: #4c723e` | `var(--good)` |
| `.schedule-warning` `#b17c31` | `var(--red-700)` |
| `.replay-banner` `#d9c38f` / `#7a5a1c` | `var(--heat-100)` / `var(--heat-700)` |
| `.status-dot.status-in_progress` `#7b9dce` | `var(--heat-500)` |
| `.status-dot.status-done` `#84a660` | `var(--good)` |
| `.status-dot.status-deferred` `#c8a16f` | `var(--gray-400)` |
| `box-shadow: 0 1px 2px #27311808` | `0 1px 2px rgb(0 0 0 / 0.04)` |
| `color: #886522` | `var(--heat-700)` |
| `background: white`(전부) | `var(--gray-0)` |

`page.tsx`의 아바타 인라인 배경 `'#eee'` 3곳은 `'var(--gray-200)'`로 바꾼다.

이어서 모서리를 줄인다.
```bash
cd web && sed -i '' -E 's/border-radius: (12|10)px/border-radius: 6px/; s/border-radius: 8px/border-radius: 4px/; s/border-radius: (16|18)px/border-radius: 8px/' app/globals.css
```

Expected: `grep -nE "#[0-9a-fA-F]{6}" app/globals.css`의 결과가 변수 블록(대략 27~110행) 안에만 있다.

- [ ] **Step 6: 전환 버튼**

`web/components/theme-toggle.tsx`:

```tsx
'use client';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

// 다크가 기본. 값은 이 브라우저에만 기억한다(서버에 저장하지 않음). 저장소가 막혀도 전환은 된다.
export function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('pm-theme', next ? 'dark' : 'light');
    } catch {
      /* 시크릿 창 등: 이번 화면에만 적용 */
    }
    setDark(next);
  }
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'}
      title={dark ? '라이트 모드' : '다크 모드'}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
```

`web/components/project-workspace.tsx`의 `SidebarFooter` 안을 다음처럼 바꾼다(`sidebar-note`는 그대로 둔다).

```tsx
        <SidebarFooter>
          <div className="sidebar-actions">
            <WorkspaceButton onClick={() => void signOut()}>
              <LogOut size={16} />
              로그아웃
            </WorkspaceButton>
            <ThemeToggle />
          </div>
          <p className="sidebar-note">
            작게 시작하고, 함께 완성하기.
            <br />
            7일 스프린트
          </p>
        </SidebarFooter>
```

import에 `import { ThemeToggle } from '@/components/theme-toggle';`를 추가하고, `globals.css` 끝에 다음을 추가한다.

```css
.sidebar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
```

- [ ] **Step 7: 확인**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: 모두 통과.

브라우저(`http://127.0.0.1:3110/workspace?project=<active id>`)에서 확인한다.
- 처음 열면 다크다. `javascript_tool`로 `document.documentElement.className`에 `dark`가 있는지 본다.
- 테마 버튼을 누르면 라이트로 바뀌고, 새로고침해도 라이트가 유지된다.
- 다시 눌러 다크로 돌린다.
- 랜딩(`http://127.0.0.1:3102/`) 첫 화면이 Task 시작 전과 같아 보인다. 다크 클래스가 붙어도 `.rl`은 자체 색을 쓴다.

다크와 라이트 각각 화면 사진을 찍는다.

- [ ] **Step 8: 커밋**

```bash
git add web/app/layout.tsx web/app/globals.css web/components/theme-toggle.tsx web/components/project-workspace.tsx web/app/workspace/page.tsx
git commit -m "feat: 작업 화면 다크 기본 테마와 라이트 전환, heat 주황 색 체계

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 메뉴 3개와 주소 변환, 프로젝트 선택 드롭다운

이 Task가 끝나면 메뉴는 홈·업무·프로젝트다. 홈에는 아직 기존 '스프린트 현황' 내용이 그대로 있다. 홈 화면은 Task 6에서 새로 짠다.

**Files:**
- Modify: `web/components/project-workspace.tsx`
- Modify: `web/app/workspace/page.tsx`
- Modify: `web/tests/meeting-panel.test.mjs`
- Modify: `web/app/globals.css`(끝에 추가)

**Interfaces:**
- Consumes: `viewFrom`, `type View`(Task 1)
- Produces: `export type WorkspaceNav = { view: View; setView: (v: View) => void; mine: boolean; setMine: (m: boolean) => void }`, `ProjectWorkspace`의 `children: (id: string, nav: WorkspaceNav) => ReactNode`

- [ ] **Step 1: 테스트를 새 메뉴 기준으로 바꾼다(실패 확인용)**

`web/tests/meeting-panel.test.mjs`에서 바꾼다.
- `"tab === 'today'"` 두 곳 → `"tab === 'home'"`. 메시지도 `today` → `home`으로 바꾼다.
- 두 번째 test 이름 → `'workspaceViews 메뉴는 홈·업무·프로젝트 3개다'`
- `assert.deepEqual(ids, [...])` → `assert.deepEqual(ids, ['home', 'tasks', 'project']);`

Run: `cd web && node --test tests/meeting-panel.test.mjs`
Expected: FAIL(아직 7개 id와 `tab === 'today'`)

- [ ] **Step 2: `project-workspace.tsx` 메뉴와 상태**

import 줄을 정리한다. lucide에서 `Plus`, `UserRound`, `Users`, `ChartNoAxesCombined`, `Flag`, `Folder`, `Sparkles`를 빼고 `Gauge`를 넣는다. 추가할 import는 다음과 같다.

```tsx
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { viewFrom, type View } from '@/lib/race';
```

`workspaceViews`를 바꾼다.

```tsx
export const workspaceViews: { id: View; label: string; icon: typeof Gauge }[] = [
  { id: 'home', label: '홈', icon: Gauge },
  { id: 'tasks', label: '업무', icon: ListTodo },
  { id: 'project', label: '프로젝트', icon: FileText },
];
export type WorkspaceNav = {
  view: View;
  setView: (view: View) => void;
  mine: boolean;
  setMine: (mine: boolean) => void;
};
```

`WorkspaceNav` 함수 컴포넌트는 이름이 타입과 겹치므로 `WorkspaceMenu`로 바꾼다(정의 한 곳, 사용 한 곳). props 타입의 `view: string`은 `view: View`로, `onChange: (view: string) => void`는 `onChange: (view: View) => void`로 바꾼다.

같은 파일에 프로젝트 선택 컴포넌트를 추가한다(`WorkspaceButton` 아래).

```tsx
// 프로젝트 목록과 새 프로젝트를 한 곳에. 모바일에서는 고른 뒤 사이드바를 닫는다.
function ProjectSwitcher({
  projects,
  value,
  onSelect,
  onCreate,
}: {
  projects: { id: string; title: string }[];
  value: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <NativeSelect
      aria-label="프로젝트 선택"
      className="project-switcher"
      value={value}
      onChange={(e) => {
        if (e.target.value === '__new') onCreate();
        else onSelect(e.target.value);
        setOpenMobile(false);
      }}
    >
      {!value && (
        <NativeSelectOption value="" disabled>
          프로젝트 선택
        </NativeSelectOption>
      )}
      {projects.map((p) => (
        <NativeSelectOption key={p.id} value={p.id}>
          {p.title}
        </NativeSelectOption>
      ))}
      <NativeSelectOption value="__new">+ 새 프로젝트</NativeSelectOption>
    </NativeSelect>
  );
}
```

`ProjectWorkspace`를 바꾼다.
- `children` 타입: `children: (id: string, nav: WorkspaceNav) => ReactNode;`
- 상태: `const [view, setView] = useState<View>('home');` 아래에 `const [mine, setMine] = useState(false);`를 둔다.
- 첫 effect 안의 `if (workspaceViews.some(...)) setView(params.get('view')!);` 두 줄을 아래로 바꾼다.
  ```tsx
        const start = viewFrom(params.get('view'));
        setView(start.view);
        setMine(start.mine);
  ```
- `SidebarHeader`의 `WorkspaceButton className="workspace-new"`(새 프로젝트 버튼) 전체를 아래로 바꾼다.
  ```tsx
          <ProjectSwitcher
            projects={projects}
            value={creating ? '__new' : selected}
            onCreate={() => setCreating(true)}
            onSelect={(id) => {
              setSelected(id);
              setCreating(false);
              setView('home');
              setMine(false);
              history.replaceState(null, '', '/workspace?project=' + encodeURIComponent(id));
            }}
          />
  ```
- `SidebarContent`에서 '프로젝트' `SidebarGroup`(프로젝트 목록) 전체를 지운다. '작업 공간' 그룹의 라벨은 `메뉴`로 바꾸고 `<WorkspaceMenu …>`를 쓴다.
- `.workspace-bar` 헤더는 프로젝트 화면이 아닐 때만 보인다. 프로젝트 화면에서는 Dashboard의 레이스 바(Task 5)가 사이드바 버튼을 갖는다. 아래처럼 감싼다.
  ```tsx
        {!(selected && !creating && !invite) && (
          <header className="workspace-bar">
            <SidebarTrigger aria-label="사이드바 열기 또는 닫기" />
            <b>{creating ? '새 프로젝트' : '프로젝트'}</b>
          </header>
        )}
  ```
- `children(selected, view, setView)` → `children(selected, { view, setView, mine, setMine })`
- `ProjectDetails`의 안내 문구 `' 등록하고, 오른쪽 위 초대하기에서 팀원을 초대해주세요.'` → `' 등록하고, 아래 팀원 구역에서 팀원을 초대해주세요.'`. `'실행 계획에서'` → `'업무 메뉴에서'`.
- `TeamInvites` 위 주석 → `// 팀장 전용 초대 관리. 프로젝트 메뉴의 팀원 구역에 그대로 둔다.`

- [ ] **Step 3: `page.tsx`를 새 메뉴에 연결**

1. `Home`:
   ```tsx
   export default function Home() {
     return (
       <ProjectWorkspace>
         {(id, nav) => <Dashboard key={id} projectId={id} nav={nav} />}
       </ProjectWorkspace>
     );
   }
   ```
2. `Dashboard`의 props를 `{ projectId, nav }: { projectId: string; nav: WorkspaceNav }`로 바꾼다. 맨 위에 `const { view: tab, setView: setTab, mine, setMine } = nav;`와 `const [reviewing, setReviewing] = useState(false);`를 둔다. `WorkspaceNav`는 `@/components/project-workspace`에서 type import한다.
3. modelContext 도구의 `execute`: `setTab(input.view as View);`(`View`는 `@/lib/race`에서 type import)
4. 모든 `setTab('plan')` → `setTab('tasks')`, `setTab('today')` → `setTab('home')`.
5. `{tab === 'today' && (` → `{tab === 'home' && (`
6. `{(tab === 'plan' || tab === 'mine') && plan && (` 블록을 아래로 바꾼다. 안쪽 `TaskCollection`과 `details.workspace-history`는 그대로 두고, `mine={tab === 'mine'}`는 `mine={mine}`로 바꾼다.
   ```tsx
            {tab === 'tasks' && plan && (
              <section>
                <div className="tasks-bar">
                  <span
                    className={`status-dot ${plan.feasible ? 'status-done' : 'status-in_progress'}`}
                  />
                  <span className="tasks-health">
                    {!tasks.length
                      ? '업무와 담당자를 등록해 계획을 시작하세요.'
                      : plan.feasible
                        ? `마감 내 배치 가능 · 남은 ${plan.needed}h / 예산 ${Math.round(plan.available * 10) / 10}h`
                        : `${plan.unscheduled.length}개 업무 배치 불가 · 담당 재배정과 선행 작업을 확인해주세요.`}
                  </span>
                  <button
                    className="btn toggle-btn"
                    aria-pressed={mine}
                    onClick={() => setMine(!mine)}
                  >
                    내 것만
                  </button>
                  <button className="btn" onClick={() => setReviewing(!reviewing)}>
                    {reviewing ? '업무 목록으로' : '회의록으로 변경안 만들기'}
                  </button>
                </div>
                {reviewing ? (
                  <ChangeReview
                    projectId={projectId}
                    revision={s.revision}
                    tasks={s.tasks}
                    members={state!.members}
                    me={state!.me}
                    writable={writable && agreedToGoal && !state!.me.leftAt}
                    onApplied={(next) => setState(next as State)}
                  />
                ) : (
                  <TaskCollection /* 기존 props 그대로, mine={mine} */ />
                )}
                <details className="workspace-history">{/* 기존 그대로 */}</details>
              </section>
            )}
   ```
   (`TaskCollection`과 `details` 블록은 실제 코드에서 기존 JSX를 그대로 옮긴다. 위 주석은 계획서 표기일 뿐이다.)
7. `{tab === 'ai' && ( <ChangeReview … /> )}` 블록을 지운다(6에 들어감).
8. `{tab === 'docs' && <ProjectDetails state={state!} />}`, `{tab === 'team' && (…)}`, `{tab === 'result' && (…)}` 세 블록을 지우고 프로젝트 화면 하나로 합친다. 팀원 목록, 참여 중단 버튼, 결과물(`refund-grid`) JSX는 기존 코드를 그대로 옮긴다.
   ```tsx
            {tab === 'project' && (
              <section className="work-section project-stack">
                <ProjectDetails state={state!} />
                <section className="project-block">
                  <div className="section-heading">
                    <h2>팀원 · {state!.members.length}/4명</h2>
                  </div>
                  <div className="team-card">{/* 기존 team 탭 '팀 상태'의 members.map + team-note 그대로 */}</div>
                  <TeamInvites
                    state={state!}
                    refresh={load}
                    link={inviteLink}
                    setLink={setInviteLink}
                    writable={writable}
                  />
                </section>
                <section className="project-block">
                  <div className="section-heading">
                    <h2>
                      완주 확인 · 결과물 {state!.completion.confirmed}/{state!.completion.total}
                    </h2>
                  </div>
                  {/* 기존 result 탭의 <div className="refund-grid">…</div> 그대로 */}
                </section>
                <section className="project-block">
                  <div className="section-heading">
                    <h2>기타</h2>
                  </div>
                  <div className="project-actions">
                    <button className="btn" disabled={busy} onClick={exportProject}>
                      내보내기
                    </button>
                    {/* 기존 team 탭의 '참여 중단 보고' 버튼(조건 포함) 그대로 */}
                  </div>
                </section>
              </section>
            )}
   ```
   기존 team 탭의 `people-grid`(공통 공수 계산)와 '공통 공수 계산' 제목·hint는 옮기지 않는다. 8시간 가정 안내는 Task 6의 팀 레인 아래로 간다.
9. 초대 대화상자를 지운다. `type Modal`에서 `'invite'`를 빼고, `DialogTitle`·`DialogDescription`의 `dialog === 'invite'` 분기와 `dialog === 'invite' && state ? (<TeamInvites …/>)` 분기를 지운다. 헤더의 '초대하기' 버튼도 지운다.
10. 시작 준비 패널: `{lifecycle === 'draft' && state!.readiness && (` → `{tab === 'home' && lifecycle === 'draft' && state!.readiness && (`
11. 회의 제안 안내 문구 `'회의 후 회의록을 변경안 검토에 붙여넣으면 업무 변경안을 만들 수 있습니다.'` → `'회의 후 업무 메뉴의 \'회의록으로 변경안 만들기\'에 회의록을 붙여넣으면 업무 변경안을 만들 수 있습니다.'`
12. 헤더(`work-heading`) 안의 `h1` 텍스트: `workspaceViews.find((v) => v.id === tab)?.label ?? '프로젝트 업무'` → `?? '홈'`(헤더 전체는 Task 5에서 바꾼다).

`globals.css` 끝에 추가한다.

```css
.project-switcher {
  width: 100%;
  margin-bottom: 8px;
}
.tasks-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  color: var(--gray-700);
}
.tasks-health {
  flex: 1 1 260px;
  min-width: 0;
}
.toggle-btn[aria-pressed='true'] {
  background: var(--gray-900);
  color: var(--gray-0);
}
.project-stack {
  display: grid;
  gap: 32px;
}
.project-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

- [ ] **Step 4: 테스트·타입·린트**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: 모두 통과. `meeting-panel.test.mjs`도 PASS.

- [ ] **Step 5: 브라우저 확인**

팀장 프록시(3110)로 확인한다.
- 사이드바 메뉴가 홈·업무·프로젝트 3개다.
- `?view=mine`으로 열면 업무 메뉴에서 '내 것만'이 눌린 상태다. `?view=ai`, `?view=docs`, `?view=xyz`도 각각 업무·프로젝트·홈으로 열린다.
- 업무에서 '회의록으로 변경안 만들기'를 누르면 변경안 검토가 열리고, '업무 목록으로'를 누르면 목록으로 돌아온다.
- 프로젝트 화면에 목표, 팀원, 초대 폼, 완주 확인, 내보내기, 참여 중단이 다 있다.
- 프로젝트 드롭다운으로 준비 중 프로젝트를 고르면 그 프로젝트의 홈이 열린다. '+ 새 프로젝트'를 고르면 만들기 폼이 열린다.

팀원 프록시(3111)에서는 프로젝트 화면에 초대 폼이 없다.

- [ ] **Step 6: 커밋**

```bash
git add web/components/project-workspace.tsx web/app/workspace/page.tsx web/tests/meeting-panel.test.mjs web/app/globals.css
git commit -m "feat: 작업 화면 메뉴를 홈·업무·프로젝트 3개로 줄이고 예전 주소를 새 메뉴로 연결

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 상단 레이스 바(카운트다운 + 진행 보고)

**Files:**
- Create: `web/hooks/use-server-now.ts`
- Create: `web/components/race-clock.tsx`
- Modify: `web/app/workspace/page.tsx`(헤더, `openCheckin`, 진행 보고 대화상자 문구)
- Modify: `web/app/globals.css`(끝에 추가, `.work-main` 여백 변수)

**Interfaces:**
- Consumes: `countdown`, `clockOffset`, `sprintDay`, `reportChoices`(Task 1)
- Produces: `useServerNow(asOf: string | null): number`(asOf가 null이면 0), `<RaceClock lifecycle deadline asOf durationDays onZero />`

- [ ] **Step 1: 서버 시각 훅**

`web/hooks/use-server-now.ts`:

```ts
import { useEffect, useState } from 'react';
import { clockOffset } from '@/lib/race';

/** 서버가 준 asOf를 기준으로 1초마다 흐르는 현재 시각(ms). asOf가 바뀌면(재조회) 다시 맞춘다. null이면 멈춘 0. */
export function useServerNow(asOf: string | null) {
  const [now, setNow] = useState(() => (asOf ? Date.parse(asOf) : 0));
  useEffect(() => {
    if (!asOf) return;
    const offset = clockOffset(asOf, Date.now());
    const tick = () => setNow(Date.now() + offset);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [asOf]);
  return asOf ? now : 0;
}
```

- [ ] **Step 2: 카운트다운 컴포넌트**

`web/components/race-clock.tsx`:

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { useServerNow } from '@/hooks/use-server-now';
import { countdown } from '@/lib/race';
import type { Lifecycle } from '@/lib/sprint-policy';

// 남은 시간. 0이 돼도 화면이 스스로 종료를 판정하지 않고 onZero(재조회)를 한 번만 부른다.
export function RaceClock({
  lifecycle,
  deadline,
  asOf,
  durationDays,
  onZero,
}: {
  lifecycle: Lifecycle;
  deadline: string | null;
  asOf: string;
  durationDays: number;
  onZero: () => void;
}) {
  const running = lifecycle === 'active' && !!deadline;
  const now = useServerNow(running ? asOf : null);
  const left = running && now ? Date.parse(deadline!) - now : Number.NaN;
  const fired = useRef(false);
  useEffect(() => {
    if (running && left <= 0 && !fired.current) {
      fired.current = true;
      onZero();
    }
  }, [running, left, onZero]);
  if (lifecycle === 'draft')
    return <span className="race-clock idle">{durationDays}일 · 시작 전</span>;
  if (lifecycle === 'completed') return <span className="race-clock done">완주</span>;
  if (lifecycle === 'expired')
    return <span className="race-clock critical">00:00:00 · 기한 종료</span>;
  if (!running || !now) return null;
  const c = countdown(left);
  return (
    <span role="timer" aria-label={`남은 시간 ${c.text}`} className={`race-clock ${c.level}`}>
      {c.text}
    </span>
  );
}
```

- [ ] **Step 3: `page.tsx` 헤더 교체**

import를 추가한다.

```tsx
import { SidebarTrigger } from '@/components/ui/sidebar';
import { RaceClock } from '@/components/race-clock';
import { reportChoices, sprintDay } from '@/lib/race';
```

lucide import에서 `RefreshCw`를 지운다(헤더에서만 썼다).

`remainingHours`, `remainingDays` 계산 두 개를 지운다. `phase` 정의 아래에 다음을 둔다.

```tsx
  const reportable = state
    ? reportChoices(tasks, state.me, isOwner)
    : { open: [] as Task[], first: null };
  const onClockZero = useCallback(() => {
    void load().catch(() => {});
  }, [load]);
```

주의: `onClockZero`는 hook이다. 컴포넌트 안에서 조건 없이 호출되는 위치(`phase` 정의 바로 아래, `return` 전)에 둔다. `useCallback`은 이미 import돼 있다.

`openCheckin`을 바꾼다.

```tsx
  function openCheckin() {
    const t = reportable.first;
    if (!t) {
      setNotice('본인에게 배정된 진행 중인 업무가 없습니다.');
      return;
    }
    setTaskId(t.id);
    setRemaining(t.remaining);
    setNote('');
    setDialog('checkin');
  }
```

`<header className="work-heading">…</header>` 전체를 바꾼다.

```tsx
            <header className="race-bar">
              <SidebarTrigger aria-label="사이드바 열기 또는 닫기" />
              <div className="race-title">
                <b>{state!.agreement?.title ?? s.title}</b>
                <span>
                  {lifecycle === 'active' && state!.policy?.startedAt
                    ? `DAY ${sprintDay(state!.policy.startedAt, Date.parse(state!.asOf), state!.policy.durationDays)} / ${state!.policy.durationDays} · `
                    : ''}
                  {phase.label}
                </span>
              </div>
              <RaceClock
                lifecycle={lifecycle}
                deadline={deadline}
                asOf={state!.asOf}
                durationDays={state!.policy?.durationDays ?? 7}
                onZero={onClockZero}
              />
              {writable && agreedToGoal && (
                <button
                  className="race-cta"
                  disabled={busy}
                  aria-disabled={!reportable.open.length}
                  onClick={openCheckin}
                >
                  진행 보고
                </button>
              )}
            </header>
```

진행 보고 대화상자의 문구를 바꾼다.
- 제목 `'지금 남은 일을 알려주세요.'` → `'진행 보고'`
- 설명은 그대로 둔다.
- 업무 선택 `NativeSelect`의 옵션 목록 `tasks.filter((t) => !t.done && (isOwner || t.person === state?.me.person))` → `reportable.open`
- `mutate('checkin', …, '체크인을 저장하고 예상 일정을 재계산했습니다.')` → 메시지 `'진행 보고를 저장하고 예상 일정을 재계산했습니다.'`
- 라벨 `진행 중인 업무` → `보고할 업무`

- [ ] **Step 4: 스타일**

`globals.css`에서 `.workspace-body .app-shell > .work-main` 규칙의 `padding: 30px 36px;`를 다음으로 바꾼다.

```css
  --pad-y: 30px;
  --pad-x: 36px;
  padding: var(--pad-y) var(--pad-x);
```

`@media (max-width: 1000px)`와 `@media (max-width: 600px)` 안의 같은 선택자 `padding`도 각각 `--pad-y: 24px; --pad-x: 20px;`와 `--pad-y: 20px; --pad-x: 14px;`로 바꾼다(`padding` 줄은 지운다).

파일 끝에 추가한다.

```css
/* 레이스 작업 화면. 라이트에서는 상단 바만 검정, 다크에서는 바탕과 같은 톤. */
.race-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 14px;
  margin: calc(-1 * var(--pad-y)) calc(-1 * var(--pad-x)) 24px;
  padding: 12px var(--pad-x);
  background: var(--gray-900);
  color: var(--gray-0);
}
.dark .race-bar {
  background: var(--gray-0);
  color: var(--gray-900);
  border-bottom: 1px solid var(--border);
}
.race-title {
  flex: 1 1 auto;
  min-width: 0;
}
.race-title b {
  display: block;
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.race-title span {
  display: block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.7;
}
.race-clock {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.race-clock.heat {
  color: var(--heat-500);
}
.race-clock.critical {
  color: var(--red-500);
  animation: race-blink 2s ease-in-out infinite;
}
.race-clock.idle {
  font-size: 16px;
  opacity: 0.6;
}
.race-clock.done {
  font-size: 16px;
  color: var(--good);
}
.race-cta {
  min-height: 44px;
  padding: 0 20px;
  border: 0;
  border-radius: 999px;
  background: var(--heat-500);
  color: var(--heat-ink);
  font-weight: 800;
  white-space: nowrap;
  animation: race-ping 2.4s ease-out infinite;
}
.race-cta:hover:not(:disabled) {
  background: var(--heat-400);
}
.race-cta[aria-disabled='true'] {
  opacity: 0.55;
  animation: none;
}
@keyframes race-ping {
  0% {
    box-shadow: 0 0 0 0 rgb(255 90 31 / 0.55);
  }
  70%,
  100% {
    box-shadow: 0 0 0 10px rgb(255 90 31 / 0);
  }
}
@keyframes race-blink {
  50% {
    opacity: 0.45;
  }
}
@media (max-width: 600px) {
  .race-bar {
    gap: 8px;
  }
  .race-title span {
    display: none;
  }
  .race-clock {
    font-size: 18px;
  }
  .race-cta {
    padding: 0 14px;
  }
}
```

- [ ] **Step 5: 확인**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: 통과.

브라우저(팀장 3110, active 프로젝트)에서 확인한다.
- 상단에 프로젝트 이름, `DAY 1 / 7 · 진행 중`, 1초마다 줄어드는 `167:…` 형식 시계, 주황 '진행 보고'가 보인다.
- 진행 보고를 누르면 제목이 '진행 보고'인 대화상자가 열리고, 팀장 업무(요구사항 정리)가 미리 선택돼 있다. 저장하면 '진행 보고를 저장하고…' 알림이 뜬다.
- 시계 색 단계 확인: `javascript_tool`로 기기 시계를 바꿀 수는 없으니, 단계는 Task 1의 테스트로 보장한다고 기록한다.
- 준비 중 프로젝트: 시계 자리에 `7일 · 시작 전`이 보인다. 완주 프로젝트: `완주`가 보이고 진행 보고 버튼은 없다.
- 팀원(3111)으로 준비 중 프로젝트를 열면, 목표 동의를 마쳤고 업무가 없으므로 진행 보고가 흐리게 보인다. 누르면 '본인에게 배정된 진행 중인 업무가 없습니다.' 알림이 뜬다.

다크와 라이트에서 상단 바 사진을 각각 찍는다.

- [ ] **Step 6: 커밋**

```bash
git add web/hooks/use-server-now.ts web/components/race-clock.tsx web/app/workspace/page.tsx web/app/globals.css
git commit -m "feat: 상단 레이스 바에 서버 시각 기준 카운트다운과 진행 보고 버튼

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 홈(큰 숫자, Day 트랙, 병목 알림, 팀 레인)

**Files:**
- Create: `web/components/race-home.tsx`
- Modify: `web/components/deadline-calendar.tsx`
- Modify: `web/app/workspace/page.tsx`(home 블록)
- Modify: `web/app/globals.css`(달력 오늘·지난 날, 끝에 추가)

**Interfaces:**
- Consumes: `sprintPulse`, `laneTask`, `dayProgress`(Task 1), `useServerNow`(Task 5)
- Produces: `<RaceHome lifecycle asOf startedAt deadline tasks plan members me people onTasks />`. `DeadlineCalendar`의 props는 `asOf: string` 대신 `now: number`, 그리고 새 `bottlenecks: number[]`.

- [ ] **Step 1: 달력에 지금 위치와 병목 깃발**

`web/components/deadline-calendar.tsx`를 바꾼다.
- import에 `import { dayProgress } from '@/lib/race';`를 추가한다.
- props: `asOf: string`(주석 포함)을 지우고 `/** 서버 기준 현재 시각(ms). useServerNow로 흐른다. */ now: number;`와 `bottlenecks: number[];`를 추가한다. 구조분해에도 반영한다.
- `const now = Date.parse(asOf);` 줄을 지운다.
- `<li key={d.day} className={'calendar-day' + when}>` 바로 안쪽 맨 앞에 추가한다.
  ```tsx
                  {when === ' today' && (
                    <span
                      className="calendar-now"
                      style={{ left: `${dayProgress(d.start, now) * 100}%` }}
                      aria-hidden="true"
                    />
                  )}
  ```
- 업무 카드 `map` 안에서 `const late = …` 아래에 `const blocked = !t.done && bottlenecks.includes(t.id);`를 두고, `className`을 `'deadline-card' + (t.done ? ' done' : late ? ' late' : '') + (blocked ? ' blocked' : '')`로 바꾼다. `deadline-title` 안의 `{t.done && <Check size={13} />}` 뒤에 `{blocked && <Flag size={13} aria-label="병목" />}`를 추가한다.
- 버튼 문구 `프로젝트 업무에서 정하기` → `업무에서 정하기`

- [ ] **Step 2: `RaceHome` 컴포넌트**

`web/components/race-home.tsx`:

```tsx
'use client';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { DeadlineCalendar } from '@/components/deadline-calendar';
import type { ProjectMeta } from '@/components/project-workspace';
import { useServerNow } from '@/hooks/use-server-now';
import { laneTask, sprintPulse } from '@/lib/race';
import type { Plan, Task as ServerTask } from '@/lib/sprint';
import type { Lifecycle } from '@/lib/sprint-policy';
import type { Wire } from '@/lib/wire';

type Task = Wire<ServerTask>;

// 홈 = 팀 레이스 현황. 계산은 lib/race의 순수 함수, 표시는 서버가 준 plan·asOf만 쓴다.
export function RaceHome({
  lifecycle,
  asOf,
  startedAt,
  deadline,
  tasks,
  plan,
  members,
  me,
  people,
  onTasks,
}: {
  lifecycle: Lifecycle;
  asOf: string;
  startedAt: string | null;
  deadline: string | null;
  tasks: Task[];
  plan: Plan | null;
  members: ProjectMeta['members'];
  me: ProjectMeta['me'];
  people: { name: string }[];
  onTasks: () => void;
}) {
  const live = useServerNow(lifecycle === 'active' ? asOf : null);
  const now = live || Date.parse(asOf);
  const pulse = sprintPulse(tasks, plan);
  const name = (person: number) =>
    members.find((m) => m.person === person)?.display_name ?? people[person]?.name ?? '미배정';
  const blocked = tasks.filter((t) => pulse.bottlenecks.includes(t.id));
  const waiting = tasks.filter(
    (t) => !t.done && t.dependsOn.some((d) => pulse.bottlenecks.includes(d)),
  );
  return (
    <>
      {!tasks.length ? (
        <div className="race-alert calm">
          <div>
            <b>업무가 아직 없습니다.</b> 업무와 담당자를 등록하면 남은 공수와 병목을 계산합니다.
            <button className="text-link" onClick={onTasks}>
              업무로 이동 <ArrowRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        plan && (
          <div className="race-stats">
            <div className="race-stat">
              <b>
                {pulse.done}/{pulse.total}
              </b>
              <span>완료 업무</span>
            </div>
            <div className={`race-stat${pulse.hoursOver > 0 ? ' bad' : ''}`}>
              <b>
                {pulse.hoursOver > 0 ? `+${pulse.hoursOver}h` : `${Math.abs(pulse.hoursOver)}h`}
              </b>
              <span>{pulse.hoursOver > 0 ? '공수 초과' : '공수 여유'}</span>
            </div>
            <div className={`race-stat${pulse.bottlenecks.length ? ' bad' : ' good'}`}>
              <b>{pulse.bottlenecks.length}건</b>
              <span>병목</span>
            </div>
          </div>
        )
      )}
      <DeadlineCalendar
        startedAt={startedAt}
        deadline={deadline}
        now={now}
        tasks={tasks}
        people={people}
        bottlenecks={pulse.bottlenecks}
        onPlan={onTasks}
      />
      {blocked.length > 0 && (
        <div className="race-alert" role="status">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <b>병목</b> · &apos;{blocked[0].title}&apos;({name(blocked[0].person)}) 마감 안에 끝나지
            않음{blocked.length > 1 ? ` 외 ${blocked.length - 1}건` : ''}
            {waiting.length > 0 &&
              ` · '${waiting[0].title}'(${name(waiting[0].person)}) 대기`}
            <p>
              목표를 줄이거나 기한을 미루는 대신 담당 재배정·진행 순서·구현 방법을 바꿔주세요.
            </p>
            <button className="text-link" onClick={onTasks}>
              업무에서 조정 <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}
      {plan && tasks.length > 0 && (
        <section className="race-lanes" aria-label="팀 레인">
          <h2 className="race-label">팀 레인 · 지금 붙잡고 있는 업무와 남은 공수</h2>
          {members
            .filter((m) => !m.left_at)
            .map((m) => {
              const lane = laneTask(tasks, m.person);
              const p = plan.perPerson.find((x) => x.person === m.person);
              const over = !!p && p.needed > p.available;
              const pct =
                p && p.available > 0 ? Math.min(100, (p.needed / p.available) * 100) : p?.needed ? 100 : 0;
              return (
                <div
                  key={m.person}
                  className={`race-lane${m.person === me.person ? ' me' : ''}`}
                >
                  <b>
                    {m.display_name}
                    {m.person === me.person && <small> 나</small>}
                  </b>
                  <span className="race-lane-task">
                    {lane ? lane.title : '진행 중인 업무 없음'}
                    {lane && pulse.bottlenecks.includes(lane.id) && (
                      <span className="race-tag">병목</span>
                    )}
                  </span>
                  <div>
                    <div className={`race-meter${over ? ' over' : ''}`}>
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    <span className="race-hours">
                      {p?.needed ?? 0}h / {Math.round((p?.available ?? 0) * 10) / 10}h
                    </span>
                  </div>
                </div>
              );
            })}
          <p className="tiny muted">
            전원 하루 {plan.dailyHours}시간은 남은 기간과 공수를 비교하기 위한 계산 가정이며, 근무시간
            기록이 아닙니다.
          </p>
        </section>
      )}
    </>
  );
}
```

- [ ] **Step 3: `page.tsx` 홈 블록 교체**

`{tab === 'home' && (` 블록 전체를 아래로 바꾼다. 회의 제안과 최근 체크인 JSX는 기존 코드(현재 `content-grid` 안의 `<div className="section-heading task-heading"><h2>회의 제안</h2>…` ~ 최근 체크인 `task-list` 끝)를 그대로 옮긴다. 메이트 카드(`agent-card`)와 오른쪽 `aside`(담당자별 공수, goal-card)는 지운다.

```tsx
            {tab === 'home' && (
              <section className="work-section">
                {lifecycle !== 'draft' && (
                  <RaceHome
                    lifecycle={lifecycle}
                    asOf={state!.asOf}
                    startedAt={state!.policy?.startedAt ?? null}
                    deadline={deadline}
                    tasks={tasks}
                    plan={plan ?? null}
                    members={state!.members}
                    me={state!.me}
                    people={people}
                    onTasks={() => setTab('tasks')}
                  />
                )}
                <div className="race-below">
                  <section>{/* 기존 '회의 제안' heading + task-list 그대로 */}</section>
                  <section>{/* 기존 '최근 체크인' heading + task-list 그대로. 제목은 '최근 진행 보고'로 */}</section>
                </div>
              </section>
            )}
```

- `import { DeadlineCalendar } …`는 page에서 더는 쓰지 않으면 지운다. `import { RaceHome } from '@/components/race-home';`를 추가한다.
- 쓰지 않게 된 lucide 아이콘(`Zap`, `Clock3`는 result 블록에서 계속 쓰는지 확인 후 판단)과 `done` 변수를 lint가 알려주는 대로 정리한다.
- 최근 체크인이 없을 때의 문구 `'하루 한 번 완료·남은 일·막힘을 남겨주세요.'` → `'하루 한 번 진행 보고로 완료·남은 일·막힘을 남겨주세요.'`

- [ ] **Step 4: 스타일**

`globals.css`에서 달력 두 규칙을 바꾼다.

```css
.calendar-day {
  position: relative; /* 기존 속성들 위에 이 한 줄 추가 */
}
.calendar-day.today {
  background: color-mix(in srgb, var(--heat-500) 18%, var(--gray-0));
  box-shadow: inset 0 4px 0 var(--heat-500);
}
.calendar-day.past {
  background: color-mix(in srgb, var(--heat-500) 7%, var(--gray-0));
}
```

(`.calendar-day`는 기존 규칙에 `position: relative;`만 추가한다. `today`·`past`는 기존 두 규칙을 위 내용으로 바꾼다.)

파일 끝에 추가한다.

```css
.calendar-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  margin-left: -1px;
  border-radius: 2px;
  background: var(--heat-500);
  pointer-events: none;
  animation: race-blink 1.2s ease-in-out infinite;
}
.deadline-card.blocked {
  box-shadow: inset 3px 0 var(--red-500);
}
.deadline-card.blocked svg {
  color: var(--red-500);
}
.race-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}
.race-stat {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--gray-50);
  animation: race-rise 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.race-stat:nth-child(2) {
  animation-delay: 0.05s;
}
.race-stat:nth-child(3) {
  animation-delay: 0.1s;
}
.race-stat b {
  display: block;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.race-stat span {
  font-size: 12px;
  font-weight: 600;
  color: var(--gray-600);
}
.race-stat.bad b {
  color: var(--red-500);
}
.race-stat.good b {
  color: var(--good);
}
@keyframes race-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.race-alert {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 20px 0;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--red-50);
  box-shadow: inset 3px 0 var(--red-500);
  font-size: 14px;
}
.race-alert.calm {
  background: var(--gray-50);
  box-shadow: inset 3px 0 var(--heat-500);
}
.race-alert > svg {
  flex: none;
  margin-top: 2px;
  color: var(--red-500);
}
.race-alert b {
  color: var(--red-700);
}
.race-alert.calm b {
  color: var(--gray-900);
}
.race-alert p {
  margin: 4px 0;
  font-size: 13px;
  color: var(--gray-700);
}
.race-label {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--gray-600);
}
.race-lanes {
  margin: 24px 0 32px;
}
.race-lane {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 140px;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: 14px;
}
.race-lane.me {
  margin: 0 -10px;
  padding: 10px;
  border-radius: var(--radius-md);
  background: var(--heat-50);
}
.race-lane small {
  font-size: 11px;
  font-weight: 600;
  color: var(--heat-700);
}
.race-lane-task {
  min-width: 0;
  overflow-wrap: anywhere;
}
.race-meter {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--gray-200);
}
.race-meter i {
  display: block;
  height: 100%;
  background: var(--gray-900);
}
.race-meter.over i {
  background: var(--red-500);
}
.race-hours {
  display: block;
  margin-top: 3px;
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 12px;
  color: var(--gray-600);
}
.race-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--red-500);
  color: var(--gray-0);
  font-size: 11px;
  font-weight: 800;
  vertical-align: 1px;
}
.race-below {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
}
@media (max-width: 900px) {
  .race-below {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .race-stats {
    gap: 6px;
  }
  .race-stat {
    padding: 10px;
  }
  .race-stat b {
    font-size: 22px;
  }
  .race-lane {
    grid-template-columns: 64px minmax(0, 1fr);
  }
  .race-lane > :last-child {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 5: 확인**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: 통과(`meeting-panel.test.mjs`는 `meetingSuggestions(`가 page에 남아 있어 통과).

브라우저(팀장 3110, active)에서 확인한다.
- 큰 숫자: `0/4 완료 업무`, 공수 초과(빨강), `1건 병목`(빨강). 시드의 '메인 화면 시안' 200h가 병목이다.
- Day 트랙: Day 1 칸이 오늘이고, 주황 위 띠와 깜빡이는 세로 막대가 있다. '메인 화면 시안' 카드에 빨간 깃발이 있다.
- 병목 알림: `'메인 화면 시안'(도윤) 마감 안에 끝나지 않음 · '로그인 API 연동'(서연) 대기`. '업무에서 조정'을 누르면 업무 메뉴로 간다.
- 팀 레인: 도윤(나, 강조, 막대 빨강), 서연.
- 아래에 회의 제안과 최근 진행 보고가 있다.
- 준비 중 프로젝트 홈: 시작 준비 패널만 있고 큰 숫자·트랙이 없다.
- 완주 프로젝트 홈: 큰 숫자·트랙이 보이고, 진행 보고 버튼은 없다.
- 375px(`resize_window` preset mobile): `javascript_tool`로 `document.documentElement.scrollWidth <= innerWidth`가 true인지 확인한다.

다크와 라이트에서 홈 사진을 각각 찍는다.

- [ ] **Step 6: 커밋**

```bash
git add web/components/race-home.tsx web/components/deadline-calendar.tsx web/app/workspace/page.tsx web/app/globals.css
git commit -m "feat: 홈을 팀 레이스 현황으로(큰 숫자·Day 트랙·병목 알림·팀 레인)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 업무 목록의 병목 강조

**Files:**
- Modify: `web/components/task-collection.tsx:184-330`
- Modify: `web/app/globals.css`(끝에 추가)

**Interfaces:**
- Consumes: `plan.unscheduled`(기존 `Plan`). 새 함수는 없다.

- [ ] **Step 1: 표와 보드에 병목 표시**

`TaskCollection` 함수 본문의 `const task = …` 아래에 다음을 둔다.

```tsx
  // 병목 = 마감 안에 배치되지 않은 미완료 업무. 홈의 '병목 n건'과 같은 기준(plan.unscheduled).
  const blocked = (t: Task) => !t.done && plan.unscheduled.includes(t.id);
```

표:
- `<TableRow key={t.id}>` → `<TableRow key={t.id} className={blocked(t) ? 'is-blocked' : undefined}>`
- 제목 버튼의 `<span>{t.title}</span>` 뒤에 `{blocked(t) && <span className="race-tag">병목</span>}`를 추가한다.
- '예상 완료' 셀의 `className={!t.done && !plan.finishes[t.id] ? 'schedule-warning' : ''}` → `className={blocked(t) ? 'schedule-warning' : ''}`
- 같은 셀의 내용을 다음으로 바꾼다.
  ```tsx
                        {t.done
                          ? '결과 확인 완료'
                          : plan.finishes[t.id]
                            ? seoulTime(plan.finishes[t.id]) + ' KST' + (blocked(t) ? ' · 마감 초과' : '')
                            : '배치 불가'}
  ```

보드:
- `<article className="board-card" key={t.id}>` → `<article className={'board-card' + (blocked(t) ? ' is-blocked' : '')} key={t.id}>`
- 제목 버튼 안 `{t.title}` 뒤에 `{blocked(t) && <span className="race-tag">병목</span>}`를 추가한다.

- [ ] **Step 2: 스타일(처음 붙을 때 한 번만 밀림)**

`globals.css` 끝에 추가한다.

```css
/* 병목: 띠와 태그는 계속, 밀림은 클래스가 처음 붙을 때 한 번만(반복 없음). */
.task-table tr.is-blocked td:first-child {
  box-shadow: inset 3px 0 var(--red-500);
}
.task-table tr.is-blocked,
.board-card.is-blocked {
  animation: race-nudge 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 1;
}
.board-card.is-blocked {
  box-shadow: inset 3px 0 var(--red-500);
}
@keyframes race-nudge {
  30% {
    transform: translateX(6px);
  }
  60% {
    transform: translateX(-3px);
  }
}
```

- [ ] **Step 3: 확인**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: 통과.

브라우저(팀장 3110, active, 업무 메뉴)에서 확인한다.
- '메인 화면 시안' 행에 빨간 왼쪽 띠와 `병목` 태그가 있고, 예상 완료가 빨간 글자로 `… KST · 마감 초과`로 보인다.
- 처음 열 때 한 번 밀렸다 돌아오고, 15초 재조회 뒤에는 다시 움직이지 않는다.
- 보드 보기에서도 같은 카드에 띠와 태그가 있다.
- 남은 시간을 200h에서 4h로 진행 보고하면 띠와 태그가 사라지고, 홈의 병목이 `0건`(초록)이 된다. 이 과정이 저장 후 재조회 확인이다.

- [ ] **Step 4: 커밋**

```bash
git add web/components/task-collection.tsx web/app/globals.css
git commit -m "feat: 업무 표·보드에서 병목 업무를 빨간 띠와 태그로 강조

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 전체 확인과 문서 갱신

**Files:**
- Modify: `docs/features.md`, `docs/current-sprint.md`, `docs/tools.md`, `docs/dev-live-model-assignment-test.md`, `web/README.md` 중 예전 메뉴 이름을 쓰는 곳

- [ ] **Step 1: 예전 메뉴 이름 갱신**

Run: `grep -rn "스프린트 현황\|내 할 일\|변경안 검토\|팀 · 공수\|완주 확인\|프로젝트 업무\|체크인 버튼" docs/*.md web/README.md`

화면 위치를 설명하는 문장만 새 이름으로 바꾼다. 예를 들어 '스프린트 현황' → '홈', '프로젝트 업무'·'내 할 일' → '업무(내 것만)', '변경안 검토' 메뉴 → '업무의 회의록으로 변경안 만들기', '팀 · 공수'·'완주 확인'·'프로젝트 문서' 메뉴 → '프로젝트', 상단 '체크인' → '진행 보고'. 기능 이름으로 쓰인 '변경안 검토', '완주 확인'(기능 설명)은 그대로 둔다. `docs/archive/`는 건드리지 않는다.

`docs/features.md`에 작업 화면 구성을 한 단락 추가한다. 메뉴 3개, 홈 구성, 다크 기본·라이트 전환, 카운트다운이 서버 시각 기준이라는 점을 적는다. 구현되지 않은 것(행동 반응 애니메이션)은 쓰지 않는다.

- [ ] **Step 2: 전체 검사**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: 모두 통과. 실패하면 출력 그대로 기록하고 고친다.

- [ ] **Step 3: 브라우저 최종 확인**

팀장(3110)과 팀원(3111)으로 아래를 확인하고 사진을 남긴다.

| 확인 | 기대 |
|---|---|
| 다크 · 홈(active) | 상단 바, 큰 숫자, 트랙, 병목 알림, 팀 레인 |
| 라이트 · 홈(active) | 상단 바만 검정, 본문 밝음 |
| 준비 중 홈 | 시작 준비 패널, `7일 · 시작 전` |
| 완주 홈 | `완주`, 진행 보고 없음 |
| 팀원 · 프로젝트 | 초대 폼 없음 |
| 팀원 · 업무 | `업무 추가` 없음 |
| 375px 홈·업무·프로젝트 | 가로 스크롤 없음(`scrollWidth <= innerWidth`) |
| 움직임 줄이기 | `javascript_tool`로 `matchMedia('(prefers-reduced-motion: reduce)')`를 직접 바꿀 수 없으니, 개발자 도구 대신 `globals.css`의 전역 규칙(`animation: none !important`)이 있는지 grep으로 확인한다 |
| 저장소 막힘 | `javascript_tool`로 `Object.defineProperty(window,'localStorage',{get(){throw new Error('x')}})` 실행 후 테마 버튼을 누른다. 오류 없이 바뀌어야 한다(`read_console_messages` onlyErrors 비어 있음) |
| 랜딩 | `http://127.0.0.1:3102/` 첫 화면이 이전과 같음 |

- [ ] **Step 4: 정리와 커밋**

`preview_stop`으로 `workspace-ui` 서버를 끄고, 프록시 두 개(백그라운드 작업)를 멈춘다. `.data/pglite-ui`는 `.gitignore`(`/.data/`)에 이미 포함돼 있다.

```bash
git add docs web/README.md
git commit -m "docs: 작업 화면 메뉴 3개·레이스 홈 구성으로 문서 갱신

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 최종 검토 요청**

브랜치 전체 diff를 Codex 서브에이전트(`codex:codex-rescue`)에게 검토 요청한다(사용자 기본 리뷰어). 서버 코드를 바꾸지 않았는지(`git diff main --stat -- web/app/api web/lib/sprint*.ts web/db`가 비어 있어야 함)도 함께 확인한다.
