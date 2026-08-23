# -*- coding: utf-8 -*-
"""使用 Contents API 逐个上传全部项目文件（适用于本地 git 环境异常的场景）"""
import json
import urllib.request
import base64
import os

TOKEN = os.environ.get("GH_TOKEN", "").strip()
REPO = "duyvxi/shangong-info"
ROOT = r"D:\下载\2026-08-22-18-42-07\shangong-info"
BRANCH = "main"

def api(method, path, payload=None):
    url = f"https://api.github.com/repos/{REPO}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "token " + TOKEN,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"API失败 {e.code} {path}: {body[:300]}")
        return None

def main():
    skip_dirs = {"node_modules", "__pycache__", ".venv", "venv", "dist", ".vscode", ".idea", ".git"}
    skip_files = {".DS_Store", "Thumbs.db"}
    files = []
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in skip_dirs]
        for fn in fns:
            if fn in skip_files:
                continue
            fp = os.path.join(dp, fn)
            rel = os.path.relpath(fp, ROOT).replace("\\", "/")
            files.append((rel, fp))
    print("待上传文件:", len(files))

    for rel, fp in files:
        # 逐个文件上传，如已存在则更新
        with open(fp, "rb") as f:
            content = base64.b64encode(f.read()).decode()
        payload = {
            "message": f"feat: 上传 {rel}",
            "content": content,
            "branch": BRANCH,
        }
        result = api("PUT", f"contents/{rel}", payload)
        if result:
            print(f"✓ {rel}")
        else:
            print(f"✗ {rel} 上传失败")

    print("全部上传完成")

if __name__ == "__main__":
    main()
