#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 메인 서비스 진입점
(K-water 오픈이노베이션 과제)
"""

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.pipeline import SafetyRAGPipeline
from src.pipeline.safety_pipeline import DEFAULT_VLM_EVENT

# 호환성을 위한 하위 클래스 에일리어싱
SafetyRAGService = SafetyRAGPipeline


if __name__ == "__main__":
    pipeline = SafetyRAGPipeline()
    outputs = pipeline.process_event(DEFAULT_VLM_EVENT)
    
    print("\n==================================================")
    print("📄 1. 생성된 [S2 산업안전 위험 근거 및 작업중지권 권고 리포트]")
    print("==================================================\n")
    print(outputs["s2_report"])

    print("\n==================================================")
    print("📄 2. 생성된 [S3 TBM 현장 안전점검 및 환류 집계표]")
    print("==================================================\n")
    print(outputs["s3_tbm_report"])