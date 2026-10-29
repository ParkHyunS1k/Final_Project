# 만들기 화면 주사위·범위 슬라이더 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 키보드 없이 주사위 단어 3개와 5단계 범위 슬라이더로 프로젝트를 만들고, 준비 중에 팀장이 목표를 고칠 수 있게 한다.

**Architecture:** 단어 목록·굴리기·단계 정의·요청 본문 생성은 `web/lib/idea-dice.ts`의 순수 함수. 화면은 `ProjectCreate`(만들기)와 `GoalEditor`(목표 고치기) 두 컴포넌트가 이 함수를 쓰고, 기존 API(`POST /api/projects` create, `POST /api/sprint` editGoal)를 그대로 호출한다. 서버·DB 파일은 바꾸지 않는다.

**Tech Stack:** Next.js(web/, 새 버전 — `web/AGENTS.md` 참고), React 19, lucide-react, plain CSS(`app/globals.css`), node:test + `--experimental-strip-types`, esbuild 렌더 테스트.

**Spec:** `docs/superpowers/specs/2026-10-29-idea-dice-create-design.md`

## Global Constraints

- 서버 파일(`web/app/api/**`, `web/lib/projects.ts`, `web/lib/sprint-policy.ts`, `web/db/**`) 수정 금지.
- 서버 길이 제한: title 100, goal 1000, scope 2000, completionCriteria 2000. `duration`은 7(생성) / `policy.durationDays`(편집).
- `deliverables`는 보내지 않는다.
- 범위 단계 이름(순서 고정): 핵심 기능 · MVP · 테스트 · 데모 · 배포. 기본값 2(MVP).
- 색은 기존 토큰(`--gray-*`, `--heat-*`, `--red-*`)만. 다크·라이트 모두. 움직임은 기존 `prefers-reduced-motion` 전역 규칙에 맡긴다.
- 린트는 기존 오류 수(작업 시작 시 `npm run lint` 결과)보다 늘지 않는다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 작업 폴더: `/Users/parkhyunsik/wt/idea-dice` (브랜치 `feat/idea-dice`). 명령은 `web/`에서.

## Review Focus

- 아이디어 칸에 공백만 입력 → 비운 것과 같게(단어 조합 이름·목표). → Task 1 테스트.
- 100자 넘는 아이디어(붙여넣기 등) → title은 100자로 잘려 서버 거절이 나지 않는다. → Task 1 테스트.
- 다시 굴리면 잠기지 않은 칸은 반드시 다른 단어로 바뀌고, 잠긴 단어와도 겹치지 않는다(같은 단어가 나오면 버튼이 고장난 것처럼 보임). → Task 1 테스트.
- [프로젝트 만들기] 연타 → 프로젝트 중복 생성. 요청 중 버튼 `disabled`. → Task 2 구현 + Task 4 브라우저 확인.
- 목표 고치기 중 다른 변경이 먼저 저장(409) → 편집 폼이 닫히지 않고 입력이 남은 채 오류 표시. `mutate`가 재조회 후 false를 돌려준다. → Task 3 구현 + Task 4 확인.

---

### Task 1: 주사위·단계 순수 함수

**Files:**
- Create: `web/lib/idea-dice.ts`
- Test: `web/tests/idea-dice.test.ts`
- Modify: `web/package.json` (`test` 스크립트 목록 끝에 `tests/idea-dice.test.ts` 추가)

