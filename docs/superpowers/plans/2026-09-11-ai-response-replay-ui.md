# AI 평가 응답 재생 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Claude도 각 Task를 독립적으로 검토하고 작업한다.

**Goal:** 저장된 Luna/Sol 실제 평가 응답을 운영 모델 호출 없이 기존 변경안 검토 화면 형식으로 표시한다.

**Architecture:** 평가 입력과 응답에서 선정한 실제 사례 4건을 Workers 번들에 포함 가능한 fixture로 고정한다. 서버의 순수 변환기가 평가의 `task_id`, `person`, `evidence_excerpt_indices`를 화면용 계약으로 변환하고, 기존 `ChangeReview`가 이를 읽기 전용 재생 결과로 렌더링한다. 재생 결과는 원문 DB와 승인 API에서 격리한다.

**Tech Stack:** Vinext/React 19, TypeScript, Cloudflare Workers + D1, Node built-in test runner, esbuild, checked-in JSON fixture. 새 의존성은 추가하지 않는다.

**Spec:** [서비스 기능—붙여넣기와 AI 변경안](../../features.md#붙여넣기와-ai-변경안), [기존 C 계획](2026-09-09-c-ai-change-review.md), [평가 응답 스키마](../../../evals/github-role-division-2026-09-11/schema.json)

## Global Constraints

- 이번 완료 기준은 실제 API 호출이 아니라 **저장된 실제 응답의 재생과 화면 수용**이다.
- 화면에 `저장된 평가 응답 재생 · 우리 프로젝트에 반영되지 않음`을 항상 표시한다.
- 재생 응답은 읽기 전용이다. 원문·제안·승인·적용 이력을 D1에 쓰지 않는다.
- 평가의 문자열 `task_id`와 로그인 `person`을 편의상 현재 D1의 숫자 ID로 바꾸지 않는다.
- 원문은 React 텍스트로만 렌더링하며 HTML로 해석하지 않는다.
- 기존 가짜 모델, 원문 저장, 부분 승인, 이력, 되돌리기 흐름을 유지한다.
- D1 스키마, `.openai/hosting.json`, 평가 원본과 결과 파일은 수정하지 않는다.
- 새 UI 의존성이나 브라우저 테스트 프레임워크를 추가하지 않는다.
- 현재 작업 트리의 무관한 수정과 untracked 파일을 건드리거나 커밋하지 않는다.

## 고정할 실제 사례

| 상태 | 모델 | 사례 ID | 화면에서 확인할 내용 |
|---|---|---|---|
| 변경 제안 있음 | Sol low | `GH-TL-1114781787` | 신규 업무 `CR 파트`, 담당자 `majink`, 근거 발췌 2 |
| 변경 없음 | Luna low | `GH-TL-1125100581` | 해석 요약과 `changes=[]` |
| 확인 필요 | Luna low | `GH-TL-4880873604` | 완료·종료 보고에 대응하는 기존 업무를 특정할 수 없는 이유 |
| 담당자 미정 | Sol low | `GH-TL-5210407787` | 신규 업무 6개, 모두 `person=null` |

모든 사례는 `evals/github-role-division-2026-09-11/results/<variant>/`의 실제 응답과 `datasets/github-role-division-candidates-v1/candidates.jsonl`의 해당 입력을 함께 고정한다. fixture에는 원본 경로와 해시를 기록해 실제 응답에서 유래했음을 검증한다.

## 수정 지도

| 파일 | 책임 |
|---|---|
| `web/scripts/build-change-review-replays.mjs` | 원본 입력·응답 4건 검증 및 결정적 fixture 생성 |
| `web/fixtures/change-review-replays.json` | Workers에 번들 가능한 최소 재생 데이터 |
| `web/lib/change-review-replay.ts` | 평가 스키마를 화면 계약으로 변환하고 근거 문자 위치 계산 |
| `web/app/api/change-proposals/route.ts` | 기존 GET에 재생 목록과 단건 자료 제공 |
| `web/components/change-review.tsx` | 보기 모드 선택, 재생 표식, 상태별 렌더링 |
| `web/app/globals.css` | 기존 스타일로 부족한 경우에만 재생 안내 스타일 추가 |
| `web/tests/change-proposals.test.mjs` | 권한, 변환 결과, DB 불변 통합 검증 |
| `web/package.json` | fixture 생성 명령 추가 |
| `docs/current-sprint.md` | 구현 후 검증 범위와 남은 제한 기록 |

---

### Task 1: 실제 평가 응답 4건을 재현 가능한 fixture로 고정

**Files:**

- Create: `web/scripts/build-change-review-replays.mjs`
- Create: `web/fixtures/change-review-replays.json`
- Modify: `web/package.json`

**Interfaces:**

- Consumes: `datasets/github-role-division-candidates-v1/candidates.jsonl`
- Consumes: `evals/github-role-division-2026-09-11/results/<variant>/<case-id>.json`
- Produces: `{ schemaVersion: 1, cases: ReplayFixture[] }`
- Invariant: fixture의 `response`는 결과 파일의 `response`와 deep-equal이어야 한다.

- [ ] **Step 1: 생성 스크립트에 고정 선택 목록을 작성한다**

```js
const selections = [
  ['sol-low', 'GH-TL-1114781787'],
  ['luna-low', 'GH-TL-1125100581'],
  ['luna-low', 'GH-TL-4880873604'],
  ['sol-low', 'GH-TL-5210407787'],
];
```

`import.meta.url`을 기준으로 프로젝트 루트를 계산해 실행 cwd에 의존하지 않게 한다. `node:fs`, `node:path`, `node:crypto`만 사용한다.

- [ ] **Step 2: 원본 결과와 입력을 검증한다**

각 선택에 대해 다음 조건이 아니면 명시적 오류로 중단한다.

```js
run.status === 'success'
run.response.id === caseId
candidate.id === caseId
Array.isArray(candidate.input.excerpts)
Array.isArray(candidate.input.prior_project_state.tasks)
```

- [ ] **Step 3: 필요한 필드만 fixture에 보존한다**

```ts
type ReplayFixture = {
  caseId: string;
  variant: string;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  thread: { title: string; url: string };
  excerpts: Array<{
    index: number;
    text: string;
    authorLogin: string;
    createdAt: string;
    sourceUrl: string;
  }>;
  tasks: Array<{
    task_id: string;
    title: string;
    state: string;
    closed_reason: string | null;
    assignees: string[];
  }>;
  members: string[];
  response: EvalResponse;
  provenance: {
    resultPath: string;
    resultSha256: string;
    candidatePath: string;
    candidateLineSha256: string;
  };
};
```

`authentication`, token usage, API 오류 세부는 fixture에 넣지 않는다. 생성 시각도 넣지 않아 재실행 결과를 결정적으로 유지한다.

- [ ] **Step 4: package script를 추가하고 두 번 생성해 동일성을 확인한다**

```json
"replays:build": "node scripts/build-change-review-replays.mjs"
```

Run:

```bash
cd web
npm run replays:build
shasum -a 256 fixtures/change-review-replays.json
npm run replays:build
shasum -a 256 fixtures/change-review-replays.json
```

Expected: 두 해시가 같고 사례가 정확히 4건이다.

- [ ] **Step 5: 해당 파일만 커밋한다**

```bash
git add web/scripts/build-change-review-replays.mjs web/fixtures/change-review-replays.json web/package.json
git commit -m "test: freeze AI response replay cases"
```

---

### Task 2: 평가 스키마를 화면용 계약으로 변환하고 기존 GET API에 연결

**Files:**

- Create: `web/lib/change-review-replay.ts`
- Modify: `web/app/api/change-proposals/route.ts`
- Modify: `web/tests/change-proposals.test.mjs`

**Interfaces:**

- Consumes: `ReplayFixture`
- Produces: `ReplayListItem[]`, `ReplayReview`
- GET list: `/api/change-proposals?project=<projectId>`의 기존 응답에 `replayCases` 추가
- GET item: `/api/change-proposals?project=<projectId>&replay=<caseId>` → `{ replay: ReplayReview }`
- Security: 기존 `identity()`와 `member(projectId, user)` 검사를 통과한 뒤에만 반환

- [ ] **Step 1: 화면용 타입을 정의한다**

```ts
export type ReplayDecision =
  | 'propose_changes'
  | 'no_change'
  | 'needs_clarification';

export type ReplayEvidence = {
  excerptIndex: number;
  start: number;
  end: number;
  quote: string;
  sourceUrl: string;
};

export type ReplayChange = {
  changeId: string;
  kind: string;
  taskId: string | null;
  taskTitle: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  unknownBefore: string[];
  evidenceItems: ReplayEvidence[];
  basis: 'fact' | 'estimate';
  needsReview: string;
  requires: 'owner' | 'assignee';
  blocked: string;
};

export type ReplayReview = {
  origin: 'replay';
  readOnly: true;
  caseId: string;
  model: string;
  variant: string;
  reasoningEffort: string;
  status: 'ready' | 'failed';
  decision: ReplayDecision;
  summary: string;
  clarification: string | null;
  source: { title: string; url: string; body: string };
  proposal: {
    id: string;
    model: string;
    promptVersion: 'evaluation-2026-09-11';
    status: 'pending' | 'failed';
    error: string;
    changes: ReplayChange[];
  };
};
```

- [ ] **Step 2: 원문 body와 발췌 문자 위치를 만드는 실패 테스트를 추가한다**

발췌는 다음 형식으로 합친다. 근거 위치는 헤더가 아니라 실제 `text`의 시작과 끝을 가리킨다.

```text
[발췌 0] haram22 · 2022-05-02 12:17 KST
좋아요 !! 제가 UD 파트 해도 될까요 !?

[발췌 1] majink · 2022-05-02 12:17 KST
...
```

핵심 단언:

```js
assert.equal(
  review.source.body.slice(evidence.start, evidence.end),
  evidence.quote,
);
```

- [ ] **Step 3: 모든 변경 종류의 before/after 매핑 테스트를 추가한다**

| 평가 `kind` | `before` | `after` |
|---|---|---|
| `createTask` | `{}` | `{ title, person, remaining, dependsOn: [] }` |
| `status` | 현재 task state | `{ status }` |
| `assignee` | `{ person: assignees[0] ?? null }` | `{ person }` |
| `remaining` | `{ remaining: null }` + `unknownBefore` | `{ remaining: remaining_hours }` |
| `dueAt` | `{ dueAt: null }` + `unknownBefore` | `{ dueAt: due_at }` |
| `complete` | `{ done: state === 'closed' }` | `{ done: true }` |

평가 입력에 없는 이전 공수와 마감을 `없음`으로 단정하지 않는다. `unknownBefore`에 필드명을 넣어 화면에서 `평가 입력에 없음`으로 표시한다.

- [ ] **Step 4: 근거, 담당자, 확인 필요 상태를 변환한다**

- `evidence_excerpt_indices`의 모든 인덱스를 `evidenceItems`로 변환한다.
- 인덱스가 범위를 벗어나면 근거를 버리지 말고 해당 replay를 `failed`로 만든다.
- `person`이 멤버 목록에 있으면 문자열 로그인을 그대로 표시한다.
- `createTask` 또는 `assignee`에서 `person === null`이면 `needsReview`를 `담당자 미정`으로 설정한다.
- 모든 replay 변경은 `blocked: '저장된 평가 응답 재생은 적용할 수 없습니다.'`로 설정한다.
- `decision`, `summary_ko`, `clarification_reason_ko`는 재분류하지 않고 원본에서 옮긴다.

- [ ] **Step 5: 고정 사례 4건의 변환 테스트를 통과시킨다**

```js
assert.equal(changed.decision, 'propose_changes');
assert.equal(changed.proposal.changes[0].after.person, 'majink');
assert.equal(noChange.decision, 'no_change');
assert.deepEqual(noChange.proposal.changes, []);
assert.equal(clarification.decision, 'needs_clarification');
assert.match(clarification.clarification, /task_id/);
assert.ok(unassigned.proposal.changes.every((c) => c.after.person === null));
assert.ok(unassigned.proposal.changes.every((c) => c.needsReview === '담당자 미정'));
```

- [ ] **Step 6: 기존 GET 라우트에 replay 목록과 단건 조회를 추가한다**

처리 순서를 다음으로 고정한다.

1. 로그인 확인
2. `project` 멤버십 확인
3. `replay`가 있으면 해당 단건 반환, 없는 ID는 404
4. 기존 `proposal` 상세 또는 목록 반환

목록의 `replayCases`는 `caseId`, 한국어 표시 이름, `decision`, `model`, `variant`만 포함한다.

- [ ] **Step 7: API 통합 테스트에서 권한과 DB 불변을 검증한다**

`web/tests/change-proposals.test.mjs`의 기존 DB fixture와 회원 설정을 재사용한다.

```js
test('회원은 실제 평가 응답 4건을 읽고 DB는 바뀌지 않는다', async () => {
  const { projectId } = await startedTeam('replay', 'replaymate');
  const count = (table) =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const before = {
    tasks: count('sprint_tasks'),
    proposals: count('ai_change_proposals'),
    applications: count('ai_change_applications'),
  };
  const listResponse = await proposalGet('replay', `project=${projectId}`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.replayCases.length, 4);

  const response = await proposalGet(
    'replay',
    `project=${projectId}&replay=GH-TL-1114781787`,
  );
  assert.equal(response.status, 200);
  const { replay } = await response.json();
  assert.equal(replay.decision, 'propose_changes');
  const evidence = replay.proposal.changes[0].evidenceItems[0];
  assert.equal(replay.source.body.slice(evidence.start, evidence.end), evidence.quote);
  assert.deepEqual(
    {
      tasks: count('sprint_tasks'),
      proposals: count('ai_change_proposals'),
      applications: count('ai_change_applications'),
    },
    before,
  );
});

test('비회원과 없는 replay ID는 각각 403과 404다', async () => {
  const { projectId } = await startedTeam('replayguard', 'replayguardmate');
  assert.equal(
    (await proposalGet('outsider', `project=${projectId}&replay=GH-TL-1114781787`)).status,
    403,
  );
  assert.equal(
    (await proposalGet('replayguard', `project=${projectId}&replay=missing`)).status,
    404,
  );
});
```

Run:

```bash
cd web
node --experimental-strip-types --test tests/change-proposals.test.mjs
```

Expected: PASS. replay 조회 전후 업무·제안·적용 행 수가 같다.

- [ ] **Step 8: 해당 파일만 커밋한다**

```bash
git add web/lib/change-review-replay.ts web/app/api/change-proposals/route.ts web/tests/change-proposals.test.mjs
git commit -m "feat: adapt saved AI responses for review"
```

---

### Task 3: 기존 변경안 검토 화면에 읽기 전용 재생 모드 연결

**Files:**

- Modify: `web/components/change-review.tsx`
- Modify only if existing classes are insufficient: `web/app/globals.css`

**Interfaces:**

- Consumes: list response의 `replayCases`, detail response의 `{ replay: ReplayReview }`
- Preserves: 기존 source paste, fake/live proposal creation, edit, partial approval, history, revert
- Modes: `project`, `replay`

- [ ] **Step 1: 보기 모드와 replay 상태를 추가한다**

```ts
type ReviewMode = 'project' | 'replay';

const [mode, setMode] = useState<ReviewMode>('project');
const [replayCases, setReplayCases] = useState<ReplayListItem[]>([]);
const [replayId, setReplayId] = useState('');
const [replay, setReplay] = useState<ReplayReview | null>(null);
const [replayBusy, setReplayBusy] = useState(false);
const [replayError, setReplayError] = useState('');
```

`refresh()`의 기존 GET 응답에서 `replayCases`를 함께 저장해 목록용 API 호출을 추가하지 않는다.

- [ ] **Step 2: 기존 섹션 머리에 두 개의 보기 모드를 제공한다**

`NativeSelect`를 재사용한다.

- `프로젝트 원문 분석`
- `저장된 실제 AI 응답 재생`

모드 전환 시 기존 live proposal, 선택, 편집 상태를 삭제하지 않는다. replay만 별도 상태로 둔다.

- [ ] **Step 3: 사례 선택, 로딩, 오류, 재시도를 연결한다**

```ts
async function openReplay(id: string) {
  setReplayId(id);
  setReplay(null);
  setReplayError('');
  setReplayBusy(true);
  try {
    const data = await call(
      `/api/change-proposals?project=${encodeURIComponent(projectId)}&replay=${encodeURIComponent(id)}`,
    );
    setReplay(data.replay as ReplayReview);
  } catch (error) {
    setReplayError((error as Error).message);
  } finally {
    setReplayBusy(false);
  }
}
```

- 로딩: `role="status"`, `aria-live="polite"`, `AI 응답을 불러오는 중입니다.`
- 오류: 오류 문구와 `다시 시도` 버튼. 현재 `replayId`로 같은 함수를 다시 호출한다.
- 요청 중 mode가 바뀌면 늦은 응답이 프로젝트 모드를 덮지 않도록 `AbortController` 또는 request sequence number 중 짧은 방법을 쓴다.

- [ ] **Step 4: 기존 변경 카드 마크업을 live/replay가 공유하게 한다**

`proposal.changes.map(...)` 마크업을 복제하지 않고 다음 차이만 조건 처리한다.

- replay의 `taskTitle`이 있으면 현재 프로젝트 task 조회보다 우선한다.
- `person`이 문자열이면 평가의 GitHub 로그인으로 표시하고, 숫자면 기존 멤버 조회를 유지한다.
- `evidenceItems`가 있으면 전부 표시하고, live의 기존 단일 `evidence`도 그대로 표시한다.
- 신규 업무도 `변경 전 없음 → 변경 후 <업무명, 담당자, 공수>`를 표시한다.
- `unknownBefore` 필드는 `없음`이 아닌 `평가 입력에 없음`으로 표시한다.
- replay 체크박스는 보이되 disabled로 두고, 편집 필드와 승인 버튼은 숨긴다.
- project 모드의 체크박스, 편집, 승인 동작은 바꾸지 않는다.

- [ ] **Step 5: 판단 상태별 문구를 렌더링한다**

| 상태 | 표시 |
|---|---|
| `propose_changes` | 해석 요약 + 변경 카드 목록 |
| `no_change` | 해석 요약 + `변경할 업무가 없습니다.` |
| `needs_clarification` | 해석 요약 + `확인 필요` + clarification |
| `failed` | `분석 결과를 불러오지 못했습니다.` + 재시도 |

모델명은 메타데이터로만 표시하고 상태 분기에는 사용하지 않는다.

- [ ] **Step 6: 재생 표식과 원문을 표시한다**

상단에 다음 문구를 항상 표시한다.

> 저장된 평가 응답 재생 · 우리 프로젝트에 반영되지 않음

모델, effort, case ID, 원본 링크는 보조 정보로 표시한다. 외부 근거 링크는 `target="_blank" rel="noreferrer"`로 연다. 원문은 기존 `source-body` 스타일을 재사용한다.

- [ ] **Step 7: 기존 프로젝트 분석의 로딩과 실패 상태도 명시적으로 유지한다**

- `createProposal()` 중에는 버튼 문구를 `분석 중…`으로 바꾸고 disabled 처리한다.
- `proposal.status === 'failed'`이면 기존 오류·DB 불변 안내와 `다시 분석`을 보인다.
- replay 오류와 프로젝트 분석 오류는 별도 상태로 관리한다.

- [ ] **Step 8: 키보드와 모바일 화면을 수동 확인한다**

Run:

```bash
cd web
npm run dev
```

확인 목록:

1. 키보드만으로 보기 모드와 사례를 선택할 수 있다.
2. 4개 사례가 각각 변경 있음, 변경 없음, 확인 필요, 담당자 미정으로 표시된다.
3. replay에서는 선택, 편집, 승인이 불가능하고 DB가 바뀌지 않는다.
4. project 모드로 돌아오면 기존 원문, 제안, 이력 흐름이 정상 동작한다.
5. 390px 너비에서 원문, 근거, 변경 전후가 가로로 잘리지 않는다.
6. 200% 텍스트 확대에서도 선택기와 재시도 버튼을 사용할 수 있다.

- [ ] **Step 9: 해당 파일만 커밋한다**

```bash
git add web/components/change-review.tsx web/app/globals.css
git commit -m "feat: show saved AI responses in change review"
```

`globals.css`가 바뀌지 않았다면 staging 대상에서 뺀다.

---

### Task 4: 회귀 검증과 현재 스프린트 기록

**Files:**

- Modify: `docs/current-sprint.md`

**Interfaces:**

- Produces: 실제 응답 재생 기능의 범위, 검증 결과, 남은 제한 기록

- [ ] **Step 1: fixture 생성과 관련 통합 테스트를 재실행한다**

```bash
cd web
npm run replays:build
node --experimental-strip-types --test tests/change-proposals.test.mjs
```

Expected: PASS. 재생 조회로 DB 행이 변하지 않는다.

- [ ] **Step 2: 전체 회귀 검증을 실행한다**

```bash
cd web
npm test
npx tsc --noEmit
npx oxlint components/change-review.tsx lib/change-review-replay.ts app/api/change-proposals/route.ts tests/change-proposals.test.mjs
npm run build
```

Expected:

- 기존 test suite 전체 PASS
- TypeScript 오류 0
- 수정 파일 lint 오류 0
- Vinext/Workers production build PASS

기존 `components/ui/*`의 무관한 lint 오류를 이번 범위에서 정리하지 않는다.

- [ ] **Step 3: diff를 요구사항에 대조한다**

```bash
git diff --check
git status --short
git diff -- web/package.json web/scripts/build-change-review-replays.mjs web/fixtures/change-review-replays.json web/lib/change-review-replay.ts web/app/api/change-proposals/route.ts web/components/change-review.tsx web/app/globals.css web/tests/change-proposals.test.mjs docs/current-sprint.md
```

확인:

- 모델명을 보고 화면을 분기하는 코드가 없다.
- replay를 apply/revert 요청으로 보내는 경로가 없다.
- 변경 없음과 확인 필요 상태에서도 요약이 사라지지 않는다.
- 복수 근거 인덱스를 모두 표시한다.
- 기존 평가 원본과 무관한 작업 트리 파일을 수정하지 않았다.

- [ ] **Step 4: 현재 스프린트 문서에 검증 결과를 기록한다**

`docs/current-sprint.md`에 다음을 명시한다.

- 실제 Sol low 평가 응답 4건을 읽기 전용으로 재생 표시함
- 변경 있음, 변경 없음, 확인 필요, 담당자 미정 화면을 확인함
- 운영 모델 API와 승인 반영은 여전히 미연결임
- 실행한 자동 검사와 수동 브라우저 확인 결과

- [ ] **Step 5: 문서만 커밋한다**

```bash
git add docs/current-sprint.md
git commit -m "docs: record AI response replay verification"
```

## 완료 기준

1. `GH-TL-1114781787`이 변경 전후, `majink`, 원문 근거, disabled 체크박스와 함께 표시된다.
2. `GH-TL-1125100581`은 해석 요약과 `변경할 업무가 없습니다.`를 표시한다.
3. `GH-TL-4880873604`는 완료·종료 보고와 기존 `task_id`를 연결할 수 없어 확인이 필요하다는 사유를 표시한다.
4. `GH-TL-5210407787`의 신규 업무 6개가 모두 `담당자 미정`으로 표시된다.
5. 재생 상태가 명시되고, 재생 화면에서 승인이나 DB 쓰기를 할 수 없다.
6. 로딩, 실패, 재시도가 보이며 키보드와 모바일에서 사용할 수 있다.
7. 모델 교체는 화면 코드 변경을 요구하지 않고 서버 변환 계약만 맞추면 된다.
8. 기존 원문 붙여넣기, 가짜 모델 분석, 편집, 부분 승인, 이력, 되돌리기 회귀 테스트가 통과한다.

## 이번에 하지 않는 것

- 실제 모델 API 호출
- Luna/Sol 자동 라우팅과 운영 모델 선정
- 48건 × 4개 모델 전체 결과 탐색 대시보드
- replay 결과를 현재 프로젝트 업무에 승인·적용하는 기능
- D1 스키마 또는 마이그레이션 변경
- 새 UI 의존성, Storybook, 브라우저 테스트 프레임워크 추가
