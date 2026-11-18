(function () {
  'use strict';

  const panel = document.getElementById('ai-panel');
  const messages = document.getElementById('ai-messages');
  const form = document.getElementById('ai-form');
  const input = document.getElementById('ai-input');
  const inputError = document.getElementById('ai-input-error');
  const sendButton = document.getElementById('ai-send');
  const newQuestionButton = document.getElementById('ai-new-question');
  const remaining = document.getElementById('ai-remaining');
  const suggestions = document.getElementById('ai-suggestions');
  const recentSection = document.getElementById('recent-questions');
  const recentList = document.getElementById('recent-question-list');
  const clearHistory = document.getElementById('clear-ai-history');
  let currentRequest = null;
  let showCancellationOnReturn = false;
  let heightAtFocus = 0;
  const conversation = window.AIConversation?.createSession(2);

  if (!messages || !form || !input || !sendButton) return;
  const initialPlaceholder = input.placeholder;

  function setQuestionError(text) {
    inputError.textContent = text;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

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
    recentSection.hidden = !history.length || panel.classList.contains('is-chatting');
    if (!history.length) { recentList.innerHTML = ''; return; }
    recentList.innerHTML = history.map((question) => `<button type="button" data-recent-question="${escapeHtml(question)}"><span>${escapeHtml(question)}</span><b>再次提问</b></button>`).join('');
  }

  function scrollMessages() {
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }

  function cancelCurrentRequest(showNotice) {
    const request = currentRequest;
    if (!request) return;
    // 先解绑旧请求，防止迟到的响应或清理动作影响下一个问题。
    currentRequest = null;
    request.controller.abort();
    request.cancel(showNotice);
    sendButton.disabled = false;
  }

  function startNewQuestion() {
    cancelCurrentRequest(false);
    showCancellationOnReturn = false;
    conversation?.clear();
    messages.replaceChildren();
    input.value = '';
    input.style.height = '';
    setQuestionError('');
    input.placeholder = initialPlaceholder;
    panel.classList.remove('is-chatting');
    renderHistory();
    window.scrollTo(0, 0);
    input.focus();
  }

  function updateVisibleHeight() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // 手机键盘展开时腾出底栏空间，让发送按钮留在可见区域。
    const keyboardOpen = document.activeElement === input && heightAtFocus - viewport.height > 100;
    document.body.classList.toggle('ai-keyboard-open', keyboardOpen);
    if (keyboardOpen) panel.style.setProperty('--ai-visible-height', `${viewport.height}px`);
    else panel.style.removeProperty('--ai-visible-height');
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
    const entries = sources.map((source) => {
      const url = safeHttpUrl(source.url);
      const sourceTags = { official_notice: '官方来源', manual: '学生整理', curated: '本站整理' };
      const tag = sourceTags[source.sourceType] || '参考资料';
      const date = source.sourceDate
        ? `资料日期 ${String(source.sourceDate).slice(0, 10)}`
        : source.verifiedAt ? `核实于 ${String(source.verifiedAt).slice(0, 10)}` : '';
      const metadata = [...new Set([tag, source.sourceLabel, date].filter(Boolean))].map(escapeHtml).join(' · ');
      const historical = source.referenceMode === 'historical_reference';
      const notice = historical ? `<div class="ai-source-time">${source.noticeYear ? `${escapeHtml(source.noticeYear)} 年资料` : '往年资料'}仅供参考</div>` : '';
      const action = source.sourceType === 'official_notice' ? '查看官方原文' : '查看来源';
      const link = url ? `<a class="ai-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${action}<svg aria-hidden="true"><use href="#icon-external"></use></svg></a>` : '';
      return `<div class="ai-source-entry"><b>${escapeHtml(source.title)}</b><small>${metadata}</small>${notice}${link}</div>`;
    });
    // 首条依据直接可读，其他资料按需展开。
    const more = entries.length > 1 ? `<details class="ai-sources-more"><summary>展开其余 ${entries.length - 1} 条资料</summary>${entries.slice(1).join('')}</details>` : '';
    return `<section class="ai-sources" aria-label="回答依据"><h3 class="ai-sources-heading"><span>回答依据</span><small>${entries.length} 条</small></h3>${entries[0]}${more}</section>`;
  }

  function renderAnswerText(bubble, answer, plain = false) {
    const escaped = escapeHtml(answer).replace(/\n/g, '<br>');
    bubble.innerHTML = plain ? escaped : window.SafeMarkdown?.render(answer) || escaped;
    if (plain) return;
    // 只高亮已有的明确时效提示，避免替回答推断日期或状态。
    for (const block of bubble.querySelectorAll(':scope > :is(h2,h3,h4,p,blockquote)')) {
      const text = block.textContent.trim();
      const cutoff = /^(?:20\d{2}\s*年\s*)?(?:[\p{Script=Han}]{0,8})?报名(?:窗口)?(?:已截止|已结束)(?:[。！：，]|$)/u;
      const historical = /^(?:20\d{2}\s*年\s*|往年|历史)(?:资料|通知|安排)(?:[，。 ]*)仅供参考/u;
      if (cutoff.test(text) || historical.test(text)) block.classList.add('ai-time-notice');
    }
  }

  function renderRetry(question) {
    return question ? `<button class="ai-retry" type="button" data-retry-question="${escapeHtml(question)}">再次提问</button>` : '';
  }

  function renderFollowUps(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="ai-follow-ups" role="group" aria-label="继续提问">${items.map((item) =>
      `<button type="button" data-follow-up="${escapeHtml(item.question)}">${escapeHtml(item.label)}</button>`
    ).join('')}</div>`;
  }

  function followUpsFor(question, meta = {}) {
    return window.AIConversation?.buildFollowUps(question, meta.questionDimensions || []) || [];
  }

  function bindCopy(container, getAnswer) {
    const button = container.querySelector('[data-copy-answer]');
    button?.addEventListener('click', async () => {
      const answer = getAnswer();
      const plainText = window.SafeMarkdown?.toPlainText(answer) || answer;
      try { await navigator.clipboard.writeText(plainText); button.textContent = '已复制'; }
      catch (error) { button.textContent = '复制失败'; }
    });
  }

  const answerActions = '<div class="ai-answer-actions"><span>办理前请核对官方通知</span><button type="button" data-copy-answer>复制回答</button></div>';

  function addAssistantMessage(answer, sources, isError, followUps = [], retryQuestion = '', statusLabel = '') {
    const wrapper = document.createElement('div');
    const label = statusLabel || (retryQuestion ? '提问失败' : isError ? '暂未查到' : 'AI 值班台');
    wrapper.className = `ai-message ai-message-assistant${isError ? ' ai-message-error' : ''}`;
    wrapper.innerHTML = `<div class="ai-message-label">${escapeHtml(label)}</div><div class="ai-bubble${isError ? '' : ' ai-markdown'}" aria-live="polite"></div>${renderSources(sources)}${isError ? renderRetry(retryQuestion) : answerActions}${renderFollowUps(followUps)}`;
    messages.appendChild(wrapper);
    renderAnswerText(wrapper.querySelector('.ai-bubble'), answer, isError);
    bindCopy(wrapper, () => answer);
    scrollMessages();
  }

  function addStreamingMessage(initialSources = []) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-message ai-message-assistant ai-message-streaming';
    wrapper.innerHTML = '<div class="ai-message-label">AI 值班台</div><div class="ai-bubble ai-markdown" aria-live="polite"></div><div class="ai-stream-status" role="status">正在组织回答…</div><div data-stream-sources></div><div data-stream-actions></div><div data-stream-follow-ups></div>';
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
      // 用户往上阅读时，继续接收回答也不把页面拉回末尾。
      const followLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      renderAnswerText(bubble, answer);
      if (!hasVisibleText && answer) {
        hasVisibleText = true;
        wrapper.classList.add('has-stream-text');
      }
      if (followLatest) scrollMessages();
    };
    const scheduleRender = (fullAnswer) => {
      answer = fullAnswer;
      const wait = Math.max(0, 80 - (performance.now() - lastRenderAt));
      if (!hasVisibleText || wait === 0) renderAnswer();
      else if (!renderTimer) renderTimer = setTimeout(renderAnswer, wait);
    };
    const addActions = () => {
      actionSlot.innerHTML = answerActions;
      bindCopy(actionSlot, () => answer);
    };

    scrollMessages();
    return {
      setSources(sources) { sourceSlot.innerHTML = renderSources(sources); },
      update(fullAnswer) { scheduleRender(fullAnswer); },
      finish(fullAnswer, sources) {
        answer = fullAnswer || answer;
        if (renderTimer) clearTimeout(renderTimer);
        renderAnswer();
        if (sources?.length && !sourceSlot.hasChildNodes()) this.setSources(sources);
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
      interrupt(message, question) {
        if (renderTimer) clearTimeout(renderTimer);
        renderAnswer();
        wrapper.classList.remove('ai-message-streaming');
        wrapper.classList.add('ai-message-interrupted');
        status.textContent = message || '回答中断，可重试';
        addActions();
        actionSlot.insertAdjacentHTML('beforeend', renderRetry(question));
        scrollMessages();
      },
      discard() {
        if (renderTimer) clearTimeout(renderTimer);
        wrapper.remove();
      },
      get hasText() { return Boolean(answer); },
    };
  }

  async function ask(question) {
    const cleanQuestion = String(question || '').trim();
    if (sendButton.disabled) return;
    if (cleanQuestion.length < 2) {
      setQuestionError('请至少输入两个字符再发送。');
      input.focus();
      return;
    }
    setQuestionError('');
    if (location.hash !== '#/ai') location.hash = '#/ai';
    panel.classList.add('is-chatting');
    input.placeholder = '继续问一个校园问题';
    window.scrollTo(0, 0);
    addUserMessage(cleanQuestion);
    saveQuestion(cleanQuestion);
    input.value = '';
    input.style.height = '';
    sendButton.disabled = true;
    const loading = addLoadingMessage();
    const requestController = new AbortController();
    const { signal } = requestController;
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
    const request = {
      controller: requestController,
      cancel(showNotice) {
        loading.remove();
        // 已收到的片段留在对话里，未收到的回答改为明确的取消提示。
        if (showNotice && streamView?.hasText) {
          streamView.interrupt('提问已取消，已保留收到的内容。', cleanQuestion);
          return;
        }
        streamView?.discard();
        if (showNotice) addAssistantMessage('离开对话时已停止本次回答。', [], true, [], cleanQuestion, '提问已取消');
      },
    };
    currentRequest = request;

    try {
      if (!window.Api?.askCampusAIStream) throw new Error('校园助手前端尚未完成配置');
      const result = await window.Api.askCampusAIStream(cleanQuestion, {
        onMeta(meta) {
          if (signal.aborted) return;
          streamMeta = meta || {};
          ensureStreamView().setSources(streamMeta.sources || []);
          if (remaining && Number.isFinite(streamMeta.remaining)) remaining.textContent = `本小时还可提问 ${streamMeta.remaining} 次`;
        },
        onDelta(_delta, fullAnswer) {
          if (!signal.aborted) ensureStreamView().update(fullAnswer);
        },
        onDone(done, fullAnswer) {
          if (!signal.aborted) ensureStreamView().finish(fullAnswer, streamMeta.sources || done.sources || []);
        },
      }, { signal, context });
      if (signal.aborted) return;
      if (result.noMatch === true) {
        loading.remove();
        if (streamView) streamView.markNoMatch(result.answer);
        else addAssistantMessage(result.answer, result.sources || [], true);
      } else if (!streamView) {
        loading.remove();
        const followUps = followUpsFor(cleanQuestion, result);
        conversation?.add(cleanQuestion, result.answer);
        messages.querySelectorAll('.ai-follow-ups').forEach((items) => items.remove());
        addAssistantMessage(result.answer, result.sources || [], false, followUps);
      } else {
        conversation?.add(cleanQuestion, result.answer);
        // 跟进按钮依赖最近一轮话题，只在最近一条成功回答上保留。
        messages.querySelectorAll('.ai-follow-ups').forEach((items) => items.remove());
        streamView.setFollowUps(followUpsFor(cleanQuestion, streamMeta));
      }
      if (remaining && Number.isFinite(result.remaining)) remaining.textContent = `本小时还可提问 ${result.remaining} 次`;
    } catch (error) {
      if (signal.aborted) return;
      loading.remove();
      if (streamView?.hasText || error.partialAnswer) {
        const partialView = ensureStreamView();
        if (!partialView.hasText) partialView.update(error.partialAnswer);
        partialView.interrupt('回答中断，已保留收到的内容。', cleanQuestion);
      } else {
        const label = ['MODEL_INCOMPLETE', 'STREAM_INCOMPLETE'].includes(error.code) ? '回答中断' : '';
        addAssistantMessage(error.message || '校园助手暂时不可用，请稍后再试。', [], true, [], cleanQuestion, label);
      }
    } finally {
      if (currentRequest === request) {
        currentRequest = null;
        sendButton.disabled = false;
        if (location.hash === '#/ai' && !matchMedia('(pointer: coarse)').matches) input.focus();
      }
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); ask(input.value); });
  newQuestionButton.addEventListener('click', startNewQuestion);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    if (inputError.textContent && input.value.trim().length >= 2) setQuestionError('');
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 108)}px`;
  });
  suggestions.addEventListener('click', (event) => { const button = event.target.closest('[data-question]'); if (button) ask(button.dataset.question); });
  recentList.addEventListener('click', (event) => { const button = event.target.closest('[data-recent-question]'); if (button) ask(button.dataset.recentQuestion); });
  messages.addEventListener('click', (event) => {
    const button = event.target.closest('[data-follow-up], [data-retry-question]');
    if (button) ask(button.dataset.followUp || button.dataset.retryQuestion);
  });
  input.addEventListener('focus', () => { heightAtFocus = window.visualViewport?.height || 0; });
  input.addEventListener('blur', updateVisibleHeight);
  window.visualViewport?.addEventListener('resize', updateVisibleHeight);
  clearHistory.addEventListener('click', () => {
    if (!window.confirm('清空最近提问？清空后无法恢复。')) return;
    try { localStorage.removeItem('sdtbu_ai_recent_questions'); } catch (error) {}
    renderHistory();
    input.focus();
  });
  window.addEventListener('hashchange', (event) => {
    if (new URL(event.newURL).hash !== '#/ai') {
      if (!currentRequest) return;
      showCancellationOnReturn = true;
      cancelCurrentRequest(true);
    } else if (showCancellationOnReturn) {
      // 对话重新显示后再滚动，确保长对话里的取消提示也能看到。
      showCancellationOnReturn = false;
      scrollMessages();
    }
  });
  window.addEventListener('pagehide', (event) => cancelCurrentRequest(event.persisted));

  renderHistory();
})();
