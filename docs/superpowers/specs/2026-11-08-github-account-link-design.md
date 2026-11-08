# GitHub 계정 연결 설계 — 2026-11-08

## 왜

학습 확인(`/api/review`, 2026-10-15)은 GitHub 아이디를 사용자가 직접 입력한다. 소유 확인이 없어 남의 아이디를 적어도 막지 못한다(그 설계의 '미구현·한계'). GitHub 계정을 연결해 **이 GitHub 아이디가 이 사용자 본인 것**임을 확인하고, 다음 작업인 GitHub 이슈 가져오기에서 이슈 담당자(@아이디)를 팀원과 짝짓는 토대로 쓴다.

## 사용자 결정(2026-11-08)

| 항목 | 결정 |
| --- | --- |
| 방식 | 로그인은 계속 **Google만**. GitHub는 로그인한 계정에 붙이는 **연결**(Supabase `linkIdentity`). GitHub 로그인 버튼은 만들지 않는다 |
| 학습 확인 | **GitHub를 연결하지 않으면 학습 확인을 못 한다.** 직접 입력한 아이디는 더 이상 받지 않는다 |
| 공개 범위 | 연결된 GitHub 아이디는 **같은 프로젝트 팀원에게도 보인다** |
| 외부 설정 | GitHub OAuth App 등록, Supabase 대시보드의 GitHub 공급자·Manual Linking 켜기는 사용자가 직접 한다 |

## 목표 / 비목표 / 실패 조건

- 목표: 마이페이지에서 GitHub 연결·해제·다른 계정으로 바꾸기. 서버 DB에 확인된 GitHub 계정 저장. 학습 확인이 그 계정을 쓴다. 팀원 목록에 GitHub 아이디 표시.
- 비목표: GitHub 로그인, 비공개 저장소 읽기, 저장소 쓰기 권한, 이슈 가져오기(다음 작업), 웹훅·GitHub App.
- 실패 조건(동작해도 실패로 본다):
  - 브라우저가 보낸 GitHub 아이디를 서버가 믿는다.
  - 연결 때문에 Google 로그인·초대 이메일 규칙(`lib/auth.ts`의 `provider === 'google'` 검사)이 깨진다.
  - GitHub 하나가 ProjectMate 계정 둘에 연결된다.
  - Supabase에서는 해제됐는데 DB에는 연결로 남아 학습 확인이 계속된다.

## 동작

### 연결

1. 마이페이지(`components/career-workspace.tsx`, 이력서·역량 영역 근처)에 'GitHub 연결' 버튼.
2. 버튼은 `supabase.auth.linkIdentity({ provider: 'github', options: { redirectTo } })`. 권한 범위는 Supabase GitHub 공급자 기본값(프로필과 `user:email`)만 쓰고 `repo` 등 추가 scope는 요청하지 않는다. 화면 안내도 이메일 주소 확인을 포함한다(Codex 리뷰 2026-11-08).
3. GitHub 승인 후 돌아오면 화면이 `POST /api/github {action:'sync'}`를 부른다.
4. 서버는 사용자의 access token으로 `GET {SUPABASE_URL}/auth/v1/user`를 직접 불러 `identities` 중 `provider === 'github'`을 찾는다. 요청 본문의 아이디·숫자 id는 받지 않는다.
   - 찾으면 GitHub 숫자 id(`identity_data.provider_id` 또는 `sub`/`id`)와 아이디(`identity_data.user_name`, 없으면 `preferred_username`)로 저장(upsert).
   - 없으면 저장된 연결을 지운다.
5. 응답: `{ github: { login, linkedAt } | null }`.

### 해제·바꾸기

- 해제: `supabase.auth.unlinkIdentity(githubIdentity)` → `POST /api/github {action:'sync'}`. 서버는 Supabase 기준으로 맞추므로 행이 지워진다.
- 바꾸기: 해제 후 다시 연결. 별도 기능을 만들지 않는다.
- Google 신원은 해제 대상이 아니다. 화면에 GitHub 해제만 둔다.

### 조회

- `GET /api/github` → 본인 연결 `{ github: { login, linkedAt } | null }`. 이 조회도 Supabase 상태로 다시 맞출지(sync와 동일)는 빌더 판단. 단 학습 확인 시작 시점에는 아래처럼 반드시 확인한다.

### 학습 확인 변경(`app/api/review/route.ts`, `lib/ai-review-store.ts`)

- `link` 액션·`start`의 인라인 등록은 **저장소 주소만** 받는다. `githubLogin` 입력은 무시하지 말고 거절하지도 말고 받지 않는 것으로 정리한다(빌더 판단: 보내도 쓰지 않음).
- `start`/`final` 시작 시 서버가 사용자의 연결된 GitHub 계정을 읽는다. 없으면 `400`(또는 기존 `PolicyError`) "마이페이지에서 GitHub를 먼저 연결해주세요." 한도는 차감하지 않는다.
- 커밋을 거르는 아이디는 연결된 계정의 아이디. `learning_reviews.github_login`에는 그때 쓴 아이디를 그대로 기록한다(지난 기록 보존).
- 이미 직접 입력한 아이디로 만든 지난 기록은 그대로 둔다.
- `GET /api/review`의 `link.githubLogin`은 연결된 계정 아이디로 보여준다(없으면 null).
- 답변(`answer`)은 이미 만든 질문을 채점하므로 연결 여부를 다시 묻지 않는다(빌더 판단으로 바꿔도 됨).

### 팀원에게 보이기

