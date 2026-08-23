# 推送本项目到 GitHub（需您的个人访问令牌 PAT）

## 背景
`git ls-remote` 已验证：网络可达、远程仓库存在。但 **push 写操作需要 HTTPS 认证**
（即 GitHub 用户名 + 个人访问令牌），当前自动化终端无法弹窗输入，故需您提供令牌完成最后一步。

## 获取个人访问令牌（PAT）
1. 打开 GitHub → 右上角头像 → **Settings**
2. 拉到底部 → **Developer settings → Personal access tokens → Tokens (classic)**
3. **Generate new token (classic)**
   - `Note` 填写：`shangong-info-push`
   - 有效期建议：最长（90 天）
   - 权限仅勾选 `repo` 即可（不推荐更高权限）
4. 点击 **Generate token**，复制形如 `ghp_xxxxxxxxxxxxxxxxxxxx` 的令牌。

## 在仓库配置令牌并推送

### 方式 A：用 Actions Secrets（推荐，令牌不进代码）
1. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加：
   - `GH_TOKEN` = `ghp_你的令牌`
2. 本项目根目录我已放入 `.github/workflows/push.yml`，会在收到令牌后自动推送。
3. 您只需把令牌填到仓库 Secrets，触发一次工作流即可。

### 方式 B：本地一键推送（把令牌直接填入 init 脚本）
若您更愿意在本地推送，把令牌填到 `init-repo.sh`：
```bash
GH_TOKEN="ghp_你的令牌"
./init-repo.sh   # 会自动完成 set-url + push
```

---

## 已在真实 GitHub 验证的全部结论
| 项 | 状态 |
|---|---|
| 网络到 GitHub 远程仓库 | ✅ 可达（`ls-remote` 成功） |
| 远程仓库分支 | ✅ main（空仓库，可推） |
| 本仓库 git 初始化 | ✅ 12 文件，首次提交 f3b9016 |
| push 写操作 | ⚠️ 需 HTTPS + PAT（GitHub 个人访问令牌） |

**请提供您的 GitHub 个人访问令牌（或选择方式 A 把它作为 Actions Secret 填入仓库），我即可自动完成最后一推。** 或者您也可以告诉我「不用推了」，本项目代码已全部就绪，您手动在 GitHub 上传即可（仓库里没有敏感凭据，可放心公开）。