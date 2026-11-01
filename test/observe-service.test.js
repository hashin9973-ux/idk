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


test('Observe throttles UI Automation independently from changed full-resolution frames', async () => {
  let tick = null;
  let clock = 10000;
  let captureCount = 0;
  let fingerprint = 'static-screen';
  let accessibilityCalls = 0;
  const mailbox = createTestMailbox();
  const service = createObserveService({
    mailbox,
    now: () => clock,
    captureScreenshot: async () => ({
      bytes: Buffer.from('full-frame-' + (++captureCount)),
      frame_id: 'exact-full-frame-' + captureCount,
      width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
      captured_at: clock, display_id: '1'
    }),
    fingerprintScreenshot: async () => fingerprint,
    getAccessibleSnapshot: async () => {
      accessibilityCalls++;
      return {
        available: true, source: 'windows_uia',
        active_window: { title: 'Browser', bbox_screen_px: [0, 0, 1920, 1080] },
        focused_control: null, controls: [{ name: 'Search', control_type: 'Edit' }],
        node_count: 2
      };
    },
    sleep: async () => {},
    setIntervalImpl: fn => { tick = fn; return 1; },
    clearIntervalImpl: () => {}
  });
  async function waitFor(predicate, label) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  }
  await service.setEnabled(true);
  await waitFor(() => service.status().frame_count === 1, 'first changed screen');
  assert.equal(accessibilityCalls, 1);

  clock += 500;
  await tick();
  await waitFor(() => service.status().capture_count === 2, 'second raw capture');
  assert.equal(service.status().frame_count, 1, 'new image bytes alone do not create a changed screen');
  assert.equal(accessibilityCalls, 1, 'unchanged visual fingerprints do not spawn a UI Automation scan');

  clock += 500;
  fingerprint = 'changed-screen-a';
  await tick();
  await waitFor(() => service.status().frame_count === 2, 'first changed frame');
  assert.equal(accessibilityCalls, 2, 'UI Automation refreshes after its one-second cooldown');

  clock += 500;
  fingerprint = 'changed-screen-b';
  await tick();
  await waitFor(() => service.status().frame_count === 3, 'second changed frame');
  assert.equal(accessibilityCalls, 2, 'rapid visual changes reuse the recent accessibility snapshot');
  assert.match(mailbox.content, /Frame ID: exact-full-frame-4/);
  await service.setEnabled(false);
  await service.dispose();
});

test('Observe coalesces passive analysis to the newest pending frame', async t => {
  let tick = null;
  let captureCount = 0;
  const analyzedFrameIds = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const mailbox = createTestMailbox();
  const service = createObserveService({
    mailbox,
    captureScreenshot: async () => {
      captureCount++;
      return {
        bytes: Buffer.from('frame-' + captureCount),
        frame_id: 'sample-frame-' + captureCount,
        width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
        captured_at: Date.now(), display_id: 'primary'
      };
    },
    fingerprintScreenshot: async captured => captured.frame_id,
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia', active_window: null, focused_control: null,
      controls: [], node_count: 1, screen: { width: screen.width, height: screen.height }
    }),
    analyzeFrame: async ({ frameId, screen }) => {
      analyzedFrameIds.push(frameId);
      if (analyzedFrameIds.length === 1) await firstGate;
      return {
        status: 'report_available',
        model: 'SmolVLM2-2.2B-Instruct',
        input_image: { frame_id: frameId },
        report: JSON.stringify({
          schema_version: 'windows-vision-context/v2',
          frame: { width_px: screen.frame_width, height_px: screen.frame_height },
          scene: { summary: 'Observed ' + frameId },
          regions: [], text_spans: [], controls: [], objects: [],
          perception: { mode: 'multimodal_vision+ocr+uia', degraded: false, error: null },
          accessibility: { available: true, controls: [] },
          ocr: { available: true, method: 'tesseract', text_spans: [] }
        })
      };
    },
    sleep: async () => {},
    setIntervalImpl: fn => { tick = fn; return 1; },
    clearIntervalImpl: () => {}
  });
  t.after(async () => { releaseFirst(); await service.setEnabled(false); await service.dispose(); });
  async function waitFor(predicate, label) {
    for (let i = 0; i < 120; i++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  }

  await service.setEnabled(true);
  await waitFor(() => analyzedFrameIds.length === 1, 'first passive analysis');
  assert.deepEqual(analyzedFrameIds, ['sample-frame-1']);
  tick();
  await waitFor(() => service.status().sequence >= 2, 'second frame');
  tick();
  await waitFor(() => service.status().sequence >= 3, 'third frame');
  assert.deepEqual(analyzedFrameIds, ['sample-frame-1'],
    'new screens replace a queued analysis frame while current inference is running');

  releaseFirst();
  await waitFor(() => analyzedFrameIds.length === 2, 'newest pending analysis');
  await waitFor(() => service.status().last_vision_frame_id === 'sample-frame-3' &&
    service.status().passive_vision_status === 'ready', 'newest frame analysis completion');
  assert.deepEqual(analyzedFrameIds, ['sample-frame-1', 'sample-frame-3']);
  assert.match(mailbox.content, /Frame ID: sample-frame-3/);
  assert.match(mailbox.content, /Observed sample-frame-3/);
});

