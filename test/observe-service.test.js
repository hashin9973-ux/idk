'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createObserveService, FRAME_LIMIT, DEFAULT_SAMPLE_FPS, SAMPLE_INTERVAL_MS,
  ACCESSIBILITY_REFRESH_INTERVAL_MS
} = require('../desktop/observe-service');

function createTestMailbox({ initialContent = null, onWrite = () => {}, reads = null, writes = null } = {}) {
  let content = initialContent;
  let sha = content === null ? null : 'a'.repeat(64);
  let revision = 0;
  return {
    getState: () => ({ configured: true, mailboxPath: 'C:\\OneDrive\\Bridge' }),
    async readContent(relativePath) {
      assert.equal(relativePath, 'SCREEN.md');
      if (reads) reads.push(relativePath);
      return content === null ? null : { content: Buffer.from(content, 'utf8'), sha };
    },
    async writeContent(relativePath, nextContent, options = {}) {
      assert.equal(relativePath, 'SCREEN.md');
      if (options.createOnly && content !== null) return { ok: false, conflict: true, sha };
      if (content !== null && options.expectedSha !== sha) {
        const error = new Error('Concurrent OneDrive test fixture update.');
        error.code = 'MAILBOX_CONFLICT';
        throw error;
      }
      if (content === null && options.expectedSha) {
        const error = new Error('SCREEN.md disappeared before update.');
        error.code = 'MAILBOX_CONFLICT';
        throw error;
      }
      content = String(nextContent);
      sha = String.fromCharCode(98 + (revision++ % 24)).repeat(64);
      if (writes) writes.push(options.expectedSha || null);
      onWrite(content);
      return { ok: true, sha };
    },
    get content() { return content; }
  };
}

function makeCapture({ fingerprint = 'screen-a', controls = [], activeWindow = { title: 'Browser' }, vision = null } = {}) {
  let currentFingerprint = fingerprint;
  let captureCount = 0;
  const capture = async () => ({
    bytes: Buffer.from('private-image-pixels-' + (++captureCount)),
    width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
    captured_at: Date.now(), display_id: '1'
  });
  return {
    capture,
    setFingerprint(value) { currentFingerprint = value; },
    fingerprint: async () => currentFingerprint,
    accessibility: async () => ({
      available: true, source: 'windows_uia',
      active_window: activeWindow,
      focused_control: { name: 'Search box', control_type: 'Edit' },
      controls, node_count: controls.length
    }),
    vision
  };
}

test('Observe defaults to 2 fps and publishes the latest screen context as Markdown', async () => {
  let tick = null;
  let intervalMs = null;
  const published = [];
  const capture = makeCapture({
    controls: [{ name: 'Minimize', control_type: 'Button', bounds: [1800, 0, 100, 40], is_enabled: true }]
  });
  const mailbox = createTestMailbox({ onWrite: content => published.push(content) });
  const service = createObserveService({
    mailbox,
    captureScreenshot: capture.capture,
    fingerprintScreenshot: capture.fingerprint,
    getAccessibleSnapshot: capture.accessibility,
    sleep: async () => {},
    setIntervalImpl: (fn, ms) => { tick = fn; intervalMs = ms; return 1; },
    clearIntervalImpl: () => {}
  });

  assert.equal(DEFAULT_SAMPLE_FPS, 2);
  assert.equal(SAMPLE_INTERVAL_MS, 500);
  assert.equal(ACCESSIBILITY_REFRESH_INTERVAL_MS > 0, true);
  assert.equal((await service.setEnabled(true)).enabled, true);
  assert.equal(service.status().fps, 2);
  assert.equal(service.status().sample_interval_ms, 500);
  assert.equal(intervalMs, 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 1);
  assert.match(mailbox.content, /^# Windows Bridge screen context/m);
  assert.match(mailbox.content, /Observe: enabled/);
  assert.match(mailbox.content, /Active window:.*Browser/);
  assert.match(mailbox.content, /Minimize/);
  assert.match(mailbox.content, /1920 × 1080 pixels/);
  assert.doesNotMatch(mailbox.content, /private-image-pixels/);
  assert.doesNotMatch(mailbox.content, /ghp_0123456789abcdefghijklmnopqrstuv/);

  await service.setFps(4);
  assert.equal(service.status().fps, 4);
  assert.equal(service.status().sample_interval_ms, 250);
  assert.equal(intervalMs, 250);
  assert.match(mailbox.content, /Sample rate: 4 fps \(250 ms interval\)/);
  await assert.rejects(service.setFps(3), /one of: 0.5, 1, 2, 4, 8/);

  capture.setFingerprint('screen-b');
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2);
  capture.setFingerprint('screen-b');
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2, 'unchanged screens are not appended');
  for (let i = 0; i < 12; i++) {
    capture.setFingerprint('screen-' + i);
    await tick();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(service.status().frame_count, FRAME_LIMIT);
  assert.match(mailbox.content, /Latest frame/);
  assert.equal(published.length > 3, true);

  await service.setEnabled(false);
  assert.equal(service.status().enabled, false);
  assert.match(mailbox.content, /Observe: disabled/);
  assert.match(mailbox.content, /Observe is disabled/);
  assert.deepEqual(service.status().frames, []);
  await service.dispose();
});

