# -*- coding: utf-8 -*-
"""
山东工商学院校园信息聚合站 - 内容自动抓取脚本
定时由 GitHub Actions 调用(每6小时)，抓取官网/教务处/学生处列表页，
提取(标题,链接,日期)，按 URL 数字ID 去重后写入 Supabase feeds 待审表。
"""
import os
import re
import sys
import hashlib
import requests
from bs4 import BeautifulSoup
from supabase import create_client

# 环境变量（由 GitHub Actions secrets 注入）
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_ANON_KEY"]

# 抓取源配置：(key, 中文名, 列表页URL, 默认归属板块)
SOURCES = [
    {"key": "sdtbu_home", "name": "学校官网·通知公告", "url": "https://www.sdtbu.edu.cn/index/tzgg.htm", "cat": None},
    {"key": "jwc", "name": "教务处·工作通知", "url": "https://jwc.sdtbu.edu.cn/index/tzgg.htm", "cat": "course"},
    {"key": "xsc", "name": "学生处·通知公告", "url": "https://xsc.sdtbu.edu.cn/index/tzgg.htm", "cat": None},
]

UA = {"User-Agent": "Mozilla/5.0 (SDTBU CampusInfoBot/1.0; +https://github.com)"}
TIMEOUT = 15


def fingerprint_of(url: str) -> str:
    """从 URL 提取数字ID作为去重指纹。
    兼容 info/栏目ID/文章ID.htm、detailnew.jsp?urltype=...&wbnewsid=数字 等格式。
    """
    nums = re.findall(r"\d+", url)
    return "|".join(nums) if nums else hashlib.md5(url.encode("utf-8")).hexdigest()


def fetch_list_page(url: str):
    """抓取列表页 HTML，失败返回 None。"""
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT)
        if r.status_code != 200:
            return None
        r.encoding = r.apparent_encoding or "utf-8"
        return r.text
    except Exception as e:
        print(f"[warn] 抓取失败 {url}: {e}")
        return None


def parse_links(html: str, base: str):
    """解析列表页，提取 (标题, 链接, 日期原文)。"""
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for a in soup.select("a[href]"):
        href = a.get("href", "")
        title = a.get("title") or a.get_text(" ", strip=True)
        if not title or len(title) < 4:
            continue
        if href.startswith("javascript") or href.startswith("mailto"):
            continue
        full = requests.compat.urljoin(base, href)
        date = None
        parent = a.find_parent("li") or a.find_parent("div")
        if parent:
            tm = parent.find("span", class_="time")
            if tm:
                date = tm.get_text(strip=True)
        items.append({"title": title, "link": full, "date": date})
    return items


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("[error] 缺少 SUPABASE_URL / SUPABASE_ANON_KEY 环境变量")
        sys.exit(1)

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    # 拉取已入库指纹，避免重复写入
    known = set()
    try:
        resp = supabase.table("feeds").select("fingerprint").limit(1000).execute()
        for row in resp.data:
            known.add(row["fingerprint"])
    except Exception as e:
        print(f"[warn] 查询已入库指纹失败: {e}")

    all_rows = []
    for src in SOURCES:
        html = fetch_list_page(src["url"])
        if not html:
            continue
        for p in parse_links(html, src["url"]):
            p["source"] = src["key"]
            p["source_name"] = src["name"]
            p["cat"] = src["cat"]
            all_rows.append(p)

    # 指纹去重 + 跳过已入库
    seen = set()
    added = 0
    for r in all_rows:
        fp = fingerprint_of(r["link"])
        if fp in seen or fp in known:
            continue
        seen.add(fp)
        try:
            supabase.table("feeds").insert({
                "source": r["source"],
                "source_name": r["source_name"],
                "title": r["title"],
                "link": r["link"],
                "fingerprint": fp,
                "pub_date": r["date"] or None,
                "status": "pending",
            }).execute()
            added += 1
            print(f"[new] {r['source_name']} | {r['title']}")
        except Exception as e:
            print(f"[skip] {r['title']} (可能已存在): {e}")

    print(f"[fetch] 扫描 {len(all_rows)} 条，新增 {added} 条待审内容")


if __name__ == "__main__":
    main()
