import { createHash } from 'node:crypto';

export function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function contentHash(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function splitLongParagraph(paragraph, maxChars) {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.split(/(?<=[。！？；!?;])/u).filter(Boolean);
  if (sentences.length <= 1) {
    const parts = [];
    for (let index = 0; index < paragraph.length; index += maxChars) {
      parts.push(paragraph.slice(index, index + maxChars));
    }
    return parts;
  }

  const parts = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      parts.push(current.trim());
      current = '';
    }
    if (sentence.length > maxChars) {
      if (current) parts.push(current.trim());
      current = '';
      for (let index = 0; index < sentence.length; index += maxChars) {
        parts.push(sentence.slice(index, index + maxChars).trim());
      }
    } else {
      current += sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

export function chunkDocument(document, options = {}) {
  const maxChars = Math.max(300, Math.min(Number(options.maxChars) || 760, 1600));
  const overlapChars = Math.max(0, Math.min(Number(options.overlapChars) || 100, 240));
  const title = normalizeWhitespace(document.title || '未命名资料');
  const content = normalizeWhitespace(document.content);
  if (!content) return [];

  const paragraphs = content
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLongParagraph(paragraph.trim(), maxChars))
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const separator = current ? '\n\n' : '';
    if (current && current.length + separator.length + paragraph.length > maxChars) {
      chunks.push(current.trim());
      const overlap = overlapChars > 0 ? current.slice(-overlapChars).trim() : '';
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
      if (current.length > maxChars + overlapChars) {
        chunks.push(current.slice(0, maxChars).trim());
        current = current.slice(maxChars - overlapChars).trim();
      }
    } else {
      current += `${separator}${paragraph}`;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.map((chunk, index) => ({
    chunk_index: index,
    title,
    content: chunk,
    content_hash: contentHash(`${title}\n${chunk}`),
  }));
}

