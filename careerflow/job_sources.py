"""Public job listing APIs used to build the local job catalogue."""
from __future__ import annotations

from datetime import datetime
import json
import os
from urllib.parse import urlparse
import xml.etree.ElementTree as ET


INTERESTS = (
    {"id": "ai_data", "label": "AI · 데이터", "keywords": ("AI", "데이터")},
    {"id": "software", "label": "소프트웨어 개발", "keywords": ("소프트웨어", "개발자")},
    {"id": "product", "label": "기획 · PM", "keywords": ("서비스 기획", "PM")},
    {"id": "design", "label": "디자인 · UX", "keywords": ("UX", "디자이너")},
    {"id": "marketing", "label": "마케팅 · 콘텐츠", "keywords": ("마케팅", "콘텐츠")},
    {"id": "sales", "label": "영업 · 사업개발", "keywords": ("영업", "사업개발")},
    {"id": "business", "label": "경영지원 · HR", "keywords": ("경영지원", "인사")},
)

_SARAMIN_URL = "https://oapi.saramin.co.kr/job-search"
_WORK24_LIST_URL = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do"
_WORK24_DETAIL_URL = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210D01.do"
_FETCH_OPTIONS = {
    "timeout": 15,
    "retries": 0,
    "follow_redirects": "safe",
    "max_redirects": 5,
    "verify": True,
    "stealthy_headers": False,
    "impersonate": None,
}


def interest(category: str) -> dict:
    for item in INTERESTS:
        if item["id"] == category:
            return item
    raise ValueError("관심 분야를 선택해주세요.")


def source_status() -> list[dict[str, str | bool]]:
    return [
        {"id": "saramin", "name": "사람인", "configured": bool(os.getenv("SARAMIN_API_KEY", "").strip()),
         "setup_url": "https://oapi.saramin.co.kr/guide/info"},
        {"id": "work24", "name": "고용24", "configured": bool(os.getenv("WORK24_API_KEY", "").strip()),
         "setup_url": "https://www.work24.go.kr/cm/e/a/0110/selectOpenApiSvcInfo.do?fullApiSvcId=000000000000000000000000000000"},
    ]


def _fetcher():
    try:
        from scrapling.fetchers import Fetcher
    except ImportError as exc:
        raise ValueError('공고 수집을 사용하려면 설치해주세요: pip install -e ".[web,scraper]"') from exc
    return Fetcher


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float)):
        return str(value).strip()
    return ""


def _nested(value, *path) -> str:
    for key in path:
        if not isinstance(value, dict):
            return ""
        value = value.get(key)
    return _text(value)


