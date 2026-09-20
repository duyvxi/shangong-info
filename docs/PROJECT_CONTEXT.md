# 山商信息通项目上下文

最后核对日期：2026-09-20
代码分支：`main`；M6 流式输出已部署为 v33，M7 两轮页面上下文和跟进按钮已部署为 v34 并完成真实追问验收。

> 本文记录当前实现和外部状态。长期开发约束以根目录 `AGENTS.md` 为准；任何接手者仍应先检查源码、Git 状态和线上配置，不能把本文当作无需复核的事实副本。

## 1. 项目目标和当前范围

“山商信息通”是面向山东工商学院学生的第三方校园信息服务，目标是把散落在学校官网、职能部门网站和经过核验的校园生活资料整理为：

1. 可按场景浏览、搜索的校园信息；
2. 可追溯来源的 AI 校园问答；
3. 经人工审核后发布的最新消息；
4. 投稿、纠错、收藏、浏览记录和后台内容运营能力。

当前仍是开发测试版，不是学校官方系统，也不替代学校部门审批或最新通知。学生端采用无需登录的匿名使用方式；Supabase Auth 主要用于管理员后台门禁，`js/api.js` 中仍保留部分早期学生账号兼容代码。

公开地址记录为 `https://duyvxi.github.io/shangong-info/`，GitHub Pages 从 `main` 分支根目录发布。另有 EdgeOne 预览来源被允许调用 AI，但预览域名变化时必须同步更新 `AI_ALLOWED_ORIGINS`。

## 2. 技术栈与目录结构

### 技术栈

- 前端：HTML5、CSS3、Vanilla JavaScript，无打包和构建步骤。
- 路由：单页 hash 路由；四个主入口为 `#/ai`、`#/info`、`#/news`、`#/me`。
- 后端：Supabase PostgreSQL、Auth、RLS、REST、Edge Functions。
- AI：服务端可替换模型 API；当前文档按百炼兼容接口配置。知识检索为关键词与 1024 维 pgvector 语义检索的混合排序。
- 自动化：GitHub Actions 每 6 小时启动内容任务；官方知识源按各自抓取间隔决定是否实际访问。
- 部署：GitHub Pages 静态托管；AI 和数据服务运行在 Supabase。

### 主要目录和文件

```text
.
├── index.html                         # 学生端移动优先 SPA
├── admin.html                         # Supabase Auth 管理后台
├── css/
│   ├── style.css                      # 通用样式
│   └── mobile-app.css                 # 四板块移动端样式
├── js/
│   ├── data.js                        # 9 类、43 条静态校园事项
│   ├── api.js                         # Supabase/Auth/互动/后台 API
│   ├── app.js                         # 路由、渲染、搜索和页面交互
│   ├── markdown.js                    # AI 回答安全 Markdown 渲染与纯文本转换
│   ├── ai-stream.js                   # 前端流式事件分片解析与完成/中断处理
│   └── ai.js                          # AI 提问、状态和来源展示
├── knowledge/
│   ├── student-curated-2026-09.json   # 17 篇已复核学生整理资料
│   └── official-major-transfer-2026.json # 2 篇已复核转专业官方资料
├── scripts/
│   ├── dev-server.mjs                 # 本地无缓存静态服务器
│   ├── fetch_feeds.py                 # 最新消息抓取
│   ├── crawl_knowledge.py             # 官方正文安全采集
│   ├── import_manual_knowledge.mjs     # 人工知识幂等导入
│   ├── knowledge-chunking.mjs          # 切片与内容哈希
│   ├── test_safe_markdown.mjs          # Markdown 格式与恶意输入离线测试
│   ├── test_ai_streaming.mjs            # 流分片、完成、中断和前端取消测试
│   ├── reindex_knowledge.mjs           # 向量生成与上传
│   ├── sync_knowledge.mjs              # 静态事项同步
│   └── test_*                          # 离线测试
├── supabase/functions/
│   ├── campus-ai/index.ts              # 配额、检索、模型、来源和日志
│   └── _shared/retrieval.js            # 关键词分词与评分
├── .github/workflows/fetch-content.yml # 定时导入、抓取、向量补充
├── supabase-schema.sql                 # 基础业务表
├── supabase-ai-phase1.sql              # AI 文档、额度和用量表
├── supabase-ai-phase2.sql              # 来源、切片、向量、缺口和抓取任务
└── supabase-security-phase2.sql        # 管理员、最小权限和 RLS 加固
```

