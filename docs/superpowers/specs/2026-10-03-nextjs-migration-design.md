# 실행 환경 이전: vinext(Workers) → Next.js 설계

작성일: 2026-10-03. 사용자와 대화로 합의했다. 이 문서는 **구현 전 설계 검토본**이며, 아래 기능이 이미 구현되었다는 뜻이 아니다.

기준 코드: `phs`, `5c5ea6a`. 작업 브랜치는 `phs`에서 새로 딴다(PR #2와 섞지 않는다).

## 1. 배경과 범위

사용자 결정(2026-10-03): 운영 배포는 **Vercel + Supabase(Auth·Postgres·이후 Storage)**. 이유는 CareerFlow(Python 앱)와 같은 사용자·데이터를 공유하려면 두 앱이 모두 접근할 수 있는 DB가 필요하고, CareerFlow의 PDF를 같은 로그인 권한의 파일 저장소에 두기 위해서다. 기존 OpenAI Sites 배포는 쓰는 사람이 없어 버린다.

전체 이전은 세 하위 프로젝트로 나눈다. **이 문서는 1번만 다룬다.**

1. **실행 환경: vinext → Next.js** (DB는 로컬 SQLite) ← 이 문서
2. DB: SQLite → Supabase Postgres
3. 배포: Vercel + Supabase 운영 환경, Cron

1번이 끝나면 앱은 로컬에서 Next.js와 SQLite 파일로 동작한다. **1번만으로는 배포하지 않는다**(Vercel에서는 SQLite 파일이 유지되지 않는다).

범위 밖: Postgres, Vercel 프로젝트와 배포, Cron, Supabase Storage, CareerFlow 결합, 기존 로컬 D1 데이터 이전(테스트 데이터라 버린다).

## 2. 실행 환경과 설정

- 의존성
  - 추가: `next@^16`(React 19.2와 호환). `package.json`에 `"engines": { "node": ">=22.13" }`(`node:sqlite` 경고 없이 사용).
  - 제거: `vinext`, `vite`, `@cloudflare/vite-plugin`, `@cloudflare/workers-types`, `wrangler`, `@openai/sites-vite-plugin`. vinext의 RSC용으로만 쓰던 `react-server-dom-webpack`도 제거한다(Next는 자체 번들을 쓴다). 제거 후 `next build`가 실패하면 그 오류를 근거로 되돌린다.
  - 스크립트: `dev`=`next dev`, `build`=`next build`, `start`=`next start`. `db:migrate`는 3장.
- 삭제: `web/vite.config.ts`, `web/wrangler.local.jsonc`, `web/.openai/`.
- Tailwind: `vite.config.ts`에 있던 PostCSS 설정을 `web/postcss.config.mjs`(`@tailwindcss/postcss`)로 옮긴다.
- `tsconfig.json`: `types`에서 `@cloudflare/workers-types`, `vinext/types`를 뺀다. Next가 요구하는 설정은 `next build`가 안내하는 대로 맞춘다.
- 서버 환경값: `import { env } from 'cloudflare:workers'`(`lib/auth.ts`, `lib/sprint-store.ts`, `app/api/change-proposals/route.ts`, `app/api/internal/reminders/route.ts`)를 `process.env`로 바꾼다. 키 이름은 그대로(`SUPABASE_URL`, `AUTH_DEV_HEADERS`, `REMINDER_RUNNER_SECRET`, `EMAIL_*`, `PROJECTMATE_LIVE_MODEL`, `OPENAI_API_KEY`, `PROJECTMATE_MODEL`, `PROJECTMATE_REASONING_EFFORT`).
- 화면 환경값: `import.meta.env.VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` → `process.env.NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`. `web/.env.example`도 같은 이름으로 바꾼다. 사용자는 `web/.env.local`의 두 이름을 바꾼다.
- 개발 헤더: `lib/auth.ts`는 `process.env.AUTH_DEV_HEADERS === '1' && process.env.NODE_ENV !== 'production'`일 때만 `oai-authenticated-*` 헤더를 읽는다. `next start`와 Vercel은 항상 `NODE_ENV=production`이라 값이 잘못 설정돼도 켜지지 않는다. 로컬 값은 커밋하는 `web/.env.development`에 `AUTH_DEV_HEADERS=1`로 둔다(비밀값 아님). `web/.gitignore`에 `!.env.development` 예외를 추가한다.
- `next/font/google`, `next/link`, App Router 페이지 3개·라우트 핸들러 5개는 Next.js 형식 그대로 쓴다. 라우트의 `export const dynamic = 'force-dynamic'`은 유지한다.

## 3. DB 연결과 마이그레이션

새 파일 `web/lib/db.ts`:

- 타입 `Statement`: `bind(...args): Statement`, `first<T>(): Promise<T | null>`, `all<T>(): Promise<{ results: T[] }>`, `run(): Promise<{ meta: { changes: number } }>`.
- 타입 `Db`: `prepare(sql): Statement`, `batch<T>(statements: Statement[]): Promise<{ results: T[]; meta: { changes: number } }[]>`.
  - 코드가 D1에서 쓰는 기능이 정확히 이것뿐이다. 2번(Postgres)에서 이 모양을 유지하고 구현만 바꾼다.
- `database(): Db`: `node:sqlite`의 `DatabaseSync`를 프로세스당 한 번 연다. 경로는 `process.env.DATABASE_PATH`, 없으면 `web/.data/projectmate.sqlite`(디렉터리가 없으면 만든다). 열 때 `PRAGMA foreign_keys=ON`, `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`.
- `batch()`: `BEGIN IMMEDIATE` → 문장을 순서대로 실행 → `COMMIT`. 하나라도 실패하면 `ROLLBACK` 후 오류를 다시 던진다(D1 batch와 같은 원자성). 문장이 행을 돌려주는지는 `StatementSync.columns().length > 0`으로 판단한다(`RETURNING` 포함). 행을 돌려주면 `{ results: rows, meta: { changes: 0 } }`, 아니면 `{ results: [], meta: { changes } }`.
- `lib/sprint-store.ts`의 `database()`는 `./db`를 다시 내보낸다. `D1Database`·`D1PreparedStatement` 타입 2곳은 `Db`·`Statement`로 바꾼다. 다른 7개 파일의 import는 바꾸지 않는다.

마이그레이션:

- `npm run db:migrate` → `node scripts/migrate.mjs`.
- `_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` 기록을 두고, `drizzle/*.sql` 중 적용 안 된 파일만 이름순으로 파일 하나씩 트랜잭션으로 적용한다. 여러 번 실행해도 결과가 같다.
- 앱 시작 때 자동 마이그레이션은 하지 않는다. README에 명시한다.
- `drizzle.config.ts`·`db/schema.ts`는 이번에 바꾸지 않는다(2번에서 Postgres로).
- `web/.data/`는 git에서 제외한다.

시드: `scripts/seed-dev-team.mjs`는 API에 개발 헤더를 보내는 방식이라 `npm run dev`에 그대로 쓴다. `docs/dev-team-seed-notes.md`의 "build 후 wrangler dev" 절차를 `npm run db:migrate && npm run dev`로 바꾼다.

## 4. 검증

자동:

- 기존 테스트 8개 파일(`api`, `apply-revert`, `change-proposals`, `reminder-dispatch`, `reminder-consistency`, `save-guards`, `auth`, `dev-live-model`)
  - esbuild 플러그인이 `cloudflare:workers` 대신 `lib/sprint-store.ts`의 `./db`를 테스트 대역 `export function database(){return globalThis.__TEST_DB}`로 바꿔치기한다. 기존 SQLite 대역과 `__BEFORE_WRITE` 훅은 그대로 둔다.
  - 환경값은 `globalThis.__TEST_ENV` 대신 `process.env`를 직접 설정·복원한다. 개발 헤더를 쓰는 파일은 맨 위에서 `process.env.AUTH_DEV_HEADERS = '1'`.
  - `dev-live-model.test.mjs`의 `vite.config.ts`·`cloudflare:workers` 소스 검사는 "라우트가 `process.env`에서 live-model 값을 읽는다"는 검사로 바꾼다.
  - `auth.test.mjs`의 "serve에서만" 소스 검사는 동작 테스트로 바꾼다: `NODE_ENV=production`, `AUTH_DEV_HEADERS=1`, 개발 헤더만 → 401.
- 새 `tests/db.test.mjs`(실제 `lib/db.ts`와 `scripts/migrate.mjs`를 임시 파일 DB로 실행)
  1. `first`·`all`·`run` 결과 모양(`results`, `meta.changes`).
  2. `batch` 중간 실패 시 앞 문장까지 모두 되돌린다.
  3. `batch` 안 `RETURNING` 문장이 행을 돌려준다.
  4. 외래키 위반이 실패한다.
  5. 마이그레이션 두 번 실행 → `_migrations` 10행, 테이블 생성 1회.
- `npm test`, `npx tsc --noEmit`, `npx oxlint`(기존 오류 외 새 오류 0), `npm run build` 성공.

실제 서버:

- `npm run build && npm start`(운영 모드): `/`, `/workspace` 200. `/api/projects` 인증 없이 401, **개발 헤더를 붙여도 401**.
- `npm run dev`: 개발 헤더로 `/api/projects` 200, `node scripts/seed-dev-team.mjs --base-url http://localhost:3000` 성공.
- 사용자: `npm run dev`에서 Google 로그인 → 프로젝트 생성 → 새로고침 유지(Next.js에서 토큰 흐름 확인).

## 5. 문서

- `web/README.md`: 실행 방법(`npm ci`, `npm run db:migrate`, `npm run dev`), 환경값 이름(`NEXT_PUBLIC_*`), D1·Sites 설명 제거.
- `docs/dev-team-seed-notes.md`: 3장 시드 절차.
- `CLAUDE.md` 기술 원칙의 "배포 서비스는 web/의 Workers 호환 API + D1(SQLite)" → "웹 서비스는 web/의 Next.js. DB는 로컬 SQLite이며 Supabase Postgres로 이전 중이고, 운영 배포(Vercel)는 아직 없다." `.claude/launch.json`의 `landing-race`(포트 3100, `npm run dev -- --port 3100`)는 Next에서도 같은 인자로 동작하는지 확인하고 필요하면 고친다.
