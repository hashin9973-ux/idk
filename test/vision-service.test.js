'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createVisionService,
  VISION_CONTROL_PROTOCOL,
  VISION_RUNTIME_PROTOCOL,
  VISION_REQUEST_PROTOCOL,
  VISION_RESULT_PROTOCOL,
  validJobId,
  MAX_SCREENSHOT_BYTES
} = require('../desktop/vision-service');

const OWNER = 'hashin9973-ux';
const REPO = 'qdqwg';
const BRANCH = 'bridge-mailbox';
const BASE_MS = Date.parse('2026-10-25T12:00:00Z');
const ISO = ms => new Date(ms).toISOString();
const ID = 'vision-' + 'a'.repeat(24);
const report = 'Overview\nA desktop window is visible.\n\nVisible text\n“Ready”\n\nUncertainty\nSmall text is not legible.';

function fixture(options = {}) {
  let clock = options.initialNow === undefined ? BASE_MS : options.initialNow;
  const files = new Map();
  const screenshots = { capture: 0, encode: 0, upload: 0, open: 0 };
  const serial = value => JSON.stringify(value, null, 2);
  const putLocalJson = (relative, value) => {
    files.set(relative, { text: serial(value), sha: crypto.createHash('sha1').update(relative + serial(value)).digest('hex') });
  };
  const readLocalJson = relative => {
    const entry = files.get(relative);
    return entry ? JSON.parse(entry.text) : null;
  };
  const control = (enabled = true) => putLocalJson('bridge/vision/control.json', {
    protocol: VISION_CONTROL_PROTOCOL, enabled, updated_at: ISO(clock), revision: 1
  });
  const runtime = (status = 'ready', modelLoaded = true, heartbeat = clock) => putLocalJson('bridge/vision/runtime.json', {
    protocol: VISION_RUNTIME_PROTOCOL, status, heartbeat_at: ISO(heartbeat), updated_at: ISO(heartbeat),
    model_loaded: modelLoaded, gpu: 'Test GPU', vram_mib: 16384, message: 'test runtime'
  });
  const requestResultFor = request => ({
    protocol: VISION_RESULT_PROTOCOL, request_id: request.request_id, status: 'completed',
    created_at: request.created_at, completed_at: ISO(clock), model: 'test-model',
    model_repository: 'test-model-repo', input_sha256: request.sha256,
    report, report_path: 'bridge/vision/reports/' + request.request_id + '.txt', inference_ms: 120
  });
  const githubAuth = {
    async requestApi(input) {
      assert.equal(input.path.startsWith('/repos/' + OWNER + '/' + REPO + '/contents/'), true);
      const relative = input.path.split('/contents/')[1];
      if (input.method === 'GET') {
        const entry = files.get(relative);
        if (!entry) throw new Error('GitHub HTTP 404: Not Found');
        return { status: 200, result: { encoding: 'base64', content: Buffer.from(entry.text).toString('base64'), sha: entry.sha } };
      }
      if (input.method === 'PUT') {
        const text = Buffer.from(input.body.content,'base64').toString('utf8');
        const sha = crypto.createHash('sha1').update(relative + text).digest('hex');
        files.set(relative, { text, sha });
        return { status: 200, result: { content: { sha } } };
      }
      throw new Error('Unexpected API method');
    }
  };
  const service = createVisionService({
    githubAuth,
    getSettings: () => ({ repositoryBridge: { owner: OWNER, repo: REPO, branch: BRANCH } }),
    getWorkspaceRoot: () => '',
    captureScreenshot: async () => { screenshots.capture++; return { bytes: Buffer.from('mock-source-image'), filename: 'screen.png' }; },
    encodeJpeg: async () => { screenshots.encode++; return { bytes: Buffer.from('mock-jpeg-image'), width: 640, height: 360, quality: 72 }; },
    publishWorkspaceFile: async (requestId, file) => {
      screenshots.upload++;
      const sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
      return { path: 'bridge/artifacts/' + requestId + '/screenshot.jpg', url: 'https://github.com/example', bytes: file.bytes.length, sha256 };
    },
    openColabNotebook: async () => { screenshots.open++; return { opened: true }; },
    now: () => clock,
    sleep: async ms => {
      clock += Math.max(1, ms);
      const req = [...files.entries()].find(([key]) => key.startsWith('bridge/vision/requests/'));
      if (options.completeOnSleep && req) {
        const request = JSON.parse(req[1].text);
        putLocalJson('bridge/vision/results/' + request.request_id + '.json', requestResultFor(request));
      }
    },
    pollIntervalMs: options.pollIntervalMs || 10
  });
  return { service, files, screenshots, control, runtime, putLocalJson, readLocalJson, setClock: n => { clock=n; }, getClock: () => clock, requestResultFor };
}

