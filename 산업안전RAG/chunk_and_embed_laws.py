#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 청킹 및 임베딩 파이프라인 진입점
(K-water 오픈이노베이션 과제)
"""

import sys
from pathlib import Path

# 루트 경로 sys.path 추가
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.parser import load_and_chunk_all_laws
from src.vectorstore import QdrantLawStore


def main():
    print("=== K-water 산업안전 RAG 파이프라인 시작 ===")
    
    # 1. 청킹 수행 및 JSON 저장
    chunks = load_and_chunk_all_laws()
    
    # 2. BGE-M3 임베딩 및 Qdrant DB 적재
    store = QdrantLawStore()
    store.upsert_chunks(chunks)
    
    # 3. 하이브리드 검색 검증 테스트
    test_query = "고소작업대 비계 작업발판 미설치 추락 위험"
    print(f"\n[검증 테스트] 쿼리: '{test_query}'")
    results = store.search_hybrid(test_query, top_k=2)
    
    for rank, res in enumerate(results, 1):
        print(f"--- [순위 {rank}] Score: {res['score']:.4f} ---")
        print(f"· 법령: {res['doc_name']} {res['heading']}")
        print(f"· 미리보기: {res['text'][:200].replace(chr(10), ' ')}...")
        print("-" * 50)
        
    print("\n=== 모든 파이프라인 단계 성공적 완료 ===")


if __name__ == "__main__":
    main()
