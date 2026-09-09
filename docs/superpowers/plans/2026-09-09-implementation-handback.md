# 구현 인계 — A → B → C (2026-09-09)

계획 문서: [시작 문서](2026-09-09-claude-handoff.md) ·
[A](2026-09-09-a-sprint-policy.md) · [B](2026-09-09-b-deadline-email.md) ·
[C](2026-09-09-c-ai-change-review.md) · [설계](../specs/2026-09-09-spartan-sprint-design.md)

브랜치 `phs`. 구현 커밋 3개(A `3987bf3`, B `b6595b6`, C `42c0643`)와
사용자 검토 후 수정 커밋 4개(`c9f1d07`, `92221ce`, `3e512ef`, `04e7219`).
`main` 병합·브랜치 삭제·강제 푸시·원격 푸시는 하지 않았다.

## 사용자 검토 지적 9건과 수정 (2026-09-09)

| # | 문제 | 수정 | 재현 테스트 |
|---|---|---|---|
| 3 | Drizzle 정의와 실제 DB 구조 불일치 | `schema.ts`를 0005~0007에 맞추고 빠진 스냅샷 생성 | `schema-migrations.test.mjs` |
| 1 | 확인하지 않은 목표에 동의 | 수락 요청에 확인한 `goalVersion` 필수, 저장 조건에도 포함 | `save-guards.test.mjs` |
| 2 | 종료 후 원문·변경안 저장 | INSERT에 상태·마감·멤버십 조건, 머리 행과 세부 항목 원자 저장 | `save-guards.test.mjs` |
| 4 | 되돌리기가 후속 기록 삭제 | 업무별 `change_version`으로 생성 이후 수정 여부 판단 | `apply-revert.test.mjs` |
| 6 | 같은 원문에서 중복 생성 | `baseRevision` 검사 + 원문·근거 위치 기반 후보 키 재검사 | `apply-revert.test.mjs` |
| 5 | AI 담당 변경 후 알림 소실 | 업무별 최종 상태를 먼저 계산해 한 번만 저장·재예약 | `reminder-consistency.test.mjs` |
| 7 | 다른 프로젝트 알림 충돌 | 단계 정리 키에 `projectId` 포함, 묶음은 수신자·시각 기준 | `reminder-consistency.test.mjs` |
| 8 | 보내지 않은 내용을 완료로 기록 | 한도를 수신자 단위로 적용, 한 묶음을 통째로 확보 | `reminder-consistency.test.mjs` |
| 9 | 완료된 업무에 독촉 발송 | 각 메일 직전에 최신 상태 재확인, 빈 묶음 미발송 | `reminder-consistency.test.mjs` |

수정으로 추가된 마이그레이션: `0008_task_change_version`, `0009_batch_recipient_slot`.
바뀐 요청 계약: `POST /api/projects` `action:'accept'`에 `goalVersion` 필수.

## 착수 전 확인한 기술 결정

| 결정 | 사용자 답변 | 반영 |
|---|---|---|
| 프로젝트 마감 계산 | **시작 시각 + 선택한 일수** | `deadlineFrom()`. 마지막 날 18시 고정 규칙 폐기 |
| 이메일 운영 발송 | 정보를 제공하겠다 | 어댑터·예약·발송 구현. 자격 정보 대기 중이라 실제 발송 미검증 |
| 운영 AI 모델 | 가짜 모델로 흐름만 | 결정적 가짜 모델 연결. 실제 호출 경로 없음 |

## 변경한 파일

**신규 (17)**
`web/lib/`: `sprint-policy.ts`, `deliverables.ts`, `reminders.ts`,
`reminder-store.ts`, `reminder-dispatch.ts`, `email.ts`, `source-documents.ts`,
`ai-extraction.ts`, `change-proposals.ts`
`web/app/api/`: `internal/reminders/route.ts`, `sources/route.ts`,
`change-proposals/route.ts`
`web/components/`: `source-paste.tsx`, `change-review.tsx`
`web/drizzle/`: `0005_spartan_policy.sql`, `0006_deadline_reminders.sql`,
`0007_ai_change_review.sql`