test('Observe protects an in-flight report frame from rolling history eviction', async t => {
  let tick = null;
  let captureCount = 0;
  const analyzedFrameIds = [];
  let releaseFirst;
  let releaseLatest;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const latestGate = new Promise(resolve => { releaseLatest = resolve; });
  const mailbox = createTestMailbox();
  const service = createObserveService({
    mailbox,
    captureScreenshot: async () => {
      captureCount++;
      return {
        bytes: Buffer.from('delayed-frame-' + captureCount),
        frame_id: 'delayed-frame-' + captureCount,
        width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
        captured_at: Date.now(), display_id: 'primary'
      };
    },
    fingerprintScreenshot: async captured => captured.frame_id,
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia', active_window: { title: 'Browser' },
      focused_control: null, controls: [], node_count: 1,
      screen: { width: screen.width, height: screen.height }
    }),
    analyzeFrame: async ({ frameId, screen }) => {
      analyzedFrameIds.push(frameId);
      if (frameId === 'delayed-frame-1') await firstGate;
      if (frameId === 'delayed-frame-13') await latestGate;
      return {
        status: 'report_available', model: 'SmolVLM2-2.2B-Instruct',
        input_image: { frame_id: frameId },
        report: JSON.stringify({
          schema_version: 'windows-vision-context/v2',
          frame: { width_px: screen.frame_width, height_px: screen.frame_height },
          scene: { summary: 'Observed ' + frameId },
          regions: [], text_spans: [], controls: [], objects: [],
          perception: { mode: 'multimodal_vision+ocr+uia', degraded: false, error: null }
        })
      };
    },
    sleep: async () => {},
    setIntervalImpl: fn => { tick = fn; return 1; },
    clearIntervalImpl: () => {}
  });
  t.after(async () => {
    releaseFirst();
    releaseLatest();
    await service.setEnabled(false);
    await service.dispose();
  });
  async function waitFor(predicate, label) {
    for (let i = 0; i < 160; i++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  }

  await service.setEnabled(true);
  await waitFor(() => analyzedFrameIds.length === 1, 'first analysis');
  for (let sequence = 2; sequence <= FRAME_LIMIT + 3; sequence++) {
    tick();
    await waitFor(() => service.status().sequence >= sequence, 'frame ' + sequence);
  }
  assert.equal(service.status().frame_count, FRAME_LIMIT);
  assert.equal(service.status().in_flight_frame_id, 'delayed-frame-1',
    'the in-flight frame remains protected after newer frames roll through history');

  releaseFirst();
  await waitFor(() => analyzedFrameIds.length === 2 &&
    service.status().last_vision_frame_id === 'delayed-frame-1', 'first delayed report to attach');
  assert.equal(service.status().in_flight_frame_id, 'delayed-frame-13',
    'the newest pending frame starts after the original in-flight report completes');
  assert.deepEqual(analyzedFrameIds, ['delayed-frame-1', 'delayed-frame-13']);
  releaseLatest();
  await waitFor(() => service.status().last_vision_frame_id === 'delayed-frame-13' &&
    service.status().passive_vision_status === 'ready', 'latest delayed report');
  assert.match(mailbox.content, /Frame ID: delayed-frame-13/);
  assert.match(mailbox.content, /Observed delayed-frame-13/);
});

