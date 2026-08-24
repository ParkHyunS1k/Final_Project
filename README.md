# 🏗️ K-water 산업안전 AI 위험행동감지 RAG 시스템

한국수자원공사(K-water) 오픈이노베이션 과제인 "AI 영상분석을 통한 위험행동감지 리포팅 기술"의 산업안전 법령 RAG 백엔드 시스템입니다.

---

## 🚀 3분 빠른 시작 (Quick Start)

### 1. 패키지 설치
$ python3 -m venv .venv
$ source .venv/bin/activate  # Windows: .venv\Scripts\activate
$ pip install -r requirements.txt

### 2. 환경변수 설정 (.env)
$ cp .env.example .env

[.env 파일 설정 내용]
LAW_OPEN_API_OC="chikipoki"          # 국가법령정보 API 키
GOOGLE_API_KEY="본인의_GEMINI_API_KEY" # Gemini LLM API 키

### 3. 로컬 DB 빌드 (최초 1회 필수)
저장소의 856개 정제 법령 청크를 읽어 로컬 Qdrant DB를 즉시 생성합니다.
$ python chunk_and_embed_laws.py

### 4. 동작 테스트 실행
$ python tests/run_e2e_test.py

---

## 💻 팀원 연동 인터페이스 (YOLO / VLM 연결용)

탐지 모델에서 위험 상황 발생 시 아래 형태로 호출하면 S2 리포트와 S3 TBM 표가 즉시 생성됩니다:

from src.pipeline import SafetyRAGPipeline

# 1. 비전 감지 이벤트 데이터
hazard_event = {
    "event_id": "EVT_20260824_001",
    "timestamp": "2026-08-24 14:15:30",
    "zone": "낙동강유역 하구둑 3공구 수변 수문 비계 작업구역",
    "snapshot_path": "./snapshots/alert_frame_01.jpg",
    "bbox_coordinates": [412, 180, 560, 620],
    "detected_hazard": "고소작업대 비계 작업발판 미설치 및 안전대 미체결 상태 작업",
    "risk_level": "CRITICAL"
}

# 2. RAG 파이프라인 실행
pipeline = SafetyRAGPipeline()
result = pipeline.process_event(hazard_event)

# 3. 결과 확인
print(result["s2_report"])      # 현장소장 결재용 작업중지권 리포트
print(result["s3_tbm_report"])  # 익일 아침 TBM 안전교육 집계표
