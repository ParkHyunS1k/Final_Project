# 초대 링크 이메일 발송(Gmail SMTP) 설계

작성일: 2026-10-04. 사용자와 대화로 합의했다. 이 문서는 **구현 전 설계 검토본**이며, 아래 기능이 이미 구현되었다는 뜻이 아니다.

기준 코드: `main`, `0e59c12`(Vercel 팀 내부 배포 후). 작업 브랜치 `invite-email`.

## 1. 배경과 범위

지금은 팀장이 초대하면 서버가 링크를 만들고 화면에 "이메일은 발송하지 않습니다"라고 보여준다. 팀장이 링크를 직접 전달해야 한다. 마감 독촉 메일은 제품에서 뺐지만(2026-10-04), **초대 링크는 초대받은 사람의 이메일로 보낸다**(사용자 결정 2026-10-04).

결정 사항:

- 발송은 **Gmail SMTP**(사용자 본인 Gmail + 앱 비밀번호, nodemailer). 팀 내부용이며 나중에 도메인을 사면 전송기만 Resend로 바꾼다.
- 발송이 실패해도 초대는 성공한다. 링크는 지금처럼 화면에 계속 보여준다.
- **다시 보내기**는 같은 초대에 **새 토큰**을 발급해 보낸다(토큰은 해시만 저장하므로 원래 링크를 다시 보낼 수 없다). 이전 링크는 즉시 무효.

범위 밖: HTML 메일, 초대 외 메일(마감 독촉·수락 통지), Gmail 계정 전체의 하루 발송량 관리, Resend 전환, 마감 독촉 코드 정리. (사용자당 하루 초대 수 제한은 리뷰 뒤 범위에 넣었다 — 9절.)

## 2. 흐름

### 초대 만들기 (`lib/projects.ts` `createInvite`)

1. 지금처럼 토큰 생성 → 해시 저장 → 이벤트 기록을 한 트랜잭션(`save`)으로.
2. 저장이 끝난 뒤(트랜잭션 밖) 메일을 보낸다.
3. 결과를 초대 행에 기록한다(`email_status`, `email_sent_at`, `email_sends`).
4. 응답: 지금의 `{ token, expiresAt, id }`에 `email: 'sent' | 'failed' | 'off'`를 더한다. `off`는 발송 설정이 없을 때(로컬 개발 등).

### 링크 주소

`<요청의 origin>/workspace?invite=<token>`. origin은 서버가 받은 요청 URL에서 얻는다(`new URL(request.url).origin`). 요청 본문 값은 쓰지 않는다. 운영에서 초대하면 운영 주소, 미리보기에서 초대하면 미리보기 주소가 된다.

### 다시 보내기 (새 동작 `resendInvite`)

- 권한: 정책 `RULES`에 `resendInvite: { scope: 'owner', states: ['draft', 'active'] }`를 더한다(초대와 같음).
- 대상: `status = 'pending'`인 초대만. 수락·취소된 초대는 400.
- 같은 행의 `token_hash`를 새 토큰으로 바꾸고 `expires_at`을 지금부터 7일로 다시 정한다. 프로젝트 버전 검사·이벤트 기록은 `save`로 한 트랜잭션.
- 한도: 초대 하나당 발송 총 3회(`email_sends`), 직전 발송 후 1분 이내 재발송 금지. 넘기면 429와 안내 문구. 한도 확인은 토큰 교체와 같은 트랜잭션 안의 조건부 UPDATE로 해서 동시 요청이 한도를 넘지 못하게 한다.
- 이후 발송·결과 기록은 초대 만들기와 같다. 응답 `{ token, expiresAt, id, email }`.

### 메일 내용 (텍스트)

- 제목: `[ProjectMate] {팀장 이름}님이 '{프로젝트 이름}' 팀에 초대했습니다`. 제목의 CR/LF는 공백으로 바꾼다.
- 본문: 초대 링크, 만료 시각(KST), "초대받은 이메일의 Google 계정으로 로그인해야 수락됩니다", "모르는 초대라면 이 메일을 무시하세요".
- 받는 사람은 초대에 저장된 이메일 하나뿐이다. 프로젝트 이름·팀장 이름은 사용자 입력이므로 텍스트로만 넣는다.

## 3. 데이터

마이그레이션 `0001`(열 추가만): `project_invites`에

- `email_status text` — `'sent' | 'failed' | 'off'`, 아직 시도 전이면 NULL
- `email_sent_at timestamptz` — 마지막 발송 시도 시각
- `email_sends integer NOT NULL DEFAULT 0` — 발송 시도 횟수

`db/schema.ts`에 같은 열을 더하고 drizzle-kit으로 SQL을 만든다(스키마-마이그레이션 일치 테스트 유지). 머지 전에 Supabase에 `npm run db:migrate`를 실행한다. 추가형이라 미리보기와 DB를 공유해도 안전하다.

## 4. 발송 설정과 안전장치 (`lib/email.ts`)

- 새 함수 `inviteSender(env): Sender`. `EMAIL_PROVIDER=gmail`, `EMAIL_FROM`(Gmail 주소), `EMAIL_API_KEY`(앱 비밀번호)가 모두 있을 때만 nodemailer로 `smtp.gmail.com:465`(TLS)에 접속해 보낸다. 하나라도 없으면 `off`를 돌려주는 전송기.
- **마감 독촉 전송기(`senderFrom`)와 분리한다.** `senderFrom`은 지금처럼 Resend만 쓴다. Gmail 설정을 넣어도 남아 있는 독촉 코드가 메일을 보내지 않는다.
- 연결·발송 제한 시간 10초. 넘으면 `failed`.
- 서버 로그에는 실패 코드(`error.code`)만 남긴다. 앱 비밀번호·본문은 남기지 않는다.
- 테스트는 `useInviteSender(sender)`로 대역을 끼운다(변경안의 `useModel`과 같은 방식).
- 의존성: `nodemailer`(+ `@types/nodemailer`) 하나를 추가한다.

