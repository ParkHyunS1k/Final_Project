# 공개 팀 목록과 참여 신청 설계

2026-10-14 피드백("딱 들어갔을 때 활성화된 팀 목록 보여주기. 사람들은 이끌어 가려고 안 함")에 대한 세션 2 설계다.
지시문: docs/handoff/2026-10-14-feedback-tasks.md 세션 2. 처음엔 서버·API만 만들었고, 사용자 결정(2026-10-15)으로 사이드바에 별도 '팀 찾기' 화면을 붙였다.

## 사용자 결정 (2026-10-15)

1. 새 프로젝트는 목록에 **비공개**로 시작한다. 팀장이 공개를 켠다. 기존 프로젝트도 모두 비공개.
2. 목록에서 고르면 **참여 신청 → 팀장 승인**으로 들어온다.
3. 준비 중 팀은 언제나, 진행 중 팀은 **시작 후 24시간 이내**에만 신청·승인할 수 있다.
4. 목록에는 이름·목표·기능 범위·완료 기준·인원 수·상태·기한을 보여준다. 팀원 이름·이메일·업무는 숨긴다.

## 규칙

**공개.** `project_policy.listed`(기본 false). 팀장만 바꾼다(`setListed`, 준비·진행). 버전 검사와 변경 기록을
남긴다. 비공개로 바꿔도 이미 들어온 신청은 그대로 남고 팀장이 승인·거절할 수 있다.

**참여 창.** `joinWindowOpen(policy, now)`: 준비 중이면 열림, 진행 중이면 `startedAt + 24h > now`이고 기한 전일 때 열림.
완주·종료·legacy는 닫힘. 이메일 초대는 이 창과 무관하게 지금 규칙(준비·진행) 그대로다.

**신청.** 로그인 사용자가 `goalVersion`과 `agreed: true`를 보낸다. 서버가 한 문장 INSERT의 조건으로 확인한다:
공개 중, 참여 창 열림, 참여 중인 팀장 있음, 목표 버전 일치, 인원 4명 미만(참여 중단자 포함, 초대와 같은 규칙), 팀 대기 신청 20개 미만, 이미 멤버 아님, 내 대기 신청 5개 미만. 같은 팀에 대기 신청은
하나(부분 유일 인덱스). 신청은 프로젝트 revision을 올리지 않는다(팀장의 편집과 충돌하지 않게). 목표 버전이 다르면
409와 최신 팀 정보를 돌려준다. 이미 대기 신청이 있으면 같은 신청을 돌려준다. 신청자는 대기 신청을 취소할 수 있다.

**승인·거절.** 팀장만(`decideJoin`, 준비·진행). 승인은 `save()` 한 트랜잭션에서 신청 상태 변경과 멤버 추가를 함께 하고,
저장 조건으로 신청 대기 중·인원 4명 미만·참여 창 열림·아직 멤버 아님을 다시 확인한다. 들어온 멤버의 동의 버전은
신청 때 확인한 버전이다. 그 뒤 목표가 바뀌었으면 기존 재동의 흐름(agreeGoal)을 거친다. 진행 중 합류는 초대 수락과 같이
프로젝트 알림 단계만 예약한다(운영에서 메일 미실행). 거절은 신청 상태만 바꾼다.

**노출.** 목록·신청 응답에 사용자 ID·이메일·팀원 이름이 없다. 팀장의 프로젝트 상태에만 대기 신청자의 표시 이름이 나온다.

## 데이터 (마이그레이션 0005, 추가만)

- `project_policy.listed boolean NOT NULL DEFAULT false`
- `project_join_requests(id pk, project_id fk, user_id, display_name, email, goal_version, status, created_at, decided_at, decided_by)`
  - status: `pending | approved | rejected | cancelled`
  - `(project_id, user_id) WHERE status='pending'` 유일, `(user_id, status)` 색인. RLS ON.

## API (화면 계약)

- `GET /api/teams` →
  `{ teams: [{ projectId, title, goal, scope, completionCriteria, lifecycle, goalVersion, members, maxMembers, startedAt, deadlineAt, joinUntil, joinable, requested }], requests: [{ requestId, projectId, title, status, createdAt, decidedAt }] }`
  - 공개 중이고 참여 창이 열린 팀만, 내가 속한 팀은 뺀다. `joinable = 인원 여유 && 대기 신청 없음`.
  - `requests`: 내 신청 최근 20개.
- `POST /api/teams { action: 'request', projectId, goalVersion, agreed: true }` → 201 `{ requestId, status: 'pending' }`
- `POST /api/teams { action: 'cancel', requestId }` → `{ ok: true }`
- `POST /api/projects { action: 'setListed', projectId, revision, listed }` → `{ ok: true }`
- `POST /api/projects { action: 'decideJoin', projectId, revision, requestId, approve }` → `{ ok: true }`
- `GET /api/sprint?project=` 응답에 `listed`, 팀장에게만 `joinRequests: [{ id, display_name, goal_version, created_at }]`.

## 테스트

비공개 팀은 목록에 없음, 공개 후 노출·멤버 정보 비노출, 내 팀 제외, 신청·중복 신청·취소, 목표 버전 변경 시 409,
인원 초과 거절, 시작 24시간 뒤 목록 제외·신청 거절·승인 거절, 완주·종료 팀 거절, 팀원은 공개 설정·승인 불가,
승인 시 멤버 추가·변경 기록, 승인 동시 경쟁에서 4명 초과 없음, 거절된 사용자는 멤버 아님, 오래된 revision 거절.
