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
