-- ==============================================================================
-- 山东工商学院校园信息聚合网站 - 完整数据库架构与后台管理升级脚本
-- (含：评论点赞 + 楼中楼回复支持)
-- ==============================================================================

-- 1. 用户档案表 (profiles)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    account_raw TEXT NOT NULL,                         -- 注册时输入的手机号或账号
    nickname TEXT NOT NULL DEFAULT '山商学子',           -- 显示昵称
    avatar_url TEXT,                                   -- 头像链接
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'editor', 'admin')), -- 角色
    grade TEXT,                                        -- 年级
    major TEXT,                                        -- 所属学院/专业
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'muted', 'banned')), -- 状态
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_role_status ON public.profiles(role, status);
CREATE INDEX IF NOT EXISTS idx_profiles_account ON public.profiles(account_raw);

-- 自动同步新用户至 profiles 表的触发器函数
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, account_raw, nickname, created_at, updated_at)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'account_raw', SPLIT_PART(NEW.email, '@', 1)),
        COALESCE(NEW.raw_user_meta_data->>'display_name', '山商学子'),
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        account_raw = EXCLUDED.account_raw,
        nickname = EXCLUDED.nickname,
        updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 注册触发器
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 回填已有注册用户至 profiles 表（确保历史注册账号显示在后台）
INSERT INTO public.profiles (id, account_raw, nickname, created_at, updated_at)
SELECT 
    id, 
    COALESCE(raw_user_meta_data->>'account_raw', SPLIT_PART(email, '@', 1), '历史账号'),
    COALESCE(raw_user_meta_data->>'display_name', '山商学子'),
    created_at,
    NOW()
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- 2. 事项点赞表 (item_likes)
CREATE TABLE IF NOT EXISTS public.item_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_slug TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT unique_user_item_like UNIQUE (item_slug, user_id)
);
CREATE INDEX IF NOT EXISTS idx_item_likes_slug ON public.item_likes(item_slug);

-- 匿名化兼容（v2）：允许 user_id 为 NULL 或本地匿名 UUID，解除对 auth.users 的强依赖
ALTER TABLE public.item_likes DROP CONSTRAINT IF EXISTS item_likes_user_id_fkey;
ALTER TABLE public.item_likes ALTER COLUMN user_id DROP NOT NULL;

-- 3. 评论表 (comments - 兼容平铺与楼中楼回复)
CREATE TABLE IF NOT EXISTS public.comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_slug TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL DEFAULT '山商学子',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
    parent_id UUID REFERENCES public.comments(id) ON DELETE CASCADE, -- 父评论ID（顶级评论为NULL）
    reply_to_name TEXT,                                             -- 被回复人的昵称（如 "张同学"）
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 若旧表已存在，补充增加 parent_id 与 reply_to_name 列
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.comments(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS reply_to_name TEXT;

-- 匿名化兼容（v2）：允许 user_id 为 NULL 或本地匿名 UUID，解除对 auth.users 的强依赖
ALTER TABLE public.comments DROP CONSTRAINT IF EXISTS comments_user_id_fkey;
ALTER TABLE public.comments ALTER COLUMN user_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_comments_slug_status ON public.comments(item_slug, status);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON public.comments(parent_id);

-- 4. 评论点赞表 (comment_likes)
CREATE TABLE IF NOT EXISTS public.comment_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id UUID NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT unique_user_comment_like UNIQUE (comment_id, user_id) -- 防刷唯一约束
);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON public.comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON public.comment_likes(user_id);

-- 匿名化兼容（v2）：允许 user_id 为 NULL 或本地匿名 UUID，解除对 auth.users 的强依赖
ALTER TABLE public.comment_likes DROP CONSTRAINT IF EXISTS comment_likes_user_id_fkey;
ALTER TABLE public.comment_likes ALTER COLUMN user_id DROP NOT NULL;

-- 5. 纠错反馈表 (feedbacks)
CREATE TABLE IF NOT EXISTS public.feedbacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_slug TEXT NOT NULL,
    issue_type TEXT NOT NULL DEFAULT 'outdated' CHECK (issue_type IN ('outdated', 'wrong_phone', 'wrong_location', 'policy_change', 'other')),
    description TEXT NOT NULL,
    contact TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'resolved', 'ignored')),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON public.feedbacks(status);

-- 6. 学生投稿表 (submissions)
CREATE TABLE IF NOT EXISTS public.submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cat TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT NOT NULL,
    source_url TEXT,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL DEFAULT '热心同学',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON public.submissions(status);

