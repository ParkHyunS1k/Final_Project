# 개발용 가상 팀 시드 실행 기록

이 문서는 로컬 개발·검증 전용이다. 시드 스크립트는 DB에 직접 쓰지 않고 서비스의
HTTP API로 프로젝트 생성, 이메일 지정 초대, 초대 수락, 목표 합의, 스프린트 시작을
수행한다. 실제 모델 호출은 이 절차에 포함되지 않는다.

## 준비와 실행

`web/`에서 로컬 D1 migration과 production build를 준비한 뒤, build 산출물을 같은
D1 저장소로 실행한다. `--persist-to`를 생략하면 build용 Wrangler가 빈 별도 로컬
DB를 열 수 있다.

```bash
npm run db:migrate
npm run build
./node_modules/.bin/wrangler dev \
  --config dist/server/wrangler.json \
  --port 3001 \
  --persist-to "$PWD/.wrangler/state"
```

다른 터미널의 `web/`에서 시드를 실행한다.

```bash
node scripts/seed-dev-team.mjs --base-url http://127.0.0.1:3001
```

도움말은 서버 없이 확인할 수 있다.

```bash
node scripts/seed-dev-team.mjs --help
```

## 2026-09-14 실행 결과

첫 실행 출력:

```text
ProjectMate 개발 시드 완료 (새 프로젝트 생성)
base URL: http://127.0.0.1:3001
project ID: p_818a7952-d30d-4185-8f5d-ddbb97ef898e
lifecycle: active
members: 4

브라우저 요청에 사용할 가상 인물 헤더:
- 김리드 (PM·QA 팀장) [owner]
  oai-authenticated-user-id: dev-seed-lead-pm-qa
  oai-authenticated-user-email: dev-seed-lead@projectmate.local
  oai-authenticated-user-full-name: %EA%B9%80%EB%A6%AC%EB%93%9C%20(PM%C2%B7QA%20%ED%8C%80%EC%9E%A5)
  oai-authenticated-user-full-name-encoding: percent-encoded-utf-8
- 이프론트 (프론트엔드) [member]
  oai-authenticated-user-id: dev-seed-frontend
  oai-authenticated-user-email: dev-seed-frontend@projectmate.local
  oai-authenticated-user-full-name: %EC%9D%B4%ED%94%84%EB%A1%A0%ED%8A%B8%20(%ED%94%84%EB%A1%A0%ED%8A%B8%EC%97%94%EB%93%9C)
  oai-authenticated-user-full-name-encoding: percent-encoded-utf-8
- 박백엔드 (백엔드) [member]
  oai-authenticated-user-id: dev-seed-backend
  oai-authenticated-user-email: dev-seed-backend@projectmate.local
  oai-authenticated-user-full-name: %EB%B0%95%EB%B0%B1%EC%97%94%EB%93%9C%20(%EB%B0%B1%EC%97%94%EB%93%9C)
  oai-authenticated-user-full-name-encoding: percent-encoded-utf-8
- 최디자인 (UX 디자인) [member]
  oai-authenticated-user-id: dev-seed-design
  oai-authenticated-user-email: dev-seed-design@projectmate.local
  oai-authenticated-user-full-name: %EC%B5%9C%EB%94%94%EC%9E%90%EC%9D%B8%20(UX%20%EB%94%94%EC%9E%90%EC%9D%B8)
  oai-authenticated-user-full-name-encoding: percent-encoded-utf-8
```

같은 명령을 즉시 다시 실행한 결과:

```text
ProjectMate 개발 시드 완료 (기존 프로젝트 재사용)
base URL: http://127.0.0.1:3001
project ID: p_818a7952-d30d-4185-8f5d-ddbb97ef898e
lifecycle: active
members: 4
```

같은 project ID를 재사용했고 멤버 수도 4명으로 유지됐다.

## 브라우저에서 보는 법

1. 위 Wrangler 서버를 실행한 상태로 둔다.
2. 브라우저의 request-header 편집 기능 또는 개발용 header extension에서 아래 네
   헤더를 한 인물의 값으로 설정한다.
   - `oai-authenticated-user-id`
   - `oai-authenticated-user-email`
   - `oai-authenticated-user-full-name`
   - `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`
3. `http://127.0.0.1:3001`을 연다. 헤더는 문서 요청뿐 아니라 같은 origin의
   `/api/*` 요청에도 적용해야 한다.
4. 팀장을 보려면 김리드 헤더를, 팀원 계정을 확인하려면 나머지 인물 중 하나의 헤더
   세트를 사용한다. 서로 다른 인물의 값을 섞지 않는다.
5. 프로젝트 `[개발 시드] ProjectMate 업무분담 검증`을 열고
   `web/fixtures/dev-team-plan-samples/`의 `.txt` 네 건을 차례로 붙여넣는다.
   대응하는 `.expected.md`는 사람이 결과를 대조할 때만 사용한다.

개발 서버 `vinext dev`가 인증용 `oai-authenticated-user-*` 헤더를 보존하지 않는
환경에서는 위 build + Wrangler 실행법을 사용한다.
