# 山东工商学院校园信息聚合站（山商信息通）

一个面向山东工商学院（SDTBU）学生的 **AI 校园信息聚合网站**：定位为「官网导航层 + 政策解读层」，按学生场景组织校园政策与资讯。静态前端部署在 GitHub Pages / EdgeOne，AI 与数据服务运行在 Supabase。

## 功能一览

- 🏠 首页：九大板块分类浏览 + 实时搜索 + 详情页（攻略/数据表/FAQ）
- 👤 账号体系：手机号/账号 + 密码自主注册（Supabase Auth，零短信成本）
- ❤️ 互动：事项点赞、评论、**楼中楼回复**、评论点赞、纠错反馈、学生投稿
- 📊 数据驾驶舱（`admin.html`）：注册用户管理、评论审查、纠错处理、投稿审核、Top10 热门榜、搜索热词缺口分析
- 🆕 **内容自动更新**：GitHub Actions 定时抓取官网通知与 AI 知识正文 → 人工审核 → 增量生成向量

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | 纯 HTML / CSS / Vanilla JS（零构建） |
| 后端 | Supabase（PostgreSQL + pgvector + Edge Functions + Auth + RLS） |
| 自动化 | GitHub Actions（定时抓取） + GitHub Pages（托管） |

## AI 校园助手

项目已加入基于 Supabase Edge Function 的只读校园问答入口。第一阶段提供关键词检索；第二阶段增加知识切片、`pgvector` 语义检索、混合排序、官方来源管理和脱敏后的未回答问题统计。模型密钥不会进入浏览器，数据库不保存完整聊天记录。

部署与手动配置见 [`AI_SETUP.md`](AI_SETUP.md)。

## 后台与数据库安全

管理后台已启用 Supabase Auth 管理员门禁，并以最小权限和 RLS 保护数据。管理员登录、GitHub Actions 服务端密钥和安全复检步骤见 [`SECURITY_SETUP.md`](SECURITY_SETUP.md)。

## 目录结构

```
shangong-info/
├── index.html            # 学生主站（单页应用，hash 路由）
├── admin.html            # 管理后台 & 数据驾驶舱
├── css/style.css         # 全站样式
├── css/mobile-app.css    # 移动端四板块与底部导航样式
├── js/
│   ├── data.js           # 站点内容数据（45+ 条已核实政策/攻略）
│   ├── api.js            # Supabase 统一 API 层
│   └── app.js            # 主站渲染与交互
├── scripts/
│   ├── dev-server.mjs    # 无依赖的本地预览服务
│   ├── knowledge-chunking.mjs # 知识切片工具
│   ├── reindex_knowledge.mjs  # 向量重建脚本
│   ├── crawl_knowledge.py     # 官网 AI 知识正文安全采集
│   └── fetch_feeds.py    # 自动抓取脚本（官网/教务处/学生处）
├── 启动本地预览.cmd      # Windows 一键预览入口
├── .github/workflows/
│   └── fetch-content.yml # 每 6 小时定时抓取
├── supabase-schema.sql   # 数据库基础建表脚本
├── supabase-ai-phase1.sql # AI 第一阶段知识库与额度
├── supabase-ai-phase2.sql # AI 第二阶段向量与知识运营
├── CRAWLER_SETUP.md       # 官网自动采集配置与审核说明
└── supabase-security-phase2.sql # 管理员与 RLS 安全迁移（基础脚本后执行）
```

## 快速开始（本地预览）

Windows 下双击项目根目录的 `启动本地预览.cmd`，脚本会启动本地服务并自动打开：

```text
http://127.0.0.1:4173/#/ai
```

预览期间请保持命令窗口开启，结束时在该窗口按 `Ctrl+C`。

不要直接双击 `index.html`。`file://` 页面没有正常的网站来源，浏览器会阻止它调用 Supabase AI 接口。

也可以手动启动本地静态服务器：

```bash
node scripts/dev-server.mjs
```

## 部署到 GitHub Pages（三步）

1. 在 GitHub 新建仓库（如 `shangong-info`），按下方命令推送本项目；
2. 仓库 `Settings → Pages` 选择 `main` 分支 `/root` 部署；
3. 在 `Settings → Secrets and variables → Actions` 添加三个服务端密钥：
   - `SUPABASE_URL`：你的 Supabase Project URL
   - `SUPABASE_SECRET_KEY`：仅供 GitHub Actions 抓取任务使用的 Supabase Secret Key
   - `AI_EMBEDDING_API_KEY`：百炼向量模型密钥

推送后自动更新功能即随 GitHub Actions 每 6 小时运行一次。
详细配置、审核和安全边界见 [`CRAWLER_SETUP.md`](CRAWLER_SETUP.md)。

## 数据来源（均为官方渠道）

- 官网：sdtbu.edu.cn（新闻/通知/融媒矩阵）
- 教务处：jwc.sdtbu.edu.cn
- 学生处：xsc.sdtbu.edu.cn
- 官方公众号：经官网「融媒矩阵」栏目合规抓取 + 学生投稿补充

> ⚠️ 本站为信息聚合与解读站，非学校官方系统。具体业务以官方最新发布为准。

## License

仅供学习交流使用。
