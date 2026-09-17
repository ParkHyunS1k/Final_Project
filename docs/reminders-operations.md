# 마감 독촉 이메일 — 운영 연결 절차

작성일 2026-09-09. 구현 근거: [B 계획](superpowers/plans/2026-09-09-b-deadline-email.md).
이 문서는 **아직 운영 발송이 켜지지 않은 상태**를 설명한다. 아래 두 가지가 설정되기
전까지 실제 메일은 한 통도 나가지 않는다.

## 지금 동작하는 것

- 승인된 업무 마감(`sprint_tasks.due_at`)과 프로젝트 최종 기한에 따라
  `reminder_items`에 발송 항목을 예약·취소한다.
- `POST /api/internal/reminders`가 도래한 항목을 원자적으로 확보하고, 전송 직전
  상태를 다시 읽고, 같은 수신자·같은 예정 시각의 항목을 한 통으로 묶는다.
- 제공자 자격 정보가 없으면 `recording` 전송기가 쓰이며 실제 메일을 보내지 않는다.
  응답의 `live:false`, `provider:"recording"`이 그 상태를 뜻한다.

## 정기 실행 환경 — 확인 결과

현재 배포 경로에서는 플랫폼 내장 정기 실행을 쓸 수 없다. 확인한 근거:

- `.openai/hosting.json`은 `project_id`, `d1`, `r2`만 가진다. 예약 실행 항목이 없다.
- `@openai/sites-vite-plugin`은 `.openai/hosting.json`과 `drizzle/**`만 배포
  산출물로 복사한다(패키지 README).
- 빌드가 만드는 `dist/server/wrangler.json`의 `triggers`는 비어 있다.
- 워커 진입점 `vinext/server/fetch-handler`는 fetch 핸들러 하나만 내보낸다.
  Cloudflare Cron Trigger가 요구하는 `scheduled` 핸들러가 없다.

따라서 **외부 실행기가 HTTP로 호출하는 방식** 하나만 쓸 수 있다. 브라우저 타이머나
사용자 세션으로 대체하지 않는다.

### 설정 방법 (사용자가 직접 수행)

1. Sites 프로젝트 환경 변수에 `REMINDER_RUNNER_SECRET`을 임의의 긴 무작위 값으로
   설정한다. 이 값이 없으면 진입점은 모든 호출을 401로 거절한다.
2. 외부 스케줄러(예: 서버의 cron, GitHub Actions schedule, 관리형 cron 서비스)에서
   1분 간격으로 아래를 호출한다.

```bash
curl -sS -X POST https://<배포주소>/api/internal/reminders \
  -H "authorization: Bearer $REMINDER_RUNNER_SECRET"
```

- 권장 간격은 1분이다. 30분 전 단계를 놓치지 않으려면 최소 5분 이내여야 한다.
- 한 번에 처리할 **수신자 수**가 한도다(기본 50명). 한 수신자의 도래 항목은
  전부 함께 확보하므로 한 통에 들어갈 내용이 나뉘어 발송되지 않는다.
- 실행기가 멈춰 여러 단계가 밀리면 같은 대상의 **가장 최근 단계만** 보내고 앞선
  단계는 `skipped`로 기록한다. 대상 마감이 지난 뒤에는 보내지 않는다.
- 확보 후 프로세스가 죽으면 5분 뒤 다른 실행기가 같은 항목을 이어받는다.
- 스케줄러의 실행 간격은 제공자의 메일 전달 지연과 별개다. 두 값을 합쳐 하나의
  정확도로 설명하지 않는다.

## 메일 제공자 — 미선정

`lib/email.ts`는 현재 Resend 하나를 운영 경로로 지원한다. 아래 세 값이 모두 있어야
실제 발송을 시도하며, 하나라도 없으면 기록용 전송기로 되돌아간다.

| 환경 변수 | 값 |
|---|---|
| `EMAIL_PROVIDER` | `resend` |
| `EMAIL_API_KEY` | 제공자 API 키 (저장소·로그·UI에 남기지 않는다) |
| `EMAIL_FROM` | 인증한 발신 도메인의 주소 |

다른 제공자를 쓰기로 하면 `senderFrom`에 분기를 하나 더 추가한다. 임의 가입이나
결제는 진행하지 않았다.

### 중복 전달에 대한 한계

같은 묶음의 재시도는 항상 같은 `idempotency-key`를 사용하고, DB의
`reminder_batches(user_id,scheduled_at)` 고유 제약이 병렬 실행기의 중복 생성을
막는다. 메일은 같은 수신자·같은 예정 시각이면 프로젝트가 달라도 한 통으로 묶고
본문에서 `[프로젝트 이름]`으로 구분한다. 발송 직전에 각 항목의 최신 상태를 다시
읽어 완료·담당 변경·프로젝트 종료로 무효가 된 항목은 제외하고, 실제로 메일에
포함한 항목만 발송 완료로 기록한다. 그러나 **DB 기록만으로 외부 메일의 정확히 한 번 전달을 보장하지는
못한다.** 제공자가 접수했는지 불명확한 응답(5xx·네트워크 오류)은 `unknown` 상태로
남기고 자동으로 재발송하지 않는다. 이미 제공자가 접수한 메일은 회수할 수 없으므로,
발송 직후 업무가 완료되는 경쟁 상황에서는 완료된 업무의 독촉이 도착할 수 있다.

## 운영자가 확인하는 곳

별도 관리자 화면은 만들지 않았다. 실패와 미확정 전송은 D1에서 직접 확인한다.

```sql
-- 실패했거나 접수 여부가 불명확한 발송
SELECT project_id,user_id,scheduled_at,status,attempts,error,last_attempt_at
FROM reminder_batches WHERE status IN ('failed','unknown') ORDER BY last_attempt_at DESC;

-- 보내지 않고 건너뛴 항목과 사유
SELECT project_id,kind,task_id,user_id,stage_minutes,detail,resolved_at
FROM reminder_items WHERE status IN ('skipped','failed') ORDER BY resolved_at DESC;
```

전송 실패는 업무 상태나 완주 판정을 바꾸지 않는다.

## 남은 검증

- [ ] 실제 제공자 자격 정보로 확인된 테스트 주소에 실제 메일 발송
- [ ] 브라우저를 닫은 상태에서 외부 실행기만으로 발송되는지 확인
- [ ] 수신 메일의 한국 시간 표기·링크·발신자 확인
