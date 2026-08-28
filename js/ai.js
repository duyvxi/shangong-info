(function () {
  'use strict';

  const launcher = document.getElementById('ai-launcher');
  const panel = document.getElementById('ai-panel');
  const closeButton = document.getElementById('ai-close');
  const messages = document.getElementById('ai-messages');
  const form = document.getElementById('ai-form');
  const input = document.getElementById('ai-input');
  const sendButton = document.getElementById('ai-send');
  const remaining = document.getElementById('ai-remaining');
  const suggestions = document.getElementById('ai-suggestions');

  if (!launcher || !panel || !messages || !form || !input || !sendButton) return;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    document.body.classList.add('ai-panel-open');
    requestAnimationFrame(() => panel.classList.add('is-open'));
    setTimeout(() => input.focus(), 180);
  }

  function closePanel() {
    panel.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('ai-panel-open');
    setTimeout(() => {
      if (!panel.classList.contains('is-open')) panel.hidden = true;
    }, 180);
    launcher.focus();
  }

  function scrollMessages() {
    messages.scrollTop = messages.scrollHeight;
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
    wrapper.innerHTML = `
      <div class="ai-message-label">AI 值班台</div>
      <div class="ai-bubble ai-loading" aria-label="正在查找校园资料">
        <span></span><span></span><span></span>
        <em>正在翻查校园资料</em>
      </div>`;
    messages.appendChild(wrapper);
    scrollMessages();
    return wrapper;
  }

  function renderSources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return '';
    const cards = sources.map((source) => {
      const date = source.verifiedAt
        ? `核实于 ${escapeHtml(String(source.verifiedAt).slice(0, 10))}`
        : source.sourceDate
          ? `资料日期 ${escapeHtml(source.sourceDate)}`
          : '核实日期未记录';
      const title = `<span class="ai-source-index">${source.index}</span><span>${escapeHtml(source.title)}</span>`;
      const sourceUrl = safeHttpUrl(source.url);
      return sourceUrl
        ? `<a class="ai-source-card" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">${title}<small>${date} · 查看官方来源 ↗</small></a>`
        : `<div class="ai-source-card ai-source-card-static">${title}<small>${date} · 本站整理资料</small></div>`;
    }).join('');
    return `<div class="ai-sources"><div class="ai-sources-title">本次参考</div>${cards}</div>`;
  }

  function addAssistantMessage(answer, sources, isError) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-message ai-message-assistant${isError ? ' ai-message-error' : ''}`;
    const safeAnswer = escapeHtml(answer).replace(/\n/g, '<br>');
    wrapper.innerHTML = `
      <div class="ai-message-label">${isError ? '未能回答' : 'AI 值班台'}</div>
      <div class="ai-bubble">${safeAnswer}</div>
      ${renderSources(sources)}`;
    messages.appendChild(wrapper);
    scrollMessages();
  }

  async function ask(question) {
    const cleanQuestion = String(question || '').trim();
    if (cleanQuestion.length < 2 || sendButton.disabled) return;

    addUserMessage(cleanQuestion);
    input.value = '';
    input.style.height = '';
    sendButton.disabled = true;
    if (suggestions) suggestions.hidden = true;
    const loading = addLoadingMessage();

    try {
      if (!window.Api || typeof window.Api.askCampusAI !== 'function') {
        throw new Error('校园助手前端尚未完成配置');
      }
      const result = await window.Api.askCampusAI(cleanQuestion);
      loading.remove();
      addAssistantMessage(result.answer, result.sources || [], false);
      if (remaining && Number.isFinite(result.remaining)) {
        remaining.textContent = `本小时还可提问 ${result.remaining} 次`;
      }
    } catch (error) {
      loading.remove();
      addAssistantMessage(error.message || '校园助手暂时不可用，请稍后再试。', [], true);
    } finally {
      sendButton.disabled = false;
      input.focus();
    }
  }

  launcher.addEventListener('click', () => {
    if (panel.hidden || !panel.classList.contains('is-open')) openPanel();
    else closePanel();
  });
  closeButton?.addEventListener('click', closePanel);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ask(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  });

  suggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-question]');
    if (button) ask(button.dataset.question);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) closePanel();
  });
})();
