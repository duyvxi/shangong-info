(function (root) {
  'use strict';

  const VERSION = '1.0.0';

  function createParser(onEvent) {
    let buffer = '';

    function dispatch(block) {
      const lines = block.split(/\r?\n/);
      let event = 'message';
      const data = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      const raw = data.join('\n');
      let payload = raw;
      try { payload = JSON.parse(raw); } catch (error) {}
      onEvent({ event, data: payload });
    }

    return {
      push(chunk) {
        buffer = (buffer + String(chunk || '')).replace(/\r\n|\r(?!$)/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          dispatch(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      },
      finish() {
        // 未收到空行的尾包不是完整事件。
        buffer = '';
      },
    };
  }

  async function consumeResponse(response, handlers = {}) {
    if (!response?.body?.getReader) throw new Error('当前浏览器不支持流式回答');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { answer: '', meta: {}, done: null };
    let streamError = null;
    const parser = createParser(({ event, data }) => {
      if (state.done || streamError) return;
      const payload = data && typeof data === 'object' ? data : {};
      if (event === 'meta') {
        state.meta = payload;
        handlers.onMeta?.(payload);
      } else if (event === 'delta') {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text) return;
        state.answer += text;
        handlers.onDelta?.(text, state.answer);
      } else if (event === 'done') {
        if (typeof payload.answer !== 'string' || !payload.answer.trim()) return;
        state.done = payload;
        if (typeof payload.answer === 'string' && payload.answer.length >= state.answer.length) {
          state.answer = payload.answer;
        }
        handlers.onDone?.(payload, state.answer);
      } else if (event === 'error') {
        streamError = new Error(payload.error || '回答中断，可重试');
        streamError.code = payload.code || 'STREAM_ERROR';
        streamError.partialAnswer = state.answer;
        handlers.onError?.(streamError, payload);
      }
    });

    function incomplete() {
      const error = new Error('回答中断，请点击“再次提问”重试');
      error.code = 'STREAM_INCOMPLETE';
      error.partialAnswer = state.answer;
      return error;
    }
    try {
      while (!state.done && !streamError) {
        const { value, done } = await reader.read().catch(() => { throw incomplete(); });
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      if (streamError) throw streamError;
      if (!state.done) throw incomplete();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return { ...state.meta, ...state.done, answer: state.answer };
  }

  root.AIStream = Object.freeze({ VERSION, createParser, consumeResponse });
})(typeof window !== 'undefined' ? window : globalThis);
