# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 법령 파서 모듈 (src/parser/law_parser.py)
"""

import os
import json
import re
from typing import List, Dict, Any, Tuple
from src.config import config


def is_dummy_or_toc_node(item: Dict[str, Any]) -> bool:
    """
    더미 노드 및 목차 필터링
    - 조문번호나 조문내용이 비어 있는 객체 스킵
    - 조문제목이 비어 있고 내용에 '제1편', '제2편', '제1장', '제2장', '제3장', '제1절' 등의 단순 목차 노드는 제외
    - 내용이 없거나 삭제 조문 중 본문 없는 항목 제외
    """
    art_no = str(item.get("조문번호") or "").strip()
    art_content = str(item.get("조문내용") or "").strip()
    art_title = str(item.get("조문제목") or "").strip()
    jo_yeobu = str(item.get("조문여부") or "").strip()

    if not art_no or not art_content or art_no == "None" or art_content == "None":
        return True

    if jo_yeobu == "전문":
        return True

    if not art_title or art_title == "None":
        if re.search(r'^\s*제\s*\d+\s*(편|장|절|관|속)\b', art_content):
            return True
        if "삭제" in art_content and not item.get("항"):
            return True

    if re.search(r'^\s*제\s*\d+\s*(편|장|절|관|속)\b', art_content) and not item.get("항"):
        if not any(char in art_content for char in ["①", "②", "③", "1.", "2."]):
            return True

    return False


def build_single_chunk_text(doc_name: str, item: Dict[str, Any]) -> Tuple[str, str, str, str]:
    """
    조·항·호·목 통합 텍스트 병합 (Single Chunk Integration)
    
    포맷:
    [{법령명} 제{조문번호}조({조문제목})]
    {조문내용}
      - {호내용 1}
      - {호내용 2}
    """
    art_no = str(item.get("조문번호") or "").strip()
    gaji_no = str(item.get("조문가지번호") or "").strip()

    if gaji_no and gaji_no != "None" and gaji_no != "0":
        full_art_no = f"{art_no}의{gaji_no}"
    else:
        full_art_no = art_no

    art_title = str(item.get("조문제목") or "").strip()
    heading = f"제{full_art_no}조({art_title})"
    header_line = f"[{doc_name} {heading}]"

    lines = [header_line]

    art_content = str(item.get("조문내용") or "").strip()
    if art_content:
        lines.append(art_content)

    hangs = item.get("항")
    if hangs:
        if isinstance(hangs, dict):
            hangs = [hangs]
        for hang in hangs:
            hang_text = str(hang.get("항내용") or "").strip()
            if hang_text and hang_text != art_content:
                lines.append(hang_text)
            
            hos = hang.get("호")
            if hos:
                if isinstance(hos, dict):
                    hos = [hos]
                for ho in hos:
                    ho_text = str(ho.get("호내용") or "").strip()
                    if ho_text:
                        lines.append(f"  - {ho_text}")
                    
                    moks = ho.get("목")
                    if moks:
                        if isinstance(moks, dict):
                            moks = [moks]
                        for mok in moks:
                            mok_text = str(mok.get("목내용") or "").strip()
                            if mok_text:
                                lines.append(f"    - {mok_text}")

    merged_text = "\n".join(lines)
    return merged_text, full_art_no, art_title, heading


def process_law_json(filepath: str) -> List[Dict[str, Any]]:
    """
    법령 JSON 데이터 로드 및 정밀 청크 리스트 생성
    """
    filename = os.path.basename(filepath)
    doc_name = filename.replace(".json", "").strip()

    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    svc = data.get("lawService") or data.get("LawService") or data.get("법령") or data
    jo_node = svc.get("조문") or svc.get("조문단위") if isinstance(svc, dict) else []

    if isinstance(jo_node, dict):
        jo_units = jo_node.get("조문단위", [])
        if isinstance(jo_units, dict):
            jo_units = [jo_units]
    elif isinstance(jo_node, list):
        jo_units = jo_node
    else:
        jo_units = []

    chunks = []
    idx = 0
    for item in jo_units:
        if is_dummy_or_toc_node(item):
            continue

        merged_text, full_art_no, art_title, heading = build_single_chunk_text(doc_name, item)
        chunk_id = f"{doc_name}_art_{full_art_no}_{idx}"

        chunk = {
            "chunk_id": chunk_id,
            "doc_name": doc_name,
            "heading": heading,
            "article_no": full_art_no,
            "article_title": art_title,
            "text": merged_text
        }
        chunks.append(chunk)
        idx += 1

    print(f"[{doc_name}] {len(jo_units)}개 원본 항목 중 {len(chunks)}개 정밀 청크 생성 완료.")
    return chunks


def load_and_chunk_all_laws() -> List[Dict[str, Any]]:
    """
    data/raw/ 하위의 원본 법령 JSON 처리 및 data/processed/safety_laws_total_chunks.json 저장
    """
    all_chunks = []
    os.makedirs(config.DATA_PROCESSED_DIR, exist_ok=True)

    for filename in config.LAW_FILES:
        filepath = config.DATA_RAW_DIR / filename
        if not os.path.exists(filepath):
            print(f"[경고] 파일이 존재하지 않습니다: {filepath}")
            continue
        chunks = process_law_json(str(filepath))
        all_chunks.extend(chunks)

    with open(config.PROCESSED_CHUNKS_FILE, 'w', encoding='utf-8') as f:
        json.dump(all_chunks, f, ensure_ascii=False, indent=2)

    print(f"총 {len(all_chunks)}개 청크 저장 완료: {config.PROCESSED_CHUNKS_FILE}")
    return all_chunks
