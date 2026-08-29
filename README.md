# 山东工商学院校园信息聚合站（山商信息通）

一个面向山东工商学院（SDTBU）新生的 **AI 校园信息聚合网站**：定位为「官网导航层 + 政策解读层」，按学生场景组织校园政策与资讯，纯静态、零后端成本。

## 功能一览

- 🏠 首页：九大板块分类浏览 + 实时搜索 + 详情页（攻略/数据表/FAQ）
- 👤 账号体系：手机号/账号 + 密码自主注册（Supabase Auth，零短信成本）
- ❤️ 互动：事项点赞、评论、**楼中楼回复**、评论点赞、纠错反馈、学生投稿
- 📊 数据驾驶舱（`admin.html`）：注册用户管理、评论审查、纠错处理、投稿审核、Top10 热门榜、搜索热词缺口分析
- 🆕 **内容自动更新**：GitHub Actions 每 6 小时抓取官网/教务处/学生处新通知 → 人工审核 → 一键发布

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | 纯 HTML / CSS / Vanilla JS（零构建） |
| 后端 | Supabase（PostgreSQL + Auth + RLS 行级安全） |
| 自动化 | GitHub Actions（定时抓取） + GitHub Pages（托管） |

## AI 校园助手（第一阶段）

项目已加入基于 Supabase Edge Function 的只读校园问答入口：服务端先从已审核知识库检索相关资料，再调用可配置的大模型生成带来源的回答。模型密钥不会进入浏览器，数据库也不保存聊天正文。

部署与手动配置见 [`AI_SETUP.md`](AI_SETUP.md)。

## 后台与数据库安全

管理后台已启用 Supabase Auth 管理员门禁，并以最小权限和 RLS 保护数据。管理员登录、GitHub Actions 服务端密钥和安全复检步骤见 [`SECURITY_SETUP.md`](SECURITY_SETUP.md)。

## 目录结构

```
shangong-info/
├── index.html            # 学生主站（单页应用，hash 路由）
├── admin.html            # 管理后台 & 数据驾驶舱
├── css/style.css         # 全站样式
├── js/
│   ├── data.js           # 站点内容数据（45+ 条已核实政策/攻略）
│   ├── api.js            # Supabase 统一 API 层
│   └── app.js            # 主站渲染与交互
├── scripts/
│   └── fetch_feeds.py    # 自动抓取脚本（官网/教务处/学生处）
├── .github/workflows/
│   └── fetch-content.yml # 每 6 小时定时抓取
├── supabase-schema.sql   # 数据库基础建表脚本
└── supabase-security-phase2.sql # 管理员与 RLS 安全迁移（基础脚本后执行）
```

## 快速开始（本地预览）

直接用浏览器打开 `index.html` 即可（纯静态，无构建步骤）。
推荐起个本地静态服务器：

```bash
# Python 方式
python -m http.server 8080
# 然后访问 http://localhost:8080
```

## 部署到 GitHub Pages（三步）

1. 在 GitHub 新建仓库（如 `shangong-info`），按下方命令推送本项目；
2. 仓库 `Settings → Pages` 选择 `main` 分支 `/root` 部署；
3. 在 `Settings → Secrets and variables → Actions` 添加两个服务端密钥：
   - `SUPABASE_URL`：你的 Supabase Project URL
   - `SUPABASE_SECRET_KEY`：仅供 GitHub Actions 抓取任务使用的 Supabase Secret Key

推送后自动更新功能即随 GitHub Actions 每 6 小时运行一次。

## 数据来源（均为官方渠道）

- 官网：sdtbu.edu.cn（新闻/通知/融媒矩阵）
- 教务处：jwc.sdtbu.edu.cn
- 学生处：xsc.sdtbu.edu.cn
- 官方公众号：经官网「融媒矩阵」栏目合规抓取 + 学生投稿补充

> ⚠️ 本站为信息聚合与解读站，非学校官方系统。具体业务以官方最新发布为准。

## License

仅供学习交流使用。
