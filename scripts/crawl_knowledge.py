# -*- coding: utf-8 -*-
"""Crawl approved SDTBU sources into the private AI knowledge review queue.

The crawler is intentionally conservative:
- only HTTPS hosts explicitly stored in knowledge_sources are visited;
- every host must belong to sdtbu.edu.cn and resolve to public IP addresses;
- robots.txt, page-count, response-size and delay limits are respected;
- new or changed pages stay in draft when requires_review is enabled;
- raw HTML, credentials and chat data are never stored.
"""

from __future__ import annotations

import hashlib
import heapq
import ipaddress
import os
import posixpath
import re
import socket
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup


PROJECT_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SECRET_KEY = (
    os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
)
FORCE_CRAWL = "--force" in sys.argv or os.environ.get("CRAWL_FORCE", "").lower() == "true"
DRY_RUN = "--dry-run" in sys.argv
USER_AGENT = "SDTBUCampusInfoBot/2.0 (+https://github.com/duyvxi/shangong-info)"
REQUEST_TIMEOUT = (6, 20)
MAX_RESPONSE_BYTES = 2_500_000
MAX_QUEUE_SIZE = 1_200
CRAWL_DELAY_SECONDS = max(0.1, min(float(os.environ.get("CRAWL_DELAY_SECONDS", "0.35")), 5.0))
REDIRECT_CODES = {301, 302, 303, 307, 308}
TRACKING_QUERY_KEYS = {
    "from", "spm", "source", "ref", "referrer", "timestamp",
    "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term",
}
SKIP_EXTENSIONS = {
    ".7z", ".avi", ".bmp", ".css", ".csv", ".doc", ".docx", ".exe",
    ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".mov", ".mp3",
    ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".rar", ".rss", ".svg",
    ".tar", ".txt", ".wav", ".webp", ".xls", ".xlsx", ".xml", ".zip",
}
SKIP_PATH_PARTS = (
    "/auth/", "/login", "/logout", "/search", "/sousuo", "/en/",
    "/english/", "/mailto", "/system/",
)
ARTICLE_URL_PATTERNS = (
    re.compile(r"/info/\d+/\d+\.html?$", re.I),
    re.compile(r"/info/\d+/\d+\.htm$", re.I),
    re.compile(r"/\d{4,}\.html?$", re.I),
    re.compile(r"(?:wbnewsid|articleid|newsid)=\d+", re.I),
)
MAIN_SELECTORS = (
    ".v_news_content",
    "#vsb_content",
    "#vsb_content_2",
    ".wp_articlecontent",
    ".wp_article_content",
    ".article-content",
    ".article_content",
    ".news-content",
    ".news_content",
    ".content-detail",
    ".content_detail",
    "article",
    "main article",
)
COMMON_START_PATHS = {
    "www.sdtbu.edu.cn": ("/index/tzgg.htm",),
    "jwc.sdtbu.edu.cn": ("/index/tzgg.htm",),
    "xsc.sdtbu.edu.cn": ("/index/tzgg.htm",),
}
CATEGORY_RULES = (
    ("入学报到", ("新生", "报到", "迎新", "录取", "入学")),
    ("奖助贷勤", ("奖学金", "助学金", "资助", "勤工", "助学贷款", "困难学生")),
    ("考试相关", ("考试", "补考", "缓考", "重修", "四六级", "考场")),
    ("选课教学", ("选课", "课程", "教学", "教材", "调课", "停课")),
    ("学籍管理", ("学籍", "转专业", "休学", "复学", "退学", "成绩", "学分")),
    ("宿舍生活", ("宿舍", "公寓", "住宿", "用电", "门禁")),
    ("毕业就业", ("毕业", "就业", "招聘", "实习", "论文", "学位")),
    ("团学与创新创业", ("学生会", "团委", "社团", "志愿", "创新创业", "竞赛")),
    ("校园服务", ("图书馆", "校园卡", "校车", "后勤", "医保", "安全", "服务")),
)


