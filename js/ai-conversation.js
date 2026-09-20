(function (root) {
  'use strict';

  const VERSION = '1.0.0';

  function clean(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
  }

  function createSession(maxTurns = 2) {
    const limit = Math.max(1, Math.min(Number(maxTurns) || 2, 2));
    const turns = [];
    return Object.freeze({
      add(question, answer) {
        const cleanQuestion = clean(question, 500);
        const cleanAnswer = clean(answer, 2000);
        if (!cleanQuestion || !cleanAnswer) return;
        turns.push({ question: cleanQuestion, answer: cleanAnswer });
        if (turns.length > limit) turns.splice(0, turns.length - limit);
      },
      getContext() {
        return turns.map((turn) => ({ ...turn }));
      },
      clear() { turns.length = 0; },
    });
  }

  function buildFollowUps(question, dimensions = []) {
    const text = clean(question, 500);
    const asked = new Set(Array.isArray(dimensions) ? dimensions : []);
    let options;
    if (/公交|路线|路车|校车|乘车|车站/.test(text)) {
      options = [
        ['查看途经站点', '这条线路具体经过哪些站点？'],
        ['查看乘车位置', '应该在哪里乘车？'],
        ['查看运营时间', '运营时间是什么？'],
      ];
    } else if (/餐厅|食堂|档口|吃饭|营业/.test(text)) {
      options = [
        ['查看营业时间', '营业时间是什么？'],
        ['查看具体位置', '具体位置在哪里？'],
        ['查看其他选择', '还有哪些类似的选择？'],
      ];
    } else if (/宿舍|公寓|电器|住宿/.test(text)) {
      options = [
        ['查看禁止事项', '还有哪些禁止事项？'],
        ['查看违规后果', '违反规定会怎样？'],
        ['查看住宿要求', '还有哪些住宿要求？'],
      ];
    } else {
      options = [
        ['查看申请条件', '申请条件和限制是什么？', '条件'],
        ['查看材料清单', '需要准备什么材料？', '材料'],
        ['查看时间安排', '时间安排是什么？', '时间'],
        ['查看办理流程', '具体办理流程是什么？', '流程'],
      ].filter((item) => !asked.has(item[2])).slice(0, 3);
    }
    return options.map(([label, followUpQuestion]) => ({ label, question: followUpQuestion }));
  }

  root.AIConversation = Object.freeze({ VERSION, createSession, buildFollowUps });
})(typeof window !== 'undefined' ? window : globalThis);
