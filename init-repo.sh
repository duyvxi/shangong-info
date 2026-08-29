# 山商信息通 - 项目初始化与一键推送脚本
# 用法：在项目根目录执行  bash init-repo.sh
# 作用：git init → 首次提交 → 关联远程仓库 → 推送 main 分支
# 注意：请先在上方 REMOTE_URL 填入你的 GitHub 仓库地址

set -e
cd "$(dirname "$0")"

# ===== 你的 GitHub 仓库地址 =====
REMOTE_URL="https://github.com/duyvxi/shangong-info.git"

# ===== 可选用：你的 GitHub 个人访问令牌（PAT），用于远程写权限认证 =====
# 获取方式见 PUSH_WITH_TOKEN.md。留空则使用已缓存的凭据。
GH_TOKEN="${GH_TOKEN:-}"

# 1. 初始化仓库
if [ ! -d .git ]; then
  git init -b main
  echo "[1/5] 已初始化 git 仓库 (main 分支)"
else
  echo "[1/5] 已存在 .git，跳过初始化"
fi

# 2. 添加远程仓库
if git remote | grep -q origin; then
  echo "[2/5] 远程 origin 已存在，更新地址"
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
  echo "[2/5] 已添加远程 origin"
fi

# 3. 暂存全部文件
git add -A
echo "[3/5] 已暂存文件："
git status --short | head -20

# 4. 首次提交
if git diff --cached --quiet; then
  echo "[4/5] 无变更可提交"
else
  git commit -m "feat: 山商信息通 - 校园信息聚合站全量代码（主站+后台+自动更新）"
  echo "[4/5] 已完成首次提交"
fi

# 5. 推送（若提供了 GH_TOKEN 则写入 URL 凭据，避免交互卡住）
if [ -n "$GH_TOKEN" ]; then
  # 把令牌拼入 remote URL，仅用于本次推送
  git remote set-url origin "https://oauth2:${GH_TOKEN}@github.com/duyvxi/shangong-info.git"
  echo "[5/5] 使用 GH_TOKEN 推送中..."
  git push -u origin main
  # 推送完成后移除令牌，避免留在配置里
  git remote set-url origin "$REMOTE_URL"
  echo "[5/5] 推送完成，已移除令牌凭据"
else
  echo "[5/5] 未提供 GH_TOKEN，尝试用系统缓存的凭据推送..."
  git push -u origin main
fi

echo ""
echo "✅ 推送完成！请继续到 GitHub 仓库完成后续配置："
echo "   1) Settings → Pages → 选择 main 分支 / root 部署"
echo "   2) Settings → Secrets and variables → Actions 添加 SUPABASE_URL / SUPABASE_SECRET_KEY"
