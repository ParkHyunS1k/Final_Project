# Vercel 팀 내부 배포 설계

작성일: 2026-10-04. 사용자와 대화로 합의했다. 이 문서는 **구현 전 설계 검토본**이며, 아래 기능이 이미 구현되었다는 뜻이 아니다.

기준 코드: `postgres-migration`, `0a2cfa7`(Postgres 이전, 최종 리뷰 전). 작업 브랜치 `vercel-deploy`. Postgres 브랜치가 머지된 뒤 `main` 기준으로 PR을 올린다.

## 1. 배경과 범위

Vercel + Supabase 이전의 3단계다(1단계 Next.js 이전, 2단계 Postgres 이전). 아직 개발 중이며 **첫 사용자는 사용자 본인과 함께 개발하는 팀원**이다. 실제 고객 파일럿이 아니다.

결정 사항(사용자, 2026-10-04):

- 배포 방식: `main` 머지 → 운영 배포, PR·브랜치 푸시 → 미리보기 배포. **모든 환경이 Supabase 프로젝트 하나(서울)를 공유**한다. 데이터는 전부 테스트 데이터다.
- **AI 변경안은 운영에서 끈다.** 운영 모델이 연결되지 않았으면 '준비 중'으로 보이고, 가짜 모델 결과가 사용자에게 보이지 않는다. 운영 모델 연결은 별도 하위 프로젝트.
- **메일 알림은 제품에서 뺀다.** 마감 임박은 화면 디자인으로 표현하기로 했다(별도 작업). 알림 코드는 이번에 지우지 않는다.
- 주소는 기본 `*.vercel.app`. 마이그레이션은 머지 전 수동 실행.

범위 밖: 빌드 시 자동 마이그레이션, 미리보기용 DB 분리, 알림 코드 삭제, 마감 임박 화면 디자인, 운영 AI 모델, 커스텀 도메인.

## 2. 배포 구조

```
GitHub (ParkHyunS1k/Final_project, 공개)
  ├─ main 머지  → Vercel 운영 배포   → <프로젝트>.vercel.app
  └─ PR·브랜치 → Vercel 미리보기     → <프로젝트>-git-<브랜치>-<계정>.vercel.app
                        │
                서울 함수(icn1) ── Supabase(ap-northeast-2) Postgres 트랜잭션 풀러 :6543
                               └─ Supabase Auth(Google)
```

- Vercel 프로젝트(사용자가 생성·연결): 저장소 가져오기, Root Directory `web`, 프레임워크 Next.js 자동 인식. Vercel의 Supabase 연동(Marketplace "Add")은 **쓰지 않는다** — 새 Supabase 프로젝트를 만들고 다른 환경변수 이름(`POSTGRES_URL` 등)을 넣는다.
- 지역: `web/vercel.json`의 `"regions": ["icn1"]`. Supabase와 같은 서울에 둔다(요청마다 DB 왕복).
- 환경변수 4개를 Production·Preview에 같은 값으로 넣는다: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL`(트랜잭션 풀러, 6543). `AUTH_DEV_HEADERS`·`AI_FAKE_MODEL`은 넣지 않는다. Vercel은 미리보기도 `NODE_ENV=production`이라 개발 헤더가 꺼진다.
- 미리보기 접근: Hobby 요금제는 Vercel 팀 멤버를 둘 수 없으므로 Deployment Protection의 Vercel Authentication을 끈다. 접근 제어는 앱의 Google 로그인과 프로젝트 멤버 확인이 맡는다.
- Supabase Auth URL(사용자가 대시보드에서): Site URL = 운영 주소. Redirect URLs에 `https://<운영주소>/**`, `https://*-<vercel계정>.vercel.app/**` 추가, `http://localhost:*/**` 유지. Google Cloud의 승인된 리디렉션(Supabase 콜백)은 바꾸지 않는다.
- 같은 DB를 공유하므로 스키마를 바꾸는 PR의 미리보기가 다른 배포를 깨뜨릴 수 있다. 이번 범위에서는 추가형 변경만 하고, 컬럼 삭제·이름 변경은 실제 서비스 전 DB 분리 후 한다.

## 3. 코드 변경

### ① 운영에서 DB 주소가 없으면 멈춤 (`web/lib/db.ts` `database()`)

`DATABASE_URL`이 없고 `NODE_ENV === 'production'`이면 PGlite로 넘어가지 않고 `DatabaseError`를 던진다. 라우트는 기존 규칙대로 503으로 숨기고 원인은 서버 로그에만 남긴다. 메시지에는 경로·비밀값을 넣지 않는다. 로컬 `next start`도 `DATABASE_URL`이 필요해진다(README에 적는다).

### ② AI 변경안 '준비 중' (`web/app/api/change-proposals/route.ts`, `web/components/change-review.tsx`)

- 사용 가능 = `model.live` 이거나, (`AI_FAKE_MODEL === '1'` 이고 `NODE_ENV !== 'production'`). 기본은 꺼짐.
- `web/.env.development`에 `AI_FAKE_MODEL=1`을 추가해 로컬 개발은 지금처럼 가짜 모델을 쓴다. 변경안 관련 테스트도 이 값을 켠다.
- GET 목록 응답에 `aiAvailable: boolean`을 더한다.
- POST `create`는 사용 불가일 때 503 `AI 변경안은 준비 중입니다.`를 돌려주고 모델을 부르지 않으며 DB에 쓰지 않는다. `apply`·`revert`와 저장된 평가 응답 재생(읽기 전용)은 그대로 둔다.
- 화면: `aiAvailable`이 거짓이면 붙여넣기 입력과 변경안 만들기 대신 '준비 중' 안내를 보여준다.