-- 7. 内容自动抓取待审池表 (feeds)
-- 由 GitHub Actions 定时爬取学校官网/教务处/学生处列表页写入
-- 管理员在后台 admin.html 审核后一键发布或忽略
CREATE TABLE IF NOT EXISTS public.feeds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,          -- 来源站点标识 (sdtbu-home / jwc / xsc / mp_weixin)
    source_name TEXT NOT NULL,     -- 来源站点中文名 (如：学校官网·通知公告)
    title TEXT NOT NULL,
    link TEXT NOT NULL,            -- 原始外链（详情页或公众号文章）
    fingerprint TEXT UNIQUE NOT NULL, -- 去重指纹（URL 数字ID）
    pub_date TEXT,                 -- 发布日期原文（如 2026-08-23）
    cat TEXT,                      -- 目标板块（人工审核时指派，如 dorm/course/exam）
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'ignored')),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_feeds_status ON public.feeds(status);
CREATE INDEX IF NOT EXISTS idx_feeds_source ON public.feeds(source);
CREATE INDEX IF NOT EXISTS idx_feeds_fingerprint ON public.feeds(fingerprint);

-- 7.1 站点配置表 (site_settings)
-- 用于后台控制自动抓取等站点级开关（如 crawl_paused 暂停自动爬虫）
CREATE TABLE IF NOT EXISTS public.site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
INSERT INTO public.site_settings (key, value)
VALUES ('crawl_paused', 'false')
ON CONFLICT (key) DO NOTHING;

