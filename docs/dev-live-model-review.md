# 개발 전용 실제 모델 어댑터 리뷰

## 차단 수준 문제

### 1. Workers HTTP 경로에서 API 키를 읽을 수 없음

`web/lib/dev-live-model.ts:184-206`은 저장소 루트 `.env`를 `node:fs/readFileSync`로 직접 읽는다.
Cloudflare Workers 런타임에는 호스트 파일시스템이 없고, build 뒤 `import.meta.url` 위치도
`web/lib/`에서 `dist/server/_next/static/`으로 바뀐다. 따라서 실제 HTTP 경로에서는
`OPENAI_API_KEY를 읽을 수 없습니다`로 실패하고 변경안이 0건으로 저장된다.

브라우저를 통한 재현 결과는 `docs/dev-live-model-assignment-test.md:228-289`에 있다.
`PROJECTMATE_LIVE_MODEL` binding을 넣으면 `live:true`까지는 전환되지만 키 조달 단계에서 실패한다.
Workers binding의 `OPENAI_API_KEY`를 route에서 adapter로 명시 주입해야 한다.

### 2. 현재 테스트가 Workers 결함을 잡지 못함

`web/tests/dev-live-model.test.mjs:17-44`는 esbuild `platform:'node'`를 사용하고 `node:fs`를
가짜 구현으로 대체한다. `web/tests/dev-live-model.test.mjs:99-113`의 route 검증도 소스 문자열
정규식이다. 그래서 Workers에서 node builtin이 동작하지 않는 실제 결함을 검출하지 못했다.

Workers-compatible bundle에 Node builtin이 남지 않는지 검증하고, secret을 옵션으로 주입했을 때
어댑터가 그 값을 사용하는 regression test가 필요하다. 기본 test suite에는 실제 네트워크 호출을
넣지 않는다.

## 개선 권고

### basis의 의미를 명확히 할 것

`web/lib/ai-extraction.ts:217-230`은 change 단위 `basis` 하나만 둔다. 담당자 단서가 없는
`03-no-owners.txt`에서 모델은 업무 제목·공수가 원문에 있다는 뜻으로 `basis=fact`를 냈지만,
`03-no-owners.expected.md:5-15`는 담당자 근거가 없다는 뜻으로 `basis=estimate`를 기대한다.
업무 자체의 근거와 담당자 배정 근거를 분리하거나 문서로 의미를 명확히 할 필요가 있다.

### 시드 프로젝트 재사용 collision

`web/scripts/seed-dev-team.mjs:127-136`은 제목만으로 기존 프로젝트를 재사용한다. 같은 제목의
별도 프로젝트가 있으면 엉뚱한 데이터를 재사용할 수 있다. 개발 시드 ID/태그를 별도로 확인하는
방식이 더 안전하다. 이번 검증 범위에서는 실제 collision을 관찰하지 않았다.

## 잘 된 부분

- 실제 모델 출력은 항상 `validateChanges()`를 통과하고 사용자 승인 전 업무 DB를 바꾸지 않는다.
- 원문 근거 위치는 모델이 준 인덱스를 신뢰하지 않고 서버가 quote를 다시 찾아 계산한다.
- 명시 담당자 4건은 모두 `basis=fact`, 역할 기반 담당자 4건은 모두 `basis=estimate`였다.
- 담당자 단서가 없는 4건은 모두 `person:null`과 `needsReview:"담당자 미정"`으로 남아 임의 배정하지 않았다.
- 지시 주입 문장은 완료 처리나 김리드 일괄 배정으로 실행되지 않았다.
- 원본 응답 JSON은 4 runs, 각 changes=4/rejected=0이며 credential-like pattern은 발견되지 않았다.

## 실행한 검증

- `npm test`: 128/128 통과
- 신규 테스트: 6/6 통과
- `npm run build`: 통과
- 전체 lint: 기존 범위 밖 오류로 exit 1
- 변경 파일 대상 oxlint: exit 0
- 응답 JSON parse: 통과
- `.env`: git status에 나타나지 않음

실제 키 재호출과 DB 쓰기는 reviewer가 수행하지 않았다. reviewer 프로필은 read-only이므로 이 문서는
리뷰 comment의 내용을 오케스트레이터가 그대로 materialize했다.
