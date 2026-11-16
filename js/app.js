// 山商信息通 · 移动端四板块应用
(function () {
  'use strict';

  const catMap = Object.fromEntries(CATEGORIES.map((category) => [category.id, category]));
  const catMarks = { report: '新', roll: '籍', course: '课', aid: '助', exam: '考', dorm: '舍', campus: '校', league: '创', grad: '毕' };
  const categoryIcons = {
    report: 'icon-entry', roll: 'icon-id-card', course: 'icon-info',
    aid: 'icon-aid', exam: 'icon-exam', dorm: 'icon-bed',
    campus: 'icon-campus', league: 'icon-idea', grad: 'icon-graduation',
  };
  const pageNames = new Set(['ai', 'info', 'news', 'me']);
  const scrollPositions = { ai: 0, info: 0, news: 0, me: 0 };

  let activePage = 'ai';
  let currentSlug = '';
  let selectedCategory = 'all';
  let searchQuery = '';
  let dynamicItems = [];
  let newsFeeds = [];
  let newsStatus = 'idle';
  let newsFilter = 'all';
  const dialogSessions = new WeakMap();

  const pages = [...document.querySelectorAll('.app-page')];
  const navItems = [...document.querySelectorAll('[data-nav]')];
  const newsNav = document.querySelector('[data-nav="news"]');
  const main = document.getElementById('app-viewport');
  const categoryGrid = document.getElementById('category-grid');
  const infoList = document.getElementById('info-card-list');
  const infoHome = document.getElementById('info-home');
  const infoDetail = document.getElementById('info-detail');
  const infoListTitle = document.getElementById('info-list-title');
  const infoResultCount = document.getElementById('info-result-count');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search');
  const clearSearchButton = document.getElementById('clear-info-search');
  const newsList = document.getElementById('news-list');
  const newsStatusPanel = document.getElementById('news-status');
  const newsStatusText = document.getElementById('news-status-text');
  const retryNewsButton = document.getElementById('retry-news');
  const markNewsReadButton = document.getElementById('mark-news-read');
  const newsFilters = document.getElementById('news-filters');
  const newsFilterButtons = [...newsFilters.querySelectorAll('[data-filter]')];
  const postDialog = document.getElementById('modal-submit');
  const feedbackDialog = document.getElementById('modal-feedback');
  const postFields = [...postDialog.querySelectorAll('input, select, textarea')];
  const requiredPostFields = [...postDialog.querySelectorAll('[required]')];
  let savedPostValues = postFields.map((field) => field.value);
  const docArticle = document.getElementById('doc-article');
  const commentFeed = document.getElementById('sidebar-comment-feed');
  const commentCount = document.getElementById('sidebar-comment-count');
  const commentInput = document.getElementById('comment-input');
  const bookmarkButton = document.getElementById('detail-bookmark');

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    if (!value || String(value).trim() === '#') return '';
    try {
      const url = new URL(String(value || ''), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function storageRead(key, fallback = []) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch (error) {
      return fallback;
    }
  }

  function storageWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {}
  }

  function allItems() {
    return [...ITEMS, ...dynamicItems];
  }

  function getNickname() {
    if (window.Api) return window.Api.getNickname();
    try { return localStorage.getItem('sdtbu_nickname') || '匿名同学'; } catch (error) { return '匿名同学'; }
  }

  function switchPage(page, restoreScroll = true) {
    const nextPage = pageNames.has(page) ? page : 'ai';
    if (activePage !== nextPage) scrollPositions[activePage] = window.scrollY;
    activePage = nextPage;
    document.body.dataset.currentPage = activePage;

    pages.forEach((section) => {
      const isActive = section.dataset.page === activePage;
      section.hidden = !isActive;
      section.classList.toggle('is-active', isActive);
    });
    navItems.forEach((item) => {
      const isActive = item.dataset.nav === activePage;
      item.classList.toggle('is-active', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });

    if (activePage === 'me') renderMyPage();
    if (activePage === 'news') renderNews();
    requestAnimationFrame(() => window.scrollTo({ top: restoreScroll ? scrollPositions[activePage] || 0 : 0, behavior: 'auto' }));
  }

  function renderCategoryGrid() {
    if (!categoryGrid) return;
    // 分类按钮只创建一次，筛选和加载数据时保留原来的键盘焦点。
    if (!categoryGrid.firstElementChild) {
      categoryGrid.innerHTML = CATEGORIES.map((category) => `<button type="button" class="category-card" data-category="${esc(category.id)}">
        <span class="category-mark" aria-hidden="true"><svg><use href="#${esc(categoryIcons[category.id] || 'icon-campus')}"></use></svg></span>
        <b>${esc(category.name)}</b><small></small>
      </button>`).join('');
    }
    const counts = new Map();
    for (const { cat } of allItems()) counts.set(cat, (counts.get(cat) || 0) + 1);
    for (const button of categoryGrid.children) {
      const category = button.dataset.category;
      const active = category === selectedCategory;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('small').textContent = `${counts.get(category) || 0} 项`;
    }
  }

  function renderInfoList() {
    if (!infoList) return;
    const cleanQuery = searchQuery.toLowerCase();
    const titleMatches = (item) => String(item.title ?? '').toLowerCase().includes(cleanQuery);
    const items = allItems().filter((item) => {
      if (selectedCategory !== 'all' && item.cat !== selectedCategory) return false;
      if (!cleanQuery) return true;
      return [item.title, item.summary, item.dept, item.object, item.material]
        .join(' ').toLowerCase().includes(cleanQuery);
    });
    // 标题直接命中的事项先显示，同一组保留原来的顺序。
    if (cleanQuery) items.sort((a, b) => Number(titleMatches(b)) - Number(titleMatches(a)));
    infoHome.classList.toggle('is-searching', Boolean(cleanQuery));
    clearSearchButton.hidden = !searchInput.value;

    const selected = catMap[selectedCategory];
    infoListTitle.textContent = searchQuery ? '搜索结果' : selected ? selected.name : '常用事项';
    infoResultCount.textContent = `${items.length} 项`;
    emptyState.hidden = items.length > 0;
    if (!items.length) {
      emptyState.querySelector('p').textContent = cleanQuery
        ? '换一个关键词，或清空搜索后按分类查找。'
        : '点击上方分类继续浏览。';
    }
    infoList.hidden = items.length === 0;

    infoList.innerHTML = items.map((item) => {
      const category = catMap[item.cat] || { name: '校园信息' };
      return `<a class="info-card" href="#/info/${encodeURIComponent(item.slug)}">
        <span class="info-card-mark">${esc(catMarks[item.cat] || '校')}</span>
        <span class="info-card-copy"><b>${esc(item.title)}${item.isDynamic ? '<span class="fresh-label">新</span>' : ''}</b><small>${esc(item.summary || item.object || '查看事项详情')}</small><em>${esc(category.name)} · ${esc(item.dept || '学校职能部门')}</em></span>
        <svg><use href="#icon-arrow"></use></svg>
      </a>`;
    }).join('');
  }

  function selectCategory(category, scrollToResults) {
    selectedCategory = selectedCategory === category ? 'all' : category;
    renderCategoryGrid();
    renderInfoList();
    if (scrollToResults) {
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      document.getElementById('info-results').scrollIntoView({ behavior, block: 'start' });
    }
  }

  function priorityClass(priority) {
    if (priority === '高') return 'pri-high';
    if (priority === '中') return 'pri-mid';
    return 'pri-low';
  }

  function renderInfoDetail(item) {
    if (!item || !docArticle) return;
    currentSlug = item.slug;
    infoHome.hidden = true;
    infoDetail.hidden = false;
    const category = catMap[item.cat] || { name: '校园信息' };
    document.getElementById('detail-category-label').textContent = category.name;
    updateBookmarkButton();

    const steps = item.steps?.length ? `<section class="doc-section"><h2>办理流程</h2><div class="steps-list">${item.steps.map((step, index) => `<div class="step-card"><span class="step-num">${index + 1}</span><span>${esc(step)}</span></div>`).join('')}</div></section>` : '';
    const dataTable = item.table?.rows ? `<section class="doc-section"><h2>${esc(item.table.title || '相关数据与明细')}</h2><div class="table-scroll"><table class="meta-table"><thead><tr>${(item.table.headers || []).map((head) => `<th>${esc(head)}</th>`).join('')}</tr></thead><tbody>${item.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : '';
    let details = '';
    if (item.sections?.length) {
      details = item.sections.map((section) => `<section class="doc-section"><h2>${esc(section.title || '事项说明')}</h2>${section.lead ? `<p class="doc-lead">${esc(section.lead)}</p>` : ''}${section.body ? `<p>${esc(section.body)}</p>` : ''}${section.bullet?.length ? `<ul>${section.bullet.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}</section>`).join('');
    } else if (item.body) {
      details = `<section class="doc-section"><h2>详细说明</h2><p>${esc(item.body)}</p></section>`;
    }

    // 先展示到现场前需要核对的三项信息。
    const meta = [
      ['办理时间', item.time], ['所需材料', item.material], ['办理地点', item.place],
      ['适用对象', item.object], ['负责部门', item.dept], ['联系电话', item.phone],
    ].filter(([, value]) => value && !['—', '-'].includes(String(value).trim()));
    const sourceUrl = safeUrl(item.url);

    docArticle.innerHTML = `<header class="doc-hero">
      <div class="doc-label-row"><span class="tag ${priorityClass(item.priority)}">${esc(item.priority || '普通')}优先级</span><span class="verified-label"><i></i>资料已整理</span></div>
      <h1>${esc(item.title)}</h1><p>${esc(item.summary || '查看完整校园事项说明')}</p>
      <div class="doc-byline"><span>${esc(item.dept || '学校职能部门')}</span><span>${item.date ? `更新于 ${esc(item.date)}` : '请以官方最新通知为准'}</span></div>
    </header>
    ${meta.length ? `<section class="doc-section doc-summary-fields"><h2>办事信息</h2><dl class="key-info">${meta.map(([key, value]) => `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>` : ''}
    ${steps}${dataTable}${details}
    ${item.notes ? `<div class="warning-box"><b>办理提醒</b><span>${esc(item.notes)}</span></div>` : ''}
    <div class="doc-actions">
      <button class="btn-like" id="btn-like-${esc(item.slug)}" type="button">有帮助 <span id="like-count-${esc(item.slug)}">0</span></button>
      <button class="btn btn-outline btn-sm" id="feedback-current" type="button" aria-haspopup="dialog">纠错反馈</button>
      ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener">查看官方原文 ↗</a>` : ''}
    </div>`;

    document.getElementById(`btn-like-${item.slug}`)?.addEventListener('click', () => handleLikeClick(item.slug));
    document.getElementById('feedback-current')?.addEventListener('click', (event) => openFeedbackModal(item.slug, item.title, event.currentTarget));
    addToHistory(item.slug);
    loadLikes(item.slug);
    loadComments(item.slug);
    window.Api?.recordView(item.slug, item.cat, null);
  }

  function showInfoHome() {
    currentSlug = '';
    infoDetail.hidden = true;
    infoHome.hidden = false;
    renderCategoryGrid();
    renderInfoList();
  }

  function getBookmarks() { return storageRead('sdtbu_bookmarks', []); }
  function getLocalLikes() { return storageRead('sdtbu_local_likes', []); }
  function getHistory() { return storageRead('sdtbu_view_history', []); }

  function addToHistory(slug) {
    const history = getHistory().filter((entry) => entry.slug !== slug);
    history.unshift({ slug, at: Date.now() });
    storageWrite('sdtbu_view_history', history.slice(0, 30));
    renderMyStats();
  }

  function updateBookmarkButton() {
    if (!bookmarkButton) return;
    const saved = getBookmarks().includes(currentSlug);
    bookmarkButton.classList.toggle('is-saved', saved);
    bookmarkButton.setAttribute('aria-label', saved ? '取消收藏当前事项' : '收藏当前事项');
  }

  function toggleBookmark() {
    if (!currentSlug) return;
    const bookmarks = getBookmarks();
    const next = bookmarks.includes(currentSlug) ? bookmarks.filter((slug) => slug !== currentSlug) : [currentSlug, ...bookmarks];
    storageWrite('sdtbu_bookmarks', next);
    updateBookmarkButton();
    renderMyStats();
  }

  async function loadLikes(slug) {
    if (!window.Api?.isConfigured()) return;
    try {
      const { count, hasLiked } = await window.Api.getLikes(slug);
      const button = document.getElementById(`btn-like-${slug}`);
      const countNode = document.getElementById(`like-count-${slug}`);
      if (countNode) countNode.textContent = count;
      button?.classList.toggle('liked', hasLiked);
    } catch (error) {}
  }

  window.handleLikeClick = async function (slug) {
    try {
      const result = await window.Api.toggleLike(slug);
      const likes = getLocalLikes();
      if (!likes.includes(slug)) storageWrite('sdtbu_local_likes', [slug, ...likes]);
      if (!result.unchanged) {
        const countNode = document.getElementById(`like-count-${slug}`);
        if (countNode) countNode.textContent = Number(countNode.textContent || 0) + 1;
      }
      document.getElementById(`btn-like-${slug}`)?.classList.add('liked');
      renderMyStats();
    } catch (error) { alert(error.message || '点赞失败，请稍后重试'); }
  };

  async function loadComments(slug) {
    if (!commentFeed) return;
    commentFeed.innerHTML = '<div class="loading-state">正在加载同学交流…</div>';
    if (!window.Api?.isConfigured()) {
      commentFeed.innerHTML = '<div class="app-empty compact"><span>交流区暂未开放</span><p>连接校园数据服务后即可使用。</p></div>';
      return;
    }
    try {
      const comments = await window.Api.getComments(slug);
      commentCount.textContent = `${comments.length} 条`;
      if (!comments.length) {
        commentFeed.innerHTML = '<div class="app-empty compact"><span>还没有公开留言</span><p>可以提交第一个问题或办事经验。</p></div>';
        return;
      }
      commentFeed.innerHTML = comments.map((comment) => {
        const replies = comment.replies?.length ? `<div class="comment-replies">${comment.replies.map((reply) => `<div class="reply-item"><b>${esc(reply.user_name)}</b>${reply.reply_to_name ? ` 回复 ${esc(reply.reply_to_name)}` : ''}：${esc(reply.content)}</div>`).join('')}</div>` : '';
        return `<article class="comment-card" data-comment-id="${esc(comment.id)}">
          <div class="comment-user-row"><span class="comment-avatar">${esc((comment.user_name || '同').slice(0, 1))}</span><b>${esc(comment.user_name || '匿名同学')}</b><time>${new Date(comment.created_at).toLocaleDateString('zh-CN')}</time></div>
          <p>${esc(comment.content)}</p>
          <div class="comment-actions"><button type="button" data-action="comment-like" class="${comment.has_liked ? 'liked' : ''}">有帮助 <span>${comment.like_count || 0}</span></button><button type="button" data-action="reply">回复</button></div>
          <div class="inline-reply-box" hidden><textarea rows="2" placeholder="回复 ${esc(comment.user_name || '这位同学')}"></textarea><div><button class="btn btn-outline btn-sm" type="button" data-action="cancel-reply">取消</button><button class="btn btn-primary btn-sm" type="button" data-action="send-reply">发送</button></div></div>${replies}
        </article>`;
      }).join('');

      commentFeed.querySelectorAll('.comment-card').forEach((card) => {
        const id = card.dataset.commentId;
        const comment = comments.find((entry) => String(entry.id) === id);
        card.querySelector('[data-action="comment-like"]')?.addEventListener('click', (event) => handleCommentLike(id, event.currentTarget));
        card.querySelector('[data-action="reply"]')?.addEventListener('click', () => { card.querySelector('.inline-reply-box').hidden = false; card.querySelector('textarea').focus(); });
        card.querySelector('[data-action="cancel-reply"]')?.addEventListener('click', () => { card.querySelector('.inline-reply-box').hidden = true; });
        card.querySelector('[data-action="send-reply"]')?.addEventListener('click', (event) => submitReply(id, comment?.user_name || '匿名同学', card, event.currentTarget));
      });
    } catch (error) {
      commentFeed.innerHTML = '<div class="app-empty compact"><span>暂时无法加载留言</span><p>检查网络后重新进入本页面。</p></div>';
    }
  }

  async function handleCommentLike(commentId, button) {
    try {
      const result = await window.Api.toggleCommentLike(commentId);
      button.classList.add('liked');
      if (!result.unchanged) button.querySelector('span').textContent = Number(button.querySelector('span').textContent || 0) + 1;
    } catch (error) { alert(error.message || '操作失败'); }
  }

  async function submitReply(parentId, targetName, card, button) {
    const input = card.querySelector('.inline-reply-box textarea');
    const content = input.value.trim();
    if (!content) return;
    try {
      button.disabled = true;
      button.textContent = '发送中';
      await window.Api.postComment(currentSlug, getNickname(), content, parentId, targetName);
      input.value = '';
      card.querySelector('.inline-reply-box').hidden = true;
      alert('回复已提交，审核通过后会公开显示。');
    } catch (error) { alert(error.message || '回复失败'); }
    finally { button.disabled = false; button.textContent = '发送'; }
  }

  window.handleCurrentCommentSubmit = async function () {
    const content = commentInput?.value.trim();
    if (!content || !currentSlug) return;
    const button = document.getElementById('btn-post-comment');
    try {
      button.disabled = true;
      button.textContent = '发送中';
      await window.Api.postComment(currentSlug, getNickname(), content);
      commentInput.value = '';
      alert('留言已提交，审核通过后会公开显示。');
    } catch (error) { alert(error.message || '发表失败，请稍后重试'); }
    finally { button.disabled = false; button.textContent = '发表'; }
  };

  function getFeedDate(feed) {
    const raw = feed.published_at || feed.created_at || feed.pub_date;
    const date = raw ? new Date(raw) : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function feedGroupLabel(feed) {
    const date = getFeedDate(feed);
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startFeed = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const difference = Math.round((startToday - startFeed) / 86400000);
    if (difference <= 0) return '今天';
    if (difference === 1) return '昨天';
    return '更早';
  }

  function feedMatchesFilter(feed) {
    if (newsFilter === 'all') return true;
    const text = `${feed.source_name || ''} ${feed.source || ''} ${feed.title || ''}`;
    if (newsFilter === '校园') return /校园|图书|后勤|保卫|网络|信息/.test(text);
    return text.includes(newsFilter);
  }

  function newsHash(filter) {
    return filter === 'all' ? '#/news' : `#/news?${new URLSearchParams({ filter })}`;
  }

  function restoreNewsFilter(query) {
    const value = new URLSearchParams(query).get('filter');
    newsFilter = newsFilterButtons.some((button) => button.dataset.filter === value) ? value : 'all';
    for (const button of newsFilterButtons) {
      const active = button.dataset.filter === newsFilter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    newsNav.href = newsHash(newsFilter);
  }

  function renderNews() {
    const ready = newsStatus === 'ready';
    const filtered = newsFeeds.filter(feedMatchesFilter);
    const hasResults = ready && filtered.length > 0;
    const loading = newsStatus === 'idle' || newsStatus === 'loading';
    const failed = newsStatus === 'error';
    markNewsReadButton.disabled = !ready || !newsFeeds.length;
    retryNewsButton.hidden = !failed;
    newsStatusPanel.hidden = hasResults;
    newsStatusPanel.className = loading ? '' : 'app-empty';
    newsStatusText.className = loading ? 'loading-state' : '';
    newsStatusText.textContent = loading ? '正在加载通知…'
      : failed ? '通知加载失败，请重试。'
      : hasResults ? ''
      : newsFeeds.length ? '这个分类暂无消息，切换到“全部”查看其他通知。'
      : '暂时没有新通知。';
    newsList.hidden = !hasResults;
    updateNewsBadge();
    if (!hasResults) {
      newsList.replaceChildren();
      return;
    }
    const readIds = new Set(storageRead('sdtbu_read_news', []));
    const groups = ['今天', '昨天', '更早'];
    newsList.innerHTML = groups.map((label) => {
      const feeds = filtered.filter((feed) => feedGroupLabel(feed) === label);
      if (!feeds.length) return '';
      return `<section class="news-day"><h2>${label}</h2>${feeds.map((feed) => {
        const link = safeUrl(feed.link || feed.source_url);
        const unread = !readIds.has(String(feed.id));
        return `<a class="news-item ${unread ? 'is-unread' : ''}" href="${esc(link || '#')}" ${link ? 'target="_blank" rel="noopener"' : ''} data-news-id="${esc(feed.id)}">
          <i></i><span class="news-copy"><b>${esc(feed.title)}</b><small>${esc(feed.source_name || feed.source || '学校官方')} · ${getFeedDate(feed).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span><svg><use href="#icon-arrow"></use></svg>
        </a>`;
      }).join('')}</section>`;
    }).join('');
    newsList.querySelectorAll('[data-news-id]').forEach((link) => link.addEventListener('click', () => markNewsRead(link.dataset.newsId)));
  }

  function markNewsRead(id) {
    const read = storageRead('sdtbu_read_news', []);
    if (!read.includes(String(id))) storageWrite('sdtbu_read_news', [...read, String(id)].slice(-200));
    updateNewsBadge();
  }

  function markAllNewsRead() {
    storageWrite('sdtbu_read_news', newsFeeds.map((feed) => String(feed.id)));
    renderNews();
  }

  function updateNewsBadge() {
    const readIds = new Set(storageRead('sdtbu_read_news', []));
    const unread = newsFeeds.filter((feed) => !readIds.has(String(feed.id))).length;
    const badge = document.getElementById('news-unread-badge');
    if (!badge) return;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
  }

  async function loadNews() {
    if (newsStatus === 'loading') return;
    newsStatus = 'loading';
    renderNews();
    try {
      newsFeeds = await window.Api.getPublishedFeeds('news', 30, { throwOnError: true });
      newsStatus = 'ready';
    } catch {
      newsStatus = 'error';
    }
    renderNews();
  }

  function renderMyStats() {
    const bookmarks = getBookmarks();
    const history = getHistory();
    const likes = getLocalLikes();
    document.getElementById('bookmark-count').textContent = bookmarks.length;
    document.getElementById('history-count').textContent = history.length;
    document.getElementById('local-like-count').textContent = likes.length;
  }

  function renderMyPage() {
    const nickname = getNickname();
    document.getElementById('profile-name').textContent = nickname;
    document.getElementById('profile-avatar').textContent = nickname.slice(0, 1) || '同';
    renderMyStats();
  }

  window.showMyList = function (type) {
    const panel = document.getElementById('me-library-panel');
    const title = document.getElementById('me-library-title');
    const list = document.getElementById('me-library-list');
    const keys = type === 'bookmarks' ? getBookmarks() : type === 'likes' ? getLocalLikes() : getHistory().map((entry) => entry.slug);
    title.textContent = type === 'bookmarks' ? '我的收藏' : type === 'likes' ? '点赞内容' : '浏览记录';
    const items = keys.map((slug) => allItems().find((item) => item.slug === slug)).filter(Boolean);
    list.innerHTML = items.length ? items.map((item) => `<a href="#/info/${encodeURIComponent(item.slug)}"><span><b>${esc(item.title)}</b><small>${esc(catMap[item.cat]?.name || '校园信息')}</small></span><svg><use href="#icon-arrow"></use></svg></a>`).join('') : '<div class="app-empty compact"><span>这里还没有内容</span><p>浏览校园信息时可以收藏或点赞。</p></div>';
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.hideMyList = function () { document.getElementById('me-library-panel').hidden = true; };

  function renderOfficialLinks() {
    const container = document.getElementById('official-links-grid');
    if (!container) return;
    container.innerHTML = LINKS.map((link) => `<a class="me-row" href="${esc(safeUrl(link.url))}" target="_blank" rel="noopener"><span class="me-row-icon blue" aria-hidden="true"><svg><use href="#icon-campus"></use></svg></span><span><b>${esc(link.name)}</b><small>学校官方渠道</small></span><svg><use href="#icon-arrow"></use></svg></a>`).join('');
  }

  window.showModal = function (id, opener = document.activeElement) {
    const modal = document.getElementById(id);
    if (modal instanceof HTMLDialogElement) {
      if (modal.open) return;
      dialogSessions.set(modal, { opener });
      // 原生模态弹窗会聚焦首个带 autofocus 的字段，并屏蔽背景交互。
      modal.showModal();
      document.body.classList.add('modal-open');
      return;
    }
    if (modal) { modal.style.display = 'flex'; document.body.classList.add('modal-open'); }
  };

  window.hideModal = function (id) {
    const modal = document.getElementById(id);
    if (modal instanceof HTMLDialogElement) {
      modal.close();
      return;
    }
    if (modal) { modal.style.display = 'none'; document.body.classList.remove('modal-open'); }
  };

  function closeSubmittedDialog(dialog, session) {
    // 上一次提交的定时关闭不能关掉后来重新打开的弹窗。
    setTimeout(() => {
      if (dialog.open && dialogSessions.get(dialog) === session) hideModal(dialog.id);
    }, 900);
  }

  window.openFeedbackModal = function (slug, title, opener) {
    document.getElementById('fb-slug').value = slug || 'general';
    document.getElementById('fb-item-title').textContent = title || '网站与校园信息';
    document.getElementById('fb-desc').value = '';
    document.getElementById('fb-contact').value = '';
    document.getElementById('fb-msg').textContent = '';
    showModal('modal-feedback', opener);
  };

  window.openGeneralFeedback = function (opener) { openFeedbackModal('general', '网站与校园信息', opener); };

  window.showAuthModal = function () {
    const input = document.getElementById('auth-nickname');
    input.value = getNickname() === '匿名同学' ? '' : getNickname();
    document.getElementById('auth-msg').textContent = '';
    showModal('modal-auth');
  };

  window.handleAuthSubmit = async function () {
    const input = document.getElementById('auth-nickname');
    const agree = document.getElementById('auth-agree');
    const message = document.getElementById('auth-msg');
    const button = document.getElementById('btn-do-auth');
    if (!agree.checked) { message.textContent = '请先阅读并同意用户协议与隐私政策'; message.className = 'form-msg error'; return; }
    button.disabled = true;
    const saved = window.Api.setNickname(input.value);
    renderMyPage();
    message.textContent = `昵称已保存：${saved}`;
    message.className = 'form-msg success';
    setTimeout(() => hideModal('modal-auth'), 650);
    button.disabled = false;
  };

  window.handleFeedbackSubmit = async function () {
    const session = dialogSessions.get(feedbackDialog);
    const description = document.getElementById('fb-desc').value.trim();
    const message = document.getElementById('fb-msg');
    const button = document.getElementById('btn-do-feedback');
    if (!description) { message.textContent = '请填写具体的反馈内容'; message.className = 'form-msg error'; return; }
    try {
      button.disabled = true; button.textContent = '提交中';
      await window.Api.submitFeedback({ slug: document.getElementById('fb-slug').value, issueType: document.getElementById('fb-type').value, description, contact: document.getElementById('fb-contact').value, userId: null });
      message.textContent = '反馈已提交，我们会尽快核实。'; message.className = 'form-msg success';
      closeSubmittedDialog(feedbackDialog, session);
    } catch (error) { message.textContent = error.message || '提交失败，请稍后重试'; message.className = 'form-msg error'; }
    finally { button.disabled = false; button.textContent = '提交反馈'; }
  };

  function setPostFieldError(field, text) {
    document.getElementById(field.getAttribute('aria-describedby')).textContent = text;
    if (text) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }

  function hasUnsavedPost() {
    return postFields.some((field, index) => field.value !== savedPostValues[index]);
  }

  function warnAboutUnsavedPost(event) {
    event.preventDefault();
    event.returnValue = true;
  }

  function updatePostDraftGuard() {
    // 只在有未提交改动时拦截刷新或离开，也不把草稿写入浏览器存储。
    if (hasUnsavedPost()) window.addEventListener('beforeunload', warnAboutUnsavedPost);
    else window.removeEventListener('beforeunload', warnAboutUnsavedPost);
  }

  window.handlePostSubmit = async function () {
    const session = dialogSessions.get(postDialog);
    const title = document.getElementById('post-title').value.trim();
    const content = document.getElementById('post-content').value.trim();
    const message = document.getElementById('post-msg');
    const button = document.getElementById('btn-do-post');
    let firstInvalidField = null;
    for (const field of requiredPostFields) {
      const missing = !field.value.trim();
      setPostFieldError(field, missing ? `请填写${field.labels[0].textContent}。` : '');
      if (missing && !firstInvalidField) firstInvalidField = field;
    }
    if (firstInvalidField) {
      message.textContent = '';
      firstInvalidField.focus();
      return;
    }
    const submittedValues = postFields.map((field) => field.value);
    try {
      button.disabled = true; button.textContent = '提交中';
      await window.Api.submitArticle({ cat: document.getElementById('post-cat').value, title, summary: document.getElementById('post-summary').value, content, sourceUrl: document.getElementById('post-url').value, userId: null, authorName: getNickname() });
      savedPostValues = submittedValues;
      updatePostDraftGuard();
      message.textContent = '投稿已进入审核队列。'; message.className = 'form-msg success';
      if (!hasUnsavedPost()) closeSubmittedDialog(postDialog, session);
    } catch (error) { message.textContent = error.message || '提交失败，请稍后重试'; message.className = 'form-msg error'; }
    finally { button.disabled = false; button.textContent = '提交审核'; }
  };

  function syncRoute() {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = decodeURIComponent(path).split('/').filter(Boolean);
    if (!parts.length) { history.replaceState(null, '', '#/ai'); switchPage('ai', false); return; }
    if (parts[0] === 'section') {
      selectedCategory = parts[1] || 'all';
      searchQuery = '';
      if (searchInput) searchInput.value = '';
      scrollPositions.info = 0;
      if (parts[2] === 'item' && parts[3]) location.replace(`#\/info\/${encodeURIComponent(parts[3])}`);
      else location.replace('#/info');
      return;
    }
    const page = pageNames.has(parts[0]) ? parts[0] : allItems().some((item) => item.slug === parts[0]) ? 'info' : 'ai';
    if (page === 'news') restoreNewsFilter(query);
    switchPage(page, parts.length === 1);
    if (page === 'info') {
      const slug = parts[1] || (!pageNames.has(parts[0]) ? parts[0] : '');
      const item = slug ? allItems().find((entry) => entry.slug === slug) : null;
      if (item) renderInfoDetail(item); else showInfoHome();
    }
    if (parts.length > 1) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  async function loadDynamicItems() {
    if (!window.Api?.isConfigured()) return;
    try {
      const feeds = await window.Api.getPublishedFeeds('all', 100);
      const valid = new Set(CATEGORIES.map((category) => category.id));
      dynamicItems = (feeds || []).filter((feed) => valid.has(feed.cat)).map((feed) => window.Api.feedToItem(feed));
      renderCategoryGrid(); renderInfoList(); syncRoute();
    } catch (error) { console.warn('动态校园信息加载失败', error); }
  }

  categoryGrid?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (button) selectCategory(button.dataset.category, event.detail > 0);
  });
  searchInput?.addEventListener('input', (event) => {
    searchQuery = event.target.value.trim();
    if (searchQuery) selectedCategory = 'all';
    renderCategoryGrid();
    renderInfoList();
  });
  clearSearchButton.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });
  bookmarkButton?.addEventListener('click', toggleBookmark);
  document.getElementById('detail-back')?.addEventListener('click', () => { location.hash = '#/info'; });
  markNewsReadButton.addEventListener('click', markAllNewsRead);
  retryNewsButton.addEventListener('click', loadNews);
  newsFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (button) location.hash = newsHash(button.dataset.filter);
  });
  postDialog.addEventListener('input', (event) => {
    const field = event.target;
    if (requiredPostFields.includes(field) && field.value.trim()) setPostFieldError(field, '');
    updatePostDraftGuard();
  });
  document.getElementById('skip-to-content').addEventListener('click', (event) => {
    event.preventDefault();
    main.focus({ preventScroll: true });
    main.scrollIntoView({ block: 'start' });
  });
  main.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target === main || target.closest('.ai-panel.is-chatting') || !target.matches(':focus-visible')) return;
    // 浏览器自动定位焦点时也让出固定页眉和手机底栏。
    requestAnimationFrame(() => {
      if (document.activeElement === target) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
  document.addEventListener('keydown', (event) => {
    const dialog = document.querySelector('dialog.modal-overlay:modal');
    if (dialog) {
      if (event.key === 'Tab') {
        const controls = dialog.querySelectorAll('button:enabled, input:not([type="hidden"]):enabled, select:enabled, textarea:enabled, a[href]');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); location.hash = '#/info'; setTimeout(() => searchInput?.focus(), 80);
    }
    if (event.key === 'Escape') document.querySelectorAll('.modal-overlay:not(dialog)').forEach((modal) => { if (modal.style.display !== 'none') hideModal(modal.id); });
  });
  document.querySelectorAll('.modal-overlay').forEach((modal) => {
    modal.addEventListener('click', (event) => { if (event.target === modal) hideModal(modal.id); });
    if (!(modal instanceof HTMLDialogElement)) return;
    modal.addEventListener('close', () => {
      if (modal.open) return;
      const session = dialogSessions.get(modal);
      dialogSessions.delete(modal);
      if (document.querySelector('dialog.modal-overlay:modal')) return;
      document.body.classList.remove('modal-open');
      session?.opener?.focus({ preventScroll: true });
    });
  });
  window.addEventListener('hashchange', syncRoute);

  renderCategoryGrid();
  renderInfoList();
  renderOfficialLinks();
  renderMyPage();
  syncRoute();
  loadDynamicItems();
  loadNews();
})();
