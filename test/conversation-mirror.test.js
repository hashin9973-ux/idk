'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  MAX_MIRROR_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_SNAPSHOT_CHARS,
  extractConversationSnapshot,
  extractConversationList,
  scrollConversationViewport
} = require('../desktop/conversation-mirror');

function runInPage(fn, context, ...args) {
  return vm.runInNewContext('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', context);
}

function makeMessage(index, options = {}) {
  const visible = options.visible === true;
  const text = options.text === undefined ? 'Message ' + index : options.text;
  const codeBlocks = Array.isArray(options.codeBlocks) ? options.codeBlocks : [];
  return {
    getAttribute(name) { return name === 'data-message-author-role' ? (index % 2 ? 'assistant' : 'user') : null; },
    getBoundingClientRect() {
      return visible
        ? { top: 200, bottom: 250, height: 50 }
        : { top: index < 25 ? -100 : 900, bottom: index < 25 ? -50 : 950, height: 50 };
    },
    cloneNode() {
      let serialized = text;
      const nodes = codeBlocks.map((block, blockIndex) => {
        const marker = '__CODE_BLOCK_' + blockIndex + '__';
        serialized += '\\n' + marker;
        const pre = {
          replaceWith(replacement) {
            serialized = serialized.replace(marker, String(replacement.textContent || ''));
          }
        };
        return {
          className: block.language ? 'language-' + block.language : '',
          innerText: String(block.text || ''),
          textContent: String(block.text || ''),
          closest: () => pre
        };
      });
      return {
        get innerText() { return serialized; },
        get textContent() { return serialized; },
        querySelectorAll(selector) { return selector === 'pre code' ? nodes : []; }
      };
    },
    querySelectorAll() { return []; },
    querySelector(selector) { return selector === 'pre code' && codeBlocks.length ? {} : null; }
  };
}

function snapshotContext({ count = 40, visibleStart = 28, visibleEnd = 32, text, codeBlocks } = {}) {
  const nodes = Array.from({ length: count }, (_, index) => makeMessage(index, {
    visible: index >= visibleStart && index <= visibleEnd,
    text: typeof text === 'function' ? text(index) : undefined,
    codeBlocks: typeof codeBlocks === 'function' ? codeBlocks(index) : codeBlocks
  }));
  const editor = { value: '' };
  return {
    location: { pathname: '/c/thread-123456', href: 'https://chatgpt.com/c/thread-123456' },
    window: { innerHeight: 720 },
    document: {
      title: 'ChatGPT - Project thread',
      body: {},
      documentElement: {},
      scrollingElement: null,
      querySelectorAll() { return nodes; },
      createTextNode(value) { return { textContent: String(value || '') }; },
      querySelector(selector) {
        if (String(selector).includes('stop-button')) return null;
        return editor;
      }
    },
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLInputElement: class HTMLInputElement {},
    nodes
  };
}

test('page snapshot serializer is self-contained when injected into ChatGPT', () => {
  const source = extractConversationSnapshot.toString();
  assert.ok(!source.includes('MAX_MIRROR_MESSAGES'));
  assert.ok(!source.includes('MAX_MESSAGE_CHARS'));
  assert.ok(!source.includes('MAX_SNAPSHOT_CHARS'));
});

test('snapshot copies the viewport and a small message buffer, not the entire thread', () => {
  const context = snapshotContext();
  const result = runInPage(extractConversationSnapshot, context);
  assert.equal(result.conversationId, 'thread-123456');
  assert.equal(result.title, 'Project thread');
  assert.equal(result.totalRenderedMessages, 40);
  assert.equal(result.startIndex, 25);
  assert.equal(result.endIndex, 36);
  assert.ok(result.messages.length <= MAX_MIRROR_MESSAGES);
  assert.ok(result.messages.some(message => message.visible));
  assert.ok(result.hasEarlier);
  assert.equal(result.hasLater, true);
  assert.equal(result.messages[0].id, 'assistant-25');
});

test('snapshot preserves rendered code blocks as fenced text for the native renderer', () => {
  const context = snapshotContext({
    codeBlocks: index => index === 29 ? [{ language: 'javascript', text: 'const count = 3;' }] : []
  });
  const result = runInPage(extractConversationSnapshot, context);
  const codeMessage = result.messages.find(message => message.id === 'assistant-29');
  assert.ok(codeMessage);
  assert.equal(codeMessage.hasCode, true);
  const fence = String.fromCharCode(96).repeat(3);
  assert.ok(codeMessage.text.includes(fence + 'javascript\nconst count = 3;\n' + fence));
});

test('snapshot applies per-message and total payload bounds', () => {
  const context = snapshotContext({ text: () => 'x'.repeat(30000) });
  const result = runInPage(extractConversationSnapshot, context);
  assert.ok(result.messages.every(message => message.text.length <= MAX_MESSAGE_CHARS));
  assert.ok(result.messages.reduce((total, message) => total + message.text.length, 0) <= MAX_SNAPSHOT_CHARS);
});

test('conversation list extracts bounded, unique thread entries only on request', () => {
  const links = [
    { getAttribute: () => '/c/thread-00000001', innerText: 'Project alpha' },
    { getAttribute: () => '/c/thread-00000002', innerText: 'Project beta' },
    { getAttribute: () => '/c/thread-00000001', innerText: 'Duplicate alpha' },
    { getAttribute: () => '/c/thread-00000003', innerText: '   ' }
  ];
  const result = runInPage(extractConversationList, {
    location: { pathname: '/c/thread-00000002', href: 'https://chatgpt.com/c/thread-00000002' },
    document: { querySelectorAll: () => links }
  });
  assert.equal(result.conversations.length, 2);
  assert.equal(result.conversations[0].title, 'Project alpha');
  assert.equal(result.conversations[1].current, true);
});

test('page scroll helper moves only one viewport at a time', () => {
  const container = {
    scrollTop: 1200,
    scrollHeight: 3000,
    clientHeight: 700,
    parentElement: null
  };
  const node = {
    getBoundingClientRect: () => ({ top: 100, bottom: 200, height: 100 }),
    parentElement: container
  };
  const body = {};
  container.parentElement = body;
  const result = runInPage(scrollConversationViewport, {
    window: { innerHeight: 720 },
    document: {
      querySelectorAll: () => [node],
      scrollingElement: container,
      body,
      documentElement: {}
    },
    getComputedStyle: element => ({ overflowY: element === container ? 'auto' : 'visible' })
  }, -1);
  assert.equal(result.ok, true);
  assert.equal(result.direction, -1);
  assert.ok(container.scrollTop < 1200);
});
