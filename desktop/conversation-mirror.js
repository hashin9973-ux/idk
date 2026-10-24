'use strict';

const MAX_MIRROR_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 18000;
const MAX_SNAPSHOT_CHARS = 120000;

// Serialized into the authenticated ChatGPT page. Returns only the current page
// viewport and a small overscan buffer; the remote conversation keeps its full context.
function extractConversationSnapshot() {
  const maxMessages = 16;
  const maxMessageChars = 18000;
  const maxSnapshotChars = 120000;
  const pathParts = String(location.pathname || '').split('/');
  const conversationIndex = pathParts.indexOf('c');
  const conversationId = conversationIndex >= 0 ? (pathParts[conversationIndex + 1] || '') : '';
  const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
  const visibleIndexes = [];
  roleNodes.forEach((node, index) => {
    const rect = node.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) visibleIndexes.push(index);
  });

  let start = visibleIndexes.length ? Math.max(0, visibleIndexes[0] - 3) : Math.max(0, roleNodes.length - 10);
  let end = visibleIndexes.length ? Math.min(roleNodes.length, visibleIndexes[visibleIndexes.length - 1] + 4) : roleNodes.length;
  if (end - start > maxMessages) start = Math.max(0, end - maxMessages);

  let remaining = maxSnapshotChars;
  const messages = roleNodes.slice(start, end).map((node, offset) => {
    const role = node.getAttribute('data-message-author-role') || 'assistant';
    const rect = node.getBoundingClientRect();
    const copy = node.cloneNode(true);
    copy.querySelectorAll('button, svg, [role="toolbar"], [data-testid*="feedback"], [aria-label*="Copy"]').forEach(item => item.remove());
    let text = String(copy.innerText || copy.textContent || '').trim();
    const imageAlts = Array.from(node.querySelectorAll('img[alt]'))
      .map(img => String(img.getAttribute('alt') || '').trim()).filter(Boolean).slice(0, 6);
    if (!text && imageAlts.length) text = imageAlts.map(alt => '[Image: ' + alt + ']').join('\n');
    text = text.slice(0, maxMessageChars);
    const allowed = Math.max(0, Math.min(text.length, remaining));
    const truncated = text.length > allowed;
    text = text.slice(0, allowed);
    remaining -= text.length;
    return {
      id: role + '-' + (start + offset),
      role,
      text,
      visible: rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight,
      hasCode: Boolean(node.querySelector('pre code')),
      hasImages: imageAlts.length > 0,
      truncated
    };
  }).filter(message => message.text || message.hasImages);

  const generating = Boolean(document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop generating response"]'
  ));
  const editor = document.querySelector(
    '#prompt-textarea, [data-testid="prompt-textarea"], form [contenteditable="true"], textarea'
  );
  const draft = editor
    ? (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.value : (editor.innerText || editor.textContent || ''))
    : '';
  const loginPage = /\/auth\/login/.test(String(location.pathname || ''));
  const title = String(document.title || '').replace(/^ChatGPT\s*[-·:]?\s*/i, '').trim();

  return {
    url: location.href,
    conversationId,
    title: title || (conversationId ? 'ChatGPT conversation' : 'New conversation'),
    signedIn: !loginPage && Boolean(editor),
    loginPage,
    generating,
    composerHasDraft: Boolean(String(draft).trim()),
    totalRenderedMessages: roleNodes.length,
    startIndex: start,
    endIndex: end,
    hasEarlier: start > 0,
    hasLater: end < roleNodes.length,
    messages
  };
}

// Called only when a user opens the conversation picker. This does not render the
// ChatGPT sidebar; it returns a short list of recent thread links for an explicit choice.
function extractConversationList() {
  const currentPath = String(location.pathname || '');
  const links = Array.from(document.querySelectorAll('a[href^="/c/"]'));
  const items = [];
  const seen = new Set();
  for (const link of links) {
    const parts = String(link.getAttribute('href') || '').split('/');
    const index = parts.indexOf('c');
    const id = index >= 0 ? (parts[index + 1] || '') : '';
    if (!id || id.length > 120 || seen.has(id)) continue;
    const title = String(link.innerText || link.textContent || '').trim().replace(/\s+/g, ' ');
    if (!title || title.toLowerCase() === 'chatgpt') continue;
    seen.add(id);
    items.push({ id, title: title.slice(0, 180), href: '/c/' + id, current: currentPath === '/c/' + id });
    if (items.length >= 40) break;
  }
  return { currentUrl: location.href, conversations: items };
}

// Move the authenticated page's conversation viewport by one page. The native mirror
// requests older content in bounded increments instead of loading the entire thread.
function scrollConversationViewport(direction) {
  const delta = direction < 0 ? -1 : 1;
  const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
  const reference = nodes.find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }) || nodes[nodes.length - 1];
  let current = reference;
  let target = null;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    if (current.scrollHeight > current.clientHeight + 80 && current.clientHeight > 100 &&
        (style.overflowY === 'auto' || style.overflowY === 'scroll' || current === document.scrollingElement)) {
      target = current;
      break;
    }
    current = current.parentElement;
  }
  if (!target) target = document.scrollingElement;
  if (!target) return { ok: false, reason: 'scroll_container_not_found' };
  const before = target.scrollTop;
  target.scrollTop += delta * Math.max(200, target.clientHeight * 0.78);
  return { ok: before !== target.scrollTop, scrollTop: target.scrollTop, direction: delta };
}

module.exports = {
  MAX_MIRROR_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_SNAPSHOT_CHARS,
  extractConversationSnapshot,
  extractConversationList,
  scrollConversationViewport
};