test('Observe keeps full-resolution pixels local and publishes matching passive vision without image bytes', async () => {
  const mailbox = createTestMailbox();
  const rawBytes = Buffer.from('private-full-resolution-pixel-buffer');
  const service = createObserveService({
    mailbox,
    captureScreenshot: async () => ({
      bytes: rawBytes, width: 1920, height: 1080,
      screen_width: 1920, screen_height: 1080,
      captured_at: Date.now(), display_id: 'primary'
    }),
    fingerprintScreenshot: async () => 'screen-fingerprint',
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Desktop', bbox_screen_px: [0, 0, screen.width, screen.height] },
      controls: [], focused_control: null, cursor: {
        x_screen_px: 300, y_screen_px: 200, x_px: 300, y_px: 200,
        source: 'windows_native_cursor', coordinate_space: 'screenshot_jpeg_px'
      }, truncated: false, node_count: 1
    }),
    analyzeFrame: async ({ frameId, screen }) => ({
      status: 'report_available',
      model: 'SmolVLM2-2.2B-Instruct',
      input_image: { frame_id: frameId },
      report: JSON.stringify({
        schema_version: 'windows-vision-context/v2',
        frame: { width_px: screen.frame_width, height_px: screen.frame_height },
        scene: { summary: 'A full-resolution desktop frame was analyzed.' },
        regions: [{ id: 'r1', label: 'desktop', bbox_px: [0, 0, screen.frame_width, screen.frame_height] }],
        text_spans: [{ text: 'Window', bbox_px: [20, 20, 90, 40] }],
        controls: [{ id: 'c1', label: 'Open', role: 'button', bbox_px: [20, 20, 90, 40] }],
        objects: [{ id: 'o1', label: 'desktop icon', category: 'icon', color: 'blue', shape: 'square', bbox_px: [20, 20, 90, 40] }],
        perception: { mode: 'multimodal_vision+ocr+uia', degraded: false, error: null },
        accessibility: { available: true, controls: [] },
        ocr: { available: true, method: 'tesseract', text_spans: [] }
      })
    }),
    sleep: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {}
  });
  await service.setEnabled(true);
  for (let i = 0; i < 120 && service.status().passive_vision_status !== 'ready'; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const latest = service.getLatestFrame(2500);
  assert.ok(latest, 'a fresh live frame must be available to the input validator');
  assert.equal(latest.width, 1920);
  assert.equal(latest.height, 1080);
  assert.equal(latest.bytes, rawBytes);
  assert.match(latest.frame_id, /^[a-f0-9]{64}$/);
  assert.equal(service.status().last_vision_frame_id, latest.frame_id);
  assert.match(mailbox.content, new RegExp('Frame ID: ' + latest.frame_id));
  assert.ok(mailbox.content.includes('SmolVLM2-2.2B-Instruct'));
  assert.ok(mailbox.content.includes('A full-resolution desktop frame was analyzed.'));
  assert.match(mailbox.content, /desktop icon/);
  assert.match(mailbox.content, /300.*200/);
  assert.doesNotMatch(mailbox.content, /private-full-resolution-pixel-buffer/);
  await service.setEnabled(false);
  assert.equal(service.getLatestFrame(), null);
  await service.dispose();
});
