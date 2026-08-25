#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VLM 위험 이벤트 파이프라인 단독 테스트 스크립트 (tests/test_vlm_pipeline.py)
"""

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.pipeline import SafetyRAGPipeline

TEST_EVENT = {
    "event_id": "EVT_TEST_2026_999",
    "timestamp": "2026-08-24 15:00:00",
    "zone": "K-water 대청댐 2공구 취수탑 수면 비계 구간",
    "snapshot_path": "./snapshots/alert_frame_999.jpg",
    "bbox_coordinates": [100, 200, 300, 400],
    "detected_hazard": "개구부 덮개 미설치 및 안전대 미체결 추락 위험",
    "risk_level": "CRITICAL"
}


def test_vlm_pipeline():
    print("=== VLM 위험 탐지 파이프라인 단독 테스트 시작 ===")
    pipeline = SafetyRAGPipeline()
    res = pipeline.process_event(TEST_EVENT)
    
    assert "s2_report" in res, "s2_report 누락됨"
    assert "s3_tbm_report" in res, "s3_tbm_report 누락됨"
    assert "[API 검증 완료]" in res["s2_report"], "API 검증 태그 누락됨"
    
    print("\n[검증 통과] s2_report 및 s3_tbm_report 정상 생성 확인!")
    print(f"S2 리포트 길이: {len(res['s2_report'])}자 | S3 TBM 리포트 길이: {len(res['s3_tbm_report'])}자")


if __name__ == "__main__":
    test_vlm_pipeline() 