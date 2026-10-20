# 동료평가 점수·등급·뱃지 설계 (세션 3)

2026-10-14 피드백 "바이럴될 만한 요소(점수, 등급, 뱃지)"의 서버 규칙과 API. 화면은 UI 세션이 만든다.
공유 링크(바이럴)는 이번 범위에서 뺐다(사용자 결정 2026-10-20).

## 사용자 결정 (2026-10-20)

| 항목 | 결정 |
|---|---|
| 점수 기준 | **개인 점수 = 동료평가 100%**. 체크인·변경 기록에는 작성자(user_id)가 없어 개인 활동 점수로 쓰지 않는다. |
| 평가 시점 | 프로젝트가 끝난 뒤(완주 또는 기한 종료) **7일 안에 1회**. 제출 후 수정 불가. 자기 평가 없음. |
| 문항 | 기여도·소통·약속 이행, 각 1~5점 정수. |
| 익명성 | 본인은 받은 평균과 평가한 인원 수만 본다. **2명 이상**이 평가해야 점수를 보여준다. 팀장도 다른 사람의 점수·개별 평가는 못 본다. |
| 등급 | S ≥ 90, A ≥ 75, B ≥ 60, 그 아래 C. **평가 기간이 끝난 뒤 확정**하며 그 전에는 점수·등급 모두 `null`. |
| 뱃지 | 7일 완주, 솔로 완주, 매일 진행 보고(팀), 병목 0으로 완주, 동료평가 기반 개인 뱃지. |

## 점수 계산

- 문항별 평균 = 그 사람이 받은 평가의 해당 문항 평균(1~5).
- 점수 = 세 문항 평균의 평균 × 20, 소수 첫째 자리 반올림(만점 100, 최저 20).
  등급은 반올림한 점수로 판정한다(S 90 = 평균 4.5).
- breakdown은 문항별 `평균 × 20 / 3`(소수 첫째 자리)이며, 화면 표시용이다. 합은 반올림 오차로 점수와 0.1 안팎 다를 수 있다.
- 평가 기간 중에는 점수를 숨긴다. 평가가 들어올 때마다 점수가 바뀌면 누가 몇 점을 줬는지 추정할 수 있어서다.
- 같은 평가 기록이면 언제 조회해도 같은 점수다(순수 함수 `peerScore`).

## 평가 대상과 기간

- 끝난 시각(`endAt`) = 완주 시각, 없으면 최종 기한(기한 종료).
- 기간: `endAt` ≤ 지금 < `endAt + 7일`. 준비·진행 중과 이전 규칙(legacy) 프로젝트는 평가할 수 없다.
- 평가자·대상: 참여 중단(`left_at`)하지 않은 현재 멤버. 대상은 자기 자신을 뺀 전원이며, **한 번에 전원을** 제출한다.
- 종료 뒤에는 초대 수락·참여 중단이 막혀 있어 대상이 바뀌지 않는다.
- 솔로·2인 팀은 평가자가 2명이 안 되어 점수가 나오지 않는다(익명성 규칙). 2인 팀도 서로 평가는 남길 수 있고 '평가 완료' 뱃지는 받는다.

## 저장 (마이그레이션 0006, 테이블 추가만)

- `peer_review_submissions(id, project_id, reviewer_id, created_at)`, `UNIQUE(project_id, reviewer_id)`: 평가자당 1회.
- `peer_reviews(project_id, reviewer_id, reviewee_id, contribution, communication, commitment, submission_id)`, 기본 키 `(project_id, reviewer_id, reviewee_id)`.
- 한 트랜잭션: 제출 행을 `ON CONFLICT DO NOTHING`으로 넣되 **평가 기간·현재 멤버 조건을 DB 현재 시각(`now()`)으로 다시 검사**한다. 평가 행은 이번 제출 행이 있을 때만 들어간다. 제출 행이 안 들어가면(중복 제출·기간 지남) 409로 거절하고 아무것도 쓰지 않는다.
- 평가 제출은 `sprint_events`에 남기지 않는다. 시각이 남으면 익명성이 약해진다. 제출 시각은 제출 행에만 있고 본인 '평가 완료' 뱃지에만 쓴다.

## 뱃지

| id | 이름 | 조건 | earnedAt |
|---|---|---|---|
| `finish` | 7일 완주 | 프로젝트 완주, 참여 중단하지 않은 멤버 | 완주 시각 |
| `solo_finish` | 솔로 완주 | 위 조건 + 가입한 멤버가 1명 | 완주 시각 |
| `daily_report` | 매일 진행 보고 | 끝난 프로젝트에서 시작~종료의 모든 일차(시작부터 24시간 단위)에 진행 보고 1건 이상. 일차가 3개 이상일 때만 | 종료 시각 |
| `zero_bottleneck` | 병목 0으로 완주 | 완주 시각 기준 계산에서 마감 안에 배치되지 않은 미완료 업무 0개 | 완주 시각 |
| `top_contributor` | 핵심 기여자 | 평가 기간 종료 후, 2명 이상 평가, 기여도 평균 ≥ 4.5 | 평가 마감 시각 |
| `top_communicator` | 소통왕 | 같은 조건, 소통 평균 ≥ 4.5 | 평가 마감 시각 |
| `promise_keeper` | 약속 지킴이 | 같은 조건, 약속 이행 평균 ≥ 4.5 | 평가 마감 시각 |
| `reviewer` | 평가 완료 | 동료평가를 제출함 | 제출 시각 |

- 팀 뱃지(`finish`·`solo_finish`·`daily_report`·`zero_bottleneck`)는 참여 중단하지 않은 멤버 모두가 같이 받는다.
- 어뷰징: 점수는 동료평가만 쓰므로 진행 보고를 반복해도 점수가 오르지 않는다. 매일 보고는 일차당 1회로만 센다.
  1일 안에 시작·완주해 매일 보고를 받는 것을 막으려고 일차가 3개 이상이어야 한다.
  빨리 완주해서 `finish`·`zero_bottleneck`을 받는 것은 막지 않는다(완주는 팀장이 완료 기준 근거를 확인해야 한다).

## API

- `GET /api/score?project=<id>` (멤버만, 본인 것만):
  `{ score: number|null, grade: 'S'|'A'|'B'|'C'|null, breakdown: [{ key, label, points }], badges: [{ id, label, description, earnedAt }], review: { status: 'not_open'|'open'|'closed', opensAt, closesAt, submitted, reviewers, minReviewers, targets: [{ person, displayName }] } }`
  - `reviewers`는 평가 기간이 끝난 뒤에만 숫자, 그 전에는 `null`.
  - `targets`는 내가 평가할 사람(기간 중이고 아직 제출하지 않았을 때만). 프로젝트 안 번호(`person`)로 가리키며 다른 사람의 계정 ID는 내보내지 않는다.
- `POST /api/score { action: 'review', projectId, reviews: [{ person, contribution, communication, commitment }] }` → 위와 같은 모양.
  거절: 비멤버 403, 기간 밖 400, 대상 누락·중복·범위 밖 400, 이미 제출 409.
- `GET /api/score/me` → `{ totalScore, bestGrade, projects, badges: [{ id, label, description, earnedAt, count }] }`
  - `totalScore`: 확정된 프로젝트 점수의 합, `projects`: 점수가 확정된 프로젝트 수, `earnedAt`: 처음 받은 시각, `count`: 받은 프로젝트 수.

## 하지 않은 것

- 공유 링크·공개 페이지, 화면.
- 체크인 작성자 기록(개인 활동 지표). 필요하면 별도 작업.
- 평가 내용 신고·이의 제기, 악의적 저평가 보정.