**수정 (11)**
`web/lib/`: `projects.ts`, `sprint-store.ts`, `sprint.ts`, `utils.ts`
`web/app/`: `api/projects/route.ts`, `api/sprint/route.ts`, `page.tsx`
`web/components/`: `project-workspace.tsx`, `task-collection.tsx`, `task-editor.tsx`
`web/package.json` (테스트 실행 대상 6개 파일)

**테스트 (신규 5, 수정 2)**
`sprint-policy.test.ts`, `reminders.test.ts`, `reminder-dispatch.test.mjs`,
`change-proposals.test.mjs`, `change-guardrails.test.mjs` / `sprint.test.ts`, `api.test.mjs`

**문서·평가**: `CLAUDE.md`, `docs/features.md`, `docs/current-sprint.md`,
`docs/eval.md`, `docs/reminders-operations.md`,
`evals/change-review/2026-09-09/{scenarios.json,REPORT.md}`

기존 마이그레이션 0000~0004와 공개 원문 데이터셋은 수정하지 않았다.
Python `server/`, `scripts/`, 기존 모델 평가 결과도 건드리지 않았다.

## 재현 방법

모든 명령은 `web/`에서 실행한다.

```bash
npm ci && npm test && npx tsc --noEmit && npm run build && npm run db:migrate
```

린트는 서비스 파일만 전달한다. `components/ui/*`의 기존 오류는 이번 변경과 무관하다.

```bash
npx oxlint lib app/api app/page.tsx components/change-review.tsx components/source-paste.tsx components/project-workspace.tsx components/task-collection.tsx components/task-editor.tsx
```

## 실행한 검사와 결과

| 검사 | 결과 |
|---|---|
| `npm test` | 116개 통과 / 0 실패 |
| `npx tsc --noEmit` | 통과 |
| `npx oxlint` (서비스 파일) | 통과 |
| `npm run build` | 통과 |
| `npm run db:migrate` (로컬 D1) | 0005·0006·0007 적용 |
| `datasets/.../validate.py` | `integrity: passed` (변경 없음 확인) |

테스트 116개 구성: 일정·공수 16, 정책 14, 알림 계산 13, 가드레일 2,
마이그레이션 3, API 통합 16, 알림 통합 13, 변경안 통합 18,
저장 검사 7, 승인·복구 7, 알림 정합성 7.

## 모의 검증과 운영 연결의 구분

| 항목 | 검증한 것 | 검증하지 않은 것 |
|---|---|---|
| 이메일 | 가짜 전송기로 예약·취소·묶음·중복·재시도·실패 기록·전송 직전 상태 재확인 | **실제 메일 발송, 제공자 응답, 배달 시간, 수신 화면** |
| 정기 실행 | 인증된 진입점의 무인증·오인증 거절, 확보·복구 | **외부 스케줄러 등록, 브라우저를 닫은 상태의 실제 실행** |
| AI 모델 | 가짜 모델로 원문·검증·부분 승인·권한·충돌·되돌리기 전 경로 | **실제 모델 호출, 프롬프트 품질, 해석 정확도** |
| 화면 | 타입·린트·빌드 | **브라우저 화면 흐름, 실제 두 계정 협업** |

## 알려진 제약

1. **실제 이메일 미발송.** `EMAIL_PROVIDER`/`EMAIL_API_KEY`/`EMAIL_FROM`이 모두
   없으면 기록용 전송기가 쓰이고 `live:false`로 표시된다. 절차와 한계는
   [운영 문서](../../reminders-operations.md).
