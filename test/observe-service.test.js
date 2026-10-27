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
        assert.equal(input.method, 'PUT');
        assert.equal(input.path, '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json');
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
  assert.equal(intervalMs, 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 1);
  assert.equal(published[0].protocol, OBSERVE_PROTOCOL);
  assert.equal(published[0].sample_fps, 2);
  assert.equal(published.at(-1).frames[0].active_window.title, 'Browser');

  await service.setFps(4);
  assert.equal(service.status().fps, 4);
  assert.equal(intervalMs, 250);
  assert.equal(published.at(-1).sample_fps, 4);
  await assert.rejects(service.setFps(3), /one of: 0.5, 1, 2, 4, 8/);

  fingerprint = 'screen-b';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2);

  fingerprint = 'screen-b';
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().frame_count, 2, 'unchanged screen should not append another frame');

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
  assert.deepEqual(published.at(-1).frames, []);
  await service.dispose();
});
