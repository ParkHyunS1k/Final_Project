#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from qdrant_client import QdrantClient
from src.config import config

# 1. 로컬 Qdrant DB 연결
client = QdrantClient(path=str(config.QDRANT_PATH))
collection_name = config.COLLECTION_NAME

# 2. 컬렉션 메타 정보 조회
info = client.get_collection(collection_name=collection_name)
print("=" * 60)
print(f"📊 [Qdrant 컬렉션 정보: {collection_name}]")
print(f"• 총 적재 포인트(조문 청크) 수: {info.points_count}개")
print(f"• 벡터 구성: {info.config.params.vectors}")
print(f"• 스파스 벡터 구성: {info.config.params.sparse_vectors}")
print("=" * 60)

# 3. 실제 적재된 포인트 샘플 3건 스크롤 조회
records, _ = client.scroll(
    collection_name=collection_name,
    limit=3,
    with_payload=True,
    with_vectors=False
)

print("\n📋 [적재된 조문 데이터 샘플 미리보기]")
for i, record in enumerate(records, 1):
    payload = record.payload
    print(f"\n[포인트 ID: {record.id}]")
    print(f"• 법령명: {payload.get('doc_name')}")
    print(f"• 표제어: {payload.get('heading')}")
    print(f"• 조문번호: {payload.get('article_no')} / 제목: {payload.get('article_title')}")
    print(f"• 저장된 전문(미리보기):\n{payload.get('text')[:180]}...")
    print("-" * 50)

client.close()