# -*- coding: utf-8 -*-
"""定时读取官网通知列表，将新消息写入 Supabase 待审表。"""
import os
import sys
from dataclasses import dataclass
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from crawl_knowledge import SafeFetcher, SupabaseRest, normalize_url, should_queue_url

# 抓取源配置：(key, 中文名, 列表页URL, 默认归属板块)
SOURCES = [
    {"key": "sdtbu_home", "name": "学校官网·通知公告", "url": "https://www.sdtbu.edu.cn/index/tzgg.htm", "cat": None},
    {"key": "jwc", "name": "教务处·工作通知", "url": "https://jwc.sdtbu.edu.cn/index/tzgg.htm", "cat": "course"},
    {"key": "xsc", "name": "学生处·通知公告", "url": "https://xsc.sdtbu.edu.cn/index/tzgg.htm", "cat": None},
]


def fetch_list_page(url: str):
    """复用官网采集的 DNS、跳转、robots 和响应大小检查。"""
    return SafeFetcher(urlsplit(url).hostname).fetch(url)


def parse_links(html: bytes, base: str):
    soup = BeautifulSoup(html, "html.parser")
    allowed_hosts = SafeFetcher(urlsplit(base).hostname).allowed_hosts
    for anchor in soup.select("a[href]"):
        title = (anchor.get("title") or anchor.get_text(" ", strip=True)).strip()
        if len(title) < 4:
            continue
        try:
            link = normalize_url(anchor["href"], base)
        except ValueError:
            continue
        if not should_queue_url(link, allowed_hosts):
            continue
        parent = anchor.find_parent("li") or anchor.find_parent("div")
        date = parent.find("span", class_="time") if parent else None
        yield {"title": title, "link": link, "date": date.get_text(strip=True) if date else None}


@dataclass
class FeedRun:
    paused: bool = False
    pause_error: bool = False
    source_failures: int = 0
    write_failures: int = 0
    scanned: int = 0
    added: int = 0
    duplicates: int = 0

    @property
    def failed(self) -> bool:
        return self.pause_error or self.source_failures > 0 or self.write_failures > 0

    def summarize(self) -> int:
        status = "failed" if self.failed else "paused" if self.paused else "ok"
        print(f"[fetch] status={status} scanned={self.scanned} added={self.added} "
              f"duplicates={self.duplicates} source_errors={self.source_failures} "
              f"write_errors={self.write_failures} pause_error={int(self.pause_error)}")
        return int(self.failed)


def error_kind(error: Exception) -> str:
    # 只显示错误类别和可识别的 HTTP 状态，避免透出数据库响应正文。
    prefix, _, rest = str(error).partition(" ")
    code = rest[:3]
    return f"HTTP {code}" if prefix in {"HTTP", "Supabase"} and code.isdecimal() else type(error).__name__


def collect(database: SupabaseRest, sources=SOURCES, fetch_page=fetch_list_page) -> FeedRun:
    result = FeedRun()
    try:
        rows = database.request("GET", "site_settings",
                                params={"select": "value", "key": "eq.crawl_paused", "limit": "1"})
        value = rows[0]["value"] if rows else None
        if value not in {"true", "false"}:
            raise ValueError("缺少有效的暂停配置")
    except Exception as error:
        result.pause_error = True
        print(f"[error] 暂停配置读取失败，未访问源站：{error_kind(error)}")
        return result

    if value == "true":
        result.paused = True
        return result

    for source in sources:
        try:
            page = fetch_page(source["url"])
            items = list(parse_links(page.content, page.url))
        except Exception as error:
            result.source_failures += 1
            print(f"[error] 源站读取失败 [{source['key']}]：{error_kind(error)}")
            continue
        for item in items:
            result.scanned += 1
            try:
                added = database.request("POST", "rpc/ingest_feed_notice", payload={
                    "p_source": source["key"], "p_source_name": source["name"],
                    "p_title": item["title"], "p_link": item["link"], "p_pub_date": item["date"],
                })
                if added is True:
                    result.added += 1
                elif added is False:
                    result.duplicates += 1
                else:
                    raise ValueError("无法确认写入结果")
            except Exception as error:
                result.write_failures += 1
                print(f"[error] 消息写入失败 [{source['key']}]：{error_kind(error)}")
    return result


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not url or not key:
        print("[error] 缺少 SUPABASE_URL / SUPABASE_SECRET_KEY 环境变量")
        return 1
    return collect(SupabaseRest(url, key)).summarize()


if __name__ == "__main__":
    sys.exit(main())
