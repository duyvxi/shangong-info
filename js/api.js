/**
 * 山东工商学院校园信息聚合网站 - Supabase API 客户端模块
 * 负责 Auth 认证、点赞互动、评论获取/发表、纠错上报、投稿流转
 */

// Supabase 真实项目连接凭据
const SUPABASE_CONFIG = {
  url: 'https://hadujcmbmgkypdqgulyh.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhZHVqY21ibWdreXBkcWd1bHloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NTI2NDMsImV4cCI6MjEwMzAyODY0M30.2zU4CnYh9hkRt4oALkiqZ4eUXyDFrtfAi8oVw4m3q3A',
};

// 检查是否已加载 Supabase JS SDK
let supabaseClient = null;
if (typeof window !== 'undefined' && window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
}

const Api = {
  /**
   * 检查是否已配置 Supabase 凭据
   */
  isConfigured() {
    return (
      SUPABASE_CONFIG.url &&
      !SUPABASE_CONFIG.url.includes('YOUR_PROJECT_ID') &&
      SUPABASE_CONFIG.anonKey &&
      !SUPABASE_CONFIG.anonKey.includes('YOUR_ANON_PUBLIC_KEY')
    );
  },

  // ==========================================
  // 用户身份管理 (Auth - 账号密码模式)
  // ==========================================

  /**
   * 将普通账号/手机号转换为 Supabase 兼容的内部邮箱格式
   */
  formatEmail(account) {
    account = account.trim();
    if (account.includes('@')) return account;
    // 纯数字或手机号自动加统一虚拟域名后缀，如 13800000000 -> 13800000000@user.sdtbu.local
    return `${account}@user.sdtbu.local`;
  },

  /**
   * 获取当前已登录的用户信息
   */
  async getCurrentUser() {
    if (!this.isConfigured() || !supabaseClient) return null;
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) return null;
    return user;
  },

  /**
   * 用户注册（手机号/账号 + 密码 + 昵称）
   */
  async signUp(account, password, nickname) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('Supabase 暂未配置，请先在 api.js 中填写项目 URL 和 Key');
    }
    const email = this.formatEmail(account);
    const displayName = nickname ? nickname.trim() : (account.includes('@') ? account.split('@')[0] : account);

    try {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName,
            account_raw: account.trim(),
          },
        },
      });

      if (error) {
        if (error.message.includes('already registered')) {
          throw new Error('该账号已被注册，请直接切换到「登录」');
        }
        if (error.message.includes('Password should be at least')) {
          throw new Error('密码长度至少需要 6 个字符');
        }
        throw error;
      }
      return data.user;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
        throw new Error('网络连接超时 (Failed to fetch)：无法直连海外认证服务器，请开启网络代理后重试');
      }
      throw err;
    }
  },

  /**
   * 用户登录（手机号/账号 + 密码）
   */
  async signIn(account, password) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('Supabase 暂未配置，请先在 api.js 中填写项目 URL 和 Key');
    }
    const email = this.formatEmail(account);

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          throw new Error('账号或密码不正确，请重新输入');
        }
        throw error;
      }
      return data.user;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
        throw new Error('网络连接超时 (Failed to fetch)：无法直连海外认证服务器，请开启网络代理后重试');
      }
      throw err;
    }
  },

  /**
   * 退出登录
   */
  async signOut() {
    if (!this.isConfigured() || !supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  },

  // ==========================================
  // 点赞互动 (Likes)
  // ==========================================

  /**
   * 获取指定事项的点赞总数和当前用户是否已点赞
   * @param {string} slug - 事项唯一标识
   * @param {string|null} userId - 当前用户ID
   */
  async getLikes(slug, userId = null) {
    if (!this.isConfigured() || !supabaseClient) {
      return { count: 0, hasLiked: false };
    }
    const { count, error } = await supabaseClient
      .from('item_likes')
      .select('*', { count: 'exact', head: true })
      .eq('item_slug', slug);

    if (error) {
      console.warn('获取点赞数失败:', error.message);
      return { count: 0, hasLiked: false };
    }

    let hasLiked = false;
    if (userId) {
      const { data } = await supabaseClient
        .from('item_likes')
        .select('id')
        .eq('item_slug', slug)
        .eq('user_id', userId)
        .maybeSingle();
      hasLiked = !!data;
    }

    return { count: count || 0, hasLiked };
  },

  /**
   * 切换点赞状态（未点赞则点赞，已点赞则取消）
   */
  async toggleLike(slug, userId) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!userId) {
      throw new Error('请先登录后再点赞');
    }

    const { data: existing } = await supabaseClient
      .from('item_likes')
      .select('id')
      .eq('item_slug', slug)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // 取消点赞
      const { error } = await supabaseClient.from('item_likes').delete().eq('id', existing.id);
      if (error) throw error;
      return { action: 'unliked' };
    } else {
      // 新增点赞
      const { error } = await supabaseClient.from('item_likes').insert({
        item_slug: slug,
        user_id: userId,
      });
      if (error) throw error;
      return { action: 'liked' };
    }
  },

  // ==========================================
  // 评论互动 (Comments & Comment Likes)
  // ==========================================

  /**
   * 获取指定事项的评论列表（含点赞数、点赞状态、子回复）
   */
  async getComments(slug, currentUserId = null) {
    if (!this.isConfigured() || !supabaseClient) return [];
    try {
      // 1. 获取该事项下全部过审评论
      const { data: comments, error } = await supabaseClient
        .from('comments')
        .select('id, user_id, user_name, content, parent_id, reply_to_name, created_at')
        .eq('item_slug', slug)
        .eq('status', 'approved')
        .order('created_at', { ascending: true });

      if (error || !comments) {
        console.warn('获取评论失败:', error ? error.message : '无数据');
        return [];
      }

      if (comments.length === 0) return [];

      const commentIds = comments.map((c) => c.id);

      // 2. 批量拉取所有评论的点赞记录
      const { data: likesData } = await supabaseClient
        .from('comment_likes')
        .select('comment_id, user_id')
        .in('comment_id', commentIds);

      // 3. 统计每条评论的点赞数以及当前用户是否已赞
      const likesCountMap = {};
      const userLikedSet = new Set();

      if (likesData && likesData.length > 0) {
        likesData.forEach((item) => {
          likesCountMap[item.comment_id] = (likesCountMap[item.comment_id] || 0) + 1;
          if (currentUserId && item.user_id === currentUserId) {
            userLikedSet.add(item.comment_id);
          }
        });
      }

      // 4. 将点赞信息附加到各评论对象
      const enriched = comments.map((c) => ({
        ...c,
        like_count: likesCountMap[c.id] || 0,
        has_liked: userLikedSet.has(c.id),
      }));

      // 5. 组织成顶级评论 + 楼中楼子回复树形结构
      const rootComments = [];
      const replyMap = {};

      enriched.forEach((c) => {
        if (!c.parent_id) {
          c.replies = [];
          rootComments.push(c);
        } else {
          if (!replyMap[c.parent_id]) {
            replyMap[c.parent_id] = [];
          }
          replyMap[c.parent_id].push(c);
        }
      });

      // 挂载子回复
      rootComments.forEach((root) => {
        root.replies = replyMap[root.id] || [];
      });

      // 顶级评论按时间倒序排（最新的在前），子回复保持正序（方便按对话流阅读）
      return rootComments.reverse();
    } catch (err) {
      console.warn('解析评论数据异常:', err);
      return [];
    }
  },

  /**
   * 发表评论或回复
   * @param {string} slug 事项 slug
   * @param {string} userId 用户 UUID
   * @param {string} userName 昵称
   * @param {string} content 内容
   * @param {string|null} parentId 父评论 ID（回复时传入）
   * @param {string|null} replyToName 被回复人昵称（回复时传入）
   */
  async postComment(slug, userId, userName, content, parentId = null, replyToName = null) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!userId || userId === 'anon' || userId === 'anonymous') {
      throw new Error('请登录后再发表评论');
    }
    if (!content || !content.trim()) {
      throw new Error('评论内容不能为空');
    }

    const payload = {
      item_slug: slug,
      user_id: userId,
      user_name: userName || '山商学子',
      content: content.trim(),
      status: 'approved',
    };

    if (parentId) payload.parent_id = parentId;
    if (replyToName) payload.reply_to_name = replyToName;

    const { data, error } = await supabaseClient.from('comments').insert(payload).select().single();

    if (error) throw error;
    return data;
  },

  /**
   * 切换评论点赞状态（点赞 / 取消点赞）
   */
  async toggleCommentLike(commentId, userId) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!userId || userId === 'anon' || userId === 'anonymous') {
      throw new Error('请登录后再为评论点赞');
    }

    // 检查是否已点赞
    const { data: existing } = await supabaseClient
      .from('comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // 取消点赞
      const { error } = await supabaseClient.from('comment_likes').delete().eq('id', existing.id);
      if (error) throw error;
      return { action: 'unliked' };
    } else {
      // 新增点赞
      const { error } = await supabaseClient.from('comment_likes').insert({
        comment_id: commentId,
        user_id: userId,
      });
      if (error) throw error;
      return { action: 'liked' };
    }
  },

  // ==========================================
  // 纠错反馈 (Feedback)
  // ==========================================

  /**
   * 提交信息纠错与失效上报
   */
  async submitFeedback({ slug, issueType, description, contact, userId = null }) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!description || !description.trim()) {
      throw new Error('请填写具体的纠错描述');
    }

    const { error } = await supabaseClient.from('feedbacks').insert({
      item_slug: slug,
      issue_type: issueType || 'outdated',
      description: description.trim(),
      contact: contact ? contact.trim() : null,
      user_id: userId,
      status: 'todo',
    });

    if (error) throw error;
    return true;
  },

  // ==========================================
  // 学生投稿 (Submissions)
  // ==========================================

  /**
   * 提交新攻略/政策解读投稿
   */
  async submitArticle({ cat, title, summary, content, sourceUrl, userId, authorName }) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!userId) {
      throw new Error('请先登录后再投稿');
    }
    if (!title || !content) {
      throw new Error('标题和正文为必填项');
    }

    const { error } = await supabaseClient.from('submissions').insert({
      cat,
      title: title.trim(),
      summary: summary ? summary.trim() : null,
      content: content.trim(),
      source_url: sourceUrl ? sourceUrl.trim() : null,
      user_id: userId,
      author_name: authorName || '热心同学',
      status: 'pending',
    });

    if (error) throw error;
    return true;
  },

  // ==========================================
  // 埋点与数据统计分析 (Analytics)
  // ==========================================

  /**
   * 事项浏览埋点上报
   */
  async recordView(slug, catId, userId = null) {
    if (!this.isConfigured() || !supabaseClient) return;
    try {
      await supabaseClient.from('item_views').insert({
        item_slug: slug,
        cat_id: catId,
        user_id: userId,
      });
    } catch (e) {
      // 埋点异常静默处理，不影响用户正常浏览
      console.warn('埋点上报忽略:', e);
    }
  },

  /**
   * 搜索热词与未命中词上报
   */
  async recordSearch(keyword, hasResult = true) {
    if (!this.isConfigured() || !supabaseClient || !keyword || !keyword.trim()) return;
    try {
      await supabaseClient.from('search_keywords').insert({
        keyword: keyword.trim().toLowerCase(),
        has_result: !!hasResult,
      });
    } catch (e) {
      console.warn('搜索统计上报忽略:', e);
    }
  },

  // ==========================================
  // 管理后台数据接口 (Admin Data)
  // ==========================================

  /**
   * 获取全站用户列表（支持按状态/角色筛选）
   */
  async getAdminProfiles({ limit = 50, status = 'all' } = {}) {
    if (!this.isConfigured() || !supabaseClient) return [];
    let query = supabaseClient.from('profiles').select('*').order('created_at', { ascending: false }).limit(limit);
    if (status !== 'all') {
      query = query.eq('status', status);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 更新用户状态（封禁/禁言/恢复）
   */
  async updateUserStatus(userId, status) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('未配置 Supabase');
    const { error } = await supabaseClient.from('profiles').update({ status, updated_at: new Date().toISOString() }).eq('id', userId);
    if (error) throw error;
    return true;
  },

  /**
   * 获取热门事项排行榜 (Top 10)
   */
  async getTopViewedItems(limit = 10) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('view_top_items').select('*').limit(limit);
    if (error) {
      console.warn('获取热榜失败:', error.message);
      return [];
    }
    return data || [];
  },

  /**
   * 获取热搜词与零命中词统计
   */
  async getSearchRankings(limit = 15) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('view_search_ranking').select('*').limit(limit);
    if (error) {
      console.warn('获取热搜词失败:', error.message);
      return [];
    }
    return data || [];
  },

  /**
   * 获取全站核心数据看板指标（汇总计数）
   */
  async getDashboardSummary() {
    if (!this.isConfigured() || !supabaseClient) {
      return { totalUsers: 0, totalPv: 0, totalLikes: 0, totalComments: 0, totalFeedbacks: 0, pendingPosts: 0 };
    }

    const [usersRes, viewsRes, likesRes, commentsRes, fbRes, postsRes] = await Promise.all([
      supabaseClient.from('profiles').select('id', { count: 'exact', head: true }),
      supabaseClient.from('item_views').select('id', { count: 'exact', head: true }),
      supabaseClient.from('item_likes').select('id', { count: 'exact', head: true }),
      supabaseClient.from('comments').select('id', { count: 'exact', head: true }),
      supabaseClient.from('feedbacks').select('id', { count: 'exact', head: true }),
      supabaseClient.from('submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    return {
      totalUsers: usersRes.count || 0,
      totalPv: viewsRes.count || 0,
      totalLikes: likesRes.count || 0,
      totalComments: commentsRes.count || 0,
      totalFeedbacks: fbRes.count || 0,
      pendingPosts: postsRes.count || 0,
    };
  },

  /**
   * 获取全部评论列表（供管理后台审查）
   */
  async getAdminComments(limit = 50) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('comments')
      .select('id, item_slug, user_name, content, status, parent_id, reply_to_name, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  /**
   * 更新评论审核状态
   */
  async updateCommentStatus(commentId, newStatus) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    const { error } = await supabaseClient
      .from('comments')
      .update({ status: newStatus })
      .eq('id', commentId);
    if (error) throw error;
    return true;
  },

  /**
   * 获取纠错反馈列表
   */
  async getFeedbacks(limit = 30) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('feedbacks').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },

  /**
   * 获取待审核投稿列表
   */
  async getSubmissions(limit = 30) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('submissions').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },

  // ==========================================
  // 内容自动抓取 (Feeds 待审池)
  // ==========================================

  /**
   * 获取待审/已发布内容源列表
   */
  async getFeeds(limit = 50) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('feeds').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },

  /**
   * 获取前台展示的已审核发布内容流
   * @param {string|null} cat 板块分类（如 'news' 或具体板块 key，传 null 或 'all' 则查全部已发布）
   * @param {number} limit 最大获取条数
   */
  async getPublishedFeeds(cat = 'news', limit = 30) {
    if (!this.isConfigured() || !supabaseClient) return [];
    try {
      let query = supabaseClient
        .from('feeds')
        .select('id, source, source_url, title, summary, pub_date, cat, status, published_at, created_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(limit);

      if (cat && cat !== 'all') {
        query = query.eq('cat', cat);
      }

      // 针对【今日最新消息 (cat === 'news')】：实施 24 小时自动下架时效控制
      if (cat === 'news') {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        query = query.gte('published_at', twentyFourHoursAgo);
      } else if (cat === 'all') {
        // 仅返回发布到常规场景板块的内容（不含 news，news 单独展示在今日最新消息）
        query = query.neq('cat', 'news').not('cat', 'is', null);
      }

      const { data, error } = await query;
      if (error) {
        console.warn('获取已发布消息失败:', error.message);
        return [];
      }
      return data || [];
    } catch (err) {
      console.warn('拉取已发布消息异常:', err);
      return [];
    }
  },

  /**
   * 将已发布的动态内容转换为前端可渲染的条目结构（与 data.js ITEMS 结构对齐）
   * @param {object} f feeds 记录
   */
  feedToItem(f) {
    return {
      id: 'feed-' + f.id,
      slug: 'feed-' + f.id,
      cat: f.cat,
      priority: '中',
      title: f.title,
      object: '以官方通知为准',
      time: f.pub_date || '近期发布',
      dept: f.source_name || f.source || '学校官方',
      place: '—',
      material: '—',
      phone: '',
      url: f.source_url || f.link || '#',
      summary: f.summary || f.title,
      date: (f.pub_date || (f.published_at ? f.published_at.slice(0, 10) : '')) || '',
      body: f.summary || f.title,
      steps: [],
      notes: '该内容由后台审核自动发布，详情以官方通知原文为准。',
      isDynamic: true,
    };
  },

  /**
   * 更新内容源状态（发布/忽略）
   * @param {string} id feeds 记录 UUID
   * @param {string} status pending/published/ignored
   * @param {string} cat 目标板块（发布时指派）
   */
  async updateFeedStatus(id, status, cat = null) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    const payload = { status };
    if (cat) payload.cat = cat;
    if (status === 'published') payload.published_at = new Date().toISOString();
    const { error } = await supabaseClient.from('feeds').update(payload).eq('id', id);
    if (error) throw error;
    return true;
  },
};

// 挂载到全局
if (typeof window !== 'undefined') {
  window.Api = Api;
}