2. **플랫폼 내장 정기 실행이 없다.** `.openai/hosting.json`에 예약 항목이 없고,
   빌드가 만드는 `dist/server/wrangler.json`의 `triggers`가 비어 있으며,
   `vinext/server/fetch-handler`는 fetch 핸들러만 내보낸다. 외부 HTTP 실행기가
   `REMINDER_RUNNER_SECRET`으로 `POST /api/internal/reminders`를 호출해야 한다.
3. **외부 메일의 정확히 한 번 전달은 보장하지 않는다.** DB 고유성과 동일 전송
   식별자로 중복 생성은 막지만, 제공자 접수 여부가 불명확한 응답은 `unknown`으로
   남기고 자동 재발송하지 않는다. 접수된 메일은 회수할 수 없다.
4. **운영 AI 모델 미연결.** `useModel()`로 교체할 수 있게 경계만 두었다.
   가드레일 평가는 형식·권한 검증만 측정했고 대상 선택의 옳고 그름은 사람이 본다.
   [평가 보고서](../../../evals/change-review/2026-09-09/REPORT.md).
5. **실제 두 계정 검증 미완료.** 로컬 개발 서버는 모의 로그인 1개만 제공하고
   인증 헤더 주입도 막혀 있어 이번 자동 검증에 포함하지 못했다.
6. **이전 규칙 프로젝트는 읽기 전용 보존.** 자동 전환을 하지 않기로 한 규칙을
   지키되, 명시적 전환 기능은 만들지 않았다. 기존 업무·체크인·가용시간 기록과
   결과물 텍스트는 그대로 남고 조회·내보내기만 가능하다. 전환이 필요하면 별도 결정 필요.
7. **준비(draft) 중에는 업무 마감을 지정할 수 없다.** 최종 기한이 확정되지 않아
   초과 여부를 검사할 수 없기 때문이다. 계획의 "미정 마감 허용"은 마감 없이
   업무를 만드는 것으로 구현했다.
8. **묶음 발송의 처리 한도는 수신자 수 기준이다(기본 50명).** 한 수신자의 도래
   항목을 모두 확보하므로 알림이 아주 많은 사용자가 있으면 한 번의 실행이 길어질
   수 있다. 실행 간격과 한도는 운영하며 조정한다.
9. **`save()`의 쓰기 시점 검사는 DB 시계를 쓴다.** 상태·마감 조건을 CAS UPDATE에
   포함해 `strftime('now')`와 비교한다. 요청 시작 시각만으로 통과한 늦은 쓰기는
   거절되지만, D1과 애플리케이션 시계가 크게 어긋나면 판정도 어긋난다.

## B·C가 재사용한 A의 계약

- `assertProjectMutationAllowed({policy, actor, action, now, assigneePerson, targetUserId})`
  → 유효 상태를 돌려주거나 `PolicyError`. `RULES`에 없는 action은 거절.
- `save(owner, sprint, action, detail, extras, states)` → 버전 CAS + 상태·마감 조건 +
  `mutation` 게이트를 건 모든 부수 쓰기를 한 트랜잭션으로 처리. B의 예약 갱신과
  C의 승인·이력이 모두 이 경계를 지난다.
- `effectiveLifecycle(policy, now)` — 저장 상태보다 시계를 우선한다.
- `readPolicy` / `readMembers` / `readDeliverables` / `currentPlan`.

## 다음에 할 일

- [ ] 이메일 제공자·발신 도메인·테스트 수신 주소 확인 후 환경 변수 설정, 실제 발송 검증
- [ ] 외부 정기 실행기 등록(1분 간격 권장)과 브라우저를 닫은 상태의 동작 확인
- [ ] 실제 두 계정으로 준비 → 목표 변경 → 재동의 → 시작 → 승인 → 결과물 확인 → 완주
- [ ] 운영 AI 모델 연결 여부 결정과 예산·인증 방식 확인
- [ ] 이전 규칙 프로젝트의 명시적 전환이 필요한지 결정
- [ ] 이미 배포된 DB가 있다면 0008·0009 마이그레이션 적용
