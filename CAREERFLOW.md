# CareerFlow

채용공고를 관심 분야별로 찾고, 직무별 이력서를 저장해 공고와 비교하며, 준비 할 일을 관리하는 로컬 웹 앱이다. ProjectMate의 랜딩 페이지에 있는 `공고·이력서` 링크가 이 앱을 연다.

## 실행

저장소 루트에서 실행한다. Python 3.11 이상이 필요하다.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m careerflow.web --port 8766
```

브라우저에서 [http://127.0.0.1:8766](http://127.0.0.1:8766)를 연다. 통합 브랜치의 CareerFlow는 개인 저장소 앱(8765)과 동시에 실행할 수 있도록 8766 포트를 사용한다. 테스트용 공고와 로컬 키워드 비교는 API 키 없이 사용할 수 있다. PDF 텍스트 추출, 실제 공고 API, Gemini/OpenAI 분석에 필요한 선택 의존성은 `careerflow/requirements.txt`에 있다.

```bash
python -m pip install -r careerflow/requirements.txt
```

실제 출처 API는 `SARAMIN_API_KEY`, `WORK24_API_KEY`, AI 비교는 `GEMINI_API_KEY` 또는 `OPENAI_API_KEY`를 서버 터미널 환경에 설정한다. 키를 코드나 저장소에 기록하지 않는다. 키 없이 쓸 수 있는 목 공고와 로컬 비교가 기본 체험 흐름이다.

## 기능

- 관심 분야별 목 공고와 설정된 공식 출처의 공고를 모아 보여준다.
- 이력서 등록 페이지에서 여러 이력서를 이름별로 저장·선택·수정·복제·삭제한다.
- 선택한 이력서와 공고의 요구 역량을 비교한다.
- 공고 보관함에서 결과를 다시 열고, 준비 할 일을 등록하거나 관리한다.
- 공고 보관함에서 비교 결과를 삭제하고, 준비 할 일에서 체크된 항목을 삭제한다. 삭제 버튼은 같은 주의색을 사용한다.
- 이력서 텍스트와 비교 기록은 로컬 `careerflow-web.db`에 저장된다. PDF 원본 파일은 저장하지 않는다.

ProjectMate와 CareerFlow는 별도 앱이다. 랜딩 링크는 CareerFlow를 여는 역할만 하며, 이력서나 분석 결과를 ProjectMate로 전송하지 않는다. 두 앱을 다른 주소로 실행할 때는 `web/.env.local`의 `NEXT_PUBLIC_CAREERFLOW_URL`을 설정하고 ProjectMate 개발 서버를 다시 시작한다.