def _clean_date(value: str) -> str:
    value = _text(value)
    if len(value) >= 10 and value[4:5] == "-":
        return value[:10]
    for fmt in ("%Y%m%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(value[:10], fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def _fetch_saramin(keyword: str, api_key: str) -> list[dict]:
    page = _fetcher().get(
        _SARAMIN_URL,
        params={"access-key": api_key, "keywords": keyword, "count": 100, "start": 0,
                "sort": "pd", "fields": "posting-date,expiration-date"},
        headers={"Accept": "application/json"},
        **_FETCH_OPTIONS,
    )
    if page.status >= 400:
        raise ValueError(f"사람인 API 요청에 실패했습니다 (HTTP {page.status}).")
    try:
        payload = json.loads(page.body)
    except (TypeError, ValueError) as exc:
        raise ValueError("사람인 API 응답을 읽지 못했습니다. 키와 이용 승인을 확인해주세요.") from exc
    if payload.get("code") and str(payload.get("code")) != "0":
        raise ValueError("사람인 API가 요청을 거부했습니다. API 키와 일일 호출 한도를 확인해주세요.")
    jobs = payload.get("jobs", {}).get("job", [])
    if isinstance(jobs, dict):
        jobs = [jobs]
    result = []
    for row in jobs if isinstance(jobs, list) else []:
        if str(row.get("active", "1")) == "0":
            continue
        position = row.get("position", {})
        company = row.get("company", {})
        url = _text(row.get("url"))
        if url.startswith("http://"):
            url = "https://" + url[7:]
        job_id = _text(row.get("id")) or urlparse(url).query
        if not job_id or not url:
            continue
        result.append({
            "source": "saramin", "source_id": job_id, "source_name": "사람인",
            "company": _nested(company, "detail", "name") or _nested(company, "name") or "회사 미공개",
            "position": _nested(position, "title") or "제목 미공개",
            "description": "", "source_url": url,
            "location": _nested(position, "location", "name"),
            "job_type": _nested(position, "job-type", "name"),
            "salary": _nested(row, "salary", "name"),
            "career": _nested(position, "experience-level", "name"),
            "deadline": _clean_date(_text(row.get("expiration-date"))),
            "posted_at": _text(row.get("posting-date"))[:25],
        })
    return result


def _xml_text(element: ET.Element, name: str) -> str:
    child = element.find(name)
    return "" if child is None or child.text is None else child.text.strip()


def _fetch_work24(keyword: str, api_key: str) -> list[dict]:
    page = _fetcher().get(
        _WORK24_LIST_URL,
        params={"authKey": api_key, "callTp": "L", "returnType": "XML",
                "startPage": 1, "display": 100, "keyword": keyword, "sortOrderBy": "DESC"},
        **_FETCH_OPTIONS,
    )
    if page.status >= 400:
        raise ValueError(f"고용24 API 요청에 실패했습니다 (HTTP {page.status}).")
    try:
        root = ET.fromstring(page.body)
    except (ET.ParseError, TypeError) as exc:
        raise ValueError("고용24 API 응답을 읽지 못했습니다. 키와 이용 승인을 확인해주세요.") from exc
    error_code = root.findtext(".//result/code")
    if error_code and error_code not in {"0", "00"}:
        raise ValueError("고용24 API가 요청을 거부했습니다. API 키와 이용 승인을 확인해주세요.")
    result = []
    for row in root.findall(".//wanted"):
        job_id = _xml_text(row, "wantedAuthNo")
        url = _xml_text(row, "wantedInfoUrl")
        if not job_id or not url:
            continue
        result.append({
            "source": "work24", "source_id": job_id, "source_name": "고용24",
            "company": _xml_text(row, "company") or "회사 미공개",
            "position": _xml_text(row, "title") or "제목 미공개",
            "description": "", "source_url": url,
            "location": _xml_text(row, "region") or _xml_text(row, "basicAddr"),
            "job_type": _xml_text(row, "holidayTpNm"),
            "salary": _xml_text(row, "sal"),
            "career": _xml_text(row, "career"),
            "deadline": _clean_date(_xml_text(row, "closeDt")),
            "posted_at": _clean_date(_xml_text(row, "regDt")),
        })
    return result


def collect_category(category: str) -> tuple[list[dict], list[dict]]:
    selected = interest(category)
    keys = {"saramin": os.getenv("SARAMIN_API_KEY", "").strip(),
            "work24": os.getenv("WORK24_API_KEY", "").strip()}
    reports = []
    collected: dict[tuple[str, str], dict] = {}
    for source_id, name, fetch in (
        ("saramin", "사람인", _fetch_saramin),
        ("work24", "고용24", _fetch_work24),
    ):
        key = keys[source_id]
        if not key:
            reports.append({"source": name, "configured": False, "count": 0,
                            "error": "공식 API 키를 설정하지 않았습니다."})
            continue
        count = 0
        error = ""
        try:
            for keyword in selected["keywords"]:
                for item in fetch(keyword, key):
                    collected[(item["source"], item["source_id"])] = item
                count += 1
        except ValueError as exc:
            error = str(exc)
        except Exception:
            error = "출처 API에 연결하지 못했습니다. 네트워크와 API 이용 상태를 확인해주세요."
        reports.append({"source": name, "configured": True, "count": count, "error": error})
    return list(collected.values()), reports


def fetch_job_description(job: dict) -> str:
    if job.get("source") == "work24" and os.getenv("WORK24_API_KEY", "").strip():
        page = _fetcher().get(
            _WORK24_DETAIL_URL,
            params={"authKey": os.environ["WORK24_API_KEY"].strip(), "callTp": "D",
                    "returnType": "XML", "wantedAuthNo": job["source_id"], "infoSvc": "VALIDATION"},
            **_FETCH_OPTIONS,
        )
        if page.status >= 400:
            raise ValueError(f"고용24 공고 상세 조회에 실패했습니다 (HTTP {page.status}).")
        try:
            root = ET.fromstring(page.body)
        except (ET.ParseError, TypeError) as exc:
            raise ValueError("고용24 공고 상세 내용을 읽지 못했습니다.") from exc
        info = root.find(".//wantedInfo")
        if info is not None:
            fields = ("wantedTitle", "jobsNm", "relJobsNm", "jobCont", "workRegion", "career", "education")
            text = "\n".join(f"{name}: {value}" for name in fields
                             if (value := _xml_text(info, name)))
            if len(text) >= 30:
                return text[:38_000]
    from .scraper import scrape_job_posting
    scraped = scrape_job_posting(job["source_url"])
    description = scraped.get("posting", "").strip()
    if len(description) < 30:
        raise ValueError("공고 상세 내용을 가져오지 못했습니다. 원문 페이지의 접근 조건을 확인해주세요.")
    return description[:38_000]
