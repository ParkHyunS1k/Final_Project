# GitHub 이슈 기록 기반 상태형 평가 후보 v1

**사람 검토 전 후보다. 정답(gold)이 아니다.** 한국어 GitHub 댓글 300건과, 댓글 시각의 이슈 목록을 이슈 기록으로 복원한 상태를 담았다. 댓글 뒤 48시간 안에 실제로 일어난 변경은 따로 저장했다. 수집일은 2026-09-10이다.

v1 평가셋(`public-task-extraction-50-v1`)에 없던 **기존 업무 목록과 참여자 목록**이 들어 있다. 그래서 다른 업무를 잘못 수정하는지, 무작업 입력에 업무를 만드는지, 대상 매칭이 맞는지 평가할 후보로 쓸 수 있다.

## 파일

| 파일 | 용도 |
|---|---|
| `candidates.jsonl` | 검토용 300건의 모델 입력. `input`만 모델에 준다. |
| `observed.jsonl` | 같은 300건의 이후 실제 변경. 채점 기준 후보이며 모델에 주지 않는다. `is_gold=false`. |
| `selection.json` | 300건 선정 방법, 유형·시기 분포, 사례별 유형. |
| `runs/all-years/`, `runs/pre2025/` | 수집 원본 풀 982건(중복 ID 제거 후). 검토에서 버린 사례의 교체용. |
| `choose_review_set.py` | 풀에서 300건을 다시 고른다. 같은 시드면 같은 결과. |
| `labels/` | AI(Claude)가 이후 기록을 보지 않고 쓴 블라인드 라벨과 기록 비교. 사람 검토자에게 보여주지 않는다. |
| `review.html` | 검토 화면. 원문·기준 시각 업무 목록을 보고 정답을 적어 `reviews-<검토자>-<날짜>.jsonl`로 내보낸다. |

## 사례 한 건의 구조

- `input.excerpts`: 기준 댓글과 같은 이슈의 바로 앞 댓글 최대 2개. API 본문을 그대로 복사했고 자르거나 고치지 않았다. 기준 댓글 위치는 `provenance.anchor_excerpt_index`.
- `input.prior_project_state.tasks`: 기준 시각 **직전**의 대상 이슈와 제목이 비슷한 이슈, 최대 8개. 제목(이후 바뀐 제목은 그때 제목으로 되돌림), 열림/닫힘, 닫힌 이유, 담당자. 번호순으로 정렬해 대상 위치가 드러나지 않는다.
- `input.member_directory`: 기준 시각 전에 이슈·댓글을 쓰거나 담당자로 지정된 계정. **실제 팀원 목록이 아니라 참여자 목록이다.**
- `observed.changes`: 기준 시각부터 48시간 안의 닫힘·다시 열림·담당자 지정/해제·제목 변경(보여준 업무만)과 저장소의 새 이슈 생성.

## 유형

| 유형 | 건수 | 뜻 |
|---|---:|---|
| A_anchor_changed | 120 | 댓글이 달린 이슈 자체가 이후 바뀜(닫힘 101, 담당자 38, 제목 16, 다시 열림 8 — 변경 건수 기준) |
| B_other_changed | 80 | 다른 이슈만 바뀌거나 새 이슈가 생김 |
| C_no_change | 100 | 기간 안 변경 없음 |

300건은 서로 다른 저장소 300개에서 1건씩이다. 기준 시각이 2025년 이전인 사례 155건, 이후 145건이다.

## 수집 방법

```sh
# runs/all-years: 아래 검색식 8개, 저장소 320개 한도, 저장소당 2건
# runs/pre2025: 같은 검색식 끝에 created:<2025-01-01 추가
python3 scripts/collect_github_timeline.py \
  --search "기능 구현 is:issue comments:>0" --search "완료했습니다 is:issue" \
  --search "작업 내용 is:issue comments:>0" --search "퍼블리싱 is:issue comments:>0" \
  --search "진행 중 is:issue comments:>0" --search "스프린트 is:issue comments:>0" \
  --search "API 연동 is:issue comments:>0" --search "버그 수정 is:issue comments:>0" \
  --max-repos 320 --per-repo 2 --out datasets/github-timeline-candidates-v1/runs/all-years
python3 datasets/github-timeline-candidates-v1/choose_review_set.py
```

제외 규칙: 이슈 5~300개 밖 저장소, 포크·보관 저장소, v1 평가셋 저장소, 기록이 100개를 넘어 잘린 저장소, 봇이 쓴 기준 댓글, 수정된 댓글(기준·앞 문맥 모두), 2,000자 초과 글, 한글 없는 글, 같은 저장소의 같은 본문 반복, AI 도구 서명(`Generated with`, `Co-Authored-By:`, `Claude Code`, 🤖)이 있는 글.

