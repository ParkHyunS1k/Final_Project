# 학습 확인(커밋 기반 AI 이해도 질문) 설계 — 2026-10-15

배경: 2026-10-14 피드백 "주기적으로 공부하는지 체크", "AI가 결과물에 대해 질문해 진짜 이해했는지 확인, 깃허브 저장소 분석, 저비용 모델로 압축해 비용 절감". 작업 지시: docs/handoff/2026-10-14-feedback-tasks.md 세션 4.

## 사용자 결정(2026-10-15)

| 항목 | 결정 |
| --- | --- |
| 두 요구 묶기 | 한 기능의 두 종류. **daily**: 그날(KST) 내 GitHub 커밋 기반 질문. **final**: 프로젝트 종료 후 프로젝트 기간 전체 내 커밋 기반 질문 |
| 주기·건너뜀 | 하루 1회, **표시만**(감점 없음). 세션 3 점수와 연결하지 않음 |
| 대상 | **공개 GitHub 저장소만**. 비공개 토큰 받지 않음 |
| 내 커밋 식별 | 프로젝트마다 저장소 URL과 **GitHub 아이디를 입력·저장**. 소유 확인(OAuth) 없음 — 남의 아이디를 적을 수 있다는 한계가 있다 |
| 커밋 없는 날 | AI 호출 없이 `status: 'no_commits'`. 기록·한도 차감 없음(커밋 후 다시 시도 가능) |
| 최종 확인 시점 | 완주(completed)·기한 종료(expired) 뒤에만, 사용자·프로젝트당 한 번 |
| 모델·한도 | 압축 저비용 모델(기본 `gpt-6.1-luna`, 이름은 운영 키로 미확인) + 질문·채점 `gpt-6.1-sol`(low). 사용자당 하루 **3회**(review_quota, AI 변경안 10회와 별도) |

## 흐름

1. `POST /api/review {action:'link', projectId, repoUrl, githubLogin}` — 등록(또는 `start`에 `sourceUrl`·`githubLogin`을 함께 보냄).
2. `POST /api/review {action:'start', projectId}` (daily) / `{action:'final', projectId}`.
   - 같은 날·종류의 확인이 이미 있으면 같은 질문을 돌려준다(`repeated: true`, 모델 재호출 없음). 이미 답했으면 409.
   - 한도 한 칸을 잡고 → GitHub 읽기 → 커밋 없음/GitHub 실패/모델 실패면 한 칸을 돌려준다.
   - 응답 `201 { reviewId, kind, status:'asked', questions:[{id,text}], commitCount, truncated }` 또는 `200 { status:'no_commits', questions:[] }`.
3. `POST /api/review {action:'answer', reviewId, answers:[{id,text}]}` → `{ reviewId, feedback:[{id, verdict:'ok'|'partial'|'missing', comment}], gaps: string[] }`. 한 번만 저장(조건부 UPDATE). 채점 실패는 저장하지 않고 다시 답할 수 있다. 빈 답은 모델 판정과 상관없이 missing.
4. `GET /api/review?project=<id>` → `{ link, today:{due, done, status, reviewId}, final:{available, done, status, reviewId}, history:[...본인 기록], quota:{limit, used}, aiAvailable }`.
   - `today.due`: 진행 중(active) 프로젝트의 현재 멤버. 화면의 '오늘의 확인' 표시용.

## 비용 절감 구조

- 저장소를 통째로 넣지 않는다. GitHub API 고정 경로로 **내 커밋 목록**(daily 최대 10, final 최대 100) + **최근 8개 커밋의 diff**(커밋당 파일 8개, 패치 1,500자, 잠금·빌드·바이너리 파일 제외) + final은 README 3,000자. 전체 24,000자 상한.
- 자료가 4,000자를 넘으면 저비용 모델이 4,000자 이내 digest로 압축. 작으면 그대로 digest.
- 질문 생성·채점은 상위 모델이 digest만 본다. 채점은 저장된 digest를 다시 써서 GitHub를 다시 부르지 않는다.

### 호출당 예상 비용(추정, 실측 아님)

