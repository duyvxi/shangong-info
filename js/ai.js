(function () {
  'use strict';

  const messages = document.getElementById('ai-messages');
  const form = document.getElementById('ai-form');
  const input = document.getElementById('ai-input');
  const sendButton = document.getElementById('ai-send');
  const remaining = document.getElementById('ai-remaining');
  const suggestions = document.getElementById('ai-suggestions');
  const recentSection = document.getElementById('recent-questions');
  const recentList = document.getElementById('recent-question-list');
  const clearHistory = document.getElementById('clear-ai-history');

  if (!messages || !form || !input || !sendButton) return;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeHttpUrl(value) {
    if (!value || String(value).trim() === '#') return '';
    try {
      const url = new URL(String(value || ''), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (error) { return ''; }
  }

  function readHistory() {
    try {
      const value = JSON.parse(localStorage.getItem('sdtbu_ai_recent_questions'));
      return Array.isArray(value) ? value : [];
    } catch (error) { return []; }
  }

  function saveQuestion(question) {
    const questions = readHistory().filter((item) => item !== question);
    questions.unshift(question);
    try { localStorage.setItem('sdtbu_ai_recent_questions', JSON.stringify(questions.slice(0, 5))); } catch (error) {}
    renderHistory();
  }

  function renderHistory() {
    const history = readHistory();
    recentSection.hidden = history.length === 0;
    if (!history.length) { recentList.innerHTML = ''; return; }
    recentList.innerHTML = history.map((question) => `<button type="button" data-recent-question="${escapeHtml(question)}"><span>${escapeHtml(question)}</span><b>再次提问</b></button>`).join('');
  }

  function scrollMessages() {
    requestAnimationFrame(() => {
      const composerHeight = document.querySelector('.ai-composer')?.offsetHeight || 110;
      const bottom = document.documentElement.scrollHeight - window.innerHeight + composerHeight;
      window.scrollTo({ top: Math.max(0, bottom), behavior: 'smooth' });
    });
  }

  function addUserMessage(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-message ai-message-user';
    wrapper.innerHTML = `<div class="ai-bubble">${escapeHtml(text)}</div>`;
    messages.appendChild(wrapper);
    scrollMessages();
  }

  function addLoadingMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-message ai-message-assistant ai-loading-row';
    wrapper.innerHTML = `<div class="ai-message-label">AI 值班台</div><div class="ai-bubble ai-loading" aria-label="正在查找校园资料"><span></span><span></span><span></span><em>正在翻查校园资料</em></div>`;
    messages.appendChild(wrapper);
    scrollMessages();
    return wrapper;
  }

  function renderSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return '';
    return `<div class="ai-sources"><div class="ai-sources-heading"><span>本次参考</span><b>${sources.length} 条资料</b></div>${sources.map((source, index) => {
      const number = String(source.index || index + 1).padStart(2, '0');
      const date = source.verifiedAt ? `核实于 ${String(source.verifiedAt).slice(0, 10)}` : source.sourceDate ? `资料日期 ${source.sourceDate}` : '本站整理资料';
      const url = safeHttpUrl(source.url);
      const tag = url ? '官方来源' : '整理资料';
      const inner = `<span class="ai-source-index">${number}</span><span class="ai-source-copy"><b>${escapeHtml(source.title)}</b><small><i></i>${escapeHtml(tag)} · ${escapeHtml(date)}</small></span><span class="ai-source-arrow">↗</span>`;
      return url ? `<a class="ai-source-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="ai-source-card ai-source-card-static">${inner}</div>`;
    }).join('')}</div>`;
  }

  function addAssistantMessage(answer, sources, isError) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-message ai-message-assistant${isError ? ' ai-message-error' : ''}`;
    wrapper.innerHTML = `<div class="ai-message-label">${isError ? '暂未查到' : 'AI 值班台'}</div><div class="ai-bubble">${escapeHtml(answer).replace(/\n/g, '<br>')}</div>${renderSources(sources)}${isError ? '' : '<div class="ai-answer-actions"><button type="button" data-copy-answer>复制回答</button><span>办理前请核对官方通知</span></div>'}`;
    messages.appendChild(wrapper);
    wrapper.querySelector('[data-copy-answer]')?.addEventListener('click', async (event) => {
      try { await navigator.clipboard.writeText(answer); event.currentTarget.textContent = '已复制'; }
      catch (error) { event.currentTarget.textContent = '复制失败'; }
    });
    scrollMessages();
  }

  async function ask(question) {
    const cleanQuestion = String(question || '').trim();
    if (cleanQuestion.length < 2 || sendButton.disabled) return;
    if (location.hash !== '#/ai') location.hash = '#/ai';
    suggestions.hidden = true;
    recentSection.hidden = true;
    addUserMessage(cleanQuestion);
    saveQuestion(cleanQuestion);
    input.value = '';
    input.style.height = '';
    sendButton.disabled = true;
    const loading = addLoadingMessage();

    try {
      if (!window.Api?.askCampusAI) throw new Error('校园助手前端尚未完成配置');
      const result = await window.Api.askCampusAI(cleanQuestion);
      loading.remove();
      addAssistantMessage(result.answer, result.sources || [], false);
      if (remaining && Number.isFinite(result.remaining)) remaining.textContent = `本小时还可提问 ${result.remaining} 次`;
    } catch (error) {
      loading.remove();
      addAssistantMessage(error.message || '校园助手暂时不可用，请稍后再试。', [], true);
    } finally {
      sendButton.disabled = false;
      if (!matchMedia('(pointer: coarse)').matches) input.focus();
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 108)}px`; });
  suggestions.addEventListener('click', (event) => { const button = event.target.closest('[data-question]'); if (button) ask(button.dataset.question); });
  recentList.addEventListener('click', (event) => { const button = event.target.closest('[data-recent-question]'); if (button) ask(button.dataset.recentQuestion); });
  clearHistory.addEventListener('click', () => { try { localStorage.removeItem('sdtbu_ai_recent_questions'); } catch (error) {} renderHistory(); });

  renderHistory();
})();
