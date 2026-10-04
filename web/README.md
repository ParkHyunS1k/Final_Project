# ProjectMate service pilot

목적은 연구가 아니라 7일 프로젝트 완주 서비스 개발이다.

## 실제로 동작하는 범위

- 노션형 작업 공간: 프로젝트 사이드바, 내 할 일, 업무 표·보드, 프로젝트 문서(저장된 목표·결과물·기준 조회), 팀 가용시간, 완주 확인.
- 업무 상세 패널에서 설명·상태·공수·선행 작업·최근 체크인·완료 근거를 확인하고 저장한다.
- 표에서 상태와 담당자를 변경하고, 보드에서도 같은 상태를 조회·변경한다. 완료는 근거 입력, 재개는 남은 시간 입력 후 확정한다.

- 목표·필수 결과물·완료 기준·시작일·7일 기간을 입력해 여러 프로젝트를 만든다.
- 이메일 지정 초대 링크와 목표 확인을 통해 최대 4명이 참여한다.
- 팀장은 업무 생성·편집·담당자 배정·선행 작업·필수/부가 여부를 설정한다.
- 팀원은 본인 업무·가용시간, 팀장은 전체 수정·초대·최종 승인 권한을 가진다.
- 참여 약속, 체크인, 남은 공수, 날짜별 가용시간, 결과물 근거를 저장한다.
- 실제 공수·가용시간·의존관계와 마감 시각으로 일정을 계산한다.
- 불가능한 계획에서 부가 기능을 보류하는 복구안을 생성하고 승인/거절을 기록한다.
- 오래된 제안, 중복 승인, 동시 수정 충돌을 차단한다.
- 결과물 근거와 변경 기록은 다시 접속해도 유지된다.

기존 샘플은 원래 소유자에게 보존한다. 새 계정에는 샘플을 자동 생성하지 않는다. 신규 프로젝트는 업무 없음·가용시간 0으로 시작한다. LLM, Python 서버 호출, 외부 업로드, 실제 결제·환급은 미연결이다.

초대 링크는 초대받은 이메일로 발송되며(Gmail SMTP, 설정이 없으면 보내지 않고 링크만 보여준다) 그 이메일의 Google 계정으로 로그인해야 수락한다. 메일 설정: Vercel·`.env.local`에 `EMAIL_PROVIDER=gmail`, `EMAIL_FROM`(Gmail 주소), `EMAIL_API_KEY`(Google 앱 비밀번호, 비밀값). 배포는 Vercel 팀 내부용이다(아래 '소스와 배포').

가용시간은 오전 9시부터 30분 단위의 연속 슬롯으로 배치한다. 임의 시작 시각이나 분할 시간대는 아직 지원하지 않는다. 알고리즘은 탐욕적이며 최적 일정을 보장하지 않는다. 결과물은 팀이 직접 검증한 근거를 입력하며 시스템이 자동 확인하지 않는다.

## 로컬 실행

Node 22.16 이상이 필요하다(테스트·스크립트가 `--experimental-strip-types`로 TS를 직접 실행한다). 이번 검증 환경은 Node 25.6.1이다.

```sh
npm ci
npm run db:migrate   # 처음 한 번, 그리고 db/migrations/에 새 파일이 생길 때마다. 개발 서버를 끈 상태에서. 앱은 자동으로 마이그레이션하지 않는다.
npm run dev
```

DB는 Postgres다. `DATABASE_URL`이 없으면 로컬 PGlite(`web/.data/pglite`, `DATABASE_PATH`로 바꿀 수 있다)를 쓰고, 있으면 그 Postgres(Supabase 연결 풀러)를 쓴다. PGlite 파일은 한 프로세스만 열 수 있어 개발 서버가 켜져 있으면 `db:migrate`가 안내와 함께 멈춘다. 모든 테이블은 RLS가 켜져 있고(정책 없음) 서버만 접근한다. 로그인은 Supabase Auth(Google)다. `.env.example`을 참고해 `web/.env.local`에 `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`를 넣고, Supabase Redirect URLs에 `http://localhost:*/**`를 등록한다. 토큰 없이 `oai-authenticated-*` 개발 헤더로 요청하는 방식은 `next dev`(`.env.development`의 `AUTH_DEV_HEADERS=1`)에서만 허용된다(`docs/dev-team-seed-notes.md`). 운영 모드(`next build && next start`, Vercel)에서는 `DATABASE_URL`이 꼭 있어야 한다. 없으면 로컬 파일로 넘어가지 않고 API가 503을 돌려준다.