## 3. 已完成内容

### 学生端

- 移动优先的 AI 助手、校园信息、最新消息、我的四板块和底部导航。
- 九类校园事项、43 条静态政策/攻略，支持场景浏览、搜索和详情页。
- 匿名昵称、收藏、浏览记录、点赞、评论、投稿和纠错入口。
- AI 回答显示资料来源，并区分官方通知、本站整理和学生整理资料。
- 无可靠资料时不调用模型编造答案，而是提示无法确认并进入待补充清单。

### AI 与知识库

- 第一阶段关键词检索、匿名小时额度和不保存正文的用量日志。
- 第二阶段 1024 维向量、关键词/语义混合排序、官方来源、有效期过滤、未回答问题聚合和后台运营。
- `match_knowledge_chunks` 使用 `OPERATOR(extensions.<=>)`，解决 `search_path` 为空时无法找到 vector 运算符的问题。
- 19 篇人工核验资料已版本化：17 篇覆盖 2026—2027 校历、东西校区公交、线路调整和食堂信息，另有 2024 年现行转专业办法和 2026 年转专业通知；旧 62 路站序设置了 2026-09-09 失效日期。
- AI 回答质量基线已建立：24 道固定问题支持离线知识就绪度和真实回答报告评分。补齐转专业资料后，22 道可离线评估题的正确来源前 5 条命中率由 63.6% 提升到 100%，资料关键点覆盖率由 62.1% 提升到 93.9%。
- 对话历史中用户曾确认向量重建成功，终端当时报告 43 篇资料、43 个切片；这是外部运行记录，本次交接未读取线上数据库复核。

### 内容运营与自动化

- 官方站点安全采集具备 HTTPS/域名白名单、DNS 与公网地址检查、跨域跳转限制、robots、大小和页数限制、1.5 秒以上间隔、失败熔断及 429/5xx 退避。
- 新增或变化内容先进入待审核；已发布内容变化时退审并删除旧向量。
- GitHub Actions 顺序为：离线采集测试 → 人工资料导入 → 最新消息抓取 → 官方知识抓取 → 已审核资料向量补充。
- 用户此前确认 GitHub 仓库已配置 `SUPABASE_URL`、`SUPABASE_SECRET_KEY` 和 `AI_EMBEDDING_API_KEY`；本次无法从本地仓库验证 Secret 是否仍有效。

### 后台与安全

- `admin.html` 必须通过 Supabase Auth 登录，并校验 `app_metadata.role = admin`。
- SQL 已采用最小表权限、管理员 RLS、敏感表禁止匿名读取、视图 `security_invoker`、高权限函数固定 `search_path` 等加固。
- 管理后台可管理内容源、知识审核、抓取任务、未回答问题、评论、反馈、投稿和统计。
- 本地管理员密码恢复脚本仅针对固定管理员 ID，隐藏输入 Secret 和新密码，要求强密码并进行二次确认。

## 4. 重要架构决策及原因

