'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObserveService, OBSERVE_PROTOCOL, FRAME_LIMIT, DEFAULT_SAMPLE_FPS, SAMPLE_INTERVAL_MS } = require('../desktop/observe-service');

test('Observe defaults to 2 fps, supports rate changes, and publishes a rolling ten-frame buffer', async () => {
  let tick = null;
  let intervalMs = null;
  let fingerprint = 'screen-a';
  const published = [];
  const service = createObserveService({
    githubAuth: {
      requestApi: async input => {
        assert.equal(input.path, '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json');
        if (input.method === 'GET') {
          assert.deepEqual(input.query, { ref: 'bridge-mailbox' });
          throw new Error('GitHub HTTP 404: Not Found');
        }
        assert.equal(input.method, 'PUT');
        const payload = JSON.parse(Buffer.from(input.body.content, 'base64').toString('utf8'));
        published.push(payload);
        return { result: { content: { sha: 'a'.repeat(40) } } };
      }
    },
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


test('Observe retains full-resolution pixels locally and publishes matching passive vision without image bytes', async () => {
  let tick = null;
  const published = [];
  const rawBytes = Buffer.from('private-full-resolution-pixel-buffer');
  const service = createObserveService({
    githubAuth: {
      requestApi: async input => {
        if (input.method === 'GET') throw new Error('GitHub HTTP 404: Not Found');
        const payload = JSON.parse(Buffer.from(input.body.content, 'base64').toString('utf8'));
        published.push(payload);
        return { result: { content: { sha: 'b'.repeat(40) } } };
      }
    },
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
    'raw screenshot bytes must stay local rather than being published to the GitHub mailbox');
  assert.equal(service.status().passive_vision_status, 'ready');
  await service.setEnabled(false);
  assert.equal(service.getLatestFrame(), null);
  await service.dispose();
});

test('Observe reads the existing blob SHA after an app restart before updating its live context file', async () => {
  let liveSha = 'a'.repeat(40);
  let revision = 98;
  const reads = [];
  const writes = [];
  const githubAuth = {
    requestApi: async input => {
      assert.equal(input.path, '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json');
      if (input.method === 'GET') {
        assert.deepEqual(input.query, { ref: 'bridge-mailbox' });
        reads.push(input);
        return { status: 200, result: { sha: liveSha } };
      }
      assert.equal(input.method, 'PUT');
      assert.equal(input.body.sha, liveSha, 'every update must carry the current Git blob SHA');
      writes.push(input.body.sha);
      const nextSha = String.fromCharCode(revision++).repeat(40);
      liveSha = nextSha;
      return { status: 200, result: { content: { sha: nextSha } } };
    }
  };
  const createService = () => createObserveService({
    githubAuth,
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

  assert.equal(reads.length, 2, 'each new service session must resolve the existing file SHA once');
  assert.deepEqual(writes.slice(0, 3), ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]);
  await secondAppSession.dispose();
});


test('startup cleanup clears a stale live Observe document without enabling sampling', async () => {
  let payload = {
    protocol: OBSERVE_PROTOCOL, enabled: true, sample_fps: 4,
    frame_count: 1, frames: [{ sequence: 1, active_window: { title: 'Old window' } }]
  };
  let currentSha = 'a'.repeat(40);
  const writes = [];
  const githubAuth = {
    requestApi: async input => {
      assert.equal(input.path, '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json');
      if (input.method === 'GET') {
        assert.deepEqual(input.query, { ref: 'bridge-mailbox' });
        return { status: 200, result: {
          sha: currentSha,
          content: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
        } };
      }
      assert.equal(input.method, 'PUT');
      assert.equal(input.body.sha, currentSha);
      const next = JSON.parse(Buffer.from(input.body.content, 'base64').toString('utf8'));
      writes.push(next);
      payload = next;
      currentSha = String.fromCharCode(currentSha.charCodeAt(0) + 1).repeat(40);
      return { status: 200, result: { content: { sha: currentSha } } };
    }
  };
  const service = createObserveService({ githubAuth });
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
    githubAuth: {
      requestApi: async input => {
        if (input.method === 'GET') throw new Error('GitHub HTTP 404: Not Found');
        const payload = JSON.parse(Buffer.from(input.body.content, 'base64').toString('utf8'));
        published.push(payload);
        return { result: { content: { sha: 'c'.repeat(40) } } };
      }
    },
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