**Interfaces:**
- Produces:
  - `export const WORDS: readonly string[]` — 일상 명사(한 단어, 공백 없음) 140~160개, 중복 없음.
  - `export type ScopeLevel = { name: string; scope: string; criteria: string }`
  - `export const SCOPE_LEVELS: readonly ScopeLevel[]` — 길이 5, 스펙 표의 문장 그대로.
  - `export const DEFAULT_LEVEL = 2`
  - `export function roll(current: readonly string[], locked: readonly boolean[], random: () => number = Math.random): string[]`
  - `export type CreateBody = { action: 'create'; title: string; goal: string; scope: string; completionCriteria: string; duration: 7; agreed: boolean }`
  - `export function createBody(input: { words: readonly string[]; idea: string; level: number; agreed: boolean }): CreateBody`
  - `export function scopeText(level: number): string` — `[이름] 문장`
  - `export function levelOf(scope: string): number` — 1~5, 접두어 없거나 모르는 이름이면 `DEFAULT_LEVEL`.

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/idea-dice.test.ts`, race.test.ts와 같은 import 방식, `../lib/idea-dice.ts`)

테스트용 시드 난수: `function seeded(n) { return () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648); }`

```ts
test('단어 목록은 중복 없이 140~160개, 공백 없는 단어', () => {
  assert.equal(new Set(WORDS).size, WORDS.length);
  assert.ok(WORDS.length >= 140 && WORDS.length <= 160);
  assert.ok(WORDS.every((w) => w && !/\s/.test(w)));
});
test('처음 굴리면 서로 다른 단어 3개', () => {
  for (let s = 1; s <= 200; s++) {
    const w = roll(['', '', ''], [false, false, false], seeded(s));
    assert.equal(w.length, 3);
    assert.equal(new Set(w).size, 3);
    assert.ok(w.every((x) => WORDS.includes(x)));
  }
});
test('다시 굴리면 잠긴 칸은 그대로, 안 잠긴 칸은 이전과 다르고 셋이 모두 다르다', () => {
  for (let s = 1; s <= 200; s++) {
    const before = roll(['', '', ''], [false, false, false], seeded(s));
    const after = roll(before, [true, false, false], seeded(s + 999));
    assert.equal(after[0], before[0]);
    assert.notEqual(after[1], before[1]);
    assert.notEqual(after[2], before[2]);
    assert.equal(new Set(after).size, 3);
  }
});
test('모두 잠그면 그대로', () => {
  assert.deepEqual(roll(['고양이', '영수증', '지도'], [true, true, true]), ['고양이', '영수증', '지도']);
});
test('단계는 핵심 기능·MVP·테스트·데모·배포', () => {
  assert.deepEqual(SCOPE_LEVELS.map((l) => l.name), ['핵심 기능', 'MVP', '테스트', '데모', '배포']);
  assert.equal(DEFAULT_LEVEL, 2);
});
test('아이디어를 비우면 단어 조합이 이름과 목표가 된다(공백만 입력 포함)', () => {
  for (const idea of ['', '   ']) {
    const b = createBody({ words: ['고양이', '영수증', '지도'], idea, level: 2, agreed: true });
    assert.equal(b.title, '고양이 · 영수증 · 지도');
    assert.equal(b.goal, "'고양이·영수증·지도' 조합에서 떠올린 서비스를 7일 안에 만든다");
  }
});
test('아이디어를 적으면 그 한 줄이 이름과 목표, 100자 초과는 이름만 자른다', () => {
  const b = createBody({ words: ['a', 'b', 'c'], idea: '  집사끼리 영수증 나누는 지도  ', level: 3, agreed: false });
  assert.equal(b.title, '집사끼리 영수증 나누는 지도');
  assert.equal(b.goal, '집사끼리 영수증 나누는 지도');
  assert.equal(b.agreed, false);
  const long = '가'.repeat(150);
  const c = createBody({ words: ['a', 'b', 'c'], idea: long, level: 2, agreed: true });
  assert.equal(c.title.length, 100);
  assert.equal(c.goal, long);
});
test('범위·완료 기준은 단계 문장, 결과물은 보내지 않고 모든 단계가 서버 제한 안', () => {
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
test('levelOf는 접두어로 단계를 찾고, 없거나 모르면 MVP', () => {
  for (let level = 1; level <= 5; level++) assert.equal(levelOf(scopeText(level)), level);
  assert.equal(levelOf('직접 쓴 범위'), 2);
  assert.equal(levelOf('[없는단계] 문장'), 2);
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/idea-dice.test.ts` → 모듈 없음으로 FAIL.

- [ ] **Step 3: `web/lib/idea-dice.ts` 구현**
  - `roll`: 잠긴 단어는 유지, 잠기지 않은 칸은 `WORDS`에서 `random()`으로 뽑되 (잠긴 단어, 이번에 이미 뽑은 단어, 그 칸의 이전 단어)와 겹치면 다시 뽑는다.
  - `createBody`: `idea.trim()`이 비면 단어 조합, 아니면 `title = trimmed.slice(0, 100)`, `goal = trimmed`. `level`은 1~5로 clamp.
  - 단어는 7일 프로젝트 영감용 일상 명사(사물·장소·사람·활동·감정 섞어서). 비속어·민감 주제 제외.

- [ ] **Step 4: 통과 확인** — 같은 명령 → 9 pass.

- [ ] **Step 5: 커밋** — `git add web/lib/idea-dice.ts web/tests/idea-dice.test.ts web/package.json && git commit -m "feat: 주사위 단어·범위 5단계·만들기 요청 본문 순수 함수"`

### Task 2: 만들기 화면 교체

**Files:**
- Create: `web/components/project-create.tsx` (`'use client'`)
- Modify: `web/components/project-workspace.tsx` — `create()` 함수와 `{creating && (<section …>…</section>)}` 안의 폼을 `ProjectCreate`로 교체
- Modify: `web/app/globals.css` — `.dice-*`, `.scope-*` 추가
- Test: `web/tests/project-create-render.test.mjs` (`team-directory-render.test.mjs`와 같은 esbuild→renderToString 방식, entry `components/project-create.tsx`)
- Modify: `web/package.json` (테스트 목록에 추가)

**Interfaces:**
- Consumes: Task 1의 `roll`, `SCOPE_LEVELS`, `DEFAULT_LEVEL`, `createBody`, `CreateBody`.
- Produces:
  - `export function ScopeSlider(props: { value: number; onChange: (level: number) => void }): JSX.Element` — `<input type="range" min=1 max=5 step=1 aria-label="기능 범위 단계">` + 단계 이름 버튼 5개(`aria-pressed`, 누르면 그 단계). 문장은 그리지 않는다.
  - `export function ProjectCreate(props: { onSubmit: (body: CreateBody) => Promise<void> }): JSX.Element`
  - (스펙의 `scope-slider.tsx` 별도 파일 대신 `project-create.tsx`에서 export — 파일 수 최소화.)

- [ ] **Step 1: 실패하는 렌더 테스트 작성**

```js
void test('만들기 화면: 단어 3개·잠금 3개·주사위, 5단계 슬라이더 기본 MVP, 결과물 입력 없음', () => {
  const html = renderToString(createElement(ProjectCreate, { onSubmit: async () => {} }));
  assert.equal((html.match(/class="dice-word"/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label="[^"]+ 고정"/g) ?? []).length, 3);
  assert.match(html, /다시 굴리기/);
  assert.match(html, /type="range"[^>]*min="1"[^>]*max="5"/);
  assert.match(html, /value="2"/);
  const names = ['핵심 기능', 'MVP', '테스트', '데모', '배포'];
  let at = -1;
  for (const n of names) { const i = html.indexOf(n, at + 1); assert.ok(i > at, n); at = i; }
  assert.match(html, /사용자가 들어와서 목적을 이루고 나가는 흐름 하나를 완성한다/);
  assert.match(html, /혼자서도 시작할 수 있어요/);
  assert.match(html, /maxLength="100"|maxlength="100"/);
  assert.doesNotMatch(html, /name="deliverables"|필수 결과물/);
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-strip-types --test tests/project-create-render.test.mjs` → entry 없음 FAIL.

- [ ] **Step 3: `ProjectCreate` 구현**
  - 상태: `words`(초기값 `useState(() => roll(['','',''],[false,false,false]))` — 만들기 패널은 클라이언트 로드 후에만 열리므로 SSR 불일치 없음), `locked: boolean[3]`, `idea`, `level = DEFAULT_LEVEL`, `agreed`, `busy`.
  - 구성(스펙 '화면' 순서): `<h1>7일 안에 완성할 프로젝트</h1>`; 안내 두 문장 — "주사위를 굴려 떠오르는 게 있을 때까지 단어를 섞어 보세요. 마음에 드는 단어는 자물쇠로 고정할 수 있어요." / "만들면 준비 상태로 저장되고, 팀장이 시작한 시각부터 7일이 흐릅니다. 혼자서도 시작할 수 있어요."
  - 단어 칩: `<span className="dice-word" key={`${i}-${w}`}>` — 단어가 바뀐 칩만 다시 마운트되어 CSS 애니메이션 1회. 칩 옆 잠금 버튼 `type="button" aria-pressed={locked[i]} aria-label={`${w} 고정`}`, 아이콘 lucide `Lock`/`LockOpen`.
  - 주사위 버튼 `type="button"`, lucide `Dices` + "다시 굴리기", 셋 다 잠기면 `disabled`.
  - 아이디어: `<input maxLength={100} placeholder="떠오른 아이디어 한 줄 (비워도 돼요)">`.
  - `ScopeSlider` 아래 `<p>`로 `SCOPE_LEVELS[level-1].scope`, `<p><b>완료 기준</b> …criteria</p>`.
  - 체크박스(required) 문구: "목표·기능 범위·완료 기준을 확인했습니다. 시작 후에는 바꿀 수 없으며 실제 결제는 발생하지 않습니다."
  - submit: `busy` 중 버튼 `disabled`, 문구 "저장 중…"/"프로젝트 만들기". `await onSubmit(createBody(...))`, finally `busy=false`.
  - 기존 `.project-panel`, `.project-form`, `.agreement`, `.btn primary` 클래스를 재사용.

- [ ] **Step 4: `project-workspace.tsx` 연결** — 기존 `create()`를 지우고:
  `<ProjectCreate onSubmit={async (body) => { setError(''); try { const r = await api('/api/projects', body); location.assign('/workspace?project=' + encodeURIComponent(r.projectId)); } catch (e) { setError((e as Error).message); } }} />`
  더 이상 쓰지 않는 `busy` 상태가 생기면 함께 지운다(다른 곳에서 쓰면 유지).

- [ ] **Step 5: CSS** — `.dice-board`(칩 3개 가로, 375px에서 줄바꿈), `.dice-word`(큰 글자, `--gray-*` 테두리, `animation: dice-shake 280ms ease-out 1`), `.dice-lock[aria-pressed='true']`(`--heat-*` 강조), `@keyframes dice-shake`(translate/rotate 작은 흔들림), `.scope-slider`(range `accent-color: var(--heat-500)` 계열, 이름 버튼 5칸 grid), `.scope-step[aria-pressed='true']`.

- [ ] **Step 6: 통과 확인** — `node --experimental-strip-types --test tests/project-create-render.test.mjs tests/workspace-views.test.mjs tests/meeting-panel.test.mjs` → 모두 pass.

- [ ] **Step 7: 커밋** — `feat: 만들기 화면을 주사위 단어·잠금·5단계 범위 슬라이더로 교체`

### Task 3: 목표 고치기 (준비 중 팀장)

**Files:**
- Create: `web/components/goal-editor.tsx` (`'use client'`)
- Modify: `web/app/workspace/page.tsx` — 프로젝트 탭 `<ProjectDetails state={state!} />` 바로 아래에 `GoalEditor`

**Interfaces:**
- Consumes: Task 1 `levelOf`, `SCOPE_LEVELS`, `scopeText`; Task 2 `ScopeSlider`; page.tsx의 기존 `mutate(action, fields, message): Promise<boolean>`(revision 포함, 409면 재조회 후 오류, 성공 시 state 교체).
- Produces: `export type GoalFields = { title: string; goal: string; scope: string; completionCriteria: string; duration: number }`
  `export function GoalEditor(props: { agreement: { title: string; goal: string; scope: string; completion_criteria: string }; durationDays: number; busy: boolean; onSave: (fields: GoalFields) => Promise<boolean> }): JSX.Element`

- [ ] **Step 1: `GoalEditor` 구현**
  - 닫힘: `<button className="btn">목표 고치기</button>` + 작은 안내 "저장하면 목표 버전이 올라가고 팀원은 다시 동의해야 합니다."
  - 열림: `.project-form` — 이름(input, maxLength 100, required), 목표(textarea 1000), `ScopeSlider`(초깃값 `levelOf(agreement.scope)`), 기능 범위(textarea 2000), 완료 기준(textarea 2000), [저장]/[취소]. 열 때마다 `agreement` 값으로 초기화.
  - 슬라이더 변경 → 기능 범위 = `scopeText(level)`, 완료 기준 = 그 단계 `criteria`로 덮어쓰기. 슬라이더 옆 문구 "단계를 바꾸면 아래 두 칸이 그 단계 문장으로 바뀝니다."
  - 저장: `onSave({ title, goal, scope, completionCriteria, duration: durationDays })`가 true면 닫기, false면 열린 채 유지(오류는 page의 기존 오류 표시).
  - `busy`면 저장 버튼 disabled.

- [ ] **Step 2: page.tsx 연결** — 조건 `state!.me.role === 'owner' && lifecycle === 'draft' && state!.agreement && state!.policy`일 때
  `<GoalEditor agreement={state!.agreement} durationDays={state!.policy.durationDays} busy={busy} onSave={(f) => mutate('editGoal', f, '목표를 고쳤습니다. 팀원은 다시 동의해야 합니다.')} />`
  (노출 조건은 편의용. 권한·상태 판단은 서버 `editGoal: owner, draft` 거절을 따른다.)

- [ ] **Step 3: 확인** — `npx tsc --noEmit -p .`(또는 `npm run build`) 타입 오류 없음, `npm test` 전부 pass.

- [ ] **Step 4: 커밋** — `feat: 준비 중 팀장의 목표 고치기 화면(editGoal 연결)`

### Task 4: 브라우저 확인·문서

**Files:**
- Modify: `docs/features.md`(프로젝트 생성 설명), `docs/current-sprint.md`(맨 위 `## 2026-10-29 만들기 화면 주사위·범위 슬라이더` 항목: 설계 링크, 서버 변경 없음, 테스트 수, 로컬 확인 결과)

- [ ] **Step 1: 로컬 실행** — 작업 폴더의 `.claude/launch.json` `workspace-ui`(PGlite `.data/pglite-ui`, 포트 3102)로 dev 서버, `node scripts/seed-ui.mjs`, `node scripts/dev-as.mjs` 프록시 3110(팀장)·3111(팀원).
- [ ] **Step 2: 키보드 없이 만들기** — 3110에서 새 프로젝트 → 🎲 여러 번(잠근 칸 유지 확인) → 슬라이더 4(데모) → 체크 → 만들기 연타. 프로젝트 1개만 생기고 준비 상태로 열림. 새로고침 후 이름 `A · B · C`, 기능 범위 `[데모] …` 재조회.
- [ ] **Step 3: 목표 고치기** — 프로젝트 탭 → 목표 고치기 → 이름·목표 수정, 슬라이더 5 → 저장 → 재조회 시 바뀐 문장과 목표 버전 +1. 팀원(3111) 화면엔 버튼 없음, 재동의 안내 표시. 두 탭에서 동시에 열고 한쪽 저장 후 다른 쪽 저장 → 오류 표시, 폼 유지.
- [ ] **Step 4: 화면 상태** — 다크·라이트, 375px 폭 가로 스크롤 없음, 콘솔 오류 없음. 스크린샷 남김.
- [ ] **Step 5: 전체 검증** — `npm test`, `npm run lint`(기존 오류 수 이하), `npm run build`.
- [ ] **Step 6: 문서 수정 후 커밋** — `docs: 만들기 화면 주사위·범위 슬라이더 반영`
