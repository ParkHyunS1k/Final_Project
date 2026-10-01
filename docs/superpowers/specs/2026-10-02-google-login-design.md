# Google 로그인(Supabase Auth) 설계

작성일: 2026-10-02. 사용자와 대화로 합의했다. 이 문서는 **구현 전 설계 검토본**이며, 아래 기능이 이미 구현되었다는 뜻이 아니다.

기준 코드: `phs`, `4723759`.

## 1. 목적과 범위

지금 로그인은 호스팅 플랫폼이 넣어 주는 `oai-authenticated-user-*` 헤더에 의존한다(`web/lib/projects.ts`의 `identity()`). 직접 배포하면 이 헤더가 없으므로 로그인을 앱이 가져야 한다.

결정 사항:

- 인증은 Supabase Auth, 제공자는 **Google만**. 초대는 이메일 일치로 판정하므로 검증된 이메일을 항상 주는 제공자로 한정한다.
- 데이터는 **D1에 그대로** 둔다. Supabase는 인증에만 쓴다.
- 세션 전달은 **Bearer 토큰**. 쿠키·SSR 세션은 쓰지 않는다.
- 기존 데이터는 모두 테스트 데이터이므로 **이어받지 않는다**. 플랫폼 ID와 Supabase ID를 잇는 코드는 만들지 않는다.

범위 밖: 운영 `wrangler.jsonc`·실제 D1 생성·도메인 연결(별도 배포 작업), 별도 로그인 페이지, 프로필 편집, SSR 로그인 상태, 카카오·GitHub·이메일 OTP.

## 2. 서버 인증

`identity(request)`를 `async`로 바꾸고, 다음 순서로 사용자를 정한다.

1. `Authorization: Bearer <JWT>`가 있으면 `jose`로 검증한다.
   - 키: `createRemoteJWKSet(new URL(SUPABASE_URL + '/auth/v1/.well-known/jwks.json'))`. 모듈 수준에 하나 두어 Worker 인스턴스 안에서 캐시한다.
   - `issuer = SUPABASE_URL + '/auth/v1'`, `audience = 'authenticated'`, 만료 검사는 `jose` 기본값.
   - 반환: `{ id: sub, email: email.trim().toLowerCase(), name: user_metadata.full_name || user_metadata.name || 이메일 앞부분 || '팀원' }`, 이름은 60자로 자른다(기존과 동일).
   - `sub`나 `email`이 없거나 검증이 실패하면 `null`.
2. 토큰이 없고 `env.AUTH_DEV_HEADERS === '1'`일 때만 기존 `oai-authenticated-*` 헤더 경로를 쓴다. 기존 코드를 그대로 옮긴다.
3. 그 외는 `null`. 호출부는 지금처럼 401을 돌려준다.

`AUTH_DEV_HEADERS`는 로컬 개발과 테스트에만 둔다. 운영에서 이 값이 켜지면 누구나 헤더로 다른 사용자를 사칭할 수 있으므로, 값이 없을 때 헤더가 무시되는 것을 테스트로 고정한다.

호출부 8곳(`app/api/{projects,sprint,sources,change-proposals}/route.ts`)은 `identity(request)` → `await identity(request)`로만 바꾼다. 권한·멤버십 로직은 바꾸지 않는다.

서버는 Supabase 서비스 키를 쓰지 않는다. 필요한 서버 변수는 `SUPABASE_URL` 하나다.

## 3. 화면

새 파일 `web/lib/supabase-browser.ts`:

- `supabase`: `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, { auth: { flowType: 'pkce' } })`. 토큰이 URL에 남지 않는다.
- `apiFetch(path, init)`: `await supabase.auth.getSession()` 후 세션이 있으면 `Authorization` 헤더를 붙여 `fetch`한다. `getSession()`은 초기화(리다이렉트로 받은 `?code=` 교환 포함)를 기다리므로, Google에서 돌아온 직후 첫 요청이 401로 깜빡이지 않는다.
- `signInWithGoogle()`: `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname + location.search } })`. `?create=1`, `?invite=` 같은 주소 정보가 유지된다.
- `signOut()`: `supabase.auth.signOut()` 후 `/`로 이동.

