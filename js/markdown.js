(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const ALLOWED_TAGS = new Set([
    'p', 'strong', 'b', 'em', 'i', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'br', 'hr',
  ]);
  const BLOCKED_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form',
    'input', 'button', 'textarea', 'select', 'option', 'meta', 'link', 'base',
  ]);

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function decodeHtmlEntities(value) {
    return String(value || '')
      .replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
      .replace(/&#x([\da-f]+);?/gi, (_, code) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
      .replace(/&colon;?/gi, ':')
      .replace(/&tab;?/gi, '\t')
      .replace(/&newline;?/gi, '\n')
      .replace(/&amp;/gi, '&');
  }

  function safeHttpUrl(value) {
    const decoded = decodeHtmlEntities(value).trim().replace(/[\u0000-\u001f\u007f]+/g, '');
    if (!decoded || decoded === '#') return '';
    try {
      const base = root.location?.href || 'https://example.invalid/';
      const url = new URL(decoded, base);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function stripRawHtml(value) {
    return String(value || '')
      .replace(/<!--[^]*?-->/g, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|form)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
      .replace(/<\/?[a-z][^>]*>/gi, '');
  }

  function sanitizeWithDom(html) {
    if (!root.document?.createElement) return null;
    const template = root.document.createElement('template');
    template.innerHTML = String(html || '');

    function unwrap(node) {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    }

    function clean(parent) {
      for (const node of Array.from(parent.childNodes || [])) {
        if (node.nodeType === 8) {
          node.remove();
          continue;
        }
        if (node.nodeType !== 1) continue;
        const tag = node.tagName.toLowerCase();
        if (BLOCKED_TAGS.has(tag)) {
          node.remove();
          continue;
        }
        clean(node);
        if (!ALLOWED_TAGS.has(tag)) {
          unwrap(node);
          continue;
        }
        const href = tag === 'a' ? safeHttpUrl(node.getAttribute('href')) : '';
        for (const attribute of Array.from(node.attributes || [])) node.removeAttribute(attribute.name);
        if (tag === 'a') {
          if (!href) {
            unwrap(node);
            continue;
          }
          node.setAttribute('href', href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    }

    clean(template.content);
    return template.innerHTML;
  }

  function sanitizeWithoutDom(html) {
    let output = String(html || '').replace(/<!--[^]*?-->/g, '');
    for (const tag of BLOCKED_TAGS) {
      output = output.replace(new RegExp(`<${tag}\\b[^>]*>[^]*?<\\/${tag}\\s*>`, 'gi'), '');
    }
    return output.replace(/<\/?([a-z][\w-]*)(?:\s[^>]*)?>/gi, (token, rawTag) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (/^<\s*\//.test(token)) return ['br', 'hr'].includes(tag) ? '' : `</${tag}>`;
      if (tag === 'br' || tag === 'hr') return `<${tag}>`;
      if (tag !== 'a') return `<${tag}>`;
      const hrefMatch = token.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
      const href = safeHttpUrl(hrefMatch?.[2]);
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">` : '';
    });
  }

  function sanitizeHtml(html) {
    return sanitizeWithDom(html) ?? sanitizeWithoutDom(html);
  }

  function renderInline(value) {
    const tokens = [];
    let source = String(value || '').replace(/[\uE000\uE001]/g, '�');
    const hold = (html) => {
      const marker = `\uE000${tokens.length}\uE001`;
      tokens.push(html);
      return marker;
    };

    source = source.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
    source = stripRawHtml(source);
    source = source.replace(/!\[([^\]\n]*)\]\([^\n)]*\)/g, (_, label) => hold(`<em>${escapeHtml(label || '图片')}</em>`));
    source = source.replace(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g, (_, label, hrefValue) => {
      const labelHtml = escapeHtml(label);
      const href = safeHttpUrl(hrefValue);
      return hold(href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
        : labelHtml);
    });

    let html = escapeHtml(source);
    html = html
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,，。])/g, '$1<em>$2</em>')
      .replace(/\*\*|__|`/g, '');
    return html.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || '');
  }

  function parseMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];
    let quoteLines = [];
    let codeFence = null;
    let codeLines = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listItems.length) return;
      output.push(`<${listType}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${listType}>`);
      listType = '';
      listItems = [];
    };
    const flushQuote = () => {
      if (!quoteLines.length) return;
      output.push(`<blockquote><p>${quoteLines.map(renderInline).join('<br>')}</p></blockquote>`);
      quoteLines = [];
    };
    const flushBlocks = () => { flushParagraph(); flushList(); flushQuote(); };
    const flushCode = () => {
      if (!codeFence) return;
      output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      codeFence = null;
      codeLines = [];
    };

    for (const line of lines) {
      const fence = line.match(/^\s*(```+|~~~+)\s*[^\s]*\s*$/);
      if (fence) {
        if (!codeFence) {
          flushBlocks();
          codeFence = fence[1][0];
        } else if (fence[1][0] === codeFence) {
          flushCode();
        } else {
          codeLines.push(line);
        }
        continue;
      }
      if (codeFence) {
        codeLines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushBlocks();
        continue;
      }
      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushBlocks();
        const level = Math.max(2, Math.min(6, heading[1].length));
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushBlocks();
        output.push('<hr>');
        continue;
      }
      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        flushQuote();
        const nextType = ordered ? 'ol' : 'ul';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push((ordered || unordered)[1]);
        continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        quoteLines.push(quote[1]);
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line.trim());
    }
    flushBlocks();
    flushCode();
    return output.join('');
  }

  function render(markdown) {
    return sanitizeHtml(parseMarkdown(markdown));
  }

  function toPlainText(markdown) {
    return stripRawHtml(markdown)
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]*(```+|~~~+)[ \t]*\S*[ \t]*$/gm, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*[-+*][ \t]+/gm, '• ')
      .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ')
      .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,，。])/g, '$1$2')
      .replace(/\*\*|__/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  root.SafeMarkdown = Object.freeze({ VERSION, render, sanitizeHtml, toPlainText });
})(typeof globalThis !== 'undefined' ? globalThis : window);