1. **零构建静态前端**：降低部署与维护门槛，使 GitHub Pages 可直接发布；代价是模块边界和自动化前端测试较弱。
2. **AI 密钥只在 Edge Function**：浏览器只携带公开 Supabase key，避免模型密钥泄露和绕过服务端配额。
3. **混合检索而非只依赖大模型**：先从校园知识中召回，再让模型组织答案；提高本校相关性，并在向量服务失败时保留关键词降级能力。
4. **发布状态和有效期双重过滤**：自动抓取与学生整理资料都可能失效；默认只有审核通过且当前有效的内容可以进入回答上下文。唯一例外是受控历史参考：目标年度通知缺失时，只允许最近三年内、已发布并明确允许历史参考的官方年度通知进入，并强制标注年份和“仅供参考”。
5. **自动采集、人工发布**：避免网页变化或解析错误未经核验直接进入 AI，同时控制对学校官网的访问风险。
6. **匿名学生端、认证管理端**：学生使用不需要提交手机号或学号；后台高权限操作由 Auth、管理员 metadata 和 RLS 共同保护。
7. **不保存完整聊天记录**：仅保留脱敏问题缺口、匿名哈希和用量元数据，以满足产品改进需要并减少隐私风险。
8. **人工资料版本化入库**：校历、公交、食堂等非稳定资料保存在 `knowledge/`，通过 checksum 幂等导入；变化时退审而不是静默覆盖。

## 5. 当前已知问题

### 产品反馈

首轮产品测试共 9 名用户，与此前 24 份需求问卷是两组独立样本，不能混用：

- 5 人反馈 AI 回答速度慢、等待时间长。
- 3 人反馈回答不够详细，很多想了解的信息问不到。
- 1 人反馈功能少、信息覆盖度不足。

线上 v33 的 AI 请求路径为：额度检查后立即建立流式连接，再读取知识、检索、生成并写用量日志。2026-09-18 已部署 Server-Timing 分段计时；2026-09-19 完成 30 题线上基线。实测显示模型阶段平均占成功请求服务端耗时 96.22%，是主要瓶颈。当前没有回答缓存；M6 已完成部署与真实浏览器验收。

性能方案 A 当前进展：测量代码和离线验证完成，保持请求顺序及模型配置不变。新增 `scripts/benchmark_campus_ai.mjs`（默认不发请求）和 `scripts/test_ai_performance.mjs`；操作与验收见 [AI_PERFORMANCE.md](AI_PERFORMANCE.md)。8 类模拟服务端场景、报告统计/限额停止/超时检查以及原有四项 Node 测试通过。2026-09-18 用户授权后已部署计时版本 v23（v22 已备份）。30 题分三个额度窗口完成，使用同一匿名标识且未提高额度：28 成功、2 次 HTTP 500，成功回答中位耗时 36.916 秒，P95 56.571 秒，模型阶段平均占服务端耗时 96.22%。浏览器控制工具连接失败，手机/桌面体验测试未执行。尚未提速或验证冷启动。

本轮线上只读核对：60 篇已发布知识，59 篇有效，三批测试前后版本指纹一致；最近成功用量记录模型为 `qwen3.5-flash`。此前 43 篇的向量重建记录不能当作当前数据库数量。

### 技术与运维

- 2026-09-19 已完成真实知识导入、24 题基线、M3 历史参考、M4 多意图检索以及 M5 安全 Markdown；未运行真实官网抓取，也未验证 GitHub Actions 最近运行结果。
- Python 依赖没有 `requirements.txt`。系统默认 Python 和工作区自带 Python 均缺少 `requests`，因此本地 `test_crawl_knowledge.py` 未执行；CI 会先安装 `requests beautifulsoup4 supabase`。
- 没有浏览器端自动化测试；移动端、后台和真实 AI 链路仍依赖人工冒烟测试。
- `README.md` 仍把“账号体系”列为学生端功能，但当前学生主界面实际采用匿名模式；`js/api.js` 还保留早期学生注册/登录兼容代码，需要决定保留还是清理。
- `privacy.html` 尚需按最终模型服务商、服务器位置和数据保留规则补充准确说明。
- Supabase 的 Leaked Password Protection 是否已开启、GitHub Secrets 是否仍有效、线上数据库迁移是否完整，均需在控制台人工确认。
- CORS 正式来源优先由 `AI_ALLOWED_ORIGINS` 管理；新增或变化的 EdgeOne/正式域名若未加入，会出现“来源不允许”错误。不要使用共享域名通配符。
- 人工公交和食堂资料大多在 2026-12-31 到期，届时必须复核或让其自动退出检索。

