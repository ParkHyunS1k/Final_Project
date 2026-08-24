# -*- coding: utf-8 -*-
"""
AI 영상분석 기반 산업안전 RAG 시스템 - 국가법령정보 API 교차 검증 모듈 (src/validator/api_validator.py)
"""

import os
import json
import re
import requests
from typing import Dict, Any
from src.config import config


def normalize_article_no(art_str: str) -> str:
    """
    조문 번호 문자열 정규화 (예: '제42조' -> '42', '제4조의2' -> '4의2', '42' -> '42')
    """
    if not art_str:
        return ""
    s = str(art_str).strip()
    s = re.sub(r'^\s*제\s*', '', s)
    s = re.sub(r'\s*조\s*$', '', s)
    return s.strip()


def get_mst_code(law_name: str) -> str:
    """
    lawSearch.do API 호출을 통해 MST(법령일련번호) 획득 (실패 시 config.MST_MAP fallback)
    """
    target_name = law_name.strip()
    oc_key = config.LAW_OPEN_API_OC

    try:
        url = "http://www.law.go.kr/DRF/lawSearch.do"
        params = {
            "OC": oc_key,
            "target": "law",
            "type": "JSON",
            "query": target_name
        }
        response = requests.get(url, params=params, timeout=3)
        if response.status_code == 200:
            data = response.json()
            if "result" not in data or "실패" not in str(data.get("result")):
                search_res = data.get("LawSearch") or data.get("lawSearch") or {}
                items = search_res.get("law") if isinstance(search_res, dict) else []
                if isinstance(items, dict):
                    items = [items]
                for item in items:
                    name = item.get("법령명한글", "") or item.get("법령명", "")
                    if target_name in name or name in target_name:
                        mst = str(item.get("법령일련번호") or item.get("MST") or "").strip()
                        if mst:
                            return mst
    except Exception:
        pass

    for k, v in config.MST_MAP.items():
        if k in target_name or target_name in k:
            return v

    return ""


def cross_check_law(law_name: str, article_no: str) -> Dict[str, Any]:
    """
    국가법령정보 API 및 local JSON 교차 대조를 통한 인용 조문 검증
    """
    clean_art_no = normalize_article_no(article_no)

    matched_law_name = law_name
    for k in config.MST_MAP.keys():
        if k in law_name or law_name in k:
            matched_law_name = k
            break

    mst = get_mst_code(matched_law_name)
    law_data = None
    oc_key = config.LAW_OPEN_API_OC

    # 1. Open API (lawService.do) 호출 시도
    if mst:
        try:
            url = "http://www.law.go.kr/DRF/lawService.do"
            params = {
                "OC": oc_key,
                "target": "law",
                "type": "JSON",
                "MST": mst
            }
            response = requests.get(url, params=params, timeout=3)
            if response.status_code == 200:
                res_json = response.json()
                if "result" not in res_json or "실패" not in str(res_json.get("result")):
                    law_data = res_json
        except Exception:
            pass

    # 2. Fallback to Local RAW Dataset
    if not law_data:
        target_filename = f"{matched_law_name}.json"
        local_path = config.DATA_RAW_DIR / target_filename
        if os.path.exists(local_path):
            with open(local_path, "r", encoding="utf-8") as f:
                law_data = json.load(f)

    if not law_data:
        return {
            "verified": False,
            "status_tag": "[API 검증 실패]",
            "law_name": matched_law_name,
            "article_no": clean_art_no,
            "article_title": None,
            "article_content": None,
            "mst": mst,
            "message": f"국가법령정보 API 교차 검증 실패: {matched_law_name} 법령 데이터를 찾을 수 없음"
        }

    svc = law_data.get("lawService") or law_data.get("LawService") or law_data.get("법령") or law_data
    jo_node = svc.get("조문") or svc.get("조문단위") if isinstance(svc, dict) else []

    if isinstance(jo_node, dict):
        jo_units = jo_node.get("조문단위", [])
        if isinstance(jo_units, dict):
            jo_units = [jo_units]
    elif isinstance(jo_node, list):
        jo_units = jo_node
    else:
        jo_units = []

    for item in jo_units:
        if item.get("조문여부") == "전문":
            continue
        art_title = str(item.get("조문제목") or "").strip()
        if not art_title or art_title == "None":
            continue

        art_no = str(item.get("조문번호") or "").strip()
        gaji_no = str(item.get("조문가지번호") or "").strip()

        if gaji_no and gaji_no != "None" and gaji_no != "0":
            full_no = f"{art_no}의{gaji_no}"
        else:
            full_no = art_no

        if full_no == clean_art_no or art_no == clean_art_no:
            art_content = str(item.get("조문내용") or "").strip()
            return {
                "verified": True,
                "status_tag": "[API 검증 완료]",
                "law_name": matched_law_name,
                "article_no": full_no,
                "article_title": art_title,
                "article_content": art_content,
                "mst": mst or config.MST_MAP.get(matched_law_name, ""),
                "message": f"국가법령정보 API 교차 검증 성공: {matched_law_name} 제{full_no}조({art_title}) 현행 법령 존재 확인"
            }

    return {
        "verified": False,
        "status_tag": "[API 검증 실패]",
        "law_name": matched_law_name,
        "article_no": clean_art_no,
        "article_title": None,
        "article_content": None,
        "mst": mst,
        "message": f"국가법령정보 API 교차 검증 실패: {matched_law_name} 제{clean_art_no}조를 현행 법령에서 찾을 수 없음"
    }
