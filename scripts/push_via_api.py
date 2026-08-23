# -*- coding: utf-8 -*-
"""通过 GitHub Git Data API 全量上传项目到远程仓库（绕过 git 网络层故障）"""
import json
import urllib.request
import base64
import os

# 令牌从环境变量读取，绝不硬编码（避免 GitHub 密钥扫描拦截）
TOKEN = os.environ.get("GH_TOKEN", "").strip()
REPO = "duyvxi/shangong-info"
REMOTE_SHA = "d50f06fa1d95c974e54fd9d87c48d5e21583ef27"
ROOT = r"D:\下载\2026-08-22-18-42-07\shangong-info"


def api(method, path, payload=None):
    url = f"https://api.github.com/repos/{REPO}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": "token " + TOKEN,
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"API失败 {e.code} {path}: {body[:400]}")
        raise


def collect_files():
    skip_dirs = {"node_modules", "__pycache__", ".venv", "venv", "dist",
                 ".vscode", ".idea", ".git"}
    files = {}
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in skip_dirs]
        for fn in fns:
            fp = os.path.join(dp, fn)
            rel = os.path.relpath(fp, ROOT).replace("\\", "/")
            with open(fp, "rb") as f:
                files[rel] = f.read()
    return files


def main():
    files = collect_files()
    print("待上传文件数:", len(files))

    # 1. 创建所有 blobs
    blob_shas = {}
    for rel, content in files.items():
        b = api("POST", "git/blobs",
                {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        blob_shas[rel] = b["sha"]
    print("blobs 创建完成:", len(blob_shas))

    # 2. 收集所有目录（含嵌套）
    dirs = set()
    for rel in files:
        parts = rel.split("/")
        for i in range(1, len(parts)):
            dirs.add("/".join(parts[:i]))

    # 3. 递归建 tree（先子后父）
    tree_cache = {}

    def build_dir(path):
        if path in tree_cache:
            return tree_cache[path]
        prefix = path + "/"
        items = []
        for d in sorted(dirs):
            if d.startswith(prefix) and d[len(prefix):].find("/") == -1 and d != path:
                items.append({"path": d[len(prefix):], "mode": "040000",
                              "type": "tree", "sha": build_dir(d)})
        for f, sha in blob_shas.items():
            if f.startswith(prefix) and f[len(prefix):].find("/") == -1:
                items.append({"path": f[len(prefix):], "mode": "100644",
                              "type": "blob", "sha": sha})
        t = api("POST", "git/trees", {"tree": items})
        tree_cache[path] = t["sha"]
        return t["sha"]

    # 4. 顶层 tree
    top_items = []
    for d in sorted(dirs):
        if d.find("/") == -1:
            top_items.append({"path": d, "mode": "040000",
                              "type": "tree", "sha": build_dir(d)})
    for f, sha in blob_shas.items():
        if f.find("/") == -1:
            top_items.append({"path": f, "mode": "100644",
                              "type": "blob", "sha": sha})
    top_tree = api("POST", "git/trees", {"tree": top_items})
    print("顶层 tree 已创建:", top_tree["sha"][:10])

    # 5. 创建提交（父为远程 main 当前 HEAD）
    commit = api("POST", "git/commits", {
        "message": "feat: 山商信息通 - 校园信息聚合站全量代码（主站+后台+自动更新+GitHub Actions）",
        "tree": top_tree["sha"],
        "parents": [REMOTE_SHA]})
    print("commit 已创建:", commit["sha"][:10])

    # 6. 更新 main 引用（force 允许覆盖远程孤立初始化提交）
    api("PATCH", "git/refs/heads/main", {"sha": commit["sha"], "force": True})
    print("SUCCESS main ->", commit["sha"])


if __name__ == "__main__":
    main()