### 当前 Git 工作区

在创建本交接前，`main` 与 `origin/main` 一致，但工作区已有用户改动：

- `SECURITY_SETUP.md` 已修改，增加管理员密码恢复说明。
- `CODEX_HANDOVER.md`、`scripts/reset_admin_password.ps1`、`重置管理员密码.cmd` 为未跟踪文件。
- 本次新增 `AGENTS.md` 和 `docs/PROJECT_CONTEXT.md`。

旧的 `CODEX_HANDOVER.md` 包含已过时描述，例如后台无鉴权、Actions 使用匿名 Key等；不得再把它作为当前架构依据。是否删除或改成指向本文，由用户后续决定。

2026-09-18 本轮复核补充：当前未找到 `CODEX_HANDOVER.md`；工作区另有 `授权申请模板.md` 的删除，保持原状。本轮新增的性能文件和 `campus-ai` 计时修改尚未提交，不能把 HEAD `b09dea9` 当成这些新增代码的部署版本。

## 6. 尚未完成的工作

1. 分段计时、v23 的 30 题基线、v24 的 10 题初测和 v25 的 10 题修正版对照均已完成。v25 完整响应中位数 6.815 秒、P95 10.719 秒，较 v23 分别下降 81.54% 和 81.05%；10/10 样本均确认 Responses API 的思考已关闭。下一步补浏览器可见耗时和答案事实核对。函数内计时不能单独证明冷启动耗时。
2. 优化响应速度：模型生成仍是最大阶段，但中位数已从 35.431 秒降至 4.716 秒。M6 流式输出已部署为 v33；成功基线样本首段文字中位数 2.604 秒，桌面和手机真实复测均完整结束。缓存和仅并行数据库请求仍不是第一优先级。
3. 受控历史参考检索已在 v29 完成：只有目标年度通知缺失时才使用最近三年的已审核官方通知，并强制标注年份和“仅供参考”。两道历史参考题线上验收均通过。
4. 为回答有用率、首字节时间、总耗时、来源点击率和无命中率建立稳定统计口径。
5. 补 `requirements.txt` 或等价依赖说明，并在本地和 CI 统一 Python 测试环境。
6. 补浏览器端移动/桌面自动化测试和真实部署冒烟测试。
7. 核对并完善隐私政策、模型供应商披露、保留规则和 Supabase Auth 安全设置。
8. 清理 README 与现状不一致的学生账号描述，决定是否移除未使用的注册代码。
9. 对当前未提交的密码恢复工具、安全文档和交接文档进行复核后再提交。

2026-09-19 已部署 v24 首轮候选并完成 10 题初测：10/10 成功，完整响应中位数较 30 题基线下降 12.73%，P95 下降 1.05%。首轮代码只对 Chat Completions 发送 `enable_thinking: false`，且响应没有记录实际接口格式，所以不能确认该参数在线上生效。随后部署 v25 修正版并完成 10 题成功集：接口全部为 Responses、思考全部关闭，完整响应中位数 6.815 秒、P95 10.719 秒，较 v23 分别下降 81.54% 和 81.05%。实际共尝试 12 次，包含一次按规则停止的限额响应和一次无服务器计时的瞬时网络/解析错误；两项均保留在原始报告中。浏览器控制连接仍失败，页面可见耗时和答案事实核对尚未完成。

## 7. 本地启动、测试和构建

### 本地预览

Windows 可双击 `启动本地预览.cmd`，或运行：

```powershell
node .\scripts\dev-server.mjs
```

访问 `http://127.0.0.1:4173/#/ai`。可用 `SHANGONG_PREVIEW_PORT` 改端口，用 `SHANGONG_NO_OPEN=1` 禁止自动打开浏览器。不要用 `file://` 直接打开页面。

