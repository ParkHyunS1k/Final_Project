# ProjectMate

**7~10일 안에 작은 프로젝트를 완성하도록 돕는 스프린트 운영 서비스.**

목적은 연구가 아니라 서비스 개발이다. 팀의 남은 작업과 가용시간을 바탕으로 병목을 확인하고, 필수 기능을 지키는 복구안을 검토·적용하도록 돕는다.

## 현재 서비스

`web/`에 웹 화면, 서버 API, D1 스키마·마이그레이션이 있다. 기존 Python 엔진은 `server/`에 별도로 보존한다. 두 구현이 연결되어 있다고 가정하지 않는다.

| 기능 | 상태 |
|---|---|
| 프로젝트 생성 | 목표·7~10일·필수 결과물·완료 기준 저장, 여러 프로젝트 전환 |
| 체크인·남은 공수 | 서버 저장 및 일정 재계산 |
| 날짜별 담당자 가용시간 | 0~12h, 0.5h 단위, 오전 9시부터 연속 배치 |
| 복구안 | 실제 용량·의존관계 계산, 부가 기능 보류안, 승인·거절·버전 검사 |
| 결과물 완료 | 직접 확인한 근거 저장. 자동 증빙 검증 아님 |
| 기록 | 변경 버전·시각·내용 저장 |
| 팀 구성 | 이메일 지정 초대 링크, 최대 4명, 팀장/팀원 권한. 실제 두 번째 계정 접속은 미검증 |
| 결제·환급 | 금액 예시만. 실제 돈 처리 없음 |
| LLM | 현재 운영 흐름은 규칙 계산. 실시간 모델 미연결 |

## 실행

웹 실행·마이그레이션·검증은 [web/README.md](web/README.md)를 따른다. `Final_Project` 저장소의 `phs` 브랜치에는 웹 소스, Python 엔진, 문서, 데이터셋과 모델 평가 결과를 함께 관리한다. 저장소를 한 번 복제하면 모든 소스를 받을 수 있다.

기존 Python 엔진 검증(macOS/Linux):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests
```

Windows는 `py -3 -m venv .venv` 및 `.venv\\Scripts\\python`을 사용한다. 이미지·스캔 PDF 전사는 기존 Python 경로의 `GEMINI_API_KEY`가 필요하지만 웹 파일럿에는 필요 없다. `.env`는 커밋하지 않는다.

## 문서

- [개발 기준](CLAUDE.md)
- [현재 기능·운영 방식](docs/features.md)
- [현재 개발 스프린트](docs/current-sprint.md)
- [서비스 품질 기준](docs/eval.md)
- [2026-09-08 검토 보고서](docs/reviews/2026-09-08-project-management-review.md)
- `docs/tools.md`: 기존 Python 엔진의 도구·DB 참조. 배포 웹의 API 계약은 `web/README.md` 기준.

과거 연구 중심 계획은 `docs/archive/`에 보관하며 현재 개발 지시로 사용하지 않는다.
