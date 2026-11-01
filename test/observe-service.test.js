'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObserveService, OBSERVE_PROTOCOL, FRAME_LIMIT, DEFAULT_SAMPLE_FPS, SAMPLE_INTERVAL_MS, ACCESSIBILITY_REFRESH_INTERVAL_MS } = require('../desktop/observe-service');

function createTestMailbox({ initialValue = null, onWrite = () => {}, reads = null, writes = null } = {}) {
  let revision = 0;
  let value = initialValue === null ? null : structuredClone(initialValue);
  let sha = value === null ? null : 'a'.repeat(64);
  return {
    getState: () => ({ configured: true, runtimePath: 'C:\\OneDrive\\Bridge\\runtime' }),
    async readJson(relativePath) {
      assert.equal(relativePath, 'bridge/vision/observe.json');
      if (reads) reads.push(relativePath);
      return value === null ? null : { value: structuredClone(value), sha };
    },
    async writeJson(relativePath, next, expectedSha = null, createOnly = false) {
      assert.equal(relativePath, 'bridge/vision/observe.json');
      if (createOnly && value !== null) return { ok: false, conflict: true, sha };
      if (value !== null && expectedSha !== sha) {
        const error = new Error('Concurrent OneDrive test fixture update.');
        error.code = 'MAILBOX_CONFLICT';
        throw error;
      }
      if (value === null && expectedSha) {
        const error = new Error('OneDrive test fixture record disappeared.');
        error.code = 'MAILBOX_CONFLICT';
        throw error;
      }
      const nextSha = String.fromCharCode(98 + (revision++ % 24)).repeat(64);
      if (writes) writes.push(expectedSha);
      value = structuredClone(next);
      sha = nextSha;
      onWrite(structuredClone(next));
      return { ok: true, sha };
    }
  };
}



test('Observe defaults to 2 fps, supports rate changes, and publishes a rolling ten-frame buffer', async () => {
  let tick = null;
  let intervalMs = null;
  let fingerprint = 'screen-a';
  const published = [];
  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    captureScreenshot: async () => ({
      bytes: Buffer.from('fake-png'),
      width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
      captured_at: Date.now(), display_id: '1'
    }),
    fingerprintScreenshot: async () => fingerprint,
    getAccessibleSnapshot: async () => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Browser', bbox_screen_px: [0, 0, 1920, 1040] },
      focused_control: null,
      controls: [{ label: 'Minimize', role: 'Button', center_px: [1807, 16], source: 'windows_uia' }],
      node_count: 1
    }),
    sleep: async () => {},
    setIntervalImpl: (fn, ms) => { tick = fn; intervalMs = ms; return 1; },
    clearIntervalImpl: () => {}
  });

  assert.equal(DEFAULT_SAMPLE_FPS, 2);
  assert.equal(SAMPLE_INTERVAL_MS, 500);
  assert.equal((await service.setEnabled(true)).enabled, true);
  assert.equal(service.status().fps, 2);
  assert.equal(service.status().sample_interval_ms, 500);
  assert.equal(intervalMs, 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 1);
  assert.equal(service.status().capture_count, 1);
  assert.equal(published[0].protocol, OBSERVE_PROTOCOL);
  assert.equal(published[0].sample_fps, 2);
  assert.equal(published[0].sample_interval_ms, 500);
  const firstFramePublication = published.findLast(payload => payload.frames.length > 0);
  assert.equal(firstFramePublication.capture_count, 1);
  assert.equal(firstFramePublication.frames[0].capture_count_at_capture, 1);
  assert.equal(firstFramePublication.frames[0].skipped_samples_at_capture, 0);
  assert.equal(firstFramePublication.frames[0].active_window.title, 'Browser');

  await service.setFps(4);
  assert.equal(service.status().fps, 4);
  assert.equal(service.status().sample_interval_ms, 250);
  assert.equal(intervalMs, 250);
  assert.equal(published.at(-1).sample_fps, 4);
  assert.equal(published.at(-1).sample_interval_ms, 250);
  await assert.rejects(service.setFps(3), /one of: 0.5, 1, 2, 4, 8/);

  fingerprint = 'screen-b';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2);
  assert.equal(service.status().capture_count, 2);

  fingerprint = 'screen-b';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2, 'unchanged screen should not append another frame');
  assert.equal(service.status().capture_count, 3, 'unchanged samples still count as captures even though they are not retained as changed frames');

  for (let i = 0; i < 12; i += 1) {
    fingerprint = 'screen-' + i;
    await tick();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(service.status().frame_count, FRAME_LIMIT);
  assert.equal(published.at(-1).frames.length, FRAME_LIMIT);
  assert.equal(published.at(-1).enabled, true);

  await service.setEnabled(false);
  assert.equal(service.status().enabled, false);
  assert.equal(published.at(-1).enabled, false);
  assert.equal(published.at(-1).capture_count, 0);
  assert.equal(published.at(-1).skipped_samples, 0);
  assert.equal(published.at(-1).last_capture_at, null);
  assert.deepEqual(published.at(-1).frames, []);
  await service.dispose();
});



