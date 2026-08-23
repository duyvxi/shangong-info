// 页面交互与路由逻辑（集成 Supabase 互动功能）
(function () {
  const catMap = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  let activeCat = 'all';
  let query = '';
  let currentUser = null;

  // DOM
  const cardsEl = document.getElementById('cards');
  const emptyEl = document.getElementById('empty');
  const catsEl = document.getElementById('cats');
  const linksEl = document.getElementById('links');
  const searchInput = document.getElementById('search');
  const heroInput = document.getElementById('hero-search');
  const heroEl = document.getElementById('hero');
  const listView = document.getElementById('list-view');
  const detailView = document.getElementById('detail-view');
  const userArea = document.getElementById('user-area');

  // ---------- 工具函数 ----------
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

  // ---------- 模态框全局控制 ----------
  window.showModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
  };

  window.hideModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  };

  // 打开反馈纠错弹窗
  window.openFeedbackModal = function (slug, title) {
    document.getElementById('fb-slug').value = slug;
    document.getElementById('fb-item-title').textContent = title;
    document.getElementById('fb-desc').value = '';
    document.getElementById('fb-contact').value = '';
    const msgEl = document.getElementById('fb-msg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    showModal('modal-feedback');
  };

  // ---------- Auth 状态维护与账号密码登录 ----------
  let authMode = 'login'; // 'login' | 'register'

  async function initAuth() {
    if (window.Api && window.Api.isConfigured()) {
      currentUser = await window.Api.getCurrentUser();
      renderUserArea();
    }
  }

  function getUserDisplayName() {
    if (!currentUser) return '山商学子';
    if (currentUser.user_metadata && currentUser.user_metadata.display_name) {
      return currentUser.user_metadata.display_name;
    }
    if (currentUser.user_metadata && currentUser.user_metadata.account_raw) {
      return currentUser.user_metadata.account_raw;
    }
    if (currentUser.email) {
      return currentUser.email.split('@')[0];
    }
    return '已登录学子';
  }

  function renderUserArea() {
    if (currentUser) {
      const name = getUserDisplayName();
      userArea.innerHTML = `
        <div class="user-badge">
          <span>👤 ${esc(name)}</span>
          <button class="btn btn-outline btn-sm" onclick="handleLogout()">退出</button>
        </div>`;
    } else {
      userArea.innerHTML = `<button class="btn btn-primary" onclick="showAuthModal()">登录 / 注册</button>`;
    }
  }

  window.showAuthModal = function () {
    switchAuthTab('login');
    showModal('modal-auth');
  };

  window.switchAuthTab = function (mode) {
    authMode = mode;
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-register');
    const groupName = document.getElementById('group-username');
    const descEl = document.getElementById('auth-desc');
    const btn = document.getElementById('btn-do-auth');
    const msgEl = document.getElementById('auth-msg');

    if (msgEl) {
      msgEl.textContent = '';
      msgEl.className = 'form-msg';
    }

    if (mode === 'login') {
      tabLogin.classList.add('active');
      tabReg.classList.remove('active');
      groupName.style.display = 'none';
      descEl.textContent = '输入你的账号（手机号或学号）和密码完成登录。';
      btn.textContent = '立即登录';
    } else {
      tabReg.classList.add('active');
      tabLogin.classList.remove('active');
      groupName.style.display = 'block';
      descEl.textContent = '自主设置账号、昵称与密码，秒级完成注册，无需等待验证码。';
      btn.textContent = '立即注册并登录';
    }
  };

  window.handleAuthSubmit = async function () {
    const account = document.getElementById('auth-account').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const nickname = document.getElementById('auth-nickname').value.trim();
    const msgEl = document.getElementById('auth-msg');
    const btn = document.getElementById('btn-do-auth');

    if (!account) {
      msgEl.textContent = '请输入手机号或账号';
      msgEl.className = 'form-msg error';
      return;
    }
    if (!password) {
      msgEl.textContent = '请输入登录密码';
      msgEl.className = 'form-msg error';
      return;
    }
    if (authMode === 'register' && password.length < 6) {
      msgEl.textContent = '密码长度至少需要 6 个字符';
      msgEl.className = 'form-msg error';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = authMode === 'login' ? '正在登录...' : '正在创建账号...';
      msgEl.textContent = '';

      let user = null;
      if (authMode === 'login') {
        user = await window.Api.signIn(account, password);
      } else {
        user = await window.Api.signUp(account, password, nickname);
      }

      currentUser = user;
      renderUserArea();

      msgEl.textContent = (authMode === 'login' ? '登录成功！' : '注册成功并已自动登录！') + ' 正在进入...';
      msgEl.className = 'form-msg success';

      setTimeout(() => {
        hideModal('modal-auth');
        // 如果当前处于详情页，重新加载当前事项的点赞与评论状态
        if (location.hash.includes('/item/')) {
          const parts = location.hash.replace(/^#\/?/, '').split('/');
          const itemIdx = parts.indexOf('item');
          if (itemIdx !== -1 && parts[itemIdx + 1]) {
            const slug = parts[itemIdx + 1];
            loadLikes(slug);
            loadComments(slug);
          }
        }
      }, 1000);
    } catch (err) {
      msgEl.textContent = err.message || '操作失败，请重试';
      msgEl.className = 'form-msg error';
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? '立即登录' : '立即注册并登录';
    }
  };

  window.handleLogout = async function () {
    if (window.Api) {
      await window.Api.signOut();
      currentUser = null;
      renderUserArea();
      // 刷新当前页面状态
      if (location.hash.includes('/item/')) {
        const parts = location.hash.replace(/^#\/?/, '').split('/');
        const itemIdx = parts.indexOf('item');
        if (itemIdx !== -1 && parts[itemIdx + 1]) {
          const slug = parts[itemIdx + 1];
          loadLikes(slug);
          loadComments(slug);
        }
      }
    }
  };

  // ---------- 纠错提交 ----------
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
        userId: currentUser ? currentUser.id : null,
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

  // ---------- 投稿提交 ----------
  window.handlePostSubmit = async function () {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请先点击右上角登录后再投稿！');
      showModal('modal-auth');
      return;
    }

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
        userId: currentUser ? currentUser.id : 'anonymous',
        authorName: getUserDisplayName(),
      });

      msgEl.textContent = '投稿成功！内容进入待审池，审核通过后将展示在网站上。';
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

  // ---------- 互动点赞与评论业务 ----------
  window.handleLikeClick = async function (slug) {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请登录后再为该政策点赞！');
      showModal('modal-auth');
      return;
    }

    try {
      const btn = document.getElementById('btn-like-' + slug);
      const res = await window.Api.toggleLike(slug, currentUser ? currentUser.id : 'anon');
      const countEl = document.getElementById('like-count-' + slug);
      let count = parseInt(countEl.textContent || '0', 10);

      if (res.action === 'liked') {
        btn.classList.add('liked');
        countEl.textContent = count + 1;
      } else {
        btn.classList.remove('liked');
        countEl.textContent = Math.max(0, count - 1);
      }
    } catch (err) {
      alert(err.message || '点赞失败');
    }
  };

  // 评论点赞切换
  window.handleCommentLike = async function (commentId, slug) {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请登录后再为评论点赞！');
      showModal('modal-auth');
      return;
    }

    try {
      const btn = document.getElementById('btn-c-like-' + commentId);
      const countEl = document.getElementById('c-like-cnt-' + commentId);
      const res = await window.Api.toggleCommentLike(commentId, currentUser.id);
      let count = parseInt(countEl.textContent || '0', 10);

      if (res.action === 'liked') {
        btn.classList.add('liked');
        countEl.textContent = count + 1;
      } else {
        btn.classList.remove('liked');
        countEl.textContent = Math.max(0, count - 1);
      }
    } catch (err) {
      alert(err.message || '评论点赞失败');
    }
  };

  // 显示/隐藏行内回复输入框
  window.toggleReplyBox = function (commentId, targetUserName) {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请登录后再参与回复交流！');
      showModal('modal-auth');
      return;
    }

    const box = document.getElementById('reply-box-' + commentId);
    if (!box) return;

    const isHidden = box.style.display === 'none' || !box.style.display;
    // 关闭页面上其他可能打开的回复框
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

  // 提交子回复
  window.handleReplySubmit = async function (slug, parentId, targetUserName) {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请登录后再回复！');
      showModal('modal-auth');
      return;
    }

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
      await window.Api.postComment(slug, currentUser.id, userName, content, parentId, targetUserName);
      input.value = '';
      const box = document.getElementById('reply-box-' + parentId);
      if (box) box.style.display = 'none';

      // 刷新评论列表
      loadComments(slug);
    } catch (err) {
      alert(err.message || '回复失败');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '回复';
      }
    }
  };

  // 提交主评论
  window.handleCommentSubmit = async function (slug) {
    if (!currentUser && window.Api.isConfigured()) {
      alert('请登录后再发表评论！');
      showModal('modal-auth');
      return;
    }

    const input = document.getElementById('comment-input');
    const content = input.value.trim();
    if (!content) return;

    try {
      const btn = document.getElementById('btn-post-comment');
      btn.disabled = true;
      btn.textContent = '发送中...';

      const userName = getUserDisplayName();
      await window.Api.postComment(slug, currentUser ? currentUser.id : 'anon', userName, content);
      input.value = '';

      // 重新加载评论
      loadComments(slug);
    } catch (err) {
      alert(err.message || '发表失败');
    } finally {
      const btn = document.getElementById('btn-post-comment');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '发表评论';
      }
    }
  };

  async function loadLikes(slug) {
    if (!window.Api || !window.Api.isConfigured()) return;
    const { count, hasLiked } = await window.Api.getLikes(slug, currentUser ? currentUser.id : null);
    const btn = document.getElementById('btn-like-' + slug);
    const countEl = document.getElementById('like-count-' + slug);
    if (btn && countEl) {
      countEl.textContent = count;
      if (hasLiked) btn.classList.add('liked');
    }
  }

  async function loadComments(slug) {
    const listEl = document.getElementById('comment-list-' + slug);
    if (!listEl) return;

    if (!window.Api || !window.Api.isConfigured()) {
      listEl.innerHTML = `<div class="comment-empty">（配置 Supabase 凭据后即可开启实时互动交流）</div>`;
      return;
    }

    const comments = await window.Api.getComments(slug, currentUser ? currentUser.id : null);
    if (!comments.length) {
      listEl.innerHTML = `<div class="comment-empty">暂无评论，来发表第一条经验或疑问吧～</div>`;
      return;
    }

    listEl.innerHTML = comments
      .map((c) => {
        // 渲染子回复列表
        const repliesHtml = (c.replies && c.replies.length > 0)
          ? `<div class="comment-replies">
              ${c.replies.map(r => `
                <div class="reply-item">
                  <div class="comment-meta">
                    <div>
                      <b>${esc(r.user_name)}</b>
                      ${r.reply_to_name ? `<span class="reply-target">回复 <b>@${esc(r.reply_to_name)}</b></span>` : ''}
                    </div>
                    <span>${new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <p class="comment-content">${esc(r.content)}</p>
                  <div class="comment-actions">
                    <button class="btn-c-like ${r.has_liked ? 'liked' : ''}" id="btn-c-like-${r.id}" onclick="handleCommentLike('${r.id}', '${slug}')">
                      ❤️ <span id="c-like-cnt-${r.id}">${r.like_count || 0}</span>
                    </button>
                    <button class="btn-c-reply" onclick="toggleReplyBox('${c.id}', '${esc(r.user_name)}')">
                      💬 回复
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>`
          : '';

        return `
        <div class="comment-item" id="comment-${c.id}">
          <div class="comment-meta">
            <b>${esc(c.user_name)}</b>
            <span>${new Date(c.created_at).toLocaleDateString()}</span>
          </div>
          <p class="comment-content">${esc(c.content)}</p>
          <div class="comment-actions">
            <button class="btn-c-like ${c.has_liked ? 'liked' : ''}" id="btn-c-like-${c.id}" onclick="handleCommentLike('${c.id}', '${slug}')">
              ❤️ 赞 (<span id="c-like-cnt-${c.id}">${c.like_count || 0}</span>)
            </button>
            <button class="btn-c-reply" onclick="toggleReplyBox('${c.id}', '${esc(c.user_name)}')">
              💬 回复
            </button>
          </div>

          <!-- 行内内嵌回复输入框 -->
          <div class="inline-reply-box" id="reply-box-${c.id}" style="display:none;">
            <textarea id="reply-input-${c.id}" rows="2" placeholder="写下你的回复..."></textarea>
            <div class="reply-box-actions">
              <button class="btn btn-sm btn-outline" onclick="toggleReplyBox('${c.id}')">取消</button>
              <button class="btn btn-sm btn-primary" id="btn-send-reply-${c.id}" onclick="handleReplySubmit('${slug}', '${c.id}', '${esc(c.user_name)}')">回复</button>
            </div>
          </div>

          <!-- 子回复楼中楼展示 -->
          ${repliesHtml}
        </div>`;
      })
      .join('');
  }

  // ---------- 板块 Chips ----------
  function renderChips() {
    const all = [{ id: 'all', name: '全部' }, ...CATEGORIES];
    catsEl.innerHTML = all
      .map(
        (c) =>
          `<button class="chip ${c.id === activeCat ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`
      )
      .join('');

    catsEl.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCat = btn.dataset.cat;
        renderChips();
        if (location.hash && location.hash !== '#/') {
          location.hash = activeCat === 'all' ? '#/' : `#/section/${activeCat}`;
        } else {
          render();
        }
      });
    });
  }

  // ---------- 列表渲染 ----------
  function match(item) {
    if (activeCat !== 'all' && item.cat !== activeCat) return false;
    if (!query) return true;
    const cat = catMap[item.cat] || {};
    const hay = [item.title, item.summary, item.dept, item.object, cat.name].join(' ');
    return hay.toLowerCase().includes(query.toLowerCase());
  }

  function makeCard(it) {
    const c = catMap[it.cat] || { name: it.cat };
    const typeTag = it.table ? '<span class="tag table">数据表</span>' : '';
    const metaFields = [
      ['对象', it.object],
      ['时间', it.time],
      ['部门', it.dept],
      ['电话', it.phone],
      ['地点', it.place],
      ['材料', it.material],
    ].filter((pair) => pair[1]);
    const metaHtml = metaFields.map((pair) => `<span><b>${pair[0]}</b>${esc(pair[1])}</span>`).join('');
    return `
      <article class="card">
        <div class="card-top">
          <span class="tag">${esc(c.name)}</span>
          ${typeTag}
          <span class="tag ok">已核实</span>
          <span class="tag ${priClass(it.priority)}">${esc(it.priority)}优先级</span>
        </div>
        <h3>${esc(it.title)}</h3>
        <p class="summary">${esc(it.summary)}</p>
        ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ''}
        <div class="card-foot">
          <span class="date">${it.date ? '发布于 ' + esc(it.date) : '以官方为准'}</span>
          <span class="foot-links">
            <a href="#/section/${esc(it.cat)}/item/${esc(it.slug)}">详情</a>
            <a href="${esc(it.url)}" target="_blank" rel="noopener">原文</a>
          </span>
        </div>
      </article>`;
  }

  function render() {
    const list = ITEMS.filter(match);
    cardsEl.innerHTML = list.map(makeCard).join('');
    emptyEl.style.display = list.length ? 'none' : 'block';
  }

  function renderLinks() {
    linksEl.innerHTML = LINKS.map(
      (l) =>
        `<a class="link" href="${esc(l.url)}" target="_blank" rel="noopener"><span>${esc(l.name)}</span><span class="arrow">→</span></a>`
    ).join('');
  }

  // ---------- 详情渲染 ----------
  function renderDetail(it, catId) {
    const c = catMap[it.cat] || { name: it.cat };
    const typeTag = it.table ? '<span class="tag table">数据表</span>' : '';

    const infoFields = [
      ['适用对象', it.object],
      ['关键时间', it.time],
      ['负责部门', it.dept],
      ['联系电话', it.phone],
      ['办理地点', it.place],
      ['所需材料', it.material],
    ].filter((pair) => pair[1]);
    const infoHtml = infoFields.length
      ? `<div class="info-card"><div class="meta">${infoFields.map((pair) => `<span><b>${pair[0]}</b>${esc(pair[1])}</span>`).join('')}</div></div>`
      : '';

    function renderSection(sec, idx) {
      const id = 'sec-' + idx;
      const inner = [];
      if (sec.lead) inner.push(`<p class="sec-lead">${esc(sec.lead)}</p>`);
      if (sec.body) inner.push(`<p>${esc(sec.body)}</p>`);
      if (sec.bullet && sec.bullet.length) {
        inner.push(`<ul class="sec-bullet">${sec.bullet.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
      }
      if (sec.table && sec.table.rows) {
        const th = (sec.table.headers || []).map((h) => `<th>${esc(h)}</th>`).join('');
        const trs = sec.table.rows.map((r) => `<tr>${r.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
        inner.push(`<div class="table-wrap"><table>${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${trs}</tbody></table></div>`);
      }
      return `<section class="detail-section" id="${id}">
        <h2 class="sec-title">${esc(sec.title || '分区 ' + (idx + 1))}</h2>
        ${inner.join('')}
      </section>`;
    }

    let bodyHtml = '';
    if (it.sections && it.sections.length) {
      const anchors = it.sections
        .map((sec, i) => `<a href="#sec-${i}">${esc(sec.title || '分区 ' + (i + 1))}</a>`)
        .join('');
      const secs = it.sections.map(renderSection).join('');
      bodyHtml = `<div class="sec-nav">${anchors}</div>${secs}`;
    } else if (it.body) {
      bodyHtml += `
        <div class="detail-body">
          <h2>政策要点</h2>
          <p>${esc(it.body)}</p>
        </div>`;
    }
    if (it.table && it.table.rows) {
      const th = (it.table.headers || []).map((h) => `<th>${esc(h)}</th>`).join('');
      const trs = it.table.rows.map((r) => `<tr>${r.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
      bodyHtml += `
        <div class="detail-table">
          <h2>数据一览</h2>
          <div class="table-wrap">
            <table>
              ${th ? `<thead><tr>${th}</tr></thead>` : ''}
              <tbody>${trs}</tbody>
            </table>
          </div>
        </div>`;
    }
    if (it.steps && it.steps.length) {
      const steps = it.steps.map((s) => `<li>${esc(s)}</li>`).join('');
      bodyHtml += `<div class="detail-steps"><h2>办理流程</h2><ol>${steps}</ol></div>`;
    }

    const notesHtml = it.notes
      ? `<div class="detail-notes"><h2>注意事项</h2><p>${esc(it.notes)}</p></div>`
      : '';

    const related = ITEMS.filter((x) => x.cat === it.cat && x.slug !== it.slug);
    const relatedHtml = related.length
      ? `<div class="related"><h2>同板块其他事项</h2><div class="cards">${related.map(makeCard).join('')}</div></div>`
      : '';

    return `
      <div class="detail">
        <nav class="crumb">
          <a href="#/">首页</a><span class="sep">›</span>
          <a href="#/section/${esc(it.cat)}">${esc(c.name)}</a><span class="sep">›</span>
          <span class="cur">${esc(it.title)}</span>
        </nav>
        <a class="back" href="#/section/${esc(it.cat)}">← 返回上一板块</a>

        <div class="detail-head">
          <div class="card-top">
            <span class="tag">${esc(c.name)}</span>
            ${typeTag}
            <span class="tag ok">已核实</span>
            <span class="tag ${priClass(it.priority)}">${esc(it.priority)}优先级</span>
          </div>
          <h1>${esc(it.title)}</h1>
          <p class="summary">${esc(it.summary)}</p>
        </div>

        ${infoHtml}
        ${bodyHtml}
        ${notesHtml}

        <!-- 互动区：点赞 & 纠错 -->
        <div class="detail-actions">
          <div class="action-left">
            <button class="btn-like" id="btn-like-${esc(it.slug)}" onclick="handleLikeClick('${esc(it.slug)}')">
              ❤️ <span id="like-count-${esc(it.slug)}">0</span> 点赞
            </button>
          </div>
          <button class="btn-report" onclick="openFeedbackModal('${esc(it.slug)}', '${esc(it.title)}')">
            🚩 信息失效 / 报错纠错
          </button>
        </div>

        <div class="source">
          <a href="${esc(it.url)}" target="_blank" rel="noopener">查看官方原文 →</a>
          <span>${it.date ? '发布于 ' + esc(it.date) : '以官方最新通知为准'}</span>
        </div>

        <!-- 评论讨论区 -->
        <div class="comments-section">
          <h2>💬 交流与提问</h2>
          <div class="comment-form">
            <textarea id="comment-input" placeholder="有疑问或经验分享？发表你的评论..."></textarea>
            <div class="comment-form-foot">
              <span style="font-size:12px;color:var(--muted);">支持理性文明交流</span>
              <button class="btn btn-primary btn-sm" id="btn-post-comment" onclick="handleCommentSubmit('${esc(it.slug)}')">发表评论</button>
            </div>
          </div>
          <div class="comment-list" id="comment-list-${esc(it.slug)}"></div>
        </div>

        ${relatedHtml}
      </div>`;
  }

  function renderNotFound(catId) {
    const back = catMap[catId] ? `#/section/${esc(catId)}` : '#/';
    return `
      <div class="detail">
        <a class="back" href="${back}">← 返回</a>
        <div class="empty">未找到该事项，可能已下线或链接有误。</div>
      </div>`;
  }

  // ---------- 路由驱动 ----------
  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (!hash) return { view: 'list', catId: 'all' };

    const parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'section' && parts[1]) {
      if (parts[2] === 'item' && parts[3]) {
        return { view: 'detail', catId: parts[1], slug: parts[3] };
      }
      return { view: 'list', catId: parts[1] };
    }
    return { view: 'list', catId: 'all' };
  }

  function route() {
    const r = parseRoute();
    if (r.view === 'detail') {
      showDetail(r.slug, r.catId);
    } else {
      showList(r.catId);
    }
  }

  function showList(catId) {
    activeCat = catMap[catId] ? catId : 'all';
    renderChips();
    detailView.style.display = 'none';
    listView.style.display = 'block';
    heroEl.style.display = 'block';
    render();
    window.scrollTo(0, 0);
  }

  function showDetail(slug, catId) {
    const item = ITEMS.find((i) => i.slug === slug);
    heroEl.style.display = 'none';
    listView.style.display = 'none';
    detailView.style.display = 'block';

    if (!item) {
      detailView.innerHTML = renderNotFound(catId);
    } else {
      detailView.innerHTML = renderDetail(item, catId);
      // 加载点赞与评论数据
      loadLikes(slug);
      loadComments(slug);
      // 触发无感浏览埋点
      if (window.Api && window.Api.recordView) {
        window.Api.recordView(slug, item.cat, currentUser ? currentUser.id : null);
      }
    }
    window.scrollTo(0, 0);
  }

  // ---------- 搜索 ----------
  let searchTimer = null;
  function bindSearch() {
    const onInput = (e) => {
      query = e.target.value.trim();
      searchInput.value = e.target.value;
      heroInput.value = e.target.value;
      if (detailView.style.display !== 'none') {
        location.hash = '#/';
      } else {
        render();
      }

      // 防抖上报搜索热词与未命中词
      clearTimeout(searchTimer);
      if (query.length >= 2) {
        searchTimer = setTimeout(() => {
          if (window.Api && window.Api.recordSearch) {
            const hitCount = getFiltered().length;
            window.Api.recordSearch(query, hitCount > 0);
          }
        }, 1200);
      }
    };
    searchInput.addEventListener('input', onInput);
    heroInput.addEventListener('input', onInput);
  }

  // ---------- 启动 ----------
  document.getElementById('count').textContent = ITEMS.length;
  initAuth();
  renderChips();
  renderLinks();
  window.addEventListener('hashchange', route);
  route();
  bindSearch();
})();