```sh
npm test
npx tsc --noEmit
npx oxlint app components/project-workspace.tsx components/task-collection.tsx components/task-editor.tsx lib/sprint.ts lib/sprint-store.ts lib/projects.ts db/schema.ts drizzle.config.ts
npm run build
```

생성된 UI 카탈로그에는 기존 린트 문제가 있으므로 작성한 서비스 코드를 대상으로 검사한다.

## API

`GET /api/projects`: 내 프로젝트 목록. `?invite=token`은 로그인 이메일을 검사한 뒤 초대 프로젝트의 목표·결과물·기준 조회.

`POST /api/projects`: create(title,goal,startDate,duration,deliverables:줄바꿈 문자열,completionCriteria,agreed), invite(projectId,revision,email: 그 주소로 초대 링크 메일 발송, 응답 email=sent|failed|off, 사용자당 하루 20개), resend(projectId,revision,inviteId: 새 링크 발급·발송, 이전 링크 무효, 초대당 3회·1분 간격), revoke(projectId,revision,inviteId), accept(token,agreed). 초대 토큰은 SHA-256 해시로만 저장, 7일 만료, 취소 가능.

`GET /api/sprint?project=ID`: 멤버십 검사 후 상태·계산 결과·체크인·복구안·최근 변경 기록 조회. 응답은 캐시하지 않는다.

`POST /api/sprint`: JSON `{ action, projectId, revision, ...fields }`.

| action | 필드 | 동작 |
|---|---|---|
| join | agreed:true | 참여 약속 기록 |
| createTask | title, person, remaining, optional, dependsOn | 팀장이 업무 생성 |
| editTask | taskId, title, person, remaining, optional, dependsOn | 팀장이 진행 중인 업무 편집·재배정 |
| checkin | taskId, note, remaining | 남은 공수와 체크인 기록 |
| capacity | person, date, hours | 날짜 가용시간 수정 |
| taskDetails | taskId, status(todo/in_progress), description, remaining | 팀장 또는 담당자가 업무 상세 저장 |
| task | taskId, done, evidence 또는 remaining | 결과 확인 또는 재개 |
| propose | 없음 | 현재 상태의 복구안 저장 |
| approve/reject | proposalId | 현재 버전 제안 처리 |
| finish | 없음 | 참여·체크인·증빙·기한 확인 후 완주 기록 |

인증 없는 요청은 401. 상태 충돌·오래된 제안은 409. 입력 오류는 400. 모든 프로젝트 요청은 멤버십으로 제한한다. 비멤버는 403, 팀원은 다른 사람의 업무·시간 수정과 팀장 작업을 실행할 수 없다. 사용자는 Supabase가 발급한 Bearer 토큰으로 서버가 확인하며(개발 헤더는 `next dev` 전용) 클라이언트가 보낸 owner 값은 사용하지 않는다.

업무 이름은 1~200자, 남은 시간은 0.5~200시간(0.5시간 단위), 한 스프린트는 최대 100개 업무다. 참여 멤버에게만 배정하며 자기 참조·순환·중복·다른 프로젝트/보류 업무 참조를 거절한다. 완료·보류 업무는 편집하지 않는다. 편집 창을 연 시점의 버전을 유지하므로 다른 변경이 저장되면 창을 다시 열어 검토한다.

한 DB batch(트랜잭션) 안에서 버전 비교 후 고유 mutation ID로 후속 쓰기를 제한한다. 업무·가용시간·제안·로그를 함께 저장하며 중간 실패는 롤백한다. DB 스키마는 db/schema.ts, 마이그레이션은 db/migrations/이다. 적용한 마이그레이션은 수정하지 않는다.

## 작업 공간 체험 순서

1. 사이드바에서 프로젝트를 선택한다. 좁은 화면에서는 왼쪽 위 버튼으로 사이드바를 연다.
2. 프로젝트 업무에서 표와 보드를 전환하고, 상태·담당자를 변경한다.
3. 업무 제목이나 남은 시간을 누르면 상세 패널이 열린다. 설명·상태·남은 시간을 저장한다.
4. 상세 패널에서 체크인과 완료 근거를 기록한다. 완료 시 표·보드·진행률·일정을 함께 갱신한다.
5. 내 할 일은 선택한 프로젝트에서 본인에게 배정된 업무만 표시한다.
6. 프로젝트 문서는 합의한 목표·결과물·완료 기준 조회다. 팀원 초대는 팀장이 상단 초대하기 버튼으로 관리한다. 자유 문서 편집·댓글·멘션·보드 드래그는 아직 지원하지 않는다.