test('Observe uses the downsampled visual fingerprint for changes and throttles expensive UI Automation refreshes', async () => {
  let tick = null;
  let clock = 10000;
  let rawFrame = 0;
  let fingerprint = 'static-screen';
  let accessibilityCalls = 0;
  const published = [];
  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    now: () => clock,
    captureScreenshot: async () => ({
      bytes: Buffer.from('full-frame-' + (++rawFrame)),
      frame_id: 'exact-full-frame-' + rawFrame,
      width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
      captured_at: clock, display_id: '1'
    }),
    fingerprintScreenshot: async () => fingerprint,
    getAccessibleSnapshot: async () => {
      accessibilityCalls++;
      return {
        available: true, source: 'windows_uia',
        active_window: { title: 'Browser', bbox_screen_px: [0, 0, 1920, 1080] },
        focused_control: null, controls: [{ label: 'Search', role: 'Edit' }],
        node_count: 2
      };
    },
    sleep: async () => {},
    setIntervalImpl: fn => { tick = fn; return 1; },
    clearIntervalImpl: () => {}
  });

  assert.equal(ACCESSIBILITY_REFRESH_INTERVAL_MS, 1000);
  await service.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 1);
  assert.equal(accessibilityCalls, 1);

  // Full-resolution bytes and frame_id change, but unchanged visual content must not
  // spawn a new accessibility query or append a redundant passive-context frame.
  clock += 500;
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().capture_count, 2);
  assert.equal(service.status().frame_count, 1);
  assert.equal(accessibilityCalls, 1);

  // A meaningful change inside one second reuses recent UI Automation geometry.
  clock += 500;
  fingerprint = 'changed-screen-a';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2);
  assert.equal(accessibilityCalls, 2);

  clock += 500;
  fingerprint = 'changed-screen-b';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 3);
  assert.equal(accessibilityCalls, 2, 'UI Automation is capped at once per second even as pixels change');
  const latestFrame = published.at(-1).frames.at(-1);
  assert.equal(latestFrame.frame_id, 'exact-full-frame-' + rawFrame);
  assert.equal(latestFrame.accessibility.snapshot_reused, true);
  assert.equal(latestFrame.accessibility.snapshot_age_ms, 500);

  await service.dispose();
});