@dataclass
class FetchedPage:
    url: str
    content: bytes
    content_type: str


@dataclass
class ParsedDocument:
    title: str
    content: str
    summary: str
    source_date: str | None


class SupabaseRest:
    def __init__(self, project_url: str, secret_key: str):
        self.base_url = f"{project_url}/rest/v1"
        self.session = requests.Session()
        self.session.headers.update({"apikey": secret_key})
        if not secret_key.startswith("sb_secret_"):
            self.session.headers.update({"Authorization": f"Bearer {secret_key}"})

    def request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        payload: Any = None,
        prefer: str | None = None,
    ) -> Any:
        headers: dict[str, str] = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer
        response = self.session.request(
            method,
            f"{self.base_url}/{table}",
            params=params,
            json=payload,
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
        if not response.ok:
            raise RuntimeError(f"Supabase {response.status_code}: {response.text[:600]}")
        if not response.content:
            return None
        return response.json()


class SafeFetcher:
    def __init__(self, source_domain: str):
        self.source_domain = source_domain.lower().rstrip(".")
        self.allowed_hosts = {self.source_domain}
        if self.source_domain == "sdtbu.edu.cn":
            self.allowed_hosts.add("www.sdtbu.edu.cn")
        elif self.source_domain == "www.sdtbu.edu.cn":
            self.allowed_hosts.add("sdtbu.edu.cn")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Language": "zh-CN,zh;q=0.9",
        })
        self.robot_parsers: dict[str, RobotFileParser] = {}

    def validate_url(self, url: str) -> None:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or host not in self.allowed_hosts:
            raise ValueError(f"URL 不在来源白名单中：{url}")
        if host != "sdtbu.edu.cn" and not host.endswith(".sdtbu.edu.cn"):
            raise ValueError(f"URL 不是山东工商学院官方域名：{url}")
        if parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError(f"URL 包含不允许的认证信息或端口：{url}")
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        except socket.gaierror as exc:
            raise ValueError(f"域名无法解析：{host}") from exc
        if not addresses:
            raise ValueError(f"域名没有可用地址：{host}")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global:
                raise ValueError(f"域名解析到非公网地址，已阻止访问：{host}")

    def robots_allows(self, url: str) -> bool:
        parsed = urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.robot_parsers:
            parser = RobotFileParser()
            parser.set_url(f"{origin}/robots.txt")
            try:
                page = self.fetch(f"{origin}/robots.txt", check_robots=False, html_only=False)
                parser.parse(page.content.decode("utf-8", errors="ignore").splitlines())
            except Exception:
                parser.parse([])
            self.robot_parsers[origin] = parser
        return self.robot_parsers[origin].can_fetch(USER_AGENT, url)

    def fetch(self, url: str, *, check_robots: bool = True, html_only: bool = True) -> FetchedPage:
        current = url
        for _ in range(5):
            self.validate_url(current)
            if check_robots and not self.robots_allows(current):
                raise PermissionError(f"robots.txt 不允许抓取：{current}")
            with self.session.get(current, timeout=REQUEST_TIMEOUT, allow_redirects=False, stream=True) as response:
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("Location")
                    if not location:
                        raise RuntimeError(f"重定向缺少目标地址：{current}")
                    current = normalize_url(location, current)
                    continue
                if response.status_code != 200:
                    raise RuntimeError(f"HTTP {response.status_code}: {current}")
                content_type = response.headers.get("Content-Type", "").lower()
                if html_only and "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                    raise ValueError(f"跳过非 HTML 页面：{content_type or '未知类型'}")
                declared_size = int(response.headers.get("Content-Length", "0") or 0)
                if declared_size > MAX_RESPONSE_BYTES:
                    raise ValueError(f"页面超过大小限制：{declared_size} bytes")
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_content(64 * 1024):
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise ValueError("页面下载过程中超过大小限制")
                    chunks.append(chunk)
                return FetchedPage(current, b"".join(chunks), content_type)
        raise RuntimeError(f"重定向次数过多：{url}")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def normalize_url(value: str, base_url: str) -> str:
    joined = urljoin(base_url, value.strip())
    parsed = urlsplit(joined)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower().rstrip(".")
    if scheme != "https" or not host:
        raise ValueError("只允许完整的 HTTPS URL")
    port = f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    raw_path = re.sub(r"/{2,}", "/", parsed.path or "/")
    path = posixpath.normpath(raw_path)
    if not path.startswith("/"):
        path = f"/{path}"
    if raw_path.endswith("/") and not path.endswith("/"):
        path += "/"
    query_pairs = [
        (key, item_value)
        for key, item_value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in TRACKING_QUERY_KEYS
    ][:8]
    query = urlencode(sorted(query_pairs))
    return urlunsplit((scheme, f"{host}{port}", path, query, ""))


