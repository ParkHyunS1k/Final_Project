import sys
from pathlib import Path

# 프로젝트 루트 경로를 sys.path에 자동 등록
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.pipeline import SafetyRAGPipeline

# 1. 비전 모듈(YOLO/sVLM) 연동 규격 모의 JSON
vision_hazard_event = {
    "event_id": "EVT_20260824_KWATER_01",
    "timestamp": "2026-08-24 10:15:32",
    "zone": "낙동강유역 하구둑 3공구 수변 수문 비계 작업구역",
    "snapshot_path": "./snapshots/alert_frame_01.jpg",
    "bbox_coordinates": [412, 180, 560, 620],
    "detected_hazard": "고소작업대 비계 작업발판 미설치 및 안전대 미체결 상태 작업",
    "risk_level": "CRITICAL"
}

# 2. End-to-End RAG 파이프라인 초기화 및 실행
print("🚀 [K-water] End-to-End 안전 RAG 파이프라인 실행 중...")
pipeline = SafetyRAGPipeline()
result = pipeline.process_event(vision_hazard_event)

# 3. 결과 출력
print("\n" + "=" * 70)
print("📋 [1. 생성된 S2 작업중지권 근거 리포트]")
print("=" * 70)
print(result["s2_report"])

print("\n" + "=" * 70)
print("📊 [2. 익일 TBM(작업 전 안전점검회의) 환류 교육표]")
print("=" * 70)
print(result["s3_tbm_report"])