# AI 校园助手第一阶段部署说明

当前第一阶段采用：Supabase 私有知识表 + 服务端关键词检索 + 可替换大模型 API。
模型只接收本次检索到的少量校园资料，浏览器不会接触模型密钥。

## 已有代码

- `supabase-ai-phase1.sql`：知识库、匿名额度和无正文用量日志。
- `scripts/sync_knowledge.mjs`：把 `js/data.js` 同步到知识表。
- `supabase/functions/campus-ai/index.ts`：检索与模型调用接口。
- `js/ai.js`：主站聊天抽屉。

## 需要在 Supabase 中设置的秘密变量

打开项目 `hadujcmbmgkypdqgulyh`：

`Edge Functions → Secrets → Add new secret`

添加：

| 名称 | 内容 |
|---|---|
| `AI_API_KEY` | 模型供应商 API 密钥 |
| `AI_API_BASE_URL` | API 根地址，例如 OpenAI 为 `https://api.openai.com/v1` |
| `AI_API_STYLE` | OpenAI Responses API 填 `responses`；兼容 Chat Completions 的供应商填 `chat_completions` |
| `AI_MODEL` | 账户实际可用的模型 ID，不要凭空填写 |
| `AI_PROVIDER` | 供应商简短名称，仅用于费用日志 |
| `AI_RATE_LIMIT_SALT` | 至少 32 字节的随机字符串，只用于匿名额度哈希 |
| `AI_REQUEST_LIMIT` | 每个匿名浏览器每小时额度，建议先填 `12` |
| `AI_ALLOWED_ORIGINS` | `https://duyvxi.github.io`（多个正式域名用英文逗号分隔；本机 localhost/127.0.0.1 的任意端口已自动允许） |

PowerShell 7 可生成额度盐：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

不要把上述真实值写入 Git、网页或聊天记录。

## 后续自行同步资料

推荐在 Supabase 创建一枚单独命名、可随时撤销的 Secret key，然后仅在本地终端临时设置：

```powershell
$env:SUPABASE_URL = 'https://hadujcmbmgkypdqgulyh.supabase.co'
$env:SUPABASE_SECRET_KEY = 'sb_secret_...'
node .\scripts\sync_knowledge.mjs
Remove-Item Env:SUPABASE_SECRET_KEY
```

脚本只上传整理后的校园资料，不上传聊天记录。Secret key 会绕过 RLS，绝不能放进 `js/api.js`。

## 使用 Supabase CLI 重新部署函数（可选）

本机安装并登录 Supabase CLI 后：

```powershell
supabase link --project-ref hadujcmbmgkypdqgulyh
supabase functions deploy campus-ai --no-verify-jwt
```

这里关闭平台 JWT 校验，是因为本站保持无需登录的匿名模式；函数内部仍校验项目 publishable/anon key、请求来源和每小时额度。

## 上线验收问题

至少检查以下问题，并逐个点击回答下方来源：

1. 新生报到需要带什么材料？
2. 宿舍可以使用哪些电器？
3. 挂科以后补考和重修怎么办？
4. 家庭困难如何申请资助？
5. 毕业论文和实习有什么时间要求？
6. 提问一个知识库没有收录的问题，确认助手明确表示无法确认。

## 上线前仍需处理

- 在 `privacy.html` 中把最终模型服务商名称、服务器位置及保留规则补充完整。
- 当前旧管理后台仍依赖匿名可更新策略。收紧这些策略前需要先补管理员鉴权，否则会导致 `admin.html` 无法审核内容。
- 正式公开后建议增加 Turnstile 等人机验证，匿名 ID 限额不能完全阻止恶意用户清除本地数据后重试。
