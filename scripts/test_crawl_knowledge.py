# -*- coding: utf-8 -*-
"""Offline tests for official-site URL and article extraction rules."""

from crawl_knowledge import (
    SafeFetcher,
    choose_category,
    discover_links,
    extract_document,
    normalize_url,
    should_queue_url,
)
from bs4 import BeautifulSoup


def run() -> None:
    normalized = normalize_url(
        "../info/1001/12345.htm?utm_source=test&wbnewsid=77#footer",
        "https://jwc.sdtbu.edu.cn/index/tzgg.htm",
    )
    assert normalized == "https://jwc.sdtbu.edu.cn/info/1001/12345.htm?wbnewsid=77"

    fetcher = SafeFetcher("jwc.sdtbu.edu.cn")
    assert should_queue_url("https://jwc.sdtbu.edu.cn/info/1001/12345.htm", fetcher.allowed_hosts)
    assert not should_queue_url("https://example.com/info/1001/12345.htm", fetcher.allowed_hosts)
    assert not should_queue_url("https://jwc.sdtbu.edu.cn/files/notice.pdf", fetcher.allowed_hosts)

    html = """
    <!doctype html>
    <html>
      <head>
        <meta property="og:title" content="关于开展学生会部门招新的通知">
        <meta name="PubDate" content="2026-09-05">
        <title>通知 - 山东工商学院</title>
      </head>
      <body>
        <nav><a href="https://outside.example/a">外站</a></nav>
        <div class="v_news_content">
          <p>校学生会下设办公室、组织部、宣传部、学习部和权益服务部。</p>
          <p>各部门面向全校学生公开招募，具体安排以本通知为准。</p>
          <p>申请人应按规定时间提交报名表，并参加统一面试和部门考核。</p>
          <p>录取结果将在学生工作部门官方网站公布，请及时关注后续信息。</p>
          <p>上一篇：其他通知</p>
        </div>
        <a href="/info/1001/12346.htm">下一篇</a>
        <a href="/files/form.docx">附件</a>
      </body>
    </html>
    """.encode("utf-8")
    document = extract_document(html, "https://jwc.sdtbu.edu.cn/info/1001/12345.htm")
    assert document is not None
    assert document.title == "关于开展学生会部门招新的通知"
    assert document.source_date == "2026-09-05"
    assert "办公室、组织部、宣传部" in document.content
    assert "上一篇" not in document.content
    assert choose_category(document.title, document.content, None) == "团学与创新创业"

    links = discover_links(
        BeautifulSoup(html, "html.parser"),
        "https://jwc.sdtbu.edu.cn/info/1001/12345.htm",
        fetcher.allowed_hosts,
    )
    assert links == ["https://jwc.sdtbu.edu.cn/info/1001/12346.htm"]

    list_page = b"<html><head><title>notice list</title></head><body><ul><li>item</li></ul></body></html>"
    assert extract_document(list_page, "https://jwc.sdtbu.edu.cn/index/tzgg.htm") is None

    print("PASS 官网采集测试：域名限制、URL 去重、正文提取、分类规则均正常。")


if __name__ == "__main__":
    run()
