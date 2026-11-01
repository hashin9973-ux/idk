'use strict';

const SECRET_KEY = /(?:token|secret|password|authorization|api[_-]?key|private[_-]?key|credential|session[_-]?id)/i;
const CODE_FIELD = /^(?:content|stdout|stderr|diff|patch|stack|trace|script|source|html|sql|command_output)$/i;
const HIDDEN_FIELDS = new Set(['protocol']);

function titleCase(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\b\w/g, char => char.toUpperCase());
}

function safeFence(value) {
  const matches = String(value).match(/`+/g) || [];
  return '`'.repeat(Math.max(3, ...matches.map(item => item.length + 1)));
}

function parseJsonText(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!/^[\[{]/.test(text)) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : value;
  } catch { return value; }
}

function renderScalar(value, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return String(value);
}

function renderMarkdownValue(value, key = 'Details', depth = 0) {
  const indent = '  '.repeat(Math.min(depth, 8));
  if (SECRET_KEY.test(key)) return [indent + '- **' + titleCase(key) + ':** [redacted]'];
  value = parseJsonText(value);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    const text = renderScalar(value, key);
    if (typeof value === 'string' && (CODE_FIELD.test(key) || /[\r\n]/.test(value))) {
      const fence = safeFence(value);
      return [indent + '**' + titleCase(key) + '**', indent + fence, ...value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(line => indent + line), indent + fence];
    }
    return [indent + '- **' + titleCase(key) + ':** ' + text];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [indent + '- **' + titleCase(key) + ':** *(none)*'];
    const lines = [indent + '**' + titleCase(key) + '**'];
    value.forEach((item, index) => {
      if (item && typeof item === 'object') {
        lines.push(indent + (index + 1) + '.');
        lines.push(...renderMarkdownValue(item, 'Item', depth + 1));
      } else {
        lines.push(indent + '- ' + renderScalar(item));
      }
    });
    return lines;
  }
  const entries = Object.entries(value).filter(([field]) => !HIDDEN_FIELDS.has(field));
  if (!entries.length) return [indent + '- **' + titleCase(key) + ':** *(empty)*'];
  const lines = depth === 0 ? [] : [indent + '**' + titleCase(key) + '**'];
  for (const [field, nested] of entries) {
    if (nested && typeof nested === 'object') {
      lines.push(...renderMarkdownValue(nested, field, depth + 1));
    } else {
      lines.push(...renderMarkdownValue(nested, field, depth));
    }
  }
  return lines;
}

function formatToolResultMarkdown(tool, output, maxChars = 48000) {
  let value = parseJsonText(output);
  const status = value && typeof value === 'object' && !Array.isArray(value)
    ? String(value.status || 'success') : 'success';
  const error = value && typeof value === 'object' && !Array.isArray(value)
    ? value.error : null;
  let result = value;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'result')) {
    result = value.result;
  }
  const lines = ['### Tool result: `/' + String(tool || 'unknown_tool').replace(/[^a-zA-Z0-9_.:-]/g, '_') + '`',
    '- **Status:** ' + status];
  if (error) lines.push('- **Error:** ' + renderScalar(error, 'error'));
  if (result !== undefined && result !== null) {
    lines.push('', '#### Result', ...renderMarkdownValue(result, 'Result'));
  }
  let rendered = lines.join('\n').trim();
  if (rendered.length > maxChars) {
    rendered = rendered.slice(0, maxChars) + '\n\n> Tool output was shortened for model context. Request a narrower path, line range, or smaller result.';
  }
  return rendered;
}

module.exports = { formatToolResultMarkdown };
