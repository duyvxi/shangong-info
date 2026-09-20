# AGENTS.md

本文件定义本仓库长期有效的开发约束。开始工作前先阅读本文件和
`docs/PROJECT_CONTEXT.md`，再以当前源码、SQL 和 Git 状态核实细节。

## 产品边界

- 本项目是面向山东工商学院学生的第三方校园信息聚合与可信问答工具，不是学校官方系统。
- 产品负责整理、检索和解释公开资料，不替代学校审批、教务系统或最新官方通知。
- 面向学生的核心入口保持低门槛；不要在未经明确产品决策、隐私评估和数据库迁移的情况下新增强制登录。
- 回答和页面必须区分“官方通知”“本站整理资料”“学生整理资料”，并保留来源、时效和不确定性提示。

## 架构约束

- 前端保持纯 HTML、CSS 和 Vanilla JavaScript，采用 hash 路由，直接从仓库根目录部署到 GitHub Pages；不要无故引入框架、打包器或构建步骤。
- `index.html` 是学生端入口，`admin.html` 是管理后台；公共逻辑集中在 `js/`，移动端布局集中在 `css/mobile-app.css`。
- 动态数据、Auth、RLS 和向量数据由 Supabase 承载；AI 调用必须经过 `supabase/functions/campus-ai`，模型密钥不得进入浏览器。
- 浏览器只能使用 Supabase publishable/anon key。Secret key、service-role key、模型 key、GitHub token 和额度盐只能存在于 Supabase Secrets、GitHub Actions Secrets 或本地进程环境变量中。
- 数据库变更必须通过可复现、可重复执行的 SQL 文件完成。基础安装顺序为：`supabase-schema.sql`、`supabase-ai-phase1.sql`、`supabase-ai-phase2.sql`、`supabase-security-phase2.sql`。
- 向量维度固定为 1024。`pgvector` 位于 `extensions` schema；在空 `search_path` 的函数内必须使用明确类型和 `OPERATOR(extensions.<=>)`，不要改回未限定的 `<=>`。
- 静态资源修改后应同步更新 HTML 中的版本查询参数，避免 GitHub Pages/CDN 缓存旧文件。

## 内容与 AI 约束

- AI 默认只能使用状态为 `published` 且仍在有效期内的知识资料组织答案。唯一例外是受控历史参考：目标年度官方通知缺失时，可以使用最近三年内、已发布、明确标记 `allow_historical_reference` 的官方年度通知，但必须标出往年年份和“仅供参考”，且不得把往年安排说成目标年度安排。没有可靠命中时必须明确回答无法确认，并记录脱敏后的未回答问题。
- 不允许把未经审核的抓取结果直接提供给 AI。内容变化后应退回待审核状态并清除旧向量，重新审核后再生成向量。
- 人工整理资料必须有稳定 slug、来源类别、整理/核验时间和适当的有效期；公交、食堂、校历等易变化内容不得伪装成长期有效的官方规定。
- 不要保存完整聊天记录。问题日志必须先移除邮箱、手机号和长编号等可能的个人信息。
- 调整检索时必须保留关键词降级路径；向量或模型服务故障不能导致已有关键词检索完全不可用。

## 抓取安全约束

- 官网采集只允许访问登记过的 `sdtbu.edu.cn` 官方 HTTPS 主机，遵守 `robots.txt`、页面大小、页数、请求间隔、失败熔断和退避限制。
- 禁止为了提高抓取量而关闭域名白名单、SSRF 防护、robots 检查、限速、最大页数或人工审核。
- 自动采集只处理公开网页，不抓取登录后内容、个人信息、附件、图片、视频、压缩包或可执行脚本。
- GitHub Actions 使用专用 `SUPABASE_SECRET_KEY`；不得把高权限密钥替换成前端 key，也不得把高权限密钥输出到日志。

## 权限、隐私与合规

- 后台管理员身份以 Supabase Auth `app_metadata.role = admin` 和数据库 RLS 为准；客户端页面判断只负责界面体验，不能充当权限边界。
- 禁止放宽 RLS、恢复匿名读取敏感表、向公共角色开放高权限 `SECURITY DEFINER` 函数，或把 service-role/Secret key 写入前端。
- 学生端匿名标识和昵称仅用于本机体验及去重。新增手机号、学号、真实姓名、邮箱、定位等个人信息采集前，必须获得明确授权并同步更新隐私政策、数据结构、保留规则和安全评审。
- 用户生成内容展示前必须转义；评论、投稿和纠错内容继续走审核流程。
- 不得使用学校官方名义宣传，不得虚构合作、授权、准确率、用户规模或收入。

## 开发与测试要求

- 不要直接双击 `index.html` 测试；使用 `node scripts/dev-server.mjs`，默认访问 `http://127.0.0.1:4173/#/ai`。
- 改动知识切片、导入、检索或向量传输时，至少运行：
  - `node scripts/test_phase2_knowledge.mjs`
  - `node scripts/test_knowledge_retrieval.mjs`
  - `node scripts/test_manual_knowledge_import.mjs`
  - `node scripts/test_reindex_transport.mjs`
- 改动 AI 回答的 Markdown 渲染或样式时运行 `node scripts/test_safe_markdown.mjs`，并检查恶意 HTML、危险链接、复制纯文本以及手机和桌面宽度。
- 改动 AI 流式传输、前端逐段显示或中断处理时运行 `node scripts/test_ai_streaming.mjs` 和 `node scripts/test_ai_performance.mjs`，并验证旧 JSON 路径仍可使用。
- 改动采集器时，先安装 `requests`、`beautifulsoup4`、`supabase`，再运行 `python scripts/test_crawl_knowledge.py`。离线测试不得访问学校官网或写入真实数据库。
- 改动管理员密码恢复工具时运行：
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/reset_admin_password.ps1 -SelfTest`。
- 前端改动至少手动检查手机和桌面宽度下的四个主板块、详情页、搜索、最新消息、投稿/纠错、AI 无命中与错误状态；不得只验证桌面截图。
- 涉及真实 Supabase、模型或官网的测试默认只读或 dry-run。任何写入、部署、密钥轮换、抓取强制运行或 GitHub 推送都需要用户明确授权。

## Git 与文件操作

- 开始修改前检查 `git status`。工作区可能包含用户未提交的改动，不得覆盖、回滚或顺手清理无关文件。
- 不使用 `git reset --hard`、`git checkout --` 或其他破坏性命令处理用户改动。
- 未经明确要求，不提交、不推送、不部署、不运行真实抓取任务。
- 不把生成物、临时渲染、密钥文件、日志、虚拟环境或依赖目录提交到仓库。
- 修改安全、部署、数据库或内容流程时，同步更新对应文档和 `docs/PROJECT_CONTEXT.md` 的当前状态。