test('Observe coalesces pending passive analysis to the newest frame and marks skipped frames', async t => {
  let tick = null;
  let captureIndex = 0;
  const published = [];
  const analyzedFrameIds = [];
  let releaseFirst;
  const firstAnalysisGate = new Promise(resolve => { releaseFirst = resolve; });

  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    captureScreenshot: async () => {
      captureIndex += 1;
      return {
        bytes: Buffer.from('frame-' + captureIndex),
        frame_id: 'sample-frame-' + captureIndex,
        width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
        captured_at: Date.now(), display_id: 'primary'
      };
    },
    fingerprintScreenshot: async captured => captured.frame_id,
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia', active_window: null, focused_control: null,
      controls: [], cursor: null, truncated: false, node_count: 1,
      screen: { width: screen.width, height: screen.height }
    }),
    analyzeFrame: async ({ frameId, screen }) => {
      analyzedFrameIds.push(frameId);
      if (analyzedFrameIds.length === 1) await firstAnalysisGate;
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

  await service.setEnabled(true);
  async function waitFor(predicate, label) {
    for (let i = 0; i < 80; i += 1) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  }
  await waitFor(() => analyzedFrameIds.length === 1, 'first passive analysis to start');
  assert.equal(analyzedFrameIds[0], 'sample-frame-1');

  tick();
  await waitFor(() => service.status().frame_count >= 2, 'second frame to enter Observe');
  tick();
  await waitFor(() => service.status().frame_count >= 3, 'third frame to enter Observe');
  assert.deepEqual(analyzedFrameIds, ['sample-frame-1'], 'new screens should replace a queued frame while current inference is running');

  releaseFirst();
  await waitFor(() => analyzedFrameIds.length === 2, 'newest pending frame to be analyzed');
  await waitFor(() => published.flatMap(payload => payload.frames || []).some(frame =>
    frame.frame_id === 'sample-frame-3' && frame.vision_status === 'ready'), 'newest frame result publication');

  assert.deepEqual(analyzedFrameIds, ['sample-frame-1', 'sample-frame-3']);
  const frames = published.flatMap(payload => payload.frames || []);
  const skipped = frames.filter(frame => frame.frame_id === 'sample-frame-2').at(-1);
  assert.ok(skipped, 'the skipped frame remains available for diagnostics');
  assert.equal(skipped.vision_status, 'superseded');
  assert.match(skipped.vision_error, /newer changed screen frame/i);
});

 
test('Observe retains an in-flight report frame beyond the rolling ten-frame history', async t => {
  let tick = null;
  let captureIndex = 0;
  const published = [];
  const analyzedFrameIds = [];
  let releaseFirst;
  const firstAnalysisGate = new Promise(resolve => { releaseFirst = resolve; });
  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    captureScreenshot: async () => {
      captureIndex += 1;
      return {
        bytes: Buffer.from('delayed-frame-' + captureIndex),
        frame_id: 'delayed-frame-' + captureIndex,
        width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
        captured_at: Date.now(), display_id: 'primary'
      };
    },
    fingerprintScreenshot: async captured => captured.frame_id,
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia', active_window: { title: 'Browser' },
      focused_control: null, controls: [], cursor: null, truncated: false, node_count: 1,
      screen: { width: screen.width, height: screen.height }
    }),
    analyzeFrame: async ({ frameId, screen }) => {
      analyzedFrameIds.push(frameId);
      if (frameId === 'delayed-frame-1') await firstAnalysisGate;
      return {
        status: 'report_available',
        model: 'SmolVLM2-2.2B-Instruct',
        input_image: { frame_id: frameId },
        report: JSON.stringify({
          schema_version: 'windows-vision-context/v2',
          frame: {
            width_px: screen.frame_width, height_px: screen.frame_height,
            coordinate_space: 'screenshot_jpeg_px', origin: 'top-left',
            x_axis: 'right', y_axis: 'down'
          },
          scene: { summary: 'Observed ' + frameId, screen_type: 'desktop' },
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
  t.after(async () => {
    releaseFirst();
    await service.setEnabled(false);
    await service.dispose();
  });

  async function waitFor(predicate, label) {
    for (let i = 0; i < 120; i += 1) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  }

  await service.setEnabled(true);
  await waitFor(() => analyzedFrameIds.length === 1, 'first passive analysis to start');
  assert.equal(analyzedFrameIds[0], 'delayed-frame-1');

  for (let index = 2; index <= FRAME_LIMIT + 3; index += 1) {
    tick();
    await waitFor(() => service.status().sequence >= index, 'frame ' + index + ' to enter Observe');
  }
  await waitFor(() => published.some(payload => payload.frames?.some(frame => frame.frame_id === 'delayed-frame-13')),
    'latest frame publication');
  assert.equal(service.status().frame_count, FRAME_LIMIT);
  const duringInference = published.findLast(payload => payload.frames?.some(frame => frame.frame_id === 'delayed-frame-13'));
  assert.ok(duringInference.frames.some(frame =>
    frame.frame_id === 'delayed-frame-1' && frame.vision_status === 'processing'),
  'the in-flight frame must remain addressable after more than ten newer frames arrive');
  assert.equal(duringInference.in_flight_frame_id, 'delayed-frame-1');

  releaseFirst();
  await waitFor(() => analyzedFrameIds.length === 2, 'the newest pending frame to be analyzed');
  await waitFor(() => published.some(payload =>
    payload.last_vision_frame_id === 'delayed-frame-1' &&
    payload.frames?.some(frame => frame.frame_id === 'delayed-frame-1' && frame.vision_status === 'ready')),
  'the delayed report to be attached to its original frame');
  const firstCompleted = published.findLast(payload =>
    payload.last_vision_frame_id === 'delayed-frame-1' &&
    payload.frames?.some(frame => frame.frame_id === 'delayed-frame-1' && frame.vision_status === 'ready'));
  const firstFrame = firstCompleted.frames.find(frame => frame.frame_id === 'delayed-frame-1');
  assert.equal(firstFrame.vision.frame_id, firstFrame.frame_id);
  assert.equal(firstFrame.vision.scene.summary, 'Observed delayed-frame-1');
  assert.equal(firstCompleted.last_vision_frame_id, 'delayed-frame-1');
  assert.equal(firstCompleted.in_flight_frame_id, 'delayed-frame-13');

  await waitFor(() => published.some(payload =>
    payload.last_vision_frame_id === 'delayed-frame-13' &&
    payload.frames?.some(frame => frame.frame_id === 'delayed-frame-13' && frame.vision_status === 'ready')),
  'the latest report to complete');
  assert.deepEqual(analyzedFrameIds, ['delayed-frame-1', 'delayed-frame-13']);
});
test('Observe retains full-resolution pixels locally and publishes matching passive vision without image bytes', async () => {
  let tick = null;
  const published = [];
  const rawBytes = Buffer.from('private-full-resolution-pixel-buffer');
  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    captureScreenshot: async () => ({
      bytes: rawBytes, width: 1920, height: 1080,
      screen_width: 1920, screen_height: 1080,
      captured_at: Date.now(), display_id: 'primary'
    }),
    fingerprintScreenshot: async () => 'screen-fingerprint',
    getAccessibleSnapshot: async ({ screen, frame }) => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Desktop', bbox_screen_px: [0, 0, screen.width, screen.height] },
      controls: [], focused_control: null, cursor: {
        x_screen_px: 300, y_screen_px: 200, x_px: 300, y_px: 200,
        source: 'windows_native_cursor', coordinate_space: 'screenshot_jpeg_px'
      }, truncated: false, node_count: 1, frame
    }),
    analyzeFrame: async ({ frameId, screen }) => ({
      status: 'report_available',
      model: 'SmolVLM2-2.2B-Instruct',
      completed_at: new Date().toISOString(),
      input_image: { frame_id: frameId },
      report: JSON.stringify({
        schema_version: 'windows-vision-context/v2',
        frame: { width_px: screen.frame_width, height_px: screen.frame_height },
        scene: { summary: 'A full-resolution desktop frame was analyzed.' },
        regions: [{ id: 'r1', label: 'desktop', bbox_px: [0, 0, screen.frame_width, screen.frame_height] }],
        text_spans: [{ text: 'Window', bbox_px: [20, 20, 90, 40] }],
        controls: [{ id: 'c1', label: 'Open', role: 'button', bbox_px: [20, 20, 90, 40] }],
        objects: [{ id: 'o1', label: 'desktop icon', category: 'icon', appearance: 'small square icon', color: 'blue', shape: 'square', confidence: 'high', bbox_px: [20, 20, 90, 40] }],
        perception: { mode: 'multimodal_vision+ocr+uia', degraded: false, error: null },
        accessibility: { available: true, controls: [] },
        ocr: { available: true, method: 'tesseract', text_spans: [] }
      })
    }),
    sleep: async () => {},
    setIntervalImpl: fn => { tick = fn; return 1; },
    clearIntervalImpl: () => {}
  });

  await service.setEnabled(true);
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));

  const latest = service.getLatestFrame(2500);
  assert.ok(latest, 'a fresh live frame should be available to the input validator');
  assert.equal(latest.width, 1920);
  assert.equal(latest.height, 1080);
  assert.equal(latest.bytes, rawBytes);
  assert.match(latest.frame_id, /^[a-f0-9]{64}$/);

  const matching = published.flatMap(item => item.frames || []).find(frame => frame.frame_id === latest.frame_id && frame.vision_status === 'ready');
  assert.ok(matching, 'visual evidence should attach only to the matching frame ID');
  assert.equal(matching.vision_model, 'SmolVLM2-2.2B-Instruct');
  assert.equal(matching.vision.scene.summary, 'A full-resolution desktop frame was analyzed.');
  assert.equal(matching.coordinate_system.frame_id, matching.frame_id);
  assert.equal(matching.coordinate_system.width_px, 1920);
  assert.deepEqual(matching.cursor, { x_screen_px: 300, y_screen_px: 200, x_px: 300, y_px: 200, source: 'windows_native_cursor', coordinate_space: 'screenshot_jpeg_px' });
  assert.equal(matching.vision.frame_id, matching.frame_id);
  assert.deepEqual(matching.vision.controls[0].bbox_px, [20, 20, 90, 40]);
  assert.equal(matching.vision.objects[0].label, 'desktop icon');
  assert.ok(matching.vision.text_spans.length <= 800);
  assert.ok(matching.vision.controls.length <= 800);
  assert.ok(matching.vision.ocr.text_spans.length <= 800);
  assert.ok(matching.controls.length <= 800);
  assert.equal(matching.vision.interaction_guidance.coordinate_frame_id, matching.frame_id);
  assert.equal(JSON.stringify(published).includes(rawBytes.toString('utf8')), false,
    'raw screenshot bytes must stay local rather than being published to the OneDrive mailbox');
  assert.equal(service.status().passive_vision_status, 'ready');
  await service.setEnabled(false);
  assert.equal(service.getLatestFrame(), null);
  await service.dispose();
});

