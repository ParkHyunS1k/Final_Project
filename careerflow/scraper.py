"""One-page, public job-posting extraction built on Scrapling."""
from __future__ import annotations

from datetime import date
from html.parser import HTMLParser
import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit


MAX_PAGE_BYTES = 5 * 1024 * 1024
MAX_POSTING_CHARS = 38_000
FETCH_OPTIONS = {
    "timeout": 12,
    "retries": 0,
    "follow_redirects": "safe",
    "max_redirects": 5,
    "verify": True,
    "stealthy_headers": False,
    "impersonate": None,
}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.hidden_depth += 1
        elif tag in {"br", "p", "div", "li", "h1", "h2", "h3", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self.hidden_depth:
            self.hidden_depth -= 1
        elif tag in {"p", "div", "li", "h1", "h2", "h3", "section"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden_depth:
            self.parts.append(data)


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    parser = _TextExtractor()
    parser.feed(value)
    return re.sub(r"[\t\u00a0 ]+", " ", "\n".join(
        line.strip() for line in "".join(parser.parts).splitlines() if line.strip()
    )).strip()


def _validate_public_url(url: str) -> str:
    normalized = url.strip()
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("올바른 채용공고 URL을 입력해주세요.") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("로그인 정보가 포함되지 않은 공개 http/https URL만 가져올 수 있습니다.")
    if port not in (None, 80, 443):
        raise ValueError("기본 웹 포트(http/https)의 공개 페이지 URL만 가져올 수 있습니다.")
    host = parsed.hostname.rstrip(".").casefold()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("내부 네트워크 주소는 가져올 수 없습니다.")
    try:
        addresses = {ipaddress.ip_address(host)} if _is_ip(host) else {
            ipaddress.ip_address(info[4][0].split("%", 1)[0])
            for info in socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError) as exc:
        raise ValueError("주소를 확인할 수 없습니다. URL을 다시 확인해주세요.") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("공개 웹사이트 주소만 가져올 수 있습니다.")
    return normalized


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _json_ld_job_posting(page):
    def visit(value):
        if isinstance(value, dict):
            kind = value.get("@type", [])
            if isinstance(kind, str):
                kind = [kind]
            if any(item.rsplit("/", 1)[-1].casefold() == "jobposting" for item in kind if isinstance(item, str)):
                return value
            for child in value.values():
                found = visit(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = visit(child)
                if found:
                    return found
        return None

    for raw in page.css('script[type="application/ld+json"]::text').getall():
        try:
            found = visit(json.loads(raw))
        except (TypeError, ValueError):
            continue
        if found:
            return found
    return None


def _first_text(page, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        try:
            values = page.css(selector)
            if values:
                value = _clean_text(values[0].text)
                if value:
                    return value
        except Exception:
            # Some sites use selectors that vary by their parser-generated DOM.
            continue
    return ""


def _first_attribute(page, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        try:
            value = page.css(selector).get()
            if value:
                return _clean_text(value)
        except Exception:
            continue
    return ""


def _site_name(host: str) -> str:
    labels = (
        (("wanted.co.kr",), "원티드"),
        (("saramin.co.kr",), "사람인"),
        (("jobkorea.co.kr",), "잡코리아"),
        (("jumpit.co.kr",), "점핏"),
        (("linkedin.com",), "LinkedIn"),
        (("incruit.com",), "인크루트"),
        (("rocketpunch.com",), "로켓펀치"),
        (("greenhouse.io", "boards.greenhouse.io"), "Greenhouse 채용 페이지"),
        (("lever.co", "jobs.lever.co"), "Lever 채용 페이지"),
    )
    for domains, label in labels:
        if any(host == domain or host.endswith("." + domain) for domain in domains):
            return label
    return host


def _deadline(value) -> str:
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError:
            pass
    return ""


def scrape_job_posting(url: str) -> dict[str, str]:
    """Fetch a public job page once and extract its structured or visible text."""
    url = _validate_public_url(url)
    try:
        from scrapling.fetchers import Fetcher
    except ImportError as exc:
        raise ValueError('스크래핑 기능을 설치해주세요: pip install -e ".[web,scraper]"') from exc

    try:
        page = Fetcher.get(url, **FETCH_OPTIONS)
    except Exception as exc:
        raise ValueError("페이지를 읽지 못했습니다. 공개 페이지인지, 사이트가 자동 수집을 허용하는지 확인해주세요.") from exc
    if getattr(page, "status", 200) >= 400:
        raise ValueError(f"사이트가 페이지 요청을 거부했습니다 (HTTP {page.status}).")
    body = getattr(page, "body", b"")
    if isinstance(body, bytes) and len(body) > MAX_PAGE_BYTES:
        raise ValueError("페이지가 너무 큽니다. 채용공고의 개별 상세 페이지를 입력해주세요.")
    headers = getattr(page, "headers", {}) or {}
    content_type = str(headers.get("content-type", "text/html")).casefold()
    if "html" not in content_type and "text/plain" not in content_type:
        raise ValueError("HTML 공고 페이지 URL을 입력해주세요.")

    host = (urlsplit(url).hostname or "").casefold()
    job = _json_ld_job_posting(page)
    title = _clean_text(job.get("title") or job.get("name")) if job else ""
    company = ""
    if job:
        employer = job.get("hiringOrganization") or {}
        if isinstance(employer, str):
            company = _clean_text(employer)
        elif isinstance(employer, dict):
            company = _clean_text(employer.get("name"))
    title = title or _first_text(page, ("h1",)) or _first_attribute(
        page, ('meta[property="og:title"]::attr(content)', "title::text")
    )
    company = company or _first_attribute(page, (
        'meta[property="og:site_name"]::attr(content)',
        'meta[name="author"]::attr(content)',
    ))

    description = _clean_text(job.get("description")) if job else ""
    if not description:
        description = _first_text(page, (
            '[itemprop="articleBody"]', '[class*="job-description"]',
            '[class*="job_description"]', '[class*="JobDescription"]',
            ".jv_cont", ".wrap_jv_cont", "#devViewWrap", ".recruit-info",
            "main", "article", '[role="main"]', "#content", "body",
        ))
    if len(description) < 30:
        raise ValueError("공고 본문을 찾지 못했습니다. 로그인·동적 로딩이 필요한 페이지는 본문을 직접 붙여넣어주세요.")
    return {
        "company": company[:200],
        "position": title[:200],
        "posting": description[:MAX_POSTING_CHARS],
        "deadline": _deadline(job.get("validThrough")) if job else "",
        "source_url": url,
        "source_name": _site_name(host),
    }
