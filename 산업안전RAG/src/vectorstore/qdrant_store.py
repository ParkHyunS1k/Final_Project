# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - Qdrant Vector Store 모듈 (src/vectorstore/qdrant_store.py)
"""

import os
from typing import List, Dict, Any, Optional
import torch
from FlagEmbedding import BGEM3FlagModel
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams,
    Distance,
    SparseVectorParams,
    SparseIndexParams,
    PointStruct,
    SparseVector,
    Prefetch,
    Fusion,
    FusionQuery
)
from src.config import config


def convert_lexical_weights_to_sparse_vector(lex_weights: Dict[Any, float], tokenizer: Any) -> SparseVector:
    """
    FlagEmbedding lexical_weights dict를 Qdrant SparseVector(indices, values)로 변환
    """
    indices = []
    values = []

    for k, v in lex_weights.items():
        if isinstance(k, int):
            idx = k
        elif isinstance(k, str):
            if k.isdigit():
                idx = int(k)
            elif tokenizer is not None:
                token_id = tokenizer.convert_tokens_to_ids(k)
                if token_id is not None and token_id != getattr(tokenizer, 'unk_token_id', None):
                    idx = token_id
                else:
                    idx = abs(hash(k)) % (2**31 - 1)
            else:
                idx = abs(hash(k)) % (2**31 - 1)
        else:
            idx = abs(hash(str(k))) % (2**31 - 1)

        indices.append(idx)
        values.append(float(v))

    return SparseVector(indices=indices, values=values)


class QdrantLawStore:
    """
    BGE-M3 하이브리드 임베딩 및 Qdrant Vector DB 적재/검색 클래스
    """

    def __init__(self, db_path: Optional[str] = None, collection_name: Optional[str] = None):
        self.db_path = db_path or str(config.QDRANT_PATH)
        self.collection_name = collection_name or config.COLLECTION_NAME
        self.device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")

        print(f"[QdrantStore] BGE-M3 모델 로딩 중 (Model: {config.EMBEDDING_MODEL_NAME}, Device: {self.device})...")
        self.model = BGEM3FlagModel(config.EMBEDDING_MODEL_NAME, use_fp16=False, device=self.device)
        self.tokenizer = getattr(self.model, 'tokenizer', None)

        os.makedirs(self.db_path, exist_ok=True)
        print(f"[QdrantStore] Qdrant Client 연결 중 ({self.db_path})...")
        self.client = QdrantClient(path=self.db_path)

    def init_collection(self, recreate: bool = True):
        """
        safety_laws 컬렉션 생성 (Dense 1024 Cosine + Sparse)
        """
        if recreate and self.client.collection_exists(self.collection_name):
            self.client.delete_collection(self.collection_name)

        if not self.client.collection_exists(self.collection_name):
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config={
                    "dense": VectorParams(size=1024, distance=Distance.COSINE)
                },
                sparse_vectors_config={
                    "sparse": SparseVectorParams(index=SparseIndexParams())
                }
            )
            print(f"[QdrantStore] 컬렉션 '{self.collection_name}' 생성 완료.")

    def upsert_chunks(self, chunks: List[Dict[str, Any]], batch_size: int = 100):
        """
        법령 청크 데이터 임베딩 계산 및 Qdrant DB 포인트 배치 업서트
        """
        self.init_collection(recreate=True)
        texts = [c["text"] for c in chunks]

        print(f"[QdrantStore] {len(texts)}개 청크의 BGE-M3 Dense & Sparse 임베딩 계산 중...")
        embeddings = self.model.encode(
            texts,
            return_dense=True,
            return_sparse=True,
            batch_size=32
        )

        dense_vecs = embeddings['dense_vecs']
        lexical_weights_list = embeddings['lexical_weights']

        points = []
        for i, chunk in enumerate(chunks):
            dense_vec = dense_vecs[i].tolist()
            sparse_vec = convert_lexical_weights_to_sparse_vector(lexical_weights_list[i], self.tokenizer)

            point = PointStruct(
                id=i + 1,
                vector={
                    "dense": dense_vec,
                    "sparse": sparse_vec
                },
                payload=chunk
            )
            points.append(point)

        for b_idx in range(0, len(points), batch_size):
            batch = points[b_idx:b_idx + batch_size]
            self.client.upsert(collection_name=self.collection_name, points=batch)

        print(f"[QdrantStore] 총 {len(points)}개 포인트를 컬렉션 '{self.collection_name}'에 성공적으로 업서트했습니다.")

    def search_hybrid(self, query: str, top_k: int = 2) -> List[Dict[str, Any]]:
        """
        Dense + Sparse RRF Fusion 하이브리드 검색 수행
        """
        emb = self.model.encode([query], return_dense=True, return_sparse=True)
        dense_vec = emb['dense_vecs'][0].tolist()
        sparse_vec = convert_lexical_weights_to_sparse_vector(emb['lexical_weights'][0], self.tokenizer)

        try:
            results = self.client.query_points(
                collection_name=self.collection_name,
                prefetch=[
                    Prefetch(query=dense_vec, using="dense", limit=10),
                    Prefetch(query=sparse_vec, using="sparse", limit=10)
                ],
                query=FusionQuery(fusion=Fusion.RRF),
                limit=top_k
            ).points
        except Exception as e:
            print(f"[QdrantStore] RRF Fusion query fallback: {e}")
            results = self.client.query_points(
                collection_name=self.collection_name,
                query=dense_vec,
                using="dense",
                limit=top_k
            ).points

        retrieved_items = []
        for rank, pt in enumerate(results, 1):
            payload = pt.payload
            item = {
                "rank": rank,
                "score": pt.score,
                "doc_name": payload.get("doc_name"),
                "heading": payload.get("heading"),
                "article_no": payload.get("article_no"),
                "article_title": payload.get("article_title"),
                "text": payload.get("text"),
                "chunk_id": payload.get("chunk_id")
            }
            retrieved_items.append(item)

        return retrieved_items


def embed_and_upsert_to_qdrant(chunks: List[Dict[str, Any]]):
    store = QdrantLawStore()
    store.upsert_chunks(chunks)