-- 8. 事项浏览埋点流水表 (item_views)
CREATE TABLE IF NOT EXISTS public.item_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_slug TEXT NOT NULL,
    cat_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    client_ip_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_views_slug_time ON public.item_views(item_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_views_cat_time ON public.item_views(cat_id, created_at DESC);

-- 8. 搜索关键词统计表 (search_keywords)
CREATE TABLE IF NOT EXISTS public.search_keywords (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword TEXT NOT NULL,
    has_result BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_keywords_kw_time ON public.search_keywords(keyword, created_at DESC);

-- 9. 每日统计表 (daily_stats)
CREATE TABLE IF NOT EXISTS public.daily_stats (
    stat_date DATE PRIMARY KEY,
    total_users INT NOT NULL DEFAULT 0,
    new_users INT NOT NULL DEFAULT 0,
    total_pv INT NOT NULL DEFAULT 0,
    total_likes INT NOT NULL DEFAULT 0,
    total_comments INT NOT NULL DEFAULT 0,
    total_feedbacks INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==============================================================================
-- 核心聚合统计视图
-- ==============================================================================

-- 热门事项排行榜视图 (view_top_items)
CREATE OR REPLACE VIEW public.view_top_items AS
SELECT 
    v.item_slug,
    v.cat_id,
    COUNT(*) AS view_count,
    COUNT(DISTINCT v.user_id) AS unique_user_count,
    MAX(v.created_at) AS last_viewed_at
FROM public.item_views v
WHERE v.created_at >= NOW() - INTERVAL '30 days'
GROUP BY v.item_slug, v.cat_id
ORDER BY view_count DESC;

-- 搜索热词排行榜视图 (view_search_ranking)
CREATE OR REPLACE VIEW public.view_search_ranking AS
SELECT 
    keyword,
    COUNT(*) AS search_count,
    COUNT(*) FILTER (WHERE has_result = false) AS zero_hit_count,
    MAX(created_at) AS last_searched_at
FROM public.search_keywords
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY keyword
ORDER BY search_count DESC;

-- 今日最新消息时效视图 (view_active_news: 自动过滤发布时间在 24 小时以内的有效通告)
CREATE OR REPLACE VIEW public.view_active_news AS
SELECT *
FROM public.feeds
WHERE status = 'published' 
  AND cat = 'news'
  AND published_at >= NOW() - INTERVAL '24 hours'
ORDER BY published_at DESC;

-- ==============================================================================
-- 启用行级安全 (RLS)
-- ==============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- RLS 安全策略配置 (带 DROP 保证幂等执行)
-- ==============================================================================

-- profiles 策略
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (true) WITH CHECK (true);

-- item_likes 策略
DROP POLICY IF EXISTS "Public item_likes can be viewed by everyone" ON public.item_likes;
CREATE POLICY "Public item_likes can be viewed by everyone" ON public.item_likes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert likes" ON public.item_likes;
DROP POLICY IF EXISTS "Anyone can insert likes" ON public.item_likes;
CREATE POLICY "Anyone can insert likes" ON public.item_likes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can delete their own likes" ON public.item_likes;
CREATE POLICY "Users can delete their own likes" ON public.item_likes FOR DELETE USING (true);

-- comments 策略（v2 匿名化：任何人可查看过审评论、可匿名发表）
DROP POLICY IF EXISTS "Approved comments can be viewed by everyone" ON public.comments;
CREATE POLICY "Approved comments can be viewed by everyone" ON public.comments FOR SELECT USING (status = 'approved' OR user_id = auth.uid() OR user_id IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can insert comments" ON public.comments;
DROP POLICY IF EXISTS "Anyone can insert comments" ON public.comments;
CREATE POLICY "Anyone can insert comments" ON public.comments FOR INSERT WITH CHECK (true);

-- comment_likes 策略（v2 匿名化：任何人可查看、可点赞/取消赞）
DROP POLICY IF EXISTS "Comment likes viewable by everyone" ON public.comment_likes;
CREATE POLICY "Comment likes viewable by everyone" ON public.comment_likes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert comment likes" ON public.comment_likes;
DROP POLICY IF EXISTS "Anyone can insert comment likes" ON public.comment_likes;
CREATE POLICY "Anyone can insert comment likes" ON public.comment_likes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can delete their own comment likes" ON public.comment_likes;
CREATE POLICY "Users can delete their own comment likes" ON public.comment_likes FOR DELETE USING (true);

-- feedbacks 策略
DROP POLICY IF EXISTS "Anyone can submit feedbacks" ON public.feedbacks;
CREATE POLICY "Anyone can submit feedbacks" ON public.feedbacks FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Feedbacks viewable by creator or admin" ON public.feedbacks;
DROP POLICY IF EXISTS "Feedbacks can be viewed by creator" ON public.feedbacks;
CREATE POLICY "Feedbacks viewable by creator or admin" ON public.feedbacks FOR SELECT USING (true);

DROP POLICY IF EXISTS "Feedbacks can be updated by admin" ON public.feedbacks;
CREATE POLICY "Feedbacks can be updated by admin" ON public.feedbacks FOR UPDATE USING (true);

-- submissions 策略（v2 匿名化：任何人可投稿，投稿人身份以昵称+本地匿名ID标识）
DROP POLICY IF EXISTS "Authenticated users can submit articles" ON public.submissions;
DROP POLICY IF EXISTS "Anyone can submit articles" ON public.submissions;
CREATE POLICY "Anyone can submit articles" ON public.submissions FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Published submissions can be viewed by everyone" ON public.submissions;
DROP POLICY IF EXISTS "Submissions viewable by admin" ON public.submissions;
CREATE POLICY "Published submissions can be viewed by everyone" ON public.submissions FOR SELECT USING (true);

DROP POLICY IF EXISTS "Submissions can be updated by admin" ON public.submissions;
CREATE POLICY "Submissions can be updated by admin" ON public.submissions FOR UPDATE USING (true);

-- item_views & search_keywords 策略
DROP POLICY IF EXISTS "Anyone can insert views" ON public.item_views;
CREATE POLICY "Anyone can insert views" ON public.item_views FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can insert search keywords" ON public.search_keywords;
CREATE POLICY "Anyone can insert search keywords" ON public.search_keywords FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Views can be queried for analytics" ON public.item_views;
CREATE POLICY "Views can be queried for analytics" ON public.item_views FOR SELECT USING (true);

DROP POLICY IF EXISTS "Keywords can be queried for analytics" ON public.search_keywords;
CREATE POLICY "Keywords can be queried for analytics" ON public.search_keywords FOR SELECT USING (true);

-- daily_stats 策略
DROP POLICY IF EXISTS "Daily stats viewable by everyone" ON public.daily_stats;
CREATE POLICY "Daily stats viewable by everyone" ON public.daily_stats FOR SELECT USING (true);

-- feeds 策略（待审池：任何人可读取；机器人按指纹幂等写入；后台更新发布状态）
DROP POLICY IF EXISTS "Feeds readable by everyone" ON public.feeds;
CREATE POLICY "Feeds readable by everyone" ON public.feeds FOR SELECT USING (true);

DROP POLICY IF EXISTS "Feeds insertable by fetch bot" ON public.feeds;
CREATE POLICY "Feeds insertable by fetch bot" ON public.feeds FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Feeds updatable by admin" ON public.feeds;
CREATE POLICY "Feeds updatable by admin" ON public.feeds FOR UPDATE USING (true) WITH CHECK (true);

-- site_settings 策略（站点配置：任何人可读，后台可更新）
DROP POLICY IF EXISTS "Site settings viewable by everyone" ON public.site_settings;
CREATE POLICY "Site settings viewable by everyone" ON public.site_settings FOR SELECT USING (true);

DROP POLICY IF EXISTS "Site settings updatable by admin" ON public.site_settings;
CREATE POLICY "Site settings updatable by admin" ON public.site_settings FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Site settings insertable by admin" ON public.site_settings;
CREATE POLICY "Site settings insertable by admin" ON public.site_settings FOR INSERT WITH CHECK (true);

-- ==============================================================================
-- 统一授予 anon 与 authenticated 角色全部访问权限
-- ==============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated;

GRANT SELECT ON public.view_top_items TO anon, authenticated;
GRANT SELECT ON public.view_search_ranking TO anon, authenticated;
GRANT SELECT ON public.view_active_news TO anon, authenticated;
-- 注意：这是项目早期的基础建表脚本。执行后必须继续执行
-- supabase-security-phase2.sql，以应用当前管理员权限和 RLS 安全规则。
