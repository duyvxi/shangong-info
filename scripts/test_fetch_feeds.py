"""由本机 PostgreSQL 验收脚本提供数据库桥接。所有源站页面均为合成数据。"""
import io
import json
import sys
from contextlib import redirect_stdout
from types import SimpleNamespace

from fetch_feeds import collect


class LocalDatabase:
    pause = None
    reject_write = False

    def request(self, method, path, *, params=None, payload=None):
        if self.pause == "error" and path == "site_settings":
            raise RuntimeError("Supabase 503: fixture")
        if self.pause == "missing" and path == "site_settings":
            return []
        if self.pause == "on" and path == "site_settings":
            return [{"value": "true"}]
        if self.reject_write and path == "rpc/ingest_feed_notice":
            payload = {**payload, "p_title": None}  # 真实数据库非空约束失败
        print(json.dumps({"method": method, "path": path, "params": params, "payload": payload}),
              file=sys.__stdout__, flush=True)
        response = json.loads(sys.stdin.readline())
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["data"]


def main():
    sources = [
        {"key": "jwc", "name": "模拟教务处", "url": "https://jwc.sdtbu.edu.cn/index/notices.htm"},
        {"key": "xsc", "name": "模拟学生处", "url": "https://xsc.sdtbu.edu.cn/index/notices.htm"},
    ]
    pages = [
        '<a href="/info/1001/8800.htm#top">虚构教务通知</a>'
        '<a href="/detailnew.jsp?wbnewsid=8800">教务同文入口</a>'
        '<a href="/info/1001/9900.htm">已有发布通知</a>'
        '<a href="/info/1001/9901.htm">已有忽略通知</a>',
        '<a href="/info/1001/8800.htm">虚构学生处通知</a>'
        '<a href="https://other.invalid/info/1001/8800.htm">外站链接不会入库</a>',
    ]
    visits = []

    def fixture(url):
        visits.append(url)
        index = next(i for i, source in enumerate(sources) if source["url"] == url)
        return SimpleNamespace(url=url, content=(f'<meta charset="UTF-8">{pages[index]}').encode())

    db = LocalDatabase()
    first = collect(db, sources, fixture)
    assert (first.scanned, first.added, first.duplicates, first.summarize()) == (5, 2, 3, 0)
    second = collect(db, sources, fixture)
    assert (second.added, second.duplicates, second.summarize()) == (0, 5, 0)

    visits.clear()
    for value in ["error", "missing", "on"]:
        db.pause = value
        report = collect(db, sources, fixture)
        assert not visits
        assert report.summarize() == int(value != "on")
    db.pause = None

    def offline(_url):
        raise RuntimeError("HTTP 502: fixture")

    capture = io.StringIO()
    with redirect_stdout(capture):
        unreachable = collect(db, sources[:1], offline)
        assert unreachable.summarize() == 1 and unreachable.source_failures == 1
        db.reject_write = True
        failed = collect(db, sources[1:], fixture)
        assert failed.summarize() == 1 and failed.write_failures == 1 and failed.duplicates == 0
    assert "status=failed" in capture.getvalue() and "HTTP 502" in capture.getvalue()
    print("PASS 消息采集：重复、跨院系同号、旧审核状态、暂停失败与源站/数据库错误。")


if __name__ == "__main__":
    assert sys.argv[1:] == ["--local-database"]
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    with redirect_stdout(sys.stderr):
        main()
