# 솔로플레이와 필수 결과물 제거 설계

2026-10-14 피드백("솔로플레이 가능하게", "필수 결과물은 없어도 될 듯")에 대한 세션 1 설계다.
지시문: docs/handoff/2026-10-14-feedback-tasks.md 세션 1.

## 사용자 결정 (2026-10-14)

1. 새 프로젝트에서 필수 결과물을 **없앤다**(선택 입력도 아님).
2. 완주 판정은 **완료 기준 문장에 대한 근거 1건 + 팀장 확인**이다.
3. 솔로(팀장 1명)도 같은 규칙: 본인이 근거를 남기고 본인이 확인한다.
4. 솔로로 시작한 뒤에도 초대·합류를 허용한다(지금 규칙 유지, 최대 4명).

이유: 필수 결과물의 가장 큰 근거였던 보증금 환급 판정은 구현·계획되지 않았다. "약속한 결과를
냈는가"는 시작 시 고정되는 완료 기준과 그 근거로 충분하다. 잃는 것은 항목별 진척 표시뿐이다.

## 규칙

**시작.** `MIN_MEMBERS = 1`. 팀장은 생성 시 목표에 동의한 상태로 저장되므로 솔로 프로젝트는 바로
시작할 수 있다. 2명 이상이면 지금처럼 현재 멤버 전원의 최신 목표 동의가 필요하다. 시작 조건에서
"필수 결과물 1개 이상" 문구는 사라진다(완료 기준 항목이 항상 있으므로 검사 자체는 데이터 손상
방어로만 남는다).

**새 프로젝트.** 생성 시 서버가 `project_deliverables`에 완료 기준 항목 1행을 넣는다.
`deliverable_id = 'd_criteria'`, `title = '완료 기준'`, `position = 0`. 요청 본문의 `deliverables`는
읽지 않는다(보내도 무시). `project_details.deliverables`에는 `[]`를 저장한다(칼럼 NOT NULL 유지).
editGoal도 결과물을 받지 않는다. editGoal은 고정 전 결과물 행을 지우고 완료 기준 행 1개를 다시
넣는다(완료 기준 문장이 바뀔 수 있으므로 준비 중 남긴 근거·확인도 풀린다. 지금 결과물 편집과 같은
동작). 시작하면 기존 쿼리가 이 행의 `fixed_at`을 채운다.

**기존 프로젝트.** 이미 저장된 결과물 행은 그대로 둔다. 판정·근거·확인·고정 규칙도 그대로다.
준비 중(draft)인 기존 프로젝트에서 editGoal을 하면 고정 전 결과물 행을 지우고 완료 기준 행 1개로
바꾼다(새 규칙으로 이행). 진행 중·완주·종료 프로젝트는 editGoal이 불가하므로 영향이 없다.

**완주.** 판정 함수는 같다: 모든 행에 근거가 있고 팀장이 확인했으면 완주 가능. 근거 기록은 멤버
누구나, 확인·완주는 팀장만. 근거를 다시 쓰면 확인이 풀린다.

## API 모양 (UI 세션 계약)

- `GET /api/sprint`의 `readiness`: `{ ready, joined, agreed, missing[] }` 그대로. 솔로면 `joined=1`, `ready=true`.
- `completion`: `{ ready, total, confirmed, missing[], mode }`.
  `mode = 'criteria'`는 결과물 행이 `d_criteria` 하나뿐일 때, 그 외(기존 결과물 프로젝트·legacy)는 `'deliverables'`.
- `deliverables` 배열은 그대로 내려간다. criteria 모드에서는 `d_criteria` 한 행이며, 화면은 이 행의
  `deliverableId`로 기존 `deliverableEvidence`·`deliverableConfirm` action을 그대로 쓴다.
- `POST /api/projects` create: `deliverables` 필드 불필요(무시). editGoal(`POST /api/sprint`)도 같다.
- 초대 미리보기(`GET /api/projects?invite=`)의 `details.deliverables`: `d_criteria` 행은 빼고 보낸다
  (새 프로젝트는 `[]`).

## 바꾸는 곳

- `web/lib/sprint-policy.ts`: `MIN_MEMBERS = 1`, `startReadiness` 결과물 문구 정리.
- `web/lib/deliverables.ts`: `CRITERIA_ID`, `completionCheck`에 `mode`. `parseDeliverables` 삭제(호출처 없음).
- `web/lib/projects.ts`: `goalInput`에서 결과물 제거, 생성 시 완료 기준 행 삽입, 초대 미리보기 필터.
- `web/app/api/sprint/route.ts`: editGoal의 결과물 삭제·삽입을 완료 기준 행 교체로, `finish`의
  거절·기록 문구를 모드에 맞게.
- `web/lib/reminder-dispatch.ts`: 미확인 결과물 제목을 메일 본문에 쓴다. 메일은 운영에서 실행하지
  않으므로 바꾸지 않는다('완료 기준'이 제목으로 들어가도 의미가 통한다).
- `web/lib/ai-extraction.ts`: 프롬프트의 "합의 결과물" 줄은 유일한 호출처(change-proposals)가 이미
  `[]`를 넘긴다. 바꾸지 않는다.
- 화면 파일은 고치지 않는다. 생성 폼의 결과물 입력은 UI 세션이 숨긴다(서버가 무시하므로 남아 있어도 동작).
- 마이그레이션 없음. 칼럼·데이터 삭제 없음.

## 테스트 (TDD)

1. 1인 생성 → 시작(ready, joined=1) → 완료 기준 근거 → 본인 확인 → 완주.
2. 결과물 필드를 보내도 무시되고 `completion.mode='criteria'`, 결과물 행은 `d_criteria` 1개.
3. editGoal 후에도 완료 기준 행 1개 유지(준비 중 근거는 풀림), 목표 버전 증가.
4. 기존 결과물 프로젝트 회귀: DB에 결과물 행 2개를 직접 넣은 2인 프로젝트에서 미동의면 시작 거절,
   하나 미확인이면 완주 거절, 모두 확인하면 완주, `mode='deliverables'`.
5. 권한: 팀원은 완료 기준 확인·완주 불가, 근거 기록은 가능.
6. 단위: `startReadiness` 1인 ready, 2인 미동의 거절. `completionCheck` 모드 판정.
7. 기존 테스트의 "1인 시작 거절" 기대값은 새 규칙으로 바꾼다.

## 운영 확인

운영 DB 읽기 전용 쿼리 1회:
- 정책이 있는(legacy 아님) 프로젝트 중 결과물 행이 0개인 것이 없는지.
- `deliverable_id = 'd_criteria'`인 기존 행이 없는지.

## 문서

CLAUDE.md, docs/features.md, web/README.md의 "필수 결과물", "최소 2명" 서술을 실제 동작에 맞게 고친다.
