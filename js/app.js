// 山商信息通 · GitBook 知识库架构交互逻辑
(function () {
  const catMap = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  let currentSlug = 'xinsheng-baodao'; // 默认当前选中第一篇
  let currentCat = 'report';
  let query = '';
  let expandedCats = new Set(['report']); // 默认展开第一个分类
  let dynamicItems = []; // 后台审核发布到常规分类的动态内容（异步拉取后合并渲染）

  // DOM 节点引用
  const treeNavEl = document.getElementById('tree-nav');
  const docArticleEl = document.getElementById('doc-article');
  const emptyStateEl = document.getElementById('empty-state');
  const officialLinksGrid = document.getElementById('official-links-grid');
  const searchInput = document.getElementById('search');
  const userArea = document.getElementById('user-area');
  const commentFeedEl = document.getElementById('sidebar-comment-feed');
  const commentCountBadge = document.getElementById('sidebar-comment-count');
  const commentInputEl = document.getElementById('comment-input');

  // ---------- 基础工具函数 ----------
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function priClass(p) {
    if (p === '高') return 'pri-high';
    if (p === '中') return 'pri-mid';
    return 'pri-low';
  }

  window.scrollToOfficialLinks = function () {
    const sec = document.getElementById('official-channels-section');
    if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  };

  // ---------- 模态框控制 ----------
  window.showModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
  };

  window.hideModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  };

  window.openFeedbackModal = function (slug, title) {
    document.getElementById('fb-slug').value = slug;
    document.getElementById('fb-item-title').textContent = title;
    document.getElementById('fb-desc').value = '';
    document.getElementById('fb-contact').value = '';
    const msgEl = document.getElementById('fb-msg');
    if (msgEl) {
      msgEl.textContent = '';
      msgEl.className = 'form-msg';
    }
    showModal('modal-feedback');
  };

  // ---------- 匿名昵称模式（v2 · 不收集个人信息） ----------
  // 无注册、无登录；昵称仅存本机 localStorage，浏览器匿名 ID 用于点赞去重。

  function initAuth() {
    renderUserArea();
  }

  function getUserDisplayName() {
    if (window.Api) return window.Api.getNickname();
    try {
      return localStorage.getItem('sdtbu_nickname') || '匿名同学';
    } catch (e) {
      return '匿名同学';
    }
  }

  function renderUserArea() {
    if (!userArea) return;
    const name = getUserDisplayName();
    userArea.innerHTML = `
      <div class="user-badge">
        <span>👤 ${esc(name)}</span>
        <button class="btn btn-outline btn-sm" onclick="showAuthModal()">改昵称</button>
      </div>`;
  }

  window.showAuthModal = function () {
    const input = document.getElementById('auth-nickname');
    if (input) input.value = getUserDisplayName() === '匿名同学' ? '' : getUserDisplayName();
    const msgEl = document.getElementById('auth-msg');
    if (msgEl) {
      msgEl.textContent = '';
      msgEl.className = 'form-msg';
    }
    showModal('modal-auth');
  };

  window.switchAuthTab = function () {};

  window.handleAuthSubmit = async function () {
    const nickname = document.getElementById('auth-nickname').value.trim();
    const msgEl = document.getElementById('auth-msg');
    const btn = document.getElementById('btn-do-auth');
    const agreeEl = document.getElementById('auth-agree');

    if (!agreeEl || !agreeEl.checked) {
      msgEl.textContent = '请先阅读并勾选同意《用户协议》与《隐私政策》';
      msgEl.className = 'form-msg error';
      return;
    }

    try {
      btn.disabled = true;
      const saved = window.Api.setNickname(nickname);
      renderUserArea();
      msgEl.textContent = `昵称已保存：${saved}（仅存于本机）`;
      msgEl.className = 'form-msg success';

      setTimeout(() => {
        hideModal('modal-auth');
        loadLikes(currentSlug);
        loadComments(currentSlug);
      }, 800);
    } catch (err) {
      msgEl.textContent = err.message || '操作失败，请重试';
      msgEl.className = 'form-msg error';
    } finally {
      btn.disabled = false;
    }
  };

  window.handleLogout = function () {};

  // ---------- 纠错与投稿 ----------
  window.handleFeedbackSubmit = async function () {
    const slug = document.getElementById('fb-slug').value;
    const issueType = document.getElementById('fb-type').value;
    const description = document.getElementById('fb-desc').value.trim();
    const contact = document.getElementById('fb-contact').value.trim();
    const msgEl = document.getElementById('fb-msg');
    const btn = document.getElementById('btn-do-feedback');

    if (!description) {
      msgEl.textContent = '请填写具体的纠错描述';
      msgEl.className = 'form-msg error';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = '正在提交...';
      await window.Api.submitFeedback({
        slug,
        issueType,
        description,
        contact,
        userId: null,
      });

      msgEl.textContent = '感谢您的反馈！我们会尽快核实并更新。';
      msgEl.className = 'form-msg success';
      setTimeout(() => hideModal('modal-feedback'), 1500);
    } catch (err) {
      msgEl.textContent = err.message || '提交失败，请重试';
      msgEl.className = 'form-msg error';
    } finally {
      btn.disabled = false;
      btn.textContent = '提交反馈';
    }
  };

  window.handlePostSubmit = async function () {
    const cat = document.getElementById('post-cat').value;
    const title = document.getElementById('post-title').value.trim();
    const summary = document.getElementById('post-summary').value.trim();
    const content = document.getElementById('post-content').value.trim();
    const sourceUrl = document.getElementById('post-url').value.trim();
    const msgEl = document.getElementById('post-msg');
    const btn = document.getElementById('btn-do-post');

    if (!title || !content) {
      msgEl.textContent = '事项标题和详细内容为必填项';
      msgEl.className = 'form-msg error';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = '正在提交...';
      await window.Api.submitArticle({
        cat,
        title,
        summary,
        content,
        sourceUrl,
        userId: null,
        authorName: getUserDisplayName(),
      });

      msgEl.textContent = '投稿成功！内容进入待审池，审核通过后将展示在知识库中。';
      msgEl.className = 'form-msg success';
      setTimeout(() => hideModal('modal-submit'), 1800);
    } catch (err) {
      msgEl.textContent = err.message || '提交失败，请重试';
      msgEl.className = 'form-msg error';
    } finally {
      btn.disabled = false;
      btn.textContent = '提交审核';
    }
  };

  // ---------- 1. 树形目录渲染 (Sidebar Tree View) ----------
  function toggleGroup(catId) {
    if (expandedCats.has(catId)) {
      expandedCats.delete(catId);
    } else {
      expandedCats.add(catId);
    }
    renderTreeSidebar();
  }

  function renderTreeSidebar() {
    if (!treeNavEl) return;

    let html = '';
    CATEGORIES.forEach((cat) => {
      // 过滤当前搜索条件下的条目（合并静态 ITEMS + 后台审核发布的动态条目）
      const catItems = [...ITEMS, ...dynamicItems].filter((item) => {
        if (item.cat !== cat.id) return false;
        if (!query) return true;
        const hay = [item.title, item.summary, item.dept, item.object].join(' ').toLowerCase();
        return hay.includes(query.toLowerCase());
      });

      if (query && catItems.length === 0) return; // 搜索时隐藏无匹配项的目录组

      const isExpanded = expandedCats.has(cat.id) || !!query;
      const count = catItems.length;

      const childrenHtml = catItems
        .map((item) => {
          const isActive = item.slug === currentSlug && currentCat !== 'news';
          const isDynamic = item.isDynamic;
          return `
            <a class="tree-item ${isActive ? 'active' : ''}" href="#/section/${cat.id}/item/${item.slug}" data-slug="${item.slug}">
              <span class="tree-item-dot" style="${isDynamic ? 'background:var(--brand); width:6px; height:6px;' : ''}"></span>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(item.title)}${isDynamic ? ' <span style="color:var(--accent); font-weight:600;">· NEW</span>' : ''}</span>
            </a>`;
        })
        .join('');

      html += `
        <div class="tree-group ${isExpanded ? 'expanded' : ''}" data-cat="${cat.id}">
          <div class="tree-parent" onclick="window._toggleTree('${cat.id}')">
            <div class="tree-parent-left">
              <span class="tree-arrow">▶</span>
              <span>${esc(cat.name)}</span>
            </div>
            <span class="tree-badge">${count}</span>
          </div>
          <div class="tree-children">
            ${childrenHtml}
          </div>
        </div>`;
    });

    // 在目录最下方添加独立条目【今日最新消息】（不隶属于任何分类）
    const isNewsActive = currentCat === 'news';
    html += `
      <div class="tree-bottom-divider"></div>
      <a class="tree-standalone-item ${isNewsActive ? 'active' : ''}" href="#/news" title="查看后台审核通过的官方自动更新资讯">
        <div style="display:flex; align-items:center; gap:8px;">
          <span>📢</span>
          <span>今日最新消息</span>
        </div>
        <span class="tree-badge" style="${isNewsActive ? 'background:rgba(255,255,255,0.25);color:#fff;' : 'background:#fff1eb;color:#fa541c;border-color:#ffd8bf;'}">NEW</span>
      </a>
    `;

    treeNavEl.innerHTML = html;
  }

  window._toggleTree = function (catId) {
    toggleGroup(catId);
  };

  // ---------- 2. 中间栏主正文渲染 (GitBook 知识块排版) ----------
  async function renderNewsFeedView() {
    if (!docArticleEl) return;
    docArticleEl.style.display = 'block';
    if (emptyStateEl) emptyStateEl.style.display = 'none';

    // 渲染骨架加载态
    docArticleEl.innerHTML = `
      <!-- 面包屑 -->
      <nav class="breadcrumb">
        <a href="#/">知识库</a>
        <span class="sep">/</span>
        <span style="color:var(--text); font-weight:500;">今日最新消息</span>
      </nav>

      <!-- 文档头 -->
      <div class="doc-header">
        <h1 class="doc-title">📢 今日最新消息 · 官方通知速递</h1>
        <div class="doc-meta-row">
          <span class="tag pri-high">24小时动态轮转</span>
          <span class="tag tag-dept">全校各部门直通</span>
          <span class="tag" style="background:var(--ok-soft); color:var(--ok); border-color:#a7f3d0;">后台已人工审核</span>
          <span>每 6 小时自动巡检</span>
        </div>
      </div>

      <!-- Callout 核心摘要 -->
      <div class="callout-summary">
        <div class="callout-title">💡 动态速递说明</div>
        <div class="callout-body">
          此处汇聚由自动化爬虫从学校官网、教务处、学生处等渠道抓取并经<b>管理员人工审核放行</b>的最新官方通告。为保证资讯时效性，发布在【今日最新消息】的内容<b>在 24 小时后将自动下架轮转</b>。如需按类别查阅完整长效政策，请点击左侧场景目录。
        </div>
      </div>

      <h2 class="section-h2">已审核通过的最新通告</h2>
      <div id="news-feed-list" class="news-feed-container">
        <div style="text-align:center; padding:40px 0; color:var(--text-muted); font-size:13px;">
          正在拉取今日最新审核资讯...
        </div>
      </div>
    `;

    const feedContainer = document.getElementById('news-feed-list');

    try {
      let feeds = [];
      if (window.Api && window.Api.isConfigured()) {
        feeds = await window.Api.getPublishedFeeds('news', 30);
      }

      if (!feeds || feeds.length === 0) {
        if (feedContainer) {
          feedContainer.innerHTML = `
            <div style="background:var(--sidebar-bg); border:1px dashed var(--border); border-radius:8px; padding:36px 20px; text-align:center;">
              <p style="font-size:24px; margin-bottom:8px;">📭</p>
              <p style="font-size:13.5px; font-weight:600; color:var(--text);">今日暂无新审核发布的通知</p>
              <p style="font-size:12px; color:var(--text-3); margin-top:4px;">后台抓取池每 6 小时自动巡检官网，有最新通知经审核后会在此第一时间呈现。</p>
            </div>
          `;
        }
        return;
      }

      if (feedContainer) {
        feedContainer.innerHTML = feeds
          .map((f) => `
            <div class="news-card">
              <div class="news-card-head">
                <span class="tag tag-dept">🏛️ ${esc(f.source_name || f.source || '官方发布')}</span>
                <span style="font-size:11px; color:var(--text-muted);">${f.pub_date || '近期发布'}</span>
              </div>
              <h3 class="news-card-title">${esc(f.title)}</h3>
              ${f.summary ? `<div class="news-card-summary">${esc(f.summary)}</div>` : ''}
              <div class="news-card-foot">
                <span>审核发布于 ${new Date(f.published_at || f.created_at).toLocaleDateString()}</span>
                <a href="${esc(f.source_url || f.link || '#')}" target="_blank" rel="noopener" style="font-weight:500; font-size:12px;">
                  查看官方通知原文 ↗
                </a>
              </div>
            </div>
          `)
          .join('');
      }
    } catch (err) {
      if (feedContainer) {
        feedContainer.innerHTML = `<div style="color:var(--pri-high); text-align:center; padding:20px 0;">拉取动态失败：${esc(err.message)}</div>`;
      }
    }
  }

  function renderMainContent(item) {
    if (!docArticleEl) return;

    if (currentCat === 'news') {
      renderNewsFeedView();
      return;
    }

    if (!item) {
      docArticleEl.style.display = 'none';
      if (emptyStateEl) emptyStateEl.style.display = 'block';
      return;
    }

    docArticleEl.style.display = 'block';
    if (emptyStateEl) emptyStateEl.style.display = 'none';

    const c = catMap[item.cat] || { name: item.cat };

    // 步骤卡片流
    let stepsHtml = '';
    if (item.steps && item.steps.length) {
      const stepItems = item.steps
        .map((s, idx) => `
          <div class="step-card">
            <span class="step-num">${idx + 1}</span>
            <span>${esc(s)}</span>
          </div>`)
        .join('');
      stepsHtml = `
        <h2 class="section-h2">办理流程与具体步骤</h2>
        <div class="steps-list">${stepItems}</div>`;
    }

    // 数据表
    let tableHtml = '';
    if (item.table && item.table.rows) {
      const ths = (item.table.headers || []).map((h) => `<th>${esc(h)}</th>`).join('');
      const trs = item.table.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
        .join('');
      const tableTitle = (item.table.title || '').trim() || '相关数据与明细标准';
      tableHtml = `
        <h2 class="section-h2">${esc(tableTitle)}</h2>
        <table class="meta-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>${trs}</tbody>
        </table>`;
    }

    // 结构化正文 Sections
    let sectionsHtml = '';
    if (item.sections && item.sections.length) {
      sectionsHtml = item.sections
        .map((sec, idx) => {
          const inner = [];
          if (sec.lead) inner.push(`<p style="font-size:13px; color:var(--text); font-weight:500;">${esc(sec.lead)}</p>`);
          if (sec.body) inner.push(`<p style="font-size:13px; color:var(--text-2); line-height:1.65;">${esc(sec.body)}</p>`);
          if (sec.bullet && sec.bullet.length) {
            inner.push(`<ul style="font-size:13px; color:var(--text-2); padding-left:20px;">${sec.bullet.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
          }
          return `
            <h2 class="section-h2">${esc(sec.title || '要点说明 ' + (idx + 1))}</h2>
            <div>${inner.join('')}</div>`;
        })
        .join('');
    } else if (item.body) {
      sectionsHtml = `
        <h2 class="section-h2">政策详细解读</h2>
        <p style="font-size:13.5px; color:var(--text-2); line-height:1.7;">${esc(item.body)}</p>`;
    }

    // 键值属性表 (KV Table) — 值为空或「—」的行自动隐藏
    const isEmpty = (v) => {
      if (v === null || v === undefined) return true;
      const s = String(v).trim();
      return s === '' || s === '—' || s === '-';
    };

    const metaList = [
      ['适用对象', item.object],
      ['关键时间', item.time],
      ['负责部门', item.dept],
      ['联系电话', item.phone ? `<a href="tel:${esc(item.phone)}">${esc(item.phone)}</a>` : '—'],
      ['办理地点', item.place || '—'],
      ['所需材料', item.material || '—'],
    ];

    const metaRows = metaList
      .filter(([, v]) => !isEmpty(v))
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join('');

    // 是否包含「办理地点 / 所需材料」（用于 KV 表标题自适应）
    const hasPlaceOrMaterial = !isEmpty(item.place) || !isEmpty(item.material);

    // 注意事项 Warning Box
    const notesHtml = item.notes
      ? `<div class="warning-box"><b>⚠️ 注意事项与提示：</b>${esc(item.notes)}</div>`
      : '';

    docArticleEl.innerHTML = `
      <!-- 面包屑 -->
      <nav class="breadcrumb">
        <a href="#/section/${esc(item.cat)}">${esc(c.name)}</a>
        <span class="sep">/</span>
        <span style="color:var(--text); font-weight:500;">${esc(item.title)}</span>
      </nav>

      <!-- 文档头 -->
      <div class="doc-header">
        <h1 class="doc-title">${esc(item.title)}</h1>
        <div class="doc-meta-row">
          <span class="tag ${priClass(item.priority)}">${esc(item.priority)}优先级</span>
          <span class="tag tag-dept">${esc(item.dept || '学校职能部门')}</span>
          <span class="tag" style="background:var(--ok-soft); color:var(--ok); border-color:#a7f3d0;">已核实</span>
          <span>${item.date ? '发布于 ' + esc(item.date) : '以官方最新通知为准'}</span>
        </div>
      </div>

      <!-- Callout 核心摘要 -->
      <div class="callout-summary">
        <div class="callout-title">💡 政策核心摘要</div>
        <div class="callout-body">${esc(item.summary)}</div>
      </div>

      <!-- 办理流程 -->
      ${stepsHtml}

      <!-- 数据表 -->
      ${tableHtml}

      <!-- 详细解读 -->
      ${sectionsHtml}

      <!-- 办事材料与联系方式表格 -->
      <h2 class="section-h2">${hasPlaceOrMaterial ? '办事凭证与联系信息' : '关键信息与联系部门'}</h2>
      <table class="meta-table">
        <tbody>${metaRows}</tbody>
      </table>

      <!-- 注意事项 -->
      ${notesHtml}

      <!-- 底部互动与纠错反馈条 -->
      <div class="doc-footer-action">
        <button class="btn-like" id="btn-like-${esc(item.slug)}" onclick="handleLikeClick('${esc(item.slug)}')">
          ❤️ 政策有用 (<span id="like-count-${esc(item.slug)}">0</span>)
        </button>
        <div style="display:flex; align-items:center; gap:12px;">
          <a href="${esc(item.url)}" target="_blank" rel="noopener" style="font-size:12px; color:var(--text-3);">
            查看官方原文 ↗
          </a>
          <button class="btn btn-outline btn-sm" onclick="openFeedbackModal('${esc(item.slug)}', '${esc(item.title)}')">
            🚩 纠错与失效反馈
          </button>
        </div>
      </div>
    `;

    // 重新拉取当前事项的点赞数据
    loadLikes(item.slug);
  }

  // ---------- 3. 右侧栏评论与避坑互动联动 ----------
  async function loadLikes(slug) {
    if (!window.Api || !window.Api.isConfigured()) return;
    const { count, hasLiked } = await window.Api.getLikes(slug);
    const btn = document.getElementById('btn-like-' + slug);
    const countEl = document.getElementById('like-count-' + slug);
    if (btn && countEl) {
      countEl.textContent = count;
      if (hasLiked) btn.classList.add('liked');
      else btn.classList.remove('liked');
    }
  }

  async function loadComments(slug) {
    if (!commentFeedEl) return;

    if (!window.Api || !window.Api.isConfigured()) {
      commentFeedEl.innerHTML = `
        <div style="font-size:12px; color:var(--text-muted); text-align:center; padding:30px 10px;">
          暂未配置云端存储，配置 Supabase 后即可开启实时避坑交流。
        </div>`;
      if (commentCountBadge) commentCountBadge.textContent = '0条';
      return;
    }

    try {
      const comments = await window.Api.getComments(slug);
      if (commentCountBadge) {
        commentCountBadge.textContent = `${comments.length}条`;
      }

      if (!comments.length) {
        commentFeedEl.innerHTML = `
          <div style="font-size:12px; color:var(--text-muted); text-align:center; padding:30px 10px; background:var(--sidebar-bg); border-radius:6px; border:1px dashed var(--border);">
            暂无同学避坑留言，来发表第一条经验或提问吧～
          </div>`;
        return;
      }

      commentFeedEl.innerHTML = comments
        .map((c) => {
          const avatarChar = (c.user_name || '学').slice(0, 1);
          const repliesHtml = (c.replies && c.replies.length > 0)
            ? `<div class="comment-replies">
                ${c.replies.map((r) => `
                  <div class="reply-item">
                    <span class="reply-user">${esc(r.user_name)}</span>
                    ${r.reply_to_name ? `<span style="color:var(--text-muted);">回复 @${esc(r.reply_to_name)}</span>` : ''}：
                    <span>${esc(r.content)}</span>
                  </div>
                `).join('')}
              </div>`
            : '';

          return `
            <div class="comment-card" id="comment-${c.id}">
              <div class="comment-user-row">
                <div class="comment-avatar">${esc(avatarChar)}</div>
                <span class="comment-username">${esc(c.user_name)}</span>
                <span class="comment-time">${new Date(c.created_at).toLocaleDateString()}</span>
              </div>
              <div class="comment-body-text">${esc(c.content)}</div>
              <div class="comment-actions">
                <button class="comment-act-btn ${c.has_liked ? 'liked' : ''}" id="btn-c-like-${c.id}" onclick="handleCommentLike('${c.id}', '${slug}')">
                  👍 <span id="c-like-cnt-${c.id}">${c.like_count || 0}</span>
                </button>
                <button class="comment-act-btn" onclick="toggleReplyBox('${c.id}', '${esc(c.user_name)}')">
                  💬 回复
                </button>
              </div>

              <!-- 行内回复框 -->
              <div class="inline-reply-box" id="reply-box-${c.id}" style="display:none; margin-top:8px;">
                <textarea id="reply-input-${c.id}" rows="2" style="width:100%; font-size:12px; padding:6px; border:1px solid var(--border); border-radius:4px;" placeholder="写下你的回复..."></textarea>
                <div style="display:flex; justify-content:flex-end; gap:6px; margin-top:4px;">
                  <button class="btn btn-outline btn-sm" onclick="toggleReplyBox('${c.id}')">取消</button>
                  <button class="btn btn-primary btn-sm" id="btn-send-reply-${c.id}" onclick="handleReplySubmit('${slug}', '${c.id}', '${esc(c.user_name)}')">发送</button>
                </div>
              </div>

              <!-- 嵌套子回复 -->
              ${repliesHtml}
            </div>`;
        })
        .join('');
    } catch (err) {
      console.error('加载评论失败', err);
      commentFeedEl.innerHTML = `<div style="font-size:12px; color:var(--pri-high); text-align:center;">评论加载失败</div>`;
    }
  }

  // 提交主评论（匿名模式：免登录）
  window.handleCurrentCommentSubmit = async function () {
    if (!commentInputEl) return;
    const content = commentInputEl.value.trim();
    if (!content) return;

    const btn = document.getElementById('btn-post-comment');
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中...';
      }

      const userName = getUserDisplayName();
      await window.Api.postComment(currentSlug, userName, content);
      commentInputEl.value = '';

      // 重新加载评论列表
      loadComments(currentSlug);
    } catch (err) {
      alert(err.message || '发表失败，请重试');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '发表';
      }
    }
  };

  window.handleLikeClick = async function (slug) {
    try {
      const btn = document.getElementById('btn-like-' + slug);
      const res = await window.Api.toggleLike(slug);
      const countEl = document.getElementById('like-count-' + slug);
      let count = parseInt(countEl.textContent || '0', 10);

      if (res.action === 'liked') {
        if (btn) btn.classList.add('liked');
        if (countEl) countEl.textContent = count + 1;
      } else {
        if (btn) btn.classList.remove('liked');
        if (countEl) countEl.textContent = Math.max(0, count - 1);
      }
    } catch (err) {
      alert(err.message || '点赞失败');
    }
  };

  window.handleCommentLike = async function (commentId, slug) {
    try {
      const btn = document.getElementById('btn-c-like-' + commentId);
      const countEl = document.getElementById('c-like-cnt-' + commentId);
      const res = await window.Api.toggleCommentLike(commentId);
      let count = parseInt(countEl.textContent || '0', 10);

      if (res.action === 'liked') {
        if (btn) btn.classList.add('liked');
        if (countEl) countEl.textContent = count + 1;
      } else {
        if (btn) btn.classList.remove('liked');
        if (countEl) countEl.textContent = Math.max(0, count - 1);
      }
    } catch (err) {
      alert(err.message || '评论点赞失败');
    }
  };

  window.toggleReplyBox = function (commentId, targetUserName) {
    const box = document.getElementById('reply-box-' + commentId);
    if (!box) return;

    const isHidden = box.style.display === 'none' || !box.style.display;
    document.querySelectorAll('.inline-reply-box').forEach((el) => {
      el.style.display = 'none';
    });

    if (isHidden) {
      box.style.display = 'block';
      const input = document.getElementById('reply-input-' + commentId);
      if (input) {
        input.placeholder = `回复 @${targetUserName} ...`;
        input.focus();
      }
    } else {
      box.style.display = 'none';
    }
  };

  window.handleReplySubmit = async function (slug, parentId, targetUserName) {
    const input = document.getElementById('reply-input-' + parentId);
    const content = input.value.trim();
    if (!content) {
      alert('回复内容不能为空');
      return;
    }

    const btn = document.getElementById('btn-send-reply-' + parentId);
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中...';
      }
      const userName = getUserDisplayName();
      await window.Api.postComment(slug, userName, content, parentId, targetUserName);
      input.value = '';
      const box = document.getElementById('reply-box-' + parentId);
      if (box) box.style.display = 'none';

      loadComments(slug);
    } catch (err) {
      alert(err.message || '回复失败');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '发送';
      }
    }
  };

  // ---------- 4. 官方渠道卡片渲染 ----------
  function renderOfficialLinks() {
    if (!officialLinksGrid) return;
    officialLinksGrid.innerHTML = LINKS.map(
      (l) => `
      <a class="link-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <span class="link-name">${esc(l.name)}</span>
        <span class="link-url">${esc(l.url.replace(/^https?:\/\//, ''))} ↗</span>
      </a>`
    ).join('');
  }

  // ---------- 5. Hash 路由与选中文档定位 ----------
  function syncRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/');

    let foundItem = null;

    if (raw === 'news' || parts[0] === 'news') {
      // 路由命中 #/news【今日最新消息】
      currentCat = 'news';
      currentSlug = 'news';
      renderTreeSidebar();
      renderMainContent(null);
      loadComments('news');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (parts[0] === 'section' && parts[1]) {
      currentCat = parts[1];
      expandedCats.add(currentCat);
      if (parts[2] === 'item' && parts[3]) {
        currentSlug = parts[3];
        foundItem = [...ITEMS, ...dynamicItems].find((i) => i.slug === currentSlug);
      } else {
        // 如果只选了分类，默认打开该分类下第一个事项（含动态条目）
        foundItem = [...ITEMS, ...dynamicItems].find((i) => i.cat === currentCat);
        if (foundItem) currentSlug = foundItem.slug;
      }
    } else if (raw) {
      // 尝试直接匹配 slug（含动态条目）
      foundItem = [...ITEMS, ...dynamicItems].find((i) => i.slug === raw);
      if (foundItem) {
        currentSlug = foundItem.slug;
        currentCat = foundItem.cat;
        expandedCats.add(currentCat);
      }
    }

    if (!foundItem) {
      // 兜底打开第一个条目
      foundItem = ITEMS[0];
      if (foundItem) {
        currentSlug = foundItem.slug;
        currentCat = foundItem.cat;
        expandedCats.add(currentCat);
      }
    }

    renderTreeSidebar();
    renderMainContent(foundItem);
    loadComments(currentSlug);

    // 滚动到正文顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- 6. 全局搜索与快捷键绑定 ----------
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      query = e.target.value.trim();
      renderTreeSidebar();

      // 如果有搜索结果，自动展开所有分类并选中第一个匹配项（含动态条目）
      if (query) {
        const matched = [...ITEMS, ...dynamicItems].filter((item) => {
          const hay = [item.title, item.summary, item.dept, item.object].join(' ').toLowerCase();
          return hay.includes(query.toLowerCase());
        });
        if (matched.length > 0) {
          currentSlug = matched[0].slug;
          currentCat = matched[0].cat;
          expandedCats.add(currentCat);
          renderMainContent(matched[0]);
          loadComments(currentSlug);
        } else {
          renderMainContent(null);
        }
      } else {
        syncRoute();
      }
    });
  }

  // ---------- 6.5 动态内容拉取（后台审核发布到常规分类的实时合并） ----------
  async function loadDynamicItems() {
    if (!window.Api || !window.Api.isConfigured()) return;
    try {
      const feeds = await window.Api.getPublishedFeeds('all', 100);
      // 过滤出存在有效分类的已发布内容（news 已经单独在今日最新消息展示）
      const validCats = new Set(CATEGORIES.map((c) => c.id));
      dynamicItems = (feeds || [])
        .filter((f) => f.cat && validCats.has(f.cat))
        .map((f) => window.Api.feedToItem(f));
      renderTreeSidebar();
      // 若当前正是动态条目，则重新渲染正文
      if (currentSlug && dynamicItems.some((i) => i.slug === currentSlug)) {
        const cur = dynamicItems.find((i) => i.slug === currentSlug);
        renderMainContent(cur);
      }
    } catch (err) {
      console.warn('拉取动态分类内容失败:', err);
    }
  }

  // 快捷键 Ctrl + K 唤起搜索框
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
  });

  // ---------- 7. 初始化启动 ----------
  window.addEventListener('hashchange', syncRoute);

  renderOfficialLinks();
  initAuth();
  loadDynamicItems(); // 拉取后台发布的动态分类内容
  syncRoute();
})();