## 알려진 한계

- **관찰된 변경은 댓글이 원인이라는 증거가 아니다.** 말없이 닫거나, 완료라고 쓰고 안 닫거나, 무관한 이슈를 같은 시간에 만든 경우가 섞인다. 25건은 48시간 안에 새 이슈가 10개 넘게 생겼다.
- **2025년 이후 글에는 코딩 에이전트가 쓴 것으로 보이는 긴 보고가 섞인다.** 서명 문자열이 없으면 걸러지지 않는다. 계정 유형 `User`도 사람이 썼다는 보장이 아니다.
- 개발 저장소의 이슈 댓글이다. 2~4인 팀의 메신저 대화와 문체·길이 분포가 다르다.
- 이슈 본문, 라벨, 하위 이슈, 체크박스 목록은 넣지 않았다. 본문은 수정 이력 때문에 기준 시각 내용을 보장할 수 없다.
- 13건은 기준 댓글이 10자 미만이다. 무작업 판단 사례로 쓸지 검토에서 정한다.
- `ghost`는 탈퇴 계정이라 누구인지 알 수 없다.
- **300건 중 258건은 저장소 라이선스가 없다.** 출처 링크를 유지한 내부 평가용이다. 외부 공개·재배포·모델 학습에 쓰기 전에 이용 범위를 따로 확인해야 한다.

## 검토 방법

```sh
python3 -m http.server 8791 --directory datasets/github-timeline-candidates-v1
# 브라우저에서 http://localhost:8791/review.html
```

파일을 직접 열면(`file://`) 브라우저가 JSONL 자동 읽기를 막는다. 이때는 화면 위에서 `candidates.jsonl`과 `observed.jsonl`을 선택한다.

1. 검토자 이름을 입력한다. 작성 내용은 이 브라우저에 검토자별로 자동 저장된다.
2. 원문과 기준 시각 업무 목록만 보고 판단한다. **맨 아래의 실제 변경은 판단을 적은 뒤에 연다.**
3. 기대 결정, 기대 변경, 건드리면 안 되는 변경, 근거 발췌를 적고 `검토 완료`를 누른다. 쓸 수 없는 사례는 이유를 적고 `제외로 저장`한다.
4. 확정한 뒤 수정하면 다시 작성 중으로 돌아간다.
5. `검토 결과 내보내기`로 파일을 받는다. 브라우저 저장소는 지워질 수 있으므로 자주 내보낸다. 받은 파일을 다시 열면 이어서 검토할 수 있다.

두 사람이 독립 검토할 때는 서로의 결과를 보지 않고 각자 내보낸다. 불일치 합의는 두 파일을 비교해 따로 한다.

### 내보낸 검토 기록 형식

한 줄이 사례 1건이다. 작성 중인 기록도 백업을 위해 함께 내보내며, 채점에는 `review_status`가 `reviewed`인 기록만 쓴다.

```json
{
  "schema": "github-timeline-review-v1",
  "id": "GH-TL-5324875848",
  "reviewer": "PHS",
  "review_status": "reviewed",
  "expected_decision": "propose_changes",
  "expected_changes": [
    {"kind": "complete", "task_id": "issue-46", "after": {}},
    {"kind": "createTask", "task_id": null, "after": {"title": "회의록 API 연동", "person": ""}}
  ],
  "forbidden_changes": [{"task_id": "issue-49", "kind": "complete"}],
  "evidence_excerpt_indices": [0],
  "suspected_agent_authored": false,
  "notes": "",
  "discard_reason": "",
  "updated_at": "2026-09-10T15:00:00.000Z",
  "reviewed_at": "2026-09-10T15:00:00.000Z"
}
```

- `expected_decision`: `propose_changes`(변경 제안), `no_change`(무작업), `needs_clarification`(확인 필요). 변경 제안이 아니면 `expected_changes`는 비어 있다.
- `kind`는 서비스의 AI 변경 종류(`web/lib/ai-extraction.ts`)와 같다. `complete`, `status`(`todo`·`in_progress`), `assignee`(`person`은 참여자 계정), `remaining`(시간), `dueAt`, `createTask`(`title`, `person`, 미정이면 빈 문자열).
- `forbidden_changes.kind`가 `any`면 그 업무의 모든 변경이 금지다.
- `evidence_excerpt_indices`는 0부터 센다. 화면에는 1부터 표시한다.

`observed.changes`는 참고만 하고 그대로 옮기지 않는다. 버린 사례는 풀에서 같은 유형으로 교체한다. 보류 평가용 분할은 검토가 끝난 뒤 저장소 단위로 만든다.