단가는 저장소 평가 스크립트(evals/*/score.py)의 gpt-5.6 단가를 대용으로 썼다(Luna 입력 $0.2·출력 $1.2, Sol 입력 $4·출력 $20 / 1M 토큰). gpt-6.1 단가는 확인하지 않았다.

| 경우 | 압축(Luna) | 질문(Sol) | 채점(Sol) | 확인 1회 |
| --- | --- | --- | --- | --- |
| 작은 하루 커밋(≤4,000자, 압축 생략) | – | 입력 ~1.5k·출력 ~0.5k ≈ $0.016 | 입력 ~2.2k·출력 ~0.7k ≈ $0.023 | **≈ $0.04** |
| 큰 자료(24,000자 ≈ 8k 토큰) | 입력 ~8.3k·출력 ~1.5k ≈ $0.004 | ≈ $0.018 | ≈ $0.025 | **≈ $0.05** |
| (비교) 압축 없이 Sol에 원자료 | – | ≈ $0.044 | ≈ $0.048 | ≈ $0.09 |

- 사용자당 하루 최대 3회 ≈ $0.15. 7일 스프린트(매일 1회 + 최종 1회) ≈ $0.35/인.
- 실측은 운영 키가 있는 환경에서 1회 호출해 서버 로그(`learning review usage`)의 토큰 수로 확인한다. 이 작업 환경에는 OPENAI 키가 없어 실측하지 못했다.

## 보안

- SSRF: 사용자 URL을 fetch하지 않는다. `https://github.com/<owner>/<repo>`만 받아 owner/repo를 정규식으로 검사한 뒤 `https://api.github.com/repos/...` 고정 경로를 서버가 만든다. 리다이렉트는 따르지 않는다(`redirect: 'manual'` → 실패). 응답 1MB 상한, 요청당 10초.
- 비공개 저장소 토큰은 받지 않는다. 서버 환경값 `GITHUB_TOKEN`(선택)은 GitHub 호출 한도 완화용(공개 읽기)으로만 쓴다. 없으면 비인증 한도(IP당 시간 60회)라 운영에서는 넣는 것을 권한다.
- 프롬프트 인젝션: 저장소 자료·digest·답은 `<repository_data>`/`<digest>`/`<answer>` 블록으로 감싸고 블록을 닫는 태그를 무력화한다. 지시문은 블록 안 명령을 따르지 말라고 한다. 출력은 strict JSON 스키마, 도구 호출 거절, 서버가 질문 수(3~5)·길이·id(q1..)·판정 enum을 다시 검사한다. 모델 출력은 DB의 다른 값을 바꾸지 못한다.
- 범위: 기록은 본인 것만 조회·답변. 남의 reviewId는 404. 비멤버 403, 떠난 멤버는 시작·답변 불가. 저장 시점에도 현재 멤버 조건을 SQL에 건다.

## 저장(마이그레이션 0007, 테이블 추가만)

- `review_links(project_id, user_id, repo_owner, repo_name, github_login, updated_at)`
- `learning_reviews(id, project_id, user_id, kind, day, status, repo, github_login, commit_count, commits, digest, questions, answers, feedback, gaps, model, created_at, answered_at)`, 유일 (project_id, user_id, kind, day). final의 day는 프로젝트 끝날(KST)로 고정해 한 번만 만든다.
- `review_quota(user_id, day, n)`

세션 2·3이 0005·0006을 쓰므로 번호를 0007로 두었다. 머지 순서에 따라 drizzle 스냅샷(meta)과 `tests/db.test.ts` 테이블 수를 다시 맞춘다.

## 미구현·한계

- 화면 없음(API만). '오늘의 확인' 표시는 UI 세션이 GET 응답으로 만든다.
- GitHub 아이디 소유 확인 없음. 다른 사람 아이디·저장소를 적어도 막지 못한다(점수와 연결하지 않은 이유 중 하나).
- 실제 모델 호출 실측(비용·시간)은 키가 있는 환경에서 따로 한다. 저비용 모델 이름 `gpt-6.1-luna`는 확인 전이며 `PROJECTMATE_REVIEW_SUMMARY_MODEL`로 바꿀 수 있다.
