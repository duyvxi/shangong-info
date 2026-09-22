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
  let currentRequestController = null;
  const conversation = window.AIConversation?.createSession(2);

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
    const cards = sources.map((source, index) => {
      const number = String(source.index || index + 1).padStart(2, '0');
      const date = source.verifiedAt ? `核实于 ${String(source.verifiedAt).slice(0, 10)}` : source.sourceDate ? `资料日期 ${source.sourceDate}` : '本站整理资料';
      const url = safeHttpUrl(source.url);
      const sourceTags = { official_notice: '官方来源', manual: '学生整理', curated: '本站整理' };
      const tag = sourceTags[source.sourceType] || (url ? '参考链接' : '整理资料');
      const inner = `<span class="ai-source-index">${number}</span><span class="ai-source-copy"><b>${escapeHtml(source.title)}</b><small><i></i>${escapeHtml(tag)} · ${escapeHtml(date)}</small></span><span class="ai-source-arrow">↗</span>`;
      return url ? `<a class="ai-source-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="ai-source-card ai-source-card-static">${inner}</div>`;
    }).join('');
    return `<details class="ai-sources"><summary class="ai-sources-heading"><span>本次参考</span><span class="ai-sources-summary"><b>${sources.length} 条资料</b><i aria-hidden="true">⌄</i></span></summary><div class="ai-source-list">${cards}</div></details>`;
  }

  function renderFollowUps(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="ai-follow-ups" aria-label="继续了解"><div class="ai-follow-ups-heading"><span>继续了解</span><b>按需补充</b></div><div>${items.map((item) =>
      `<button type="button" data-follow-up="${escapeHtml(item.question)}">${escapeHtml(item.label)}</button>`
    ).join('')}</div></div>`;
  }

  function followUpsFor(question, meta = {}) {
    return window.AIConversation?.buildFollowUps(question, meta.questionDimensions || []) || [];
  }

  function addAssistantMessage(answer, sources, isError, followUps = []) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-message ai-message-assistant${isError ? ' ai-message-error' : ''}`;
    const answerHtml = isError
      ? escapeHtml(answer).replace(/\n/g, '<br>')
      : window.SafeMarkdown?.render(answer) || escapeHtml(answer).replace(/\n/g, '<br>');
    wrapper.innerHTML = `<div class="ai-message-label">${isError ? '暂未查到' : 'AI 值班台'}</div><div class="ai-bubble${isError ? '' : ' ai-markdown'}">${answerHtml}</div>${renderSources(sources)}${isError ? '' : `<div class="ai-answer-actions"><button type="button" data-copy-answer>复制回答</button><span>办理前请核对官方通知</span></div>${renderFollowUps(followUps)}`}`;
    messages.appendChild(wrapper);
    wrapper.querySelector('[data-copy-answer]')?.addEventListener('click', async (event) => {
      const plainText = window.SafeMarkdown?.toPlainText(answer) || answer;
      try { await navigator.clipboard.writeText(plainText); event.currentTarget.textContent = '已复制'; }
      catch (error) { event.currentTarget.textContent = '复制失败'; }
    });
    scrollMessages();
  }

  function addStreamingMessage(initialSources = []) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-message ai-message-assistant ai-message-streaming';
    wrapper.innerHTML = '<div class="ai-message-label">AI 值班台</div><div class="ai-bubble ai-markdown" aria-live="polite"></div><div class="ai-stream-status">正在组织回答…</div><div data-stream-sources></div><div data-stream-actions></div><div data-stream-follow-ups></div>';
    messages.appendChild(wrapper);
    const bubble = wrapper.querySelector('.ai-bubble');
    const status = wrapper.querySelector('.ai-stream-status');
    const sourceSlot = wrapper.querySelector('[data-stream-sources]');
    const actionSlot = wrapper.querySelector('[data-stream-actions]');
    const followUpSlot = wrapper.querySelector('[data-stream-follow-ups]');
    let answer = '';
    let renderTimer = null;
    let lastRenderAt = 0;
    let hasVisibleText = false;

    sourceSlot.innerHTML = renderSources(initialSources);
    const renderAnswer = () => {
      renderTimer = null;
      lastRenderAt = performance.now();
      bubble.innerHTML = window.SafeMarkdown?.render(answer) || escapeHtml(answer).replace(/\n/g, '<br>');
      if (!hasVisibleText && answer) {
        hasVisibleText = true;
        wrapper.classList.add('has-stream-text');
      }
      scrollMessages();
    };
    const scheduleRender = (fullAnswer) => {
      answer = fullAnswer;
      const wait = Math.max(0, 80 - (performance.now() - lastRenderAt));
      if (!hasVisibleText || wait === 0) renderAnswer();
      else if (!renderTimer) renderTimer = setTimeout(renderAnswer, wait);
    };
    const addActions = () => {
      actionSlot.innerHTML = '<div class="ai-answer-actions"><button type="button" data-copy-answer>复制回答</button><span>办理前请核对官方通知</span></div>';
      actionSlot.querySelector('[data-copy-answer]')?.addEventListener('click', async (event) => {
        const plainText = window.SafeMarkdown?.toPlainText(answer) || answer;
        try { await navigator.clipboard.writeText(plainText); event.currentTarget.textContent = '已复制'; }
        catch (error) { event.currentTarget.textContent = '复制失败'; }
      });
    };

    scrollMessages();
    return {
      setSources(sources) { sourceSlot.innerHTML = renderSources(sources); },
      update(fullAnswer) { scheduleRender(fullAnswer); },
      finish(fullAnswer, sources) {
        answer = fullAnswer || answer;
        if (renderTimer) clearTimeout(renderTimer);
        renderAnswer();
        if (sources) this.setSources(sources);
        wrapper.classList.remove('ai-message-streaming');
        status.remove();
        addActions();
      },
      setFollowUps(items) { followUpSlot.innerHTML = renderFollowUps(items); },
      markNoMatch(message) {
        answer = message || answer;
        if (renderTimer) clearTimeout(renderTimer);
        bubble.classList.remove('ai-markdown');
        bubble.innerHTML = escapeHtml(answer).replace(/\n/g, '<br>');
        wrapper.classList.remove('ai-message-streaming');
        wrapper.classList.add('ai-message-error');
        wrapper.querySelector('.ai-message-label').textContent = '暂未查到';
        status.remove();
        sourceSlot.innerHTML = '';
        actionSlot.innerHTML = '';
        followUpSlot.innerHTML = '';
      },
      interrupt(message) {
        if (renderTimer) clearTimeout(renderTimer);
        renderAnswer();
        wrapper.classList.remove('ai-message-streaming');
        wrapper.classList.add('ai-message-interrupted');
        status.textContent = message || '回答中断，可重试';
        addActions();
      },
      get hasText() { return Boolean(answer); },
    };
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
    const requestController = new AbortController();
    currentRequestController = requestController;
    let streamView = null;
    let streamMeta = {};
    const context = conversation?.getContext() || [];
    const ensureStreamView = () => {
      if (!streamView) {
        loading.remove();
        streamView = addStreamingMessage(streamMeta.sources || []);
      }
      return streamView;
    };

    try {
      if (!window.Api?.askCampusAIStream) throw new Error('校园助手前端尚未完成配置');
      const result = await window.Api.askCampusAIStream(cleanQuestion, {
        onMeta(meta) {
          streamMeta = meta || {};
          ensureStreamView().setSources(streamMeta.sources || []);
          if (remaining && Number.isFinite(streamMeta.remaining)) remaining.textContent = `本小时还可提问 ${streamMeta.remaining} 次`;
        },
        onDelta(_delta, fullAnswer) { ensureStreamView().update(fullAnswer); },
        onDone(done, fullAnswer) {
          ensureStreamView().finish(fullAnswer, streamMeta.sources || done.sources || []);
        },
      }, { signal: requestController.signal, context });
      if (result.noMatch === true) {
        loading.remove();
        if (streamView) streamView.markNoMatch(result.answer);
        else addAssistantMessage(result.answer, result.sources || [], true);
      } else if (!streamView) {
        loading.remove();
        const followUps = followUpsFor(cleanQuestion, result);
        conversation?.add(cleanQuestion, result.answer);
        addAssistantMessage(result.answer, result.sources || [], false, followUps);
      } else {
        conversation?.add(cleanQuestion, result.answer);
        streamView.setFollowUps(followUpsFor(cleanQuestion, streamMeta));
      }
      if (remaining && Number.isFinite(result.remaining)) remaining.textContent = `本小时还可提问 ${result.remaining} 次`;
    } catch (error) {
      loading.remove();
      if (requestController.signal.aborted && location.hash !== '#/ai') return;
      if (streamView?.hasText || error.partialAnswer) {
        streamView?.interrupt('回答中断，可点击“再次提问”重试');
      } else {
        addAssistantMessage(error.message || '校园助手暂时不可用，请稍后再试。', [], true);
      }
    } finally {
      if (currentRequestController === requestController) currentRequestController = null;
      sendButton.disabled = false;
      if (location.hash === '#/ai' && !matchMedia('(pointer: coarse)').matches) input.focus();
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 108)}px`; });
  suggestions.addEventListener('click', (event) => { const button = event.target.closest('[data-question]'); if (button) ask(button.dataset.question); });
  recentList.addEventListener('click', (event) => { const button = event.target.closest('[data-recent-question]'); if (button) ask(button.dataset.recentQuestion); });
  messages.addEventListener('click', (event) => { const button = event.target.closest('[data-follow-up]'); if (button) ask(button.dataset.followUp); });
  clearHistory.addEventListener('click', () => { try { localStorage.removeItem('sdtbu_ai_recent_questions'); } catch (error) {} renderHistory(); });
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#/ai') currentRequestController?.abort();
  });
  window.addEventListener('pagehide', () => currentRequestController?.abort());

  renderHistory();
})();