test('SCREEN.md redacts password-like control values and excludes private image bytes', async () => {
  const mailbox = createTestMailbox();
  const capture = makeCapture({
    controls: [
      { name: 'Password', control_type: 'Edit', is_password: true, value: 'do-not-publish-this' },
      { name: 'Search', control_type: 'Edit', value: 'public search text' },
      { name: 'Token preview', control_type: 'Text', value: 'Bearer ghp_0123456789abcdefghijklmnopqrstuv' }
    ]
  });
  const service = createObserveService({
    mailbox,
    captureScreenshot: capture.capture,
    fingerprintScreenshot: capture.fingerprint,
    getAccessibleSnapshot: capture.accessibility,
    sleep: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {}
  });
  await service.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(mailbox.content, /\[REDACTED\]/);
  assert.doesNotMatch(mailbox.content, /do-not-publish-this/);
  assert.doesNotMatch(mailbox.content, /private-image-pixels/);
  assert.match(mailbox.content, /public search text/);
  await service.dispose();
});

test('Observe writes explicit disabled context at startup when stale context may remain', async () => {
  const published = [];
  const mailbox = createTestMailbox({ initialContent: '# old screen context', onWrite: content => published.push(content) });
  const service = createObserveService({
    mailbox,
    captureScreenshot: async () => { throw new Error('should not capture while disabled'); },
    fingerprintScreenshot: async () => 'unused',
    sleep: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {}
  });
  await service.clearStaleContext();
  assert.match(mailbox.content, /Observe: disabled/);
  assert.match(mailbox.content, /No screen content is currently published/);
  assert.equal(published.length, 1);
  await service.dispose();
});

test('SCREEN.md updates use expected content hashes and retry concurrent mailbox conflicts', async () => {
  let conflictOnce = true;
  const mailbox = createTestMailbox({
    onWrite: () => {},
  });
  const originalWrite = mailbox.writeContent.bind(mailbox);
  mailbox.writeContent = async (relativePath, content, options = {}) => {
    if (conflictOnce && options.createOnly === false) {
      conflictOnce = false;
      const error = new Error('Concurrent OneDrive update.');
      error.code = 'MAILBOX_CONFLICT';
      throw error;
    }
    return originalWrite(relativePath, content, options);
  };
  const service = createObserveService({
    mailbox,
    captureScreenshot: async () => ({
      bytes: Buffer.from('pixels'), width: 800, height: 600, screen_width: 800, screen_height: 600,
      captured_at: Date.now(), display_id: '1'
    }),
    fingerprintScreenshot: async () => 'frame',
    sleep: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {}
  });
  await service.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(mailbox.content, /Observe: enabled/);
  await service.dispose();
});