### ③ 메일·AI 문구

- `web/components/task-editor.tsx` 설명: "지정하면 마감 2시간·1시간·30분 전에 담당자에게 이메일을 보냅니다." 삭제.
- `web/components/task-editor.tsx` 마감 안내: "비워두면 마감 미정으로 저장되고 독촉 이메일이 예약되지 않습니다." → "비워두면 마감 미정으로 저장됩니다."
- `web/components/task-collection.tsx`: "미정 · 독촉 이메일 예약 없음" → "미정".
- `web/components/landing-page.tsx`: "계획서를 붙여넣으면, 업무 변경안이 나옵니다." 장면 제목에 다른 장면과 같은 `준비 중인 기능` 표시. 하단 "AI 변경안은 파일럿 단계입니다." → "AI 변경안은 준비 중입니다."
- 알림 실행 진입점(`/api/internal/reminders`)은 `REMINDER_RUNNER_SECRET`이 없으면 401이므로 그대로 둔다.

### ④ `web/vercel.json`

```json
{ "regions": ["icn1"] }
```

### ⑤ 서버리스 연결 (`web/lib/db.ts` `openPostgres`)

postgres.js 옵션에 `idle_timeout: 20`(초)을 더해 쉬는 함수가 연결을 붙잡지 않게 한다.

## 4. 테스트

- ①: `NODE_ENV=production`, `DATABASE_URL` 없음 → `database()`가 `DatabaseError`, 메시지에 `.data`·경로 없음. 라우트 경유 503은 기존 `db-route` 테스트 방식으로 확인.
- ②: 사용 불가에서 `create` → 503, `ai_change_proposals` 행 0. GET 목록의 `aiAvailable`이 사용 불가 false·사용 가능 true. 기존 변경안 테스트는 `AI_FAKE_MODEL=1`로 그대로 통과.
- ③④⑤: 테스트 없음(문구·설정). ⑤는 배포 후 검증으로 확인.
- 전체: `npm test`, `tsc --noEmit`, `oxlint`, `next build` 통과. Codex 리뷰.

## 5. 배포 절차

| # | 담당 | 할 일 |
|---|---|---|
| 1 | Claude | Postgres 브랜치 Codex 최종 리뷰 → 수정 → 머지 |
| 2 | Claude | 이 설계 구현(`vercel-deploy`), 검증, Codex 리뷰, PR |
| 3 | 사용자 | Vercel 프로젝트 이름 정리(선택), 환경변수 4개(Production·Preview), 미리보기 Vercel Authentication 끄기 |
| 4 | 사용자 | PR 머지 → 첫 운영 배포 |
| 5 | 사용자 | Supabase Auth Site URL·Redirect URLs 등록 |
| 6 | 둘 다 | 6절 검증 |

## 6. 검증 (배포된 주소)

- Claude: `/`·`/workspace` 200. API 무인증 401. `oai-authenticated-*` 헤더 요청도 401(운영에서 개발 헤더 꺼짐). 응답 헤더 `x-vercel-id`로 `icn1` 확인. 10분 이상 유휴 후 첫 API 요청 정상(⑤).
- 사용자(+팀원 1명): 운영 주소에서 Google 로그인 → 프로젝트 생성 → 새로고침 후 유지. 팀원 초대·수락. AI 변경안 탭 '준비 중' 표시.
- 미리보기: PR 미리보기 주소에서 Google 로그인 후 같은 미리보기 주소로 복귀. 협업자 커밋이 미리보기로 배포되는지(Hobby 제한 확인).
- 실패 시: Vercel Instant Rollback으로 직전 배포. 이번 범위는 DB 스키마를 바꾸지 않으므로 되돌림에 DB 조치가 필요 없다.

## 7. 문서

- `CLAUDE.md`: "운영 배포(Vercel)는 아직 없다" → Vercel 팀 내부 배포(main=운영, PR=미리보기, DB 공유). 메일 알림 제외(사용자 결정 2026-10-04). AI 변경안은 운영에서 '준비 중'.
- `web/README.md`: Vercel 설정(Root `web`, 환경변수 4개, 미리보기 보호, Auth URL), 머지 전 수동 마이그레이션, 운영 모드 `DATABASE_URL` 필수.
- `docs/features.md`, `docs/reminders-operations.md`: 메일 알림은 제품에서 제외, 코드는 남아 있으나 쓰지 않음.

## 8. 실제 서비스 전환 시 (이번 범위 밖, 기록용)

| 항목 | 지금(팀 내부) | 실제 서비스 |
|---|---|---|
| DB | Supabase 하나 공유 | 운영 전용 Supabase 프로젝트 신설, 지금 DB는 개발·미리보기용. Vercel 환경변수를 Production/Preview로 나눔 |
| 백업 | 없음(무료) | Supabase Pro 일일 백업 또는 정기 `pg_dump` |
| 마이그레이션 | 머지 전 수동 | 운영 DB에도 실행. 삭제·이름 변경은 추가→코드 전환→삭제로 나눠 배포 |
| Vercel 요금제 | Hobby(비상업) | 유료 서비스면 Pro |
| 주소 | `*.vercel.app` | 도메인 연결, Supabase 복귀 주소 교체 |
| Google 로그인 | 테스트 모드 가능 | 동의 화면 프로덕션 전환(앱 이름·로고·개인정보처리방침 주소) |
| 법적 고지 | 없음 | 개인정보처리방침·이용약관 |
| AI 변경안 | 준비 중 | 운영 모델 연결, 호출·비용 한도(별도 하위 프로젝트) |
| 마감 임박 | 현재 화면 | 결정된 화면 디자인(별도 작업) |