test('activation when inactive explicitly opens Colab but honestly returns starting until a fresh runtime is ready', async () => {
  const f = fixture();
  const result = await f.service.activate({}, 'activate-1');
  assert.equal(result.status, 'starting');
  assert.equal(result.enabled, true);
  assert.equal(f.screenshots.open, 1);
  assert.equal(f.readLocalJson('bridge/vision/control.json').enabled, true);
  assert.notEqual(result.status, 'ready');
});

test('Connect Colab opens the notebook and waits for a heartbeat without activating vision', async () => {
  const f = fixture();
  const result = await f.service.connectColab();
  assert.equal(result.status, 'waiting_for_runtime');
  assert.equal(result.connected, false);
  assert.equal(result.opened, true);
  assert.equal(result.vision_activated, false);
  assert.equal(f.screenshots.open, 1);
  assert.equal(f.readLocalJson('bridge/vision/control.json'), null);
});

test('Connect Colab recognizes a live runtime and does not reopen the notebook', async () => {
  const f = fixture();
  f.control(false);
  f.runtime('inactive', false);
  const result = await f.service.connectColab();
  assert.equal(result.connected, true);
  assert.equal(result.opened, false);
  assert.equal(result.vision_activated, false);
  assert.equal(result.runtime_fresh, true);
  assert.equal(f.screenshots.open, 0);
  assert.equal(f.readLocalJson('bridge/vision/control.json').enabled, false);
});

test('activation reuses a live loaded model without reopening Colab or reloading weights', async () => {
  const f = fixture();
  f.control(true);
  f.runtime('ready', true);
  const result = await f.service.activate({}, 'activate-ready');
  assert.equal(result.status, 'ready');
  assert.equal(result.already_ready, true);
  assert.equal(result.model_reload_requested, false);
  assert.equal(f.screenshots.open, 0);
});

test('activation re-enables an intentionally inactive but loaded runtime without opening a second notebook', async () => {
  const f = fixture();
  f.control(false);
  f.runtime('inactive', true);
  const result = await f.service.activate({}, 'activate-reuse');
  assert.equal(result.status, 'starting');
  assert.equal(result.reused_runtime, true);
  assert.equal(f.screenshots.open, 0);
});

test('activation reports a live runtime without a GPU rather than claiming readiness', async () => {
  const f = fixture();
  f.control(false);
  f.runtime('gpu_unavailable', false);
  const result = await f.service.activate({}, 'activate-no-gpu');
  assert.equal(result.status, 'gpu_unavailable');
  assert.ok(Array.isArray(result.manual_steps));
  assert.equal(f.screenshots.open, 0);
});

test('deactivation is idempotent and never shuts down the Colab runtime', async () => {
  const f = fixture();
  f.control(true);
  f.runtime('ready', true);
  const a = await f.service.deactivate({}, 'deactivate-1');
  const b = await f.service.deactivate({}, 'deactivate-2');
  assert.equal(a.status, 'inactive');
  assert.equal(a.runtime_kept_alive, true);
  assert.equal(a.runtime_shutdown_attempted, undefined);
  assert.equal(b.runtime_kept_alive, true);
  assert.equal(f.readLocalJson('bridge/vision/control.json').enabled, false);
});

test('screenshot analysis is refused while vision is inactive without capturing or uploading', async () => {
  const f = fixture();
  f.control(false);
  f.runtime('inactive', true);
  const result = await f.service.analyzeScreenshot({}, 'request-inactive');
  assert.equal(result.status, 'inactive');
  assert.equal(f.screenshots.capture, 0);
  assert.equal(f.screenshots.upload, 0);
});

test('successful inference result is accepted only when both request ID and input SHA-256 match', async () => {
  const f = fixture({ completeOnSleep: true });
  f.control(true);
  f.runtime('ready', true);
  const queued = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 0 }, 'request-good');
  assert.equal(queued.status, 'inference_in_progress');
  assert.ok(validJobId(queued.request_id));
  const completed = await f.service.wait({ request_id: queued.request_id, waitMs: 100 }, 'wait-good');
  assert.equal(completed.status, 'report_available');
  assert.equal(completed.analysis_completed, true);
  assert.match(completed.report, /Overview/);
  assert.equal(completed.request_id, queued.request_id);
  assert.equal(f.screenshots.capture, 1);
  assert.equal(f.screenshots.upload, 1);
  assert.equal(completed.input_image.sha256, f.readLocalJson('bridge/vision/requests/' + queued.request_id + '.json').sha256);
});