표·보드·패널은 동일한 서버 상태를 사용한다. 편집 중 다른 변경이 생기면 덮어쓰지 않고 다시 열도록 안내한다. 상세 체크인은 프로젝트 최근 20건에서 해당 업무를 골라 표시한다.

## 기존 샘플 체험 순서

1. 참여 약속을 확인한다.
2. 체크인에서 PDF 업로드 지원을 선택하고 남은 시간을 30시간으로 입력한다.
3. 홈에서 배치 불가를 확인하고 복구안을 계산한다.
4. 부가 기능인 PDF 지원 보류안을 승인한다.
5. 새로고침 후 작업 보류와 변경 이력이 유지되는지 확인한다.
6. 다른 작업에 결과물 검증 근거를 기록한 뒤 완주를 확인한다.

실제 가용시간이나 날짜에 따라 계산 결과가 달라질 수 있다. 핵심 작업 자체가 불가능하면 범위를 억지로 줄여 가능하다고 표시하지 않는다.

## 검증

현재 구조(Next.js + Postgres) 기준, 2026-10-03:

- `npm test` 185개: 일정 계산, API 핸들러(실제 `lib/db.ts` + PGlite로 실제 SQL 실행: 권한·계정 분리·초대 만료/취소·동시 수락·인원 제한·동시 쓰기·롤백·오래된 변경 거절·기한 경과), Supabase 토큰 검증과 개발 헤더 차단, DB 포트(값 타입·트랜잭션·RLS·마이그레이션·PGlite 잠금), 실제 DB 어댑터를 거친 라우트의 503 처리.
- 타입 검사, 린트(기존 오류 외 새 오류 없음), `next build`.
- `next dev`에서 시드 스크립트로 4인 프로젝트 생성, 개발 헤더 200. `next start`(운영 모드)에서는 개발 헤더 401.
- 로컬에서 실제 Google 계정으로 로그인 → 프로젝트 생성 → 새로고침 유지. Google 두 계정 초대·수락은 Next.js 전환 전(2026-10-02, vinext 로컬)에 확인했고, 전환 후에는 한 계정만 다시 확인했다.
- 미검증: 운영 배포 환경(Vercel·운영 Supabase), 서로 다른 실제 계정의 운영 협업.

이전 구조(vinext + D1) 기록: 로컬 Workers + D1에서 로그인 → 참여 → 체크인 → 제안 → 승인 → 재조회, 로컬 브라우저에서 프로젝트·초대·업무·가용시간 흐름, 당시 Sites 운영 계정에서 체크인 새로고침 유지를 확인했다.

## 소스와 배포

`Final_Project` 저장소의 `web/`이 서비스 소스다. 배포는 Vercel 팀 내부용이다(`docs/superpowers/specs/2026-10-04-vercel-deploy-design.md`). `main` 머지는 운영, PR·브랜치 푸시는 미리보기로 배포되며 모든 환경이 같은 Supabase DB를 쓴다.

- Vercel 프로젝트: Root Directory `web`, 지역은 `vercel.json`의 `icn1`(Supabase 서울과 같은 곳). Vercel의 Supabase 연동(Add)은 쓰지 않는다.
- 환경변수(Production·Preview 같은 값): `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL`(트랜잭션 풀러 6543). `AUTH_DEV_HEADERS`·`AI_FAKE_MODEL`은 넣지 않는다(넣어도 운영에서는 무시된다). `NEXT_PUBLIC_*`는 빌드 때 박히므로 바꾸면 다시 배포한다.
- 미리보기 접근: Deployment Protection의 Vercel Authentication을 끈다. 접근 제어는 앱의 Google 로그인과 프로젝트 멤버 확인이다.
- Supabase Auth: Site URL은 운영 주소, Redirect URLs에 `https://<운영주소>/**`, `https://*-<vercel계정>.vercel.app/**`, `http://localhost:*/**`.
- 마이그레이션은 자동으로 돌지 않는다. `db/migrations/`에 새 파일이 생기는 PR은 머지 전에 `.env.local`의 `DATABASE_URL`로 `npm run db:migrate`를 실행한다. 미리보기도 같은 DB를 쓰므로 컬럼 삭제·이름 변경은 하지 않는다.
- AI 변경안은 운영 모델이 연결되지 않아 배포 환경에서 '준비 중'이다(`lib/ai-extraction.ts` `aiAvailable`).
