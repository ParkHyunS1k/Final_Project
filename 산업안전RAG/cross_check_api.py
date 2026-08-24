#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 국가법령정보 API 교차 검증 진입점
(K-water 오픈이노베이션 과제)
"""

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.validator import normalize_article_no, get_mst_code, cross_check_law


if __name__ == "__main__":
    print("=== 국가법령정보 API 교차 검증기 모듈 테스트 ===")
    
    test_cases = [
        ("산업안전보건기준에 관한 규칙", "42"),
        ("산업안전보건법", "52"),
        ("산업안전보건기준에 관한 규칙", "4의2"),
        ("존재하지않는법령", "999")
    ]
    
    for law, art in test_cases:
        res = cross_check_law(law, art)
        print(f"\n· 검증 대상: {law} 제{art}조")
        print(f"· 결과: {res['status_tag']} | Verified: {res['verified']}")
        print(f"· 메시지: {res['message']}")
        if res['verified']:
            print(f"· 조문제목: {res['article_title']}")