### 离线 Node 测试

```powershell
node .\scripts\test_phase2_knowledge.mjs
node .\scripts\test_knowledge_retrieval.mjs
node .\scripts\test_manual_knowledge_import.mjs
node .\scripts\test_reindex_transport.mjs
node .\scripts\test_historical_retrieval.mjs
node .\scripts\test_multi_intent_retrieval.mjs
node .\scripts\test_safe_markdown.mjs
node .\scripts\test_ai_streaming.mjs
node .\scripts\test_ai_performance.mjs
node .\scripts\test_ai_quality_baseline.mjs
node .\scripts\benchmark_ai_quality.mjs
```

本次结果：M5 安全 Markdown、M6 流式输出和已有 Node 回归测试全部通过。流式测试覆盖分片跨包、正常结束、上游中断、连接提前关闭、Responses 流、旧 JSON 回退和取消请求；安全测试继续覆盖 HTML 白名单、危险链接、残缺格式、长列表和复制纯文本。

### 采集器测试

先在隔离环境安装依赖：

```powershell
python -m pip install requests beautifulsoup4 supabase
python .\scripts\test_crawl_knowledge.py
```

该测试设计为离线测试，不应访问真实学校网站。本次已在工作区忽略的 `.venv` 中安装依赖并通过测试；GitHub Actions 仍会在运行时安装依赖后执行同一测试。

