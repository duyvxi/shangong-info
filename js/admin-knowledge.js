(function () {
  const element = (id) => document.getElementById(`knowledge-${id}`);
  const dialog = element('detail');
  const pageSize = 25;
  const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
  });
  const statusLabels = { draft: '待审核', published: '已发布', archived: '已归档' };
  const sourceLabels = { official_notice: '官方通知', curated: '本站整理', manual: '学生整理' };
  const actionLabels = {
    publish: '审核发布', verify: '记录核验通过', hold: '记录暂无法核实',
    return: '退回待审', archive: '归档', restore: '恢复待审',
  };
  let page = 0;
  let listRequest = 0;
  let detailRequest = 0;
  let activeId;
  let activeDocument;
  let detailTrigger;
  let saving = false;

  function dateWindow(now = Date.now()) {
    return { today: dateFormat.format(now), horizon: dateFormat.format(now + 30 * 86400000) };
  }

  function validityLabel(document, { today, horizon }) {
    if (document.effective_until && document.effective_until < today) return '已过期';
    if (document.effective_from && document.effective_from > today) return '尚未生效';
    if (!document.effective_until) return '无到期日';
    return document.effective_until <= horizon ? '将到期' : '有效';
  }

  function describeAudience(document) {
    const metadata = document.metadata || {};
    return document.last_review?.audience || metadata.audience || metadata.campus || '';
  }

  function showMessage(area, message, error = false) {
    const output = element(area);
    output.textContent = message;
    output.toggleAttribute('data-error', error);
  }

  function displayTime(value) {
    return value ? timeFormat.format(new Date(value)) : '未记录';
  }

  function errorMessage(error, fallback) {
    if (['42703', 'PGRST202', 'PGRST204'].includes(error.code)) {
      return '后台还无法读取知识审核字段。请先在测试数据库应用知识审核升级，再重试。';
    }
    if (error.code === '42501') return '当前账号没有权限，请重新登录管理员账号。';
    if (error.code === '22023') return error.message;
    return fallback;
  }

  async function load(targetPage = page) {
    const request = ++listRequest;
    const tbody = document.getElementById('tbl-knowledge-documents');
    const dates = dateWindow();
    element('prev').disabled = true;
    element('next').disabled = true;
    tbody.replaceChildren();
    showMessage('list-status', '正在读取资料…');
    try {
      const result = await window.Api.getKnowledgeDocuments({
        page: targetPage, limit: pageSize, ...dates,
        status: element('status').value, validity: element('validity').value,
        sourceType: element('source-type').value, category: element('category').value.trim(),
        search: element('search').value.trim(), sort: element('sort').value,
      });
      if (request !== listRequest) return;
      const pages = Math.max(1, Math.ceil(result.count / pageSize));
      if (targetPage >= pages) return load(pages - 1);
      page = targetPage;
      tbody.innerHTML = result.documents.map((item) => `
        <tr>
          <td><strong>${escapeHtml(item.title)}</strong><br><small>${escapeHtml(item.category)} · ${escapeHtml(item.slug)}</small></td>
          <td>${escapeHtml(sourceLabels[item.source_type] || '未分类')}</td>
          <td>${escapeHtml(statusLabels[item.status])}<br><small>${validityLabel(item, dates)}</small></td>
          <td>${escapeHtml(describeAudience(item) || '待核对')}</td>
          <td>${escapeHtml(displayTime(item.verified_at))}</td>
          <td>${escapeHtml(item.effective_until || '无到期日')}</td>
          <td><button class="btn-action" type="button" data-knowledge-id="${escapeHtml(item.id)}" aria-label="查看详情：${escapeHtml(item.title)}">查看详情</button></td>
        </tr>`).join('');
      showMessage('list-status', result.count ? `共 ${result.count} 条资料` : '没有符合条件的资料。');
      element('pagination').hidden = pages < 2;
      element('page').textContent = `第 ${page + 1} / ${pages} 页`;
      element('prev').disabled = page === 0;
      element('next').disabled = page + 1 >= pages;
    } catch (error) {
      if (request !== listRequest) return;
      if (targetPage > 0 && error.code === 'PGRST103') return load(0);
      element('pagination').hidden = true;
      showMessage('list-status', errorMessage(error, '资料加载失败，请检查网络后再次筛选。'), true);
    }
  }

  function renderDetail(item, keepInputs) {
    const sourceUrl = safeExternalUrl(item.source_url || item.canonical_url);
    const previousUrl = safeExternalUrl(item.previous_version?.source_url);
    const lastReview = item.last_review || item.previous_version?.last_review;
    const facts = {
      '资料编号': item.slug,
      '分类': item.category,
      '来源': [sourceLabels[item.source_type], item.metadata?.source_name].filter(Boolean).join(' · '),
      '维护入口': item.metadata?.crawler ? '学校官网 · 自动采集' : '仓库 knowledge/ · 人工整理',
      '适用对象': describeAudience(item) || '待核对',
      '原文发布日期': item.source_date || '未记录',
      '生效日': item.effective_from || '无起始限制',
      '到期日': item.effective_until || '无到期日',
      '审核状态': statusLabels[item.status],
      '资料时效': validityLabel(item, dateWindow()),
      '最近核验（北京时间）': displayTime(item.verified_at),
      '最近更新（北京时间）': displayTime(item.updated_at),
    };
    element('detail-title').textContent = item.title;
    element('detail-content').innerHTML = `
      <dl class="knowledge-facts">${Object.entries(facts).map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
      ${sourceUrl !== '#' ? `<a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">打开原文或参考链接</a>` : '<p>原文链接未记录，请填写可核查出处。</p>'}
      ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      <h4>完整正文</h4><div class="knowledge-body" tabindex="0">${escapeHtml(item.content)}</div>
      ${item.previous_version ? `<details><summary>对照上一版</summary>
        <p>${escapeHtml(item.previous_version.title)} · 原文发布日期 ${escapeHtml(item.previous_version.source_date || '未记录')} · 到期日 ${escapeHtml(item.previous_version.effective_until || '无到期日')}</p>
        ${previousUrl === '#' ? '' : `<a href="${previousUrl}" target="_blank" rel="noopener noreferrer">打开上一版登记的出处</a>`}
        <div class="knowledge-body" tabindex="0">${escapeHtml(item.previous_version.content)}</div></details>` : ''}
      ${lastReview ? `<h4>${item.last_review ? '本版' : '上一版'}处理记录</h4><p>${escapeHtml(actionLabels[lastReview.action])} · ${escapeHtml(displayTime(lastReview.at))}${lastReview.public_confirmed ? ' · 已核对可公开' : ''}</p>
        ${lastReview.evidence ? `<p>出处：${escapeHtml(lastReview.evidence)}</p>` : ''}
        ${lastReview.note ? `<p>备注：${escapeHtml(lastReview.note)}</p>` : ''}` : ''}`;
    element('detail-content').hidden = false;
    const actions = item.status === 'draft' ? ['publish', 'hold', 'archive']
      : item.status === 'published' ? ['verify', 'hold', 'return', 'archive'] : ['restore'];
    element('review-actions').innerHTML = actions.map((action) => `
      <button class="btn-action${['publish', 'verify'].includes(action) ? ' btn-success' : ''}" type="submit" value="${action}">${actionLabels[action]}</button>`).join('');
    element('audience').value = describeAudience(item);
    element('evidence').value = item.last_review?.evidence || (sourceUrl !== '#' ? item.source_url || item.canonical_url : '');
    if (!keepInputs) element('review-note').value = '';
    element('public').checked = false;
    element('review-form').hidden = !item.revision;
  }

  async function openDetail(id, keepInputs = false) {
    const request = ++detailRequest;
    activeId = id;
    activeDocument = null;
    element('detail-title').textContent = '资料详情';
    element('detail-content').hidden = true;
    element('review-form').hidden = true;
    element('reload').hidden = true;
    if (!dialog.open) dialog.showModal();
    showMessage('detail-status', '正在读取完整资料…');
    try {
      const item = await window.Api.getKnowledgeDocument(id);
      if (request !== detailRequest || !dialog.open) return;
      activeDocument = item;
      renderDetail(item, keepInputs);
      showMessage('detail-status', keepInputs ? '已重新读取，请核对当前资料与备注。' : '');
    } catch (error) {
      if (request !== detailRequest || !dialog.open) return;
      element('reload').hidden = false;
      showMessage('detail-status', errorMessage(error, '无法读取资料，请重试。'), true);
    }
  }

  async function submitReview(event) {
    event.preventDefault();
    const action = event.submitter?.value;
    if (saving || !activeDocument || !actionLabels[action]) return;
    const review = {
      audience: element('audience').value.trim(), evidence: element('evidence').value.trim(),
      note: element('review-note').value.trim(), publicConfirmed: element('public').checked,
    };
    const confirming = action === 'publish' || action === 'verify';
    const required = confirming
      ? { audience: review.audience, evidence: review.evidence, public: review.publicConfirmed }
      : { 'review-note': review.note };
    const missing = Object.keys(required).find((field) => !required[field]);
    if (missing) {
      showMessage('detail-status', confirming ? '请填写适用对象、核验出处，并确认资料可以公开。' : '请先填写处理备注。', true);
      element(missing).focus();
      return;
    }
    saving = true;
    const formFields = [...element('review-form').elements, element('close')];
    formFields.forEach((field) => { field.disabled = true; });
    showMessage('detail-status', '正在保存…');
    try {
      const result = await window.Api.reviewKnowledgeDocument(activeDocument, action, review);
      activeDocument = { ...activeDocument, ...result };
      renderDetail(activeDocument, false);
      element('reload').hidden = true;
      showMessage('detail-status', `已保存。当前状态：${statusLabels[result.status]}。`);
      element('detail-status').focus();
      void load();
    } catch (error) {
      element('reload').hidden = false;
      if (error.message === 'KNOWLEDGE_CONFLICT') {
        activeDocument = null;
        showMessage('detail-status', '资料或审核状态已更新。请重新读取并核对新版，已写的备注会保留。', true);
        element('reload').focus();
      } else {
        showMessage('detail-status', errorMessage(error, '未确认保存成功。请重新读取核对状态，或重试保存。'), true);
      }
    } finally {
      formFields.forEach((field) => { field.disabled = false; });
      if (!activeDocument) element('review-actions').querySelectorAll('button').forEach((button) => { button.disabled = true; });
      saving = false;
    }
  }

  document.getElementById('tbl-knowledge-documents').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-knowledge-id]');
    if (!trigger) return;
    detailTrigger = trigger;
    void openDetail(trigger.dataset.knowledgeId);
  });
  element('filters').addEventListener('submit', (event) => { event.preventDefault(); void load(0); });
  element('prev').addEventListener('click', () => void load(page - 1));
  element('next').addEventListener('click', () => void load(page + 1));
  element('close').addEventListener('click', () => dialog.close());
  element('reload').addEventListener('click', () => void openDetail(activeId, true));
  element('review-form').addEventListener('submit', submitReview);
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    detailRequest++;
    activeDocument = null;
    (detailTrigger?.isConnected ? detailTrigger : element('filters').querySelector('button')).focus();
  });
  for (const option of document.getElementById('source-category').options) {
    if (option.value) element('categories').append(option.cloneNode(true));
  }
  window.AdminKnowledge = { load };
}());