test('retry with the same bridge request ID reuses one screenshot/job rather than duplicating inference', async () => {
  const f = fixture();
  f.control(true);
  f.runtime('ready', true);
  const first = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 0 }, 'stable-id');
  const second = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 0 }, 'stable-id');
  assert.equal(second.request_id, first.request_id);
  assert.equal(f.screenshots.capture, 1);
  assert.equal(f.screenshots.upload, 1);
});

test('stale heartbeat reports disconnected and preserves an existing request for recovery', async () => {
  const f = fixture({ initialNow: BASE_MS });
  f.control(true);
  f.runtime('ready', true, BASE_MS - 10 * 60 * 1000);
  const state = await f.service.status();
  assert.equal(state.status, 'disconnected');
  assert.equal(state.enabled, true);
});

test('malformed or mismatched result records are rejected rather than reported as successful vision', async () => {
  const f = fixture();
  f.control(true);
  f.runtime('ready', true);
  f.putLocalJson('bridge/vision/results/' + ID + '.json', {
    protocol: VISION_RESULT_PROTOCOL, request_id: 'vision-' + 'b'.repeat(24), status: 'completed', report
  });
  const result = await f.service.analyzeScreenshot({}, 'call-id-that-is-not-this-job');
  // Use a correctly derived call ID for the second check; a malformed unrelated record is never trusted.
  const knownCall = 'malformed-job';
  const job = 'vision-' + crypto.createHash('sha256').update(knownCall).digest('hex').slice(0,24);
  f.putLocalJson('bridge/vision/results/' + job + '.json', {
    protocol: VISION_RESULT_PROTOCOL, request_id: job, status: 'completed', report
  });
  const malformed = await f.service.analyzeScreenshot({}, knownCall);
  assert.equal(malformed.status, 'inference_failed');
  assert.match(malformed.error, /no request ID|did not prove|did not match/i);
  assert.equal(f.screenshots.capture, 1);
});

test('a restart can wait on a pending request by ID without needing in-memory job state', async () => {
  const f = fixture({ completeOnSleep: true });
  const jobId = ID;
  const request = {
    protocol: VISION_REQUEST_PROTOCOL, request_id: jobId, status: 'queued', created_at: ISO(BASE_MS),
    sha256: crypto.createHash('sha256').update('already-uploaded').digest('hex'),
    idempotency_key: jobId
  };
  f.control(true);
  f.runtime('ready', true);
  f.putLocalJson('bridge/vision/requests/' + jobId + '.json', request);
  const result = await f.service.wait({ request_id: jobId, waitMs: 100 }, 'after-restart');
  assert.equal(result.status, 'report_available');
  assert.equal(result.request_id, jobId);
});

test('status distinguishes missing runtime and a runtime waiting for Google authentication', async () => {
  const noRuntime = fixture();
  noRuntime.control(true);
  const missing = await noRuntime.service.status();
  assert.equal(missing.status, 'starting');
  const auth = fixture();
  auth.control(true);
  auth.runtime('needs_authentication', false);
  const needsAuth = await auth.service.status();
  assert.equal(needsAuth.status, 'needs_authentication');
});

test('setup check verifies the existing mailbox read without enabling vision or starting downloads', async () => {
  const f = fixture();
  f.putLocalJson('bridge/state/windows-app.json', {
    protocol: 'chatgpt-local-repo-state/v1',
    status: 'idle'
  });
  f.control(false);
  f.runtime('inactive', false);
  const result = await f.service.setupCheck({ authenticated: true, login: 'architect' });
  assert.equal(result.status, 'action_required');
  assert.equal(result.checks.github.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'action_required');
  assert.equal(result.checks.vision.status, 'disabled');
  assert.equal(f.readLocalJson('bridge/vision/control.json').enabled, false);
  assert.ok(Array.isArray(result.next_steps));
});

test('setup check does not pretend an absent runtime proves Google is signed out', async () => {
  const f = fixture();
  const result = await f.service.setupCheck({ authenticated: true, login: 'architect' });
  assert.equal(result.checks.mailbox.status, 'failed');
  assert.equal(result.checks.colab.status, 'not_verified');
  assert.match(result.checks.colab.message, /does not prove Google is signed out/i);
  assert.equal(result.checks.model.status, 'not_verified');
});

test('setup check reports missing GitHub sign-in and avoids mailbox API reads', async () => {
  const f = fixture();
  const result = await f.service.setupCheck({ authenticated: false });
  assert.equal(result.status, 'action_required');
  assert.equal(result.checks.github.status, 'action_required');
  assert.equal(result.checks.mailbox.status, 'action_required');
});

test('screenshot transfer limit stays below the desktop GitHub Contents response cap', () => {
  assert.equal(MAX_SCREENSHOT_BYTES, 600 * 1024);
});
