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
        buffer += String(chunk || '').replace(/\r\n?/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          dispatch(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      },
      finish() {
        if (buffer.trim()) dispatch(buffer);
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

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
    if (streamError) throw streamError;
    if (!state.done) {
      const error = new Error('回答连接提前结束，可重试');
      error.code = 'STREAM_INCOMPLETE';
      error.partialAnswer = state.answer;
      throw error;
    }
    return { ...state.meta, ...state.done, answer: state.answer };
  }

  root.AIStream = Object.freeze({ VERSION, createParser, consumeResponse });
})(typeof window !== 'undefined' ? window : globalThis);