### 管理员密码恢复工具自检

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\reset_admin_password.ps1 -SelfTest
```

本次结果：通过。不要在自检之外随意运行真实重置流程；真实重置需要 Supabase Secret key 和明确确认。

### 知识导入与向量 dry-run

人工资料格式可无数据库检查：

```powershell
node .\scripts\import_manual_knowledge.mjs --dry-run
```

`reindex_knowledge.mjs --dry-run` 仍需要读取 Supabase 已发布文档，但不会调用向量模型或写回数据库。所需变量和正式运行步骤见 `AI_SETUP.md`。Secret 只在当前进程临时设置，结束后立即清理。

### 构建与部署

前端没有构建步骤。GitHub Pages 直接发布仓库根目录。Supabase Edge Function 可按 `AI_SETUP.md` 使用 Supabase CLI 部署；未经用户授权不要执行部署。GitHub Actions 的抓取和向量任务配置见 `CRAWLER_SETUP.md`。

## 8. 下一步最优先任务

最高优先级是严格按 M1 至 M8 继续完成 [AI_QUALITY_STREAMING_PLAN.md](AI_QUALITY_STREAMING_PLAN.md)。M1 至 M7 已完成。下一步为：

1. M8：完成 24 题最终复测和质量、速度前后对照报告。

M3 部署记录：v28 首测历史标注率 50%，发现“4 月底”未被识别为时间意图；修复后部署 v29。v29 的 `history-01`、`history-02` 均完整通过，历史标注率 100%，接口和来源的历史年份标记全部正确。v29 bundle SHA-256 为 `25d21b392d865c32afc60f24749d6572527d675af35c5b8c9d9e0d0bc8917646`，v25 回退包保存在被 Git 忽略的 `out/ai-quality/rollback-pre-m3/`。

M4 部署记录：新增问题维度识别、年度通知与现行政策角色分散、同文档最多两个语义切片、年份与官方来源加权、上海当前日期和申请窗口状态，并加强逐项回答提示。首轮线上验收中 `condition-01`、`process-01` 通过，`multi-01` 遗漏适用年级；加强条件回答规则并过滤其他主题资料后部署 v31，单题复测达到 4/4 答案点。三道目标题的最新结果为 3/3 通过、答案点覆盖率和引用率均为 100%，完整响应中位数 10.670 秒、P95 14.008 秒。v31 状态为 `ACTIVE`，bundle SHA-256 为 `9d600fb77ae1ba4aebc7ece6ced1551faee519879c43d80c3476b023b357e725`，v29 回退包保存在 `out/ai-quality/rollback-pre-m4/`。

M5 记录：新增 `js/markdown.js` 的固定版本安全渲染模块，原始 HTML 会被移除，生成结果再经过标签和属性白名单清理，只允许 HTTP/HTTPS 链接。复制回答会移除 Markdown 和 HTML。桌面 1440px、手机 390px 的真实本地页面检查覆盖四个主板块、详情、搜索、最新消息、投稿/纠错、AI 富文本、无命中和错误状态，均无横向溢出。2026-09-19 在明确授权后以提交 `ec95c0a` 推送到 `main`，并确认 GitHub Pages 已加载新版入口、样式、AI 脚本和 Markdown 渲染器。

M6 完成记录：`campus-ai` 新增可选 SSE 流式路径，事件为 `meta`、`delta`、`done` 和 `error`；旧 JSON 路径保留。前端每约 80 毫秒更新一次安全 Markdown，页面切换会取消请求，流式中断会保留已显示文字。v32 的 10 题首轮有 7 题成功，首段文字中位数 2.604 秒、完整回答中位数 6.667 秒；3 题在响应头前被网关断开。v33 改为检索前立即建立连接，原失败类别的桌面和手机真实复测均成功，完整回答分别为 7.296 秒和 6.779 秒，无中断、Markdown 与来源正常、无横向溢出。v33 状态为 `ACTIVE`，bundle SHA-256 为 `8019ef9720568b7274a66e25bad177e27fb3bb3d8a4573adddbfa8a524a9186`；v31 回退包保存在 `out/ai-streaming/rollback-v31/`。受 12 次调用上限约束，完整 10 题稳定性留到 M8 验证。

M7 完成记录：新增 `js/ai-conversation.js`，只在页面内存保留最近两组问答，刷新后清除；每组问题和回答分别限制为 500 与 2000 字符。明显追问会组合最近问题进行检索，历史回答仅用于理解指代，不作为事实来源，模型仍设置 `store: false`。跟进按钮按办事、公交、餐饮和宿舍主题生成。离线测试与模拟流页面验证确认上下文长度按 0、1、2 变化，刷新后归零；桌面和手机均无横向溢出。v34 真实两轮追问确认请求上下文长度为 0、1，材料追问返回 2 条来源且无中断；v34 状态为 `ACTIVE`，bundle SHA-256 为 `7a10d5bb50b033e2aec8e76a2007eb0d369f021fefc095bd283229bab915e59e`，v33 回退包保存在 `out/ai-conversation/rollback-v33/`。

2026-09-19 已在明确授权后完成原第 3 项：真实知识导入新增 2、未变化 17，数据库现有 62 篇知识文档、63 个切片，两篇新资料生成 3 个向量。24 道真实回答全部完成，完整通过率 79.2%、关键点覆盖率 85.3%、引用率 100%、无依据克制率 100%；完整响应中位数 6.303 秒、P95 10.768 秒。24 个回答均使用 Responses API 且思考关闭。未通过的 5 题进一步确认：转专业长政策的单切片召回遗漏基本条件，历史参考回答缺少统一的“仅供参考”限制语。原始报告保存在被 Git 忽略的 `out/ai-quality/`。

## 9. 对话中已补入本文的重要信息

- 24 份需求问卷与 9 名首轮测试用户属于不同阶段、不同样本，不能合并统计。
- 9 名测试用户的反馈分布为速度 5、回答覆盖/详细度 3、功能覆盖 1。
- 用户曾确认 GitHub 三个自动化 Secrets 已保存，并曾完成一次知识向量重建；本次未验证其当前线上状态。
- 当前最影响体验的问题是响应速度，其次是知识覆盖，而不是简单地“必须更换模型”。

没有把商业计划书、路演 PPT、PPT 视频故障、个人账号或密钥等与代码维护无关或不应长期保存的内容写入本交接。