test('Observe resolves the current OneDrive file hash after an app restart before updating live context', async () => {
  const reads = [];
  const writes = [];
  const mailbox = createTestMailbox({
    initialValue: { protocol: OBSERVE_PROTOCOL, enabled: false, frame_count: 0, frames: [] },
    reads, writes
  });
  const createService = () => createObserveService({
    mailbox,
    captureScreenshot: async () => ({
      bytes: Buffer.from('test-screen'), width: 100, height: 100,
      screen_width: 100, screen_height: 100, captured_at: Date.now()
    }),
    fingerprintScreenshot: async () => '',
    getAccessibleSnapshot: async () => ({ available: true, controls: [] })
  });

  const firstAppSession = createService();
  await firstAppSession.setEnabled(true);
  await firstAppSession.dispose();
  const secondAppSession = createService();
  await secondAppSession.setEnabled(true);

  assert.equal(reads.length, 2, 'each new service session must resolve the existing OneDrive content hash once');
  assert.deepEqual(writes.slice(0, 3), ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  await secondAppSession.dispose();
});


test('startup cleanup clears a stale live Observe document without enabling sampling', async () => {
  const payload = {
    protocol: OBSERVE_PROTOCOL, enabled: true, sample_fps: 4,
    frame_count: 1, frames: [{ sequence: 1, active_window: { title: 'Old window' } }]
  };
  const writes = [];
  const mailbox = createTestMailbox({ initialValue: payload, onWrite: value => writes.push(value) });
  const service = createObserveService({ mailbox });
  const state = await service.clearStaleContext();
  assert.equal(state.enabled, false);
  assert.equal(state.fps, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].enabled, false);
  assert.equal(writes[0].frame_count, 0);
  assert.deepEqual(writes[0].frames, []);
  assert.equal(writes[0].sample_fps, 2);
  await service.dispose();
});


