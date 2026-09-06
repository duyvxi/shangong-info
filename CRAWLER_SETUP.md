# 官网自动采集使用说明

## 作用

官网知识采集由 GitHub Actions 定时执行，数据流如下：

1. 从 Supabase `knowledge_sources` 读取已启用的学校官方来源；
2. 仅访问该来源登记的 `sdtbu.edu.cn` 官方 HTTPS 域名；
3. 从列表页发现文章，提取标题、发布日期和正文；
4. 按规范化网址与内容哈希去重；
5. 新文章或发生变化的文章进入 `knowledge_documents` 待审核状态；
6. 管理员在 `admin.html` 核对官网原文后发布；
7. 下一次任务只为新增或变化的已发布切片生成向量。

工作流还会导入仓库 `knowledge/` 中已经人工复核的版本化资料。人工资料会标明来源性质和有效期；相同内容重复运行不会重复新增，已发布内容发生变化时会自动退回待审核并删除旧向量。

采集不会保存原始 HTML、账号信息或聊天内容。默认 `requires_review=true`，所以未经人工审核的网页不会直接成为 AI 答案依据。

## GitHub Secrets

打开 GitHub 仓库：

`Settings → Secrets and variables → Actions → New repository secret`

确认存在以下三个 Repository secrets：

| 名称 | 内容 |
|---|---|
| `SUPABASE_URL` | 当前 Supabase Project URL |
| `SUPABASE_SECRET_KEY` | 专门给 GitHub Actions 使用的 `sb_secret_...` 服务端密钥 |
| `AI_EMBEDDING_API_KEY` | 百炼 API Key，用于 `text-embedding-v4` |

建议在 Supabase 单独创建名为 `github-crawler` 的 Secret key。不要使用浏览器里的 publishable/anon key；不要把任何 Secret key 写进仓库文件、Issues、Actions 日志或聊天记录。

## 第一次手动运行

1. 打开 GitHub 仓库的 `Actions`。
2. 选择“抓取校园新内容”。
3. 点击 `Run workflow`。
4. 第一次运行不需要开启“忽略来源间隔”；只有确认需要提前重新检查时才手动开启。
5. 再点击绿色的 `Run workflow`。
6. 等待各步骤显示绿色对勾。

定时任务每 6 小时启动一次，但每个 AI 来源默认每 24 小时抓取一次。手动运行时可以强制检查全部已启用来源。

## 审核采集内容

1. 打开线上 `admin.html` 并使用管理员账号登录。
2. 进入“AI 知识来源”。
3. 在“AI 知识审核”中打开有链接的官网原文；人工资料则核对来源标签、日期、正文主题和分类。
4. 内容可靠且仍然有效时点击“审核发布”；无关、重复或过期页面点击“忽略”。
5. 发布后 AI 可以先通过关键词检索使用内容；下一次 Actions 会自动生成语义向量。

“最近采集任务”会显示每个来源扫描、增加、更新和失败的页面数量。单个网页失败不会中断其他来源。

人工整理资料没有原文链接时，后台会直接显示其来源标签。此类内容不能当作学校正式通知；公交、食堂等动态信息到期后会自动退出 AI 检索，需要复核更新后再延长有效期。

## 安全限制

- 只允许数据库白名单中的 HTTPS 域名；
- 域名必须是 `sdtbu.edu.cn` 或其子域名；
- 阻止非公网 IP、用户密码 URL、非 443 端口和跨域跳转；
- 遵守 `robots.txt`；
- 跳过 PDF、Office、图片、视频、压缩包和脚本文件；
- 单页最大约 2.5 MB，单来源每次最多尝试 20 页；
- 所有成功、失败和被拒绝的页面都会计入 20 次上限；
- 请求之间至少等待 1.5 秒，连续失败 3 次会停止当前来源；
- 遇到 429、502、503 时尊重服务端限流并退避，只重试一次；
- 官网内容变化后立即删除旧向量，重新审核后才生成新向量。

## 常见结果

- `succeeded`：本来源采集完成；
- `partial`：部分页面失败，其他页面仍已处理；
- `failed`：该来源没有成功读取任何页面；
- 没有新增：网页没有变化，属于正常结果；
- 跳过向量补充：GitHub 尚未配置 `AI_EMBEDDING_API_KEY`。

不要为了绕过学校网站的访问限制而关闭域名、robots.txt 或请求频率保护。