- 프로젝트의 팀원 목록을 돌려주는 기존 응답(프로젝트 화면의 members, `display_name`을 쓰는 곳)에 `githubLogin`(없으면 null)을 붙인다. 같은 프로젝트 현재 멤버에게만 보인다. 공개 팀 목록(팀 찾기)·비멤버에게는 보이지 않는다.
- 화면에는 팀원 이름 옆에 `@아이디`. GitHub 프로필 링크(`https://github.com/<login>`)는 빌더 판단.

## 저장(새 마이그레이션 0010, 테이블 추가만)

`github_accounts`
- `user_id` text PK
- `github_id` text NOT NULL **UNIQUE** — 아이디는 바뀔 수 있으니 숫자 id가 기준
- `login` text NOT NULL
- `linked_at` timestamptz NOT NULL
- `updated_at` timestamptz NOT NULL
- RLS ON, 정책 없음(다른 테이블과 같다).

`review_links.github_login`은 지우지 않는다(파괴적 마이그레이션 금지). 새로 저장할 때 무엇을 넣을지(연결된 아이디 또는 빈 문자열)는 빌더 판단이며, 읽을 때는 쓰지 않는다.

## 규칙·보안

- 서버만 GitHub 계정을 쓴다. 기준은 Supabase 신원 → DB. 브라우저 값은 믿지 않는다.
- 같은 GitHub를 다른 사용자가 연결하려 하면 Supabase가 먼저 거절한다(identity already linked).
- **옛 행 넘기기(작성자 판단):** A가 Supabase에서 해제하고 sync 없이 떠나면 DB에 A의 행이 남는다. 그 뒤 B가 같은 GitHub를 연결해 sync하면 `github_id` UNIQUE 충돌이 난다. Supabase는 한 신원을 한 사용자에게만 붙이므로, B의 신원에 있다는 것이 소유 증거다. 한 트랜잭션에서 A의 행을 지우고 B로 저장하며, 양쪽에 기록을 남긴다. 409로 막지 않는다. 서버에는 service role 키가 없어 A의 상태를 따로 확인하지 않는다.
- Supabase 조회 실패는 503(기존 `AuthUnavailable`과 같은 처리). 이때 기존 연결을 지우지 않는다.
- 연결·해제는 변경 기록을 남긴다(CLAUDE.md '설명할 수 있는 기록'). 기존 `events` 테이블을 쓸지, 계정 단위라 프로젝트가 없으니 다른 곳에 남길지는 빌더 판단.
- 로컬·테스트(PGlite, `AUTH_DEV_HEADERS`)에는 Supabase가 없다. sync가 부르는 "Supabase 사용자 조회"를 바꿔 끼울 수 있게 해 테스트에서 가짜 신원을 넣는다(`lib/ai-review-runtime.ts`처럼).
- GitHub 계정 연결은 로그인 판정(`lib/auth.ts`)을 바꾸지 않는다. 연결 뒤에도 토큰의 `app_metadata.provider`는 `google`로 남는지 실제 Supabase에서 확인한다. 바뀐다면 `providers` 배열에 `google`이 있는지로 판정해야 하며 이 경우 사용자에게 먼저 알린다.
- **표시 이름은 Google 이름 유지(작성자 판단):** Supabase가 연결 때 `user_metadata.full_name`/`name`을 GitHub 값으로 덮어쓸 수 있다(미확인). `lib/auth.ts`는 표시 이름을 여기서 읽으므로, 덮어쓰면 이후 멤버 등록·참여 신청·관심 표시에 GitHub 이름이 저장된다. 실제 Supabase에서 먼저 확인하고, 덮어쓴다면 Google 이름이 유지되도록 `lib/auth.ts`의 이름 읽기만 고친다(로그인 판정은 그대로).
- 나간 멤버: 나간 사람이 프로젝트를 다시 볼 때는 팀원 `githubLogin`을 숨긴다. 남은 팀원에게는 나간 멤버의 아이디를 계속 보여준다(작성자 판단).

## 검증(개발 완료 기준)

- 연결 → sync → 재조회 시 같은 아이디.
- 계정 분리: B의 Supabase 신원에 GitHub가 없으면 B가 sync해도 A의 연결이 바뀌지 않는다. B의 신원에 A와 같은 github_id가 있으면(옛 행) A의 행은 지워지고 B로 넘어간다.
- 운영 확인에 표시 이름 확인을 추가: 연결 뒤 새로 참여한 프로젝트에 Google 이름이 저장되는지.
- 해제 후 sync → 행 삭제 → 학습 확인 시작 거절, 한도 그대로.
- 연결 없이 학습 확인 시작 → 거절. 연결 후 → 연결된 아이디로 커밋 조회.
- 팀원 목록: 같은 프로젝트 멤버는 아이디를 보고, 비멤버는 프로젝트 자체를 못 보며, 공개 팀 목록에는 없다.
- Supabase 조회 실패 시 기존 연결 유지.
- 운영 확인(사용자와 함께): 실제 GitHub 연결 1회, 연결 뒤 Google 재로그인이 되는지.

## 사용자가 할 일(코드 밖)

1. GitHub → Settings → Developer settings → OAuth Apps에서 앱 등록. Callback URL은 `https://<supabase-project>.supabase.co/auth/v1/callback`.
2. Supabase → Authentication → Providers → GitHub 켜고 Client ID/Secret 입력.
3. Supabase → Authentication → Settings에서 Manual Linking 켜기.
4. 운영 DB에 0010 마이그레이션 적용.

## 빌더에게 맡김

API 파일 위치(`app/api/github/route.ts` 권장), 화면 문구·모양, 팀원 목록 표시 모양, 기록 위치, `GET /api/github`의 재동기화 여부.