test('Observe publishes marked degraded OCR/UIA coordinates instead of dropping a frame when passive VLM inference fails', async () => {
  let fingerprint = 'degraded-frame';
  const published = [];
  const rawBytes = Buffer.from('private-degraded-frame');
  const service = createObserveService({
    mailbox: createTestMailbox({ onWrite: payload => published.push(payload) }),
    captureScreenshot: async () => ({
      bytes: rawBytes, width: 1920, height: 1080, screen_width: 1920, screen_height: 1080,
      captured_at: Date.now(), display_id: 'primary'
    }),
    fingerprintScreenshot: async () => fingerprint,
    getAccessibleSnapshot: async ({ screen }) => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Test browser', bbox_px: [0, 0, screen.width, screen.height] },
      focused_control: null,
      controls: [{ id: 'uia-run', label: 'Run', role: 'Button', enabled: true, bbox_px: [800, 700, 900, 740] }],
      cursor: { x_screen_px: 1234, y_screen_px: 567, x_px: 1234, y_px: 567, source: 'windows_native_cursor', coordinate_space: 'screenshot_jpeg_px' },
      truncated: false, node_count: 2
    }),
    analyzeFrame: async ({ frameId, screen }) => ({
      status: 'report_available',
      model: 'OCR/UIA fallback (multimodal inference degraded)',
      model_error: 'Ollama HTTP 400: model does not support multimodal requests',
      completed_at: new Date().toISOString(),
      input_image: { frame_id: frameId },
      report: JSON.stringify({
        schema_version: 'windows-vision-context/v2',
        frame: { width_px: screen.frame_width, height_px: screen.frame_height, coordinate_space: 'screenshot_jpeg_px', origin: 'top-left' },
        scene: { summary: 'Multimodal inference failed; OCR and UI Automation only.' },
        regions: [{ id: 'r1', label: 'desktop', bbox_px: [0, 0, screen.frame_width, screen.frame_height] }],
        text_spans: [{ text: 'Run now', source: 'tesseract_ocr', bbox_px: [790, 670, 910, 745] }],
        controls: [{ id: 'uia-run', label: 'Run', role: 'Button', coordinate_source: 'windows_uia', position_verification: 'accessibility_grounded', bbox_px: [800, 700, 900, 740] }],
        objects: [],
        perception: { mode: 'ocr_accessibility_fallback', degraded: true, error: 'Ollama rejected multimodal request.' },
        focused_element: null, cursor: { visible: false, bbox_1000: null, location: 'native cursor in frame metadata' },
        accessibility: { available: true, controls: [{ id: 'uia-run', label: 'Run', role: 'Button', bbox_px: [800, 700, 900, 740] }] },
        ocr: { available: true, method: 'tesseract', text_spans: [{ text: 'Run now', bbox_px: [790, 670, 910, 745] }] },
        limitations: ['Degraded OCR/UIA-only context.']
      })
    }),
    sleep: async () => {},
    setIntervalImpl: fn => { return 1; },
    clearIntervalImpl: () => {}
  });

  await service.setEnabled(true);
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
  const matching = published.flatMap(item => item.frames || []).find(frame => frame.vision_status === 'degraded');
  assert.ok(matching, 'degraded but useful perception must be published for the exact frame');
  assert.equal(matching.vision.perception.mode, 'ocr_accessibility_fallback');
  assert.equal(matching.vision_error, 'Ollama rejected multimodal request.');
  assert.deepEqual(matching.vision.controls[0].bbox_px, [800, 700, 900, 740]);
  assert.deepEqual(matching.cursor, {
    x_screen_px: 1234, y_screen_px: 567, x_px: 1234, y_px: 567,
    source: 'windows_native_cursor', coordinate_space: 'screenshot_jpeg_px'
  });
  assert.equal(service.status().passive_vision_status, 'degraded');
  await service.setEnabled(false);
  await service.dispose();
});
