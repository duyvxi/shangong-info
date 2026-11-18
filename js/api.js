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
  // 匿名身份 (v2 匿名模式 - 不收集个人信息)
  // 每个浏览器生成一个本地匿名 UUID，用于点赞去重与评论归属标识，
  // 浏览器本地保存编号，互动时按用途发送给服务端。
  // ==========================================

  /**
   * 获取（或首次生成）本机匿名身份 ID
   * @returns {string} 匿名 UUID
   */
  getAnonymousId() {
    try {
      let id = localStorage.getItem('sdtbu_anon_id');
      const isUuid = typeof id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
      if (!isUuid) {
        id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
              const value = Math.floor(Math.random() * 16);
              return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
            });
        localStorage.setItem('sdtbu_anon_id', id);
      }
      return id;
    } catch (e) {
      return '00000000-0000-4000-8000-000000000000';
    }
  },

  /**
   * 读取本机昵称（未设置则返回默认「匿名同学」）
   */
  getNickname() {
    try {
      return localStorage.getItem('sdtbu_nickname') || '匿名同学';
    } catch (e) {
      return '匿名同学';
    }
  },

  /** 保存本机昵称。发表评论或投稿时，会随内容发送当时使用的昵称。 */
  setNickname(name) {
    const clean = (name || '').trim().slice(0, 20);
    try {
      if (clean) localStorage.setItem('sdtbu_nickname', clean);
      else localStorage.removeItem('sdtbu_nickname');
    } catch (e) {}
    return clean || '匿名同学';
  },

  // ==========================================
  // 用户身份管理 (Auth - 保留兼容旧代码，匿名模式不再使用)
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

  /**
   * 返回当前可信管理员。客户端判断仅用于页面体验，真正权限由数据库 RLS 强制执行。
   */
  async getCurrentAdmin() {
    const user = await this.getCurrentUser();
    return user && user.app_metadata && user.app_metadata.role === 'admin' ? user : null;
  },

  async signInAdmin(account, password) {
    await this.signIn(account, password);
    const admin = await this.getCurrentAdmin();
    if (!admin) {
      await this.signOut();
      throw new Error('该账号没有后台管理员权限');
    }
    return admin;
  },

  // ==========================================
  // 点赞互动 (Likes)
  // ==========================================

  /**
   * 获取指定事项的点赞总数和当前浏览器是否已点赞
   * @param {string} slug - 事项唯一标识
   */
  async getLikes(slug) {
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
    const userId = this.getAnonymousId();
    const { data } = await supabaseClient
      .from('item_likes')
      .select('id')
      .eq('item_slug', slug)
      .eq('user_id', userId)
      .maybeSingle();
    hasLiked = !!data;

    return { count: count || 0, hasLiked };
  },

  /**
   * 切换点赞状态（未点赞则点赞，已点赞则取消）——匿名模式按浏览器身份去重
   */
  async toggleLike(slug) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    const userId = this.getAnonymousId();

    const { data: existing } = await supabaseClient
      .from('item_likes')
      .select('id')
      .eq('item_slug', slug)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // 匿名身份无法安全证明删除归属，安全加固后不再开放公开删除。
      return { action: 'liked', unchanged: true };
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

  /** 分页读取公开评论，由数据库汇总点赞。 */
  async getComments(slug, { offset = 0, parentId = null } = {}) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('未配置 Supabase');
    const { data, error } = await supabaseClient.rpc('get_item_comments', {
      p_item_slug: slug, p_user_id: this.getAnonymousId(), p_offset: offset, p_parent_id: parentId,
    });
    if (error) throw error;
    return data;
  },

  /**
   * 发表评论或回复（匿名模式：昵称+浏览器匿名ID，无需登录）
   * @param {string} slug 事项 slug
   * @param {string} userName 昵称
   * @param {string} content 内容
   * @param {string|null} parentId 父评论 ID（回复时传入）
   * @param {string|null} replyToName 被回复人昵称（回复时传入）
   */
  async postComment(slug, userName, content, parentId = null, replyToName = null) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    if (!content || !content.trim()) {
      throw new Error('评论内容不能为空');
    }

    const payload = {
      item_slug: slug,
      user_id: this.getAnonymousId(),
      user_name: (userName || '匿名同学').trim().slice(0, 20),
      content: content.trim(),
      status: 'pending',
    };

    if (parentId) payload.parent_id = parentId;
    if (replyToName) payload.reply_to_name = replyToName;

    const { error } = await supabaseClient.from('comments').insert(payload);

    if (error) throw error;
    return { pending: true };
  },

  /** 匿名点赞可重复提交，接口只返回汇总结果。 */
  async toggleCommentLike(commentId) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('未配置 Supabase');
    const { data, error } = await supabaseClient.rpc('record_comment_like', {
      p_comment_id: commentId, p_user_id: this.getAnonymousId(),
    });
    if (error) throw error;
    return data;
  },

  // ==========================================
  // 纠错反馈 (Feedback)
  // ==========================================

  /**
   * 提交信息纠错与失效上报（匿名模式）
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
      // 这里引用正式账号。匿名提交不附带浏览器编号。
      user_id: userId ?? null,
      status: 'todo',
    });

    if (error) throw error;
    return true;
  },

  // ==========================================
  // 学生投稿 (Submissions)
  // ==========================================

  /**
   * 提交新攻略或政策解读。匿名投稿只随内容保存署名。
   */
  async submitArticle({ cat, title, summary, content, sourceUrl, userId, authorName }) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
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
      user_id: userId ?? null,
      author_name: authorName || this.getNickname(),
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
    if (error) throw error;
    return data || [];
  },

  /**
   * 获取热搜词与零命中词统计
   */
  async getSearchRankings(limit = 15) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient.from('view_search_ranking').select('*').limit(limit);
    if (error) throw error;
    return data || [];
  },

  /** 独立读取单个看板计数，失败由对应卡片显示。 */
  async getAdminCount(metric) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('未配置 Supabase');
    const tables = {
      users: 'profiles', pv: 'item_views', likes: 'item_likes', comments: 'comments',
      feedbacks: 'feedbacks', 'knowledge-documents': 'knowledge_documents',
      'knowledge-chunks': 'knowledge_chunks', 'open-questions': 'unanswered_questions',
    };
    let query = supabaseClient.from(tables[metric]).select('id', { count: 'exact', head: true });
    if (metric === 'knowledge-documents') query = query.eq('status', 'published');
    if (metric === 'knowledge-chunks') query = query.eq('embedding_status', 'ready').not('document_revision', 'is', null);
    if (metric === 'open-questions') query = query.eq('status', 'open');
    const { count, error } = await query;
    if (error) throw error;
    if (!Number.isInteger(count)) throw new Error('数据库未返回计数');
    return count;
  },

  /** 按固定顺序读取一页待后台查看的评论。 */
  async getAdminComments(limit = 50, offset = 0) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('comments')
      .select('id, item_slug, user_name, content, status, parent_id, reply_to_name, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
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
  async getPublishedFeeds(cat = 'news', limit = 30, { throwOnError = false } = {}) {
    try {
      if (!this.isConfigured() || !supabaseClient) {
        if (throwOnError) throw new Error('消息服务暂不可用');
        return [];
      }
      let query = supabaseClient
        .from('feeds')
        .select('id, source, source_name, title, link, pub_date, cat, status, published_at, created_at')
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
      if (error) throw error;
      return data || [];
    } catch (error) {
      // 最新消息需要区分请求失败和空列表，其他调用保留空列表回退。
      if (throwOnError) throw error;
      console.warn('获取已发布消息失败:', error.message);
      return [];
    }
  },

  /**
   * 将已发布的动态内容转换为前端可渲染的条目结构（与 data.js ITEMS 结构对齐）
   * @param {object} f feeds 记录
   */
  feedToItem(f) {
    // feeds 表实际字段：source / source_name / title / link / pub_date / cat / status / published_at
    const fallbackSummary = f.title;
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
      url: f.link || '#',
      summary: fallbackSummary,
      date: (f.pub_date || (f.published_at ? f.published_at.slice(0, 10) : '')) || '',
      body: fallbackSummary,
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

  // ==========================================
  // AI 知识运营（仅可信管理员，数据库 RLS 强制校验）
  // ==========================================

  async getKnowledgeSources(limit = 100) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('knowledge_sources')
      .select('id,name,base_url,domain,source_type,default_category,enabled,requires_review,crawl_interval_hours,max_pages_per_run,last_crawled_at,last_status,last_error,updated_at')
      .order('enabled', { ascending: false })
      .order('name', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async createKnowledgeSource(source) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('请先配置 Supabase 后端凭证');
    let parsed;
    try {
      parsed = new URL(String(source.baseUrl || '').trim());
    } catch (error) {
      throw new Error('请输入完整的 HTTPS 官网地址');
    }
    if (parsed.protocol !== 'https:') throw new Error('知识来源必须使用 HTTPS 地址');
    const domain = parsed.hostname.toLowerCase();
    if (domain !== 'sdtbu.edu.cn' && !domain.endsWith('.sdtbu.edu.cn')) {
      throw new Error('目前只允许添加山东工商学院 sdtbu.edu.cn 官方域名');
    }
    const baseUrl = `${parsed.origin}/`;
    const payload = {
      name: String(source.name || '').trim().slice(0, 120),
      base_url: baseUrl,
      domain,
      source_type: source.sourceType || 'department_site',
      default_category: source.defaultCategory || null,
      enabled: true,
      requires_review: true,
    };
    if (!payload.name) throw new Error('请填写来源名称');
    const { data, error } = await supabaseClient
      .from('knowledge_sources')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async updateKnowledgeSource(sourceId, changes) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('请先配置 Supabase 后端凭证');
    const allowed = [
      'name', 'default_category', 'enabled', 'requires_review',
      'crawl_interval_hours', 'max_pages_per_run', 'last_status',
    ];
    const payload = { updated_at: new Date().toISOString() };
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(changes || {}, key)) payload[key] = changes[key];
    });
    const { error } = await supabaseClient.from('knowledge_sources').update(payload).eq('id', sourceId);
    if (error) throw error;
    return true;
  },

  async getKnowledgeDocuments({ page, limit, status, sourceType, category, search, validity, sort, today, horizon }) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('Supabase 未配置');
    let query = supabaseClient
      .from('knowledge_documents')
      .select('id,slug,title,category,source_type,verified_at,effective_from,effective_until,status,metadata,last_review', { count: 'exact' });
    if (status !== 'all') query = query.eq('status', status);
    if (sourceType !== 'all') query = query.eq('source_type', sourceType);
    if (category) query = query.eq('category', category);
    // 转义搜索内容，避免特殊字符被解释为筛选语法或通配符。
    if (search) {
      const pattern = `%${search.replace(/[%_\\*]/g, '\\$&')}%`.replace(/["\\]/g, '\\$&');
      query = query.or(`title.ilike."${pattern}",slug.ilike."${pattern}"`);
    }
    if (validity === 'expired') query = query.lt('effective_until', today);
    if (validity === 'upcoming') query = query.gt('effective_from', today);
    if (validity === 'permanent') query = query.is('effective_until', null);
    if (validity === 'soon') {
      query = query.gte('effective_until', today).lte('effective_until', horizon)
        .or(`effective_from.is.null,effective_from.lte.${today}`);
    }
    if (sort === 'expiry') query = query.order('effective_until', { ascending: true, nullsFirst: false });
    const start = page * limit;
    const { data, count, error } = await query.order('updated_at', { ascending: false })
      .order('id').range(start, start + limit - 1);
    if (error) throw error;
    return { documents: data || [], count: count || 0 };
  },

  async getKnowledgeDocument(documentId) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('Supabase 未配置');
    const { data, error } = await supabaseClient
      .from('knowledge_documents')
      .select('id,slug,title,category,summary,content,source_type,source_url,canonical_url,source_date,verified_at,effective_from,effective_until,status,metadata,updated_at,revision,last_review,previous_version')
      .eq('id', documentId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('资料不存在，或当前账号无法读取');
    return data;
  },

  async reviewKnowledgeDocument(document, action, review) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('Supabase 未配置');
    const { data, error } = await supabaseClient.rpc('review_knowledge_document', {
      p_id: document.id,
      p_revision: document.revision,
      p_updated_at: document.updated_at,
      p_status: document.status,
      p_action: action,
      p_audience: review.audience,
      p_evidence: review.evidence,
      p_note: review.note,
      p_public_confirmed: review.publicConfirmed,
    });
    if (error) throw error;
    if (!data?.id) throw new Error('未收到保存确认，请重新读取资料核对结果');
    return data;
  },

  async getUnansweredQuestions({ limit = 100, status = 'open' } = {}) {
    if (!this.isConfigured() || !supabaseClient) return [];
    let query = supabaseClient
      .from('unanswered_questions')
      .select('id,sample_question,topic,ask_count,status,first_asked_at,last_asked_at,resolved_at,resolution_document_id,metadata')
      .order('ask_count', { ascending: false })
      .order('last_asked_at', { ascending: false })
      .limit(limit);
    if (status && status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async updateUnansweredQuestion(questionId, status) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('请先配置 Supabase 后端凭证');
    if (!['open', 'reviewing', 'ignored'].includes(status)) throw new Error('无效的处理状态');
    const payload = {
      status,
      resolved_at: null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseClient.from('unanswered_questions').update(payload).eq('id', questionId);
    if (error) throw error;
    return true;
  },

  async resolveKnowledgeGap(question, { slug, cause, result }) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('Supabase 未配置');
    const { data, error } = await supabaseClient.rpc('resolve_knowledge_gap', {
      p_id: question.id, p_status: question.status, p_slug: slug, p_cause: cause, p_result: result,
    });
    if (error) throw error;
    if (!data) throw new Error('未收到结单确认，请刷新列表核对');
  },

  async getCrawlJobs(limit = 30) {
    if (!this.isConfigured() || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('crawl_jobs')
      .select('id,source_id,status,pages_scanned,pages_added,pages_updated,pages_failed,error_summary,started_at,finished_at,created_at,knowledge_sources(name)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // ==========================================
  // AI 校园助手（模型密钥仅存在 Supabase Edge Function）
  // ==========================================

  /**
   * 向校园 AI 助手提问。前端只发送问题与本地匿名 ID，
   * 不保存聊天正文，也不会接触模型 API 密钥。
   */
  async askCampusAI(question, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('校园助手后端尚未配置');
    }

    if (window.location.protocol === 'file:') {
      throw new Error('当前页面是本地文件模式，浏览器会阻止 AI 请求。请关闭本页并双击项目中的“启动本地预览.cmd”');
    }

    const endpoint = `${SUPABASE_CONFIG.url}/functions/v1/campus-ai`;
    const controller = new AbortController();
    // Edge Function 最多等待模型 55 秒；浏览器多预留 15 秒给检索与网络传输。
    const timeoutId = setTimeout(() => controller.abort(), 70000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_CONFIG.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: String(question || '').trim(),
          clientId: this.getAnonymousId(),
          context: Array.isArray(options.context) ? options.context : [],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('校园助手响应超时，请稍后重试');
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('当前设备处于离线状态，请联网后重试');
      }

      const hostname = window.location.hostname;
      const isLoopback = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)
        || hostname.endsWith('.localhost');
      const isPrivateNetwork = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
      const isOfficialSite = [
        'https://duyvxi.github.io',
        'https://dgtzddf-2lxcnmk2.edgeone.cool',
        'https://tgfhjvhcvasgdiusfgfsh-4egfid21.edgeone.cool',
      ].includes(window.location.origin);
      if (!isLoopback && !isPrivateNetwork && !isOfficialSite) {
        throw new Error(`当前预览来源 ${window.location.origin} 尚未加入校园助手白名单，请改用 localhost 或联系维护者添加该地址`);
      }
      throw new Error('浏览器无法访问校园助手服务。请检查网络代理、防火墙或浏览器拦截扩展后重试');
    } finally {
      clearTimeout(timeoutId);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('校园助手返回了无法识别的响应');
    }

    if (!response.ok) {
      const error = new Error(payload.error || '校园助手暂时不可用');
      error.status = response.status;
      error.resetAt = payload.resetAt || null;
      throw error;
    }

    return payload;
  },

  /**
   * 流式提问。服务器不支持流式响应时自动兼容旧 JSON 返回。
   * handlers 可包含 onMeta、onDelta、onDone 和 onError。
   */
  async askCampusAIStream(question, handlers = {}, options = {}) {
    if (!this.isConfigured()) throw new Error('校园助手后端尚未配置');
    if (window.location.protocol === 'file:') {
      throw new Error('当前页面是本地文件模式，浏览器会阻止 AI 请求。请使用项目中的本地预览服务');
    }
    if (!window.AIStream?.consumeResponse) {
      const result = await this.askCampusAI(question, options);
      handlers.onMeta?.(result);
      if (result.answer) handlers.onDelta?.(result.answer, result.answer);
      handlers.onDone?.(result, result.answer || '');
      return result;
    }

    const endpoint = `${SUPABASE_CONFIG.url}/functions/v1/campus-ai`;
    const controller = new AbortController();
    const externalSignal = options.signal;
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 70000);

    try {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_CONFIG.anonKey,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
          },
          body: JSON.stringify({
            question: String(question || '').trim(),
            clientId: this.getAnonymousId(),
            stream: true,
            context: Array.isArray(options.context) ? options.context : [],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (externalSignal?.aborted && !timedOut) throw error;
          throw new Error('校园助手响应超时，请稍后重试');
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new Error('当前设备处于离线状态，请联网后重试');
        }
        throw new Error('浏览器无法访问校园助手服务。请检查网络代理、防火墙或浏览器拦截扩展后重试');
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (!contentType.includes('text/event-stream')) {
        let payload = {};
        try { payload = await response.json(); }
        catch (error) { throw new Error('校园助手返回了无法识别的响应'); }
        if (!response.ok) {
          const requestError = new Error(payload.error || '校园助手暂时不可用');
          requestError.status = response.status;
          requestError.resetAt = payload.resetAt || null;
          throw requestError;
        }
        if (payload.noMatch === true) return payload;
        handlers.onMeta?.(payload);
        if (payload.answer) handlers.onDelta?.(payload.answer, payload.answer);
        handlers.onDone?.(payload, payload.answer || '');
        return payload;
      }

      if (!response.ok) throw new Error('校园助手暂时不可用');
      return await window.AIStream.consumeResponse(response, handlers);
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  },

  // ==========================================
  // 站点配置 (Site Settings)
  // ==========================================

  /**
   * 读取站点配置项
   * @param {string} key 配置键（如 crawl_paused）
   * @param {string} fallback 缺省值
   */
  async getSiteSetting(key) {
    if (!this.isConfigured() || !supabaseClient) throw new Error('未配置 Supabase');
    const { data, error } = await supabaseClient.from('site_settings').select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    if (!['true', 'false'].includes(data?.value)) throw new Error('缺少有效的抓取暂停配置');
    return data.value;
  },

  /**
   * 写入站点配置项（不存在则插入，存在则更新）
   * @param {string} key 配置键
   * @param {string} value 配置值
   */
  async setSiteSetting(key, value) {
    if (!this.isConfigured() || !supabaseClient) {
      throw new Error('请先配置 Supabase 后端凭证');
    }
    const now = new Date().toISOString();
    const { error } = await supabaseClient
      .from('site_settings')
      .upsert({ key, value, updated_at: now }, { onConflict: 'key' });
    if (error) throw error;
    return true;
  },
};

// 挂载到全局
if (typeof window !== 'undefined') {
  window.Api = Api;
}