def should_queue_url(url: str, allowed_hosts: set[str]) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in allowed_hosts:
        return False
    lower_path = parsed.path.lower()
    if any(lower_path.endswith(extension) for extension in SKIP_EXTENSIONS):
        return False
    if any(part in lower_path for part in SKIP_PATH_PARTS):
        return False
    if len(url) > 900 or len(parse_qsl(parsed.query, keep_blank_values=True)) > 8:
        return False
    return True


def article_priority(url: str) -> int:
    if any(pattern.search(url) for pattern in ARTICLE_URL_PATTERNS):
        return 0
    path = urlsplit(url).path.lower()
    if path.endswith((".htm", ".html")):
        return 2
    return 5


def clean_text(value: str) -> str:
    value = value.replace("\xa0", " ").replace("\u3000", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"(?<=\d) (?=\d)", "", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def page_title(soup: BeautifulSoup) -> str:
    candidates = [
        soup.select_one('meta[property="og:title"]'),
        soup.select_one('meta[name="ArticleTitle"]'),
        soup.select_one("h1"),
        soup.select_one(".article-title"),
        soup.select_one(".news-title"),
        soup.title,
    ]
    for node in candidates:
        if not node:
            continue
        value = node.get("content") if node.name == "meta" else node.get_text(" ", strip=True)
        value = clean_text(value or "")
        value = re.split(r"\s*[-_|]\s*(?:山东工商学院|山商)", value, maxsplit=1)[0].strip()
        if 4 <= len(value) <= 180:
            return value
    return ""


def page_date(soup: BeautifulSoup) -> str | None:
    for selector, attribute in (
        ('meta[property="article:published_time"]', "content"),
        ('meta[name="PubDate"]', "content"),
        ('meta[name="publishdate"]', "content"),
        ("time[datetime]", "datetime"),
    ):
        node = soup.select_one(selector)
        if node:
            match = re.search(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", node.get(attribute, ""))
            if match:
                return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    head_text = clean_text(soup.get_text(" ", strip=True)[:8000])
    match = re.search(r"(?:发布时间|发布日期|发布于|时间)?[：:\s]*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", head_text)
    if match:
        return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    return None


def extract_document(html: bytes, url: str) -> ParsedDocument | None:
    soup = BeautifulSoup(html, "html.parser")
    title = page_title(soup)
    if not title:
        return None

    main = None
    for selector in MAIN_SELECTORS:
        candidates = soup.select(selector)
        candidates.sort(key=lambda node: len(node.get_text(" ", strip=True)), reverse=True)
        if candidates and len(candidates[0].get_text(" ", strip=True)) >= 80:
            main = candidates[0]
            break
    if main is None:
        return None

    for node in main.select("script,style,noscript,nav,header,footer,form,button,.share,.tools,.pagination"):
        node.decompose()

    lines: list[str] = []
    nodes = main.select("h2,h3,h4,p,li,tr")
    if not nodes:
        nodes = [main]
    for node in nodes:
        line = clean_text(node.get_text(" ", strip=True))
        if not line or line in lines[-2:]:
            continue
        if re.match(r"^(上一篇|下一篇|打印|关闭窗口|责任编辑|阅读次数)", line):
            continue
        lines.append(line)
    content = clean_text("\n\n".join(lines))
    if len(content) < 100 or len(content) > 60_000:
        return None
    published_date = page_date(soup)
    if not any(pattern.search(url) for pattern in ARTICLE_URL_PATTERNS) and published_date is None:
        return None

    summary = re.sub(r"\s+", " ", content)[:260].rstrip("，。；; ")
    return ParsedDocument(title=title, content=content, summary=summary, source_date=published_date)


def discover_links(soup: BeautifulSoup, base_url: str, allowed_hosts: set[str]) -> list[str]:
    links: set[str] = set()
    for anchor in soup.select("a[href]"):
        href = (anchor.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        try:
            url = normalize_url(href, base_url)
        except (TypeError, ValueError):
            continue
        if should_queue_url(url, allowed_hosts):
            links.add(url)
    return sorted(links, key=lambda item: (article_priority(item), item))


def choose_category(title: str, content: str, default_category: str | None) -> str:
    excerpt = content[:1800]
    best_category = default_category or "校园服务"
    best_score = 0
    for category, keywords in CATEGORY_RULES:
        # Title matches express the page's main topic, so they outweigh incidental
        # words such as “录取结果” that may occur inside an unrelated notice.
        score = sum(3 for keyword in keywords if keyword in title)
        score += sum(1 for keyword in keywords if keyword in excerpt)
        if score > best_score:
            best_category = category
            best_score = score
    return best_category


def document_checksum(title: str, category: str, content: str) -> str:
    return hashlib.sha256(f"{title}\n{category}\n{content}".encode("utf-8")).hexdigest()


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def source_is_due(source: dict[str, Any]) -> bool:
    if FORCE_CRAWL:
        return True
    last_crawled = parse_timestamp(source.get("last_crawled_at"))
    interval = max(1, min(int(source.get("crawl_interval_hours") or 24), 720))
    return last_crawled is None or utc_now() >= last_crawled + timedelta(hours=interval)


def crawler_is_paused(database: SupabaseRest) -> bool:
    rows = database.request(
        "GET",
        "site_settings",
        params={"select": "value", "key": "eq.crawl_paused", "limit": "1"},
    ) or []
    return bool(rows and str(rows[0].get("value", "")).lower() == "true")


def get_sources(database: SupabaseRest) -> list[dict[str, Any]]:
    return database.request(
        "GET",
        "knowledge_sources",
        params={
            "select": "id,name,base_url,domain,default_category,enabled,requires_review,crawl_interval_hours,max_pages_per_run,last_crawled_at,metadata",
            "enabled": "eq.true",
            "order": "name.asc",
        },
    ) or []


def existing_document(database: SupabaseRest, canonical_url: str) -> dict[str, Any] | None:
    rows = database.request(
        "GET",
        "knowledge_documents",
        params={
            "select": "id,slug,checksum,status,metadata",
            "canonical_url": f"eq.{canonical_url}",
            "limit": "1",
        },
    ) or []
    return rows[0] if rows else None


def save_document(
    database: SupabaseRest,
    source: dict[str, Any],
    canonical_url: str,
    document: ParsedDocument,
) -> str:
    existing = existing_document(database, canonical_url)
    category = choose_category(document.title, document.content, source.get("default_category"))
    checksum = document_checksum(document.title, category, document.content)
    crawled_at = iso_now()

    if existing and existing.get("checksum") == checksum:
        if not DRY_RUN:
            database.request(
                "PATCH",
                "knowledge_documents",
                params={"id": f"eq.{existing['id']}"},
                payload={"last_crawled_at": crawled_at},
                prefer="return=minimal",
            )
        return "unchanged"

    requires_review = bool(source.get("requires_review", True))
    old_status = existing.get("status") if existing else None
    if old_status == "archived":
        status = "archived"
    elif requires_review:
        status = "draft"
    else:
        status = "published"
    slug = existing.get("slug") if existing else f"official-{hashlib.sha256(canonical_url.encode('utf-8')).hexdigest()[:24]}"
    previous_metadata = existing.get("metadata") if existing and isinstance(existing.get("metadata"), dict) else {}
    metadata = {
        **previous_metadata,
        "crawler": "official-site-v1",
        "source_name": source.get("name"),
        "source_domain": source.get("domain"),
        "review_reason": "new_page" if not existing else "source_changed",
    }
    payload = {
        "slug": slug,
        "title": document.title,
        "category": category,
        "summary": document.summary,
        "content": document.content,
        "source_url": canonical_url,
        "source_type": "official_notice",
        "source_date": document.source_date,
        "verified_at": crawled_at if status == "published" else None,
        "status": status,
        "checksum": checksum,
        "metadata": metadata,
        "source_id": source.get("id"),
        "canonical_url": canonical_url,
        "content_format": "html",
        "effective_from": document.source_date,
        "last_crawled_at": crawled_at,
        "updated_at": crawled_at,
    }

    if DRY_RUN:
        return "updated" if existing else "added"

    database.request(
        "POST",
        "knowledge_documents",
        params={"on_conflict": "slug"},
        payload=payload,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    if existing:
        # Changed content must never keep an old semantic vector.
        database.request(
            "DELETE",
            "knowledge_chunks",
            params={"document_id": f"eq.{existing['id']}"},
            prefer="return=minimal",
        )
    return "updated" if existing else "added"


def source_start_urls(source: dict[str, Any], fetcher: SafeFetcher) -> list[str]:
    base_url = normalize_url(source["base_url"], source["base_url"])
    values: list[str] = [base_url]
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    configured = metadata.get("start_urls")
    if isinstance(configured, list):
        values.extend(str(item) for item in configured[:20])
    for path in COMMON_START_PATHS.get(source["domain"], ()):
        values.append(urljoin(base_url, path))
    normalized: list[str] = []
    for value in values:
        try:
            url = normalize_url(value, base_url)
        except ValueError:
            continue
        if should_queue_url(url, fetcher.allowed_hosts) and url not in normalized:
            normalized.append(url)
    return normalized


def crawl_source(database: SupabaseRest, source: dict[str, Any]) -> dict[str, Any]:
    started_at = iso_now()
    job_id = str(uuid.uuid4())
    if not DRY_RUN:
        database.request(
            "POST",
            "crawl_jobs",
            payload={
                "id": job_id,
                "source_id": source["id"],
                "status": "running",
                "started_at": started_at,
                "details": {"force": FORCE_CRAWL, "user_agent": USER_AGENT},
            },
            prefer="return=minimal",
        )

    fetcher = SafeFetcher(source["domain"])
    page_limit = max(1, min(int(source.get("max_pages_per_run") or 40), 500))
    queue: list[tuple[int, int, str]] = []
    queued: set[str] = set()
    visited: set[str] = set()
    sequence = 0
    for url in source_start_urls(source, fetcher):
        heapq.heappush(queue, (article_priority(url), sequence, url))
        queued.add(url)
        sequence += 1

    result: dict[str, Any] = {
        "pages_scanned": 0,
        "pages_added": 0,
        "pages_updated": 0,
        "pages_failed": 0,
        "unchanged": 0,
        "errors": [],
    }
    while queue and result["pages_scanned"] < page_limit:
        _, _, url = heapq.heappop(queue)
        if url in visited:
            continue
        visited.add(url)
        try:
            page = fetcher.fetch(url)
            result["pages_scanned"] += 1
            soup = BeautifulSoup(page.content, "html.parser")
            for discovered in discover_links(soup, page.url, fetcher.allowed_hosts):
                if discovered in queued or len(queued) >= MAX_QUEUE_SIZE:
                    continue
                heapq.heappush(queue, (article_priority(discovered), sequence, discovered))
                queued.add(discovered)
                sequence += 1

            parsed = extract_document(page.content, page.url)
            if parsed:
                outcome = save_document(database, source, page.url, parsed)
                if outcome == "added":
                    result["pages_added"] += 1
                    print(f"[new] {source['name']} | {parsed.title}")
                elif outcome == "updated":
                    result["pages_updated"] += 1
                    print(f"[updated] {source['name']} | {parsed.title}")
                else:
                    result["unchanged"] += 1
            time.sleep(CRAWL_DELAY_SECONDS)
        except PermissionError as exc:
            print(f"[robots] {exc}")
        except Exception as exc:  # Keep one broken page from stopping the source.
            result["pages_failed"] += 1
            message = f"{url}: {exc}"
            result["errors"].append(message[:500])
            print(f"[warn] {message}")

    if result["pages_scanned"] == 0 and result["pages_failed"]:
        status = "error"
    elif result["pages_failed"]:
        status = "partial"
    else:
        status = "ok"
    finished_at = iso_now()
    error_summary = "; ".join(result["errors"][:3]) or None
    job_status = "succeeded" if status == "ok" else "failed" if status == "error" else "partial"

    if not DRY_RUN:
        database.request(
            "PATCH",
            "crawl_jobs",
            params={"id": f"eq.{job_id}"},
            payload={
                "status": job_status,
                "pages_scanned": result["pages_scanned"],
                "pages_added": result["pages_added"],
                "pages_updated": result["pages_updated"],
                "pages_failed": result["pages_failed"],
                "error_summary": error_summary,
                "details": {
                    "force": FORCE_CRAWL,
                    "unchanged": result["unchanged"],
                    "queued": len(queued),
                    "errors": result["errors"][:10],
                },
                "finished_at": finished_at,
            },
            prefer="return=minimal",
        )
        database.request(
            "PATCH",
            "knowledge_sources",
            params={"id": f"eq.{source['id']}"},
            payload={
                "last_crawled_at": finished_at,
                "last_status": status,
                "last_error": error_summary,
                "updated_at": finished_at,
            },
            prefer="return=minimal",
        )
    return result


def main() -> int:
    if not PROJECT_URL or not SECRET_KEY:
        print("[error] 缺少 SUPABASE_URL / SUPABASE_SECRET_KEY 环境变量")
        return 1
    database = SupabaseRest(PROJECT_URL, SECRET_KEY)
    if crawler_is_paused(database):
        print("[pause] 管理员已暂停自动抓取，本次不访问任何官网页面。")
        return 0

    sources = [source for source in get_sources(database) if source_is_due(source)]
    if not sources:
        print("[skip] 当前没有到达采集时间的已启用来源。")
        return 0

    totals = {"pages_scanned": 0, "pages_added": 0, "pages_updated": 0, "pages_failed": 0}
    source_failures = 0
    for source in sources:
        print(f"[source] {source['name']} ({source['domain']})")
        try:
            result = crawl_source(database, source)
            for key in totals:
                totals[key] += result[key]
            if result["pages_scanned"] == 0 and result["pages_failed"]:
                source_failures += 1
        except Exception as exc:
            source_failures += 1
            print(f"[error] 来源采集失败 {source['name']}: {exc}")

    mode = "演练" if DRY_RUN else "采集"
    print(
        f"[{mode}] 来源 {len(sources)} 个，扫描 {totals['pages_scanned']} 页，"
        f"新增 {totals['pages_added']}，更新 {totals['pages_updated']}，失败 {totals['pages_failed']}。"
    )
    return 1 if source_failures == len(sources) else 0


if __name__ == "__main__":
    raise SystemExit(main())