## 5. 화면

- 데이터: 프로젝트 상태의 초대 목록 조회(`lib/projects.ts` `projectState`, 팀장에게만 반환)에 `email_status`·`email_sent_at`·`email_sends`를 더한다.
- 팀·공수 탭 초대 목록: 초대마다 "메일 보냄 · HH:mm", "메일 실패", "메일 꺼짐" 표시. 팀장에게 **다시 보내기** 버튼. 누르면 새 링크를 보여주고 "이전 링크는 더 이상 쓸 수 없습니다" 안내.
- 초대 직후 안내: `sent` → "{email}로 초대 메일을 보냈습니다. 아래 링크도 직접 전달할 수 있습니다.", `failed` → "메일을 보내지 못했습니다. 아래 링크를 직접 전달해 주세요.", `off` → "메일 발송이 설정되지 않아 보내지 않았습니다. 아래 링크를 직접 전달해 주세요."
- 문구 정리: `web/components/project-workspace.tsx`(초대 결과), `web/app/workspace/page.tsx`(초대 설명), `docs/features.md`(초대 절), `web/README.md`(초대 설명)의 "이메일은 발송하지 않는다"를 실제 동작에 맞게 바꾼다.

## 6. 테스트 (대역 전송기 + PGlite)

- 초대 만들기: 초대 이메일로 메일 1통, 링크에 토큰과 **요청 origin**이 들어간다. 요청 본문에 다른 origin을 넣어도 무시된다. 응답 `email: 'sent'`, 행 `email_status='sent'`, `email_sends=1`.
- 발송 실패: 초대는 201, 응답에 토큰, `email: 'failed'`, 행 `email_status='failed'`. 설정 없음: `email: 'off'`.
- 다시 보내기: 이전 토큰 조회 404, 새 토큰 정상, `expires_at` 갱신, 이벤트 기록.
- 한도: 1분 안 재발송 429, 총 4번째 발송 429. 동시 재발송 2건에서 한도를 넘지 않는다.
- 권한·상태: 팀원(비팀장) 403, 수락·취소된 초대 400, 오래된 버전 409.
- 제목 CR/LF 제거.
- Gmail 실제 접속은 자동 테스트에 넣지 않는다. 배포 후 사용자가 실제 초대로 확인한다.

## 7. 사용자 작업과 검증

1. Google 계정 → 보안 → 2단계 인증 켜기 → 앱 비밀번호 생성(16자리).
2. Vercel 환경변수: `EMAIL_PROVIDER=gmail`(Config), `EMAIL_FROM=<Gmail 주소>`(Config), `EMAIL_API_KEY=<앱 비밀번호>`(**Secret**), Production·Preview. 로컬 확인은 `.env.local`에 같은 값.
3. 머지 전 Supabase에 마이그레이션 `0001` 적용(Claude가 `.env.local`의 `DATABASE_URL`로 실행).
4. 미리보기 주소에서 실제 초대 → 메일 도착(스팸함 포함) → 메일의 링크가 같은 미리보기 주소로 열리고 수락되는지. 다시 보내기 후 이전 링크가 막히는지.

## 8. 문서

- `CLAUDE.md` 현재 파일럿 범위: "이메일 지정 초대" → 초대 링크 메일 발송(Gmail SMTP, 팀 내부용) 명시.
- `docs/features.md` 초대 절, `web/README.md` 초대 설명과 환경변수(`EMAIL_*`), `.env.example`에 `EMAIL_PROVIDER`·`EMAIL_FROM`·`EMAIL_API_KEY`(값 없이).

## 9. 리뷰 뒤 확정된 변경 (2026-10-04~05, Codex 리뷰 반영)

위 2·4·6절과 다르면 이 절이 우선한다.

- 수신자: 이메일 칸은 주소 하나만 받는다. 쉼표·세미콜론·꺾쇠·공백·따옴표·괄호가 있으면 400(메일 라이브러리가 여러 수신자로 읽지 않게).
- 남용 방지: 한 사용자가 만들 수 있는 초대는 하루(KST 0시 기준) 20개. 테이블 `invite_quota(user_id, day, n)`(마이그레이션 `0002`, RLS ON)에 한 문장 upsert(`… WHERE n < 20 RETURNING n`)로 늘려 동시 요청에도 넘지 않는다. 다른 검사를 다 통과한 뒤에 쓰며, 이어지는 저장이 버전 충돌로 실패해도 한 칸은 쓴 것으로 남는다.
- 링크 주소(2절 대체): Vercel 운영은 `VERCEL_PROJECT_PRODUCTION_URL`, 미리보기는 `VERCEL_BRANCH_URL`(없으면 `VERCEL_URL`). 요청 주소는 로컬(Vercel 밖)에서만 쓴다. 요청의 Host를 믿지 않는다.
- 제한 시간(4절 대체): 발송 전체 15초(넘으면 `failed`), SMTP 연결·인사·소켓·DNS 각 10초. 제한 시간을 넘긴 SMTP 연결은 끊지 않아 드물게 '실패' 뒤 메일이 늦게 도착할 수 있다.
- 이전 링크(6절 대체): 다시 보내기 뒤 이전 토큰으로 열면 403(해당 토큰의 초대가 없어 '초대받은 이메일의 계정으로 로그인해주세요').
