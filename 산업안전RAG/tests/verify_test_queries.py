#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.vectorstore import QdrantLawStore

# 1. Qdrant Store 초기화 및 하이브리드 인덱스 검증
store = QdrantLawStore()

# 2. 검증 시나리오 2종
test_scenarios = [
    {
        "name": "시나리오 1: 안전대/개구부 위험",
        "query": "개구부 덮개 미설치 및 안전대 미체결",
        "expected": ["제43조(개구부 등의 방호 조치)", "제44조(안전대의 부착설비 등)"]
    },
    {
        "name": "시나리오 2: 작업중지권 법률 근거",
        "query": "중대재해 발생 급박한 위험 근로자 작업중지",
        "expected": ["산업안전보건법 제52조(근로자의 작업중지)"]
    }
]

print("\n" + "="*60)
print("🚀 Qdrant 하이브리드 검색 정밀도 검증 시작")
print("="*60)

for scenario in test_scenarios:
    q_text = scenario["query"]
    print(f"\n📌 [{scenario['name']}]")
    print(f"• 입력 쿼리: \"{q_text}\"")
    print(f"• 기대 조항: {', '.join(scenario['expected'])}")
    
    results = store.search_hybrid(q_text, top_k=3)
    
    print("\n[🔍 검색 결과 상위 3건]")
    for rank, res in enumerate(results, start=1):
        print(f"  {rank}위: [{res['doc_name']} {res['heading']}] (Score: {res['score']:.4f})")
        lines = [line.strip() for line in res['text'].split('\n') if line.strip()]
        first_line = lines[1] if len(lines) > 1 else lines[0]
        print(f"       미리보기: {first_line[:85]}...")