변경 지점:

- API 호출 `fetch` 6곳(`app/workspace/page.tsx` 4곳, `components/project-workspace.tsx` 1곳, `components/change-review.tsx` 1곳)을 `apiFetch`로 바꾼다. 응답 처리는 그대로 둔다. `project-workspace.tsx`의 `api()`와 `change-review.tsx`의 `call()`은 공용 헬퍼라 그 안의 `fetch` 한 줄만 바꾸면 된다.
- "ChatGPT로 로그인" 버튼 2곳(`app/workspace/page.tsx`, `components/project-workspace.tsx`)을 "Google로 로그인" 버튼으로 바꾸고, `signInWithGoogle()`을 호출한다. 401일 때 버튼이 뜨는 기존 흐름은 유지한다.
- 작업 공간 상단에 로그아웃 버튼 하나.
- 초대 안내 문구 "팀원의 ChatGPT 로그인 이메일" → "팀원의 Google 계정 이메일".

## 4. 설정

| 위치 | 변수 | 둘 곳 |
|---|---|---|
| 서버 | `SUPABASE_URL` | 로컬: `web/.env.local` → `vite.config.ts`의 로컬 vars 목록에 추가. 운영: wrangler `vars` |
| 서버(로컬 전용) | `AUTH_DEV_HEADERS=1` | `vite.config.ts` 로컬 vars에 고정값으로 추가 |
| 화면(빌드 시) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `web/.env.local` |

- `web/.gitignore`가 `.env*`를 모두 제외하므로 `!.env.example`을 추가하고 `web/.env.example`에 변수 이름만 적는다.
- 새 의존성: `@supabase/supabase-js`, `jose`.

코드 밖에서 사용자가 할 일(구현 계획에 체크리스트로 넣는다):

1. Supabase 프로젝트 생성.
2. Google Cloud에서 OAuth 클라이언트(웹) 생성, 승인된 리디렉션 URI에 `https://<ref>.supabase.co/auth/v1/callback`.
3. Supabase Authentication → Providers → Google에 클라이언트 ID·비밀값 입력.
4. Supabase URL Configuration의 Redirect URLs에 `http://localhost:*/**`와 이후 운영 도메인.

## 5. 검증

자동(`web/tests/auth.test.mjs` 신규, 기존 `api.test.mjs`의 esbuild·가짜 `env` 방식을 따른다):

- 기존 테스트 6개 파일의 가짜 `env`에 `AUTH_DEV_HEADERS: '1'`와 `SUPABASE_URL`만 추가하고 전부 통과한다.
- 테스트 안에서 ES256 키를 만들어 토큰을 서명하고, JWKS 주소 요청만 `globalThis.fetch` 대체로 응답한다. 앱 코드에 테스트용 분기를 넣지 않는다.
  1. 올바른 토큰 → 프로젝트 생성 200, 다시 조회했을 때 소유자가 토큰의 `sub`·`email`.
  2. 만료, 다른 `iss`, 다른 `aud`, 다른 키 서명, `email` 없음 → 각각 401.
  3. `AUTH_DEV_HEADERS` 없음 + `oai-authenticated-user-id` 헤더만 → 401.
  4. A 토큰으로 만든 프로젝트를 B 토큰으로 조회 → 거절.
- `npm test`, `npm run lint`, `npm run build` 통과.

수동(로컬 개발 서버, 실제 Google 계정 두 개):

- A 로그인 → 프로젝트 생성 → B 이메일로 초대 → B가 초대 링크로 로그인 → 같은 프로젝트 조회. 새로고침 후 로그인 유지, 로그아웃 후 401 화면.
- 결과는 스크린샷과 함께 보고한다. 이것이 CLAUDE.md의 "실제 두 계정 협업 검증"을 처음 채운다.

## 6. 문서 갱신

- `docs/dev-team-seed-notes.md`: 헤더 방식은 `AUTH_DEV_HEADERS=1`인 로컬 전용이라고 명시.
- `CLAUDE.md`: 수동 검증을 통과하면 미검증 목록에서 "실제 두 계정 협업 검증"을 뺀다. 통과 전에는 바꾸지 않는다.
