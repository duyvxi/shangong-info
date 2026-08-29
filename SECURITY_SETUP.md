# 后台与数据库安全说明

## 已完成

- 管理员权限保存在 Supabase Auth `app_metadata`，普通用户不能自行修改。
- `admin.html` 必须登录并通过管理员身份校验后才能显示。
- 数据库使用最小表权限和 RLS 双重保护。
- 匿名访客不能读取用户档案、反馈、投稿、搜索记录或原始浏览记录。
- 新评论进入待审核状态，管理员放行后才公开显示。
- 高权限视图已改为 `security_invoker`。
- 公共角色不能直接执行 `SECURITY DEFINER` 函数。
- 后台渲染用户内容前会做 HTML 转义，避免存储型 XSS。

## 管理员登录

打开：`https://duyvxi.github.io/shangong-info/admin.html`

使用昵称“杜”对应账号原来的登录账号与密码。管理员权限更新后，旧会话中的 JWT 不会自动刷新；首次使用请重新登录。

## 必须手动配置：GitHub Actions 抓取密钥

安全迁移后，定时抓取任务不再使用公开匿名 Key 写数据库。

1. 打开 GitHub 仓库 `duyvxi/shangong-info`。
2. 进入 **Settings → Secrets and variables → Actions**。
3. 新建 Repository secret：`SUPABASE_SECRET_KEY`。
4. 值填写 Supabase 项目的服务端 Secret Key。
5. 不要把该值写进仓库、截图、Issue 或聊天记录。
6. 保存后，到 **Actions → 抓取校园新内容 → Run workflow** 手动运行一次。

## 建议手动开启：泄露密码保护

Supabase 安全顾问仍提示 Leaked Password Protection 未开启。请在 Supabase Dashboard 的 Auth 密码安全设置中启用该功能，然后要求管理员使用强密码。

## 复现迁移

数据库安全规则保存在 `supabase-security-phase2.sql`。它包含管理员校验，管理员账号不匹配时会整体回滚。
