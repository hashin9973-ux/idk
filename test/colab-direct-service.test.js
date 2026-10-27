'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createVisionService,
  DIRECT_VISION_PROTOCOL,
  validateVisionContext,
  safeTunnelUrl,
  safeApiKey,
  parseTunnelEndpoint
} = require('../desktop/colab-direct-service');

const API_KEY = 'a'.repeat(43);
const TUNNEL_HOST = 'https://direct-vision-test.trycloudflare.com';
const ENDPOINT = TUNNEL_HOST + '/' + API_KEY;
const serviceTestCalls = new WeakMap();

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function createVisionReport(width, height) {
  return {
    schema_version: 'windows-vision-context/v1',
    frame: { width_px: width, height_px: height, coordinate_space: 'screenshot_jpeg_px', origin: 'top-left' },
    scene: {
      summary: 'A test window is visible.',
      active_application: 'Test window',
      window_title: 'Test window',
      screen_type: 'desktop',
      current_state: 'Idle test screen.',
      visible_dialogs: [],
      task_relevant_facts: ['The primary test window is visible.'],
      uncertainties: ['Small text may be unreadable.']
    },
    regions: [{ id: 'r1', label: 'main window', purpose: 'Primary visible interface', bbox_1000: [0, 0, 1000, 1000], bbox_px: [0, 0, width, height] }],
    text_spans: [{ text: 'Test window', region_id: 'r1', kind: 'heading', bbox_1000: [10, 10, 200, 80], bbox_px: [Math.floor(width * 0.01), Math.floor(height * 0.01), Math.floor(width * 0.2), Math.floor(height * 0.08)] }],
    controls: [{
      id: 'c1', label: 'OK', role: 'button', region_id: 'r1', bbox_1000: [100, 100, 250, 180],
      bbox_px: [Math.floor(width * 0.1), Math.floor(height * 0.1), Math.floor(width * 0.25), Math.floor(height * 0.18)],
      center_px: [999, 999], coordinate_source: 'vision_estimate', state: 'enabled',
      relation: 'In the main window', targetability: 'clear', position_verification: 'unverified_visual_estimate'
    }],
    focused_element: null,
    cursor: { visible: false, bbox_1000: null, bbox_px: null, location: 'Not confidently visible.' },
    accessibility: { available: false, source: 'windows_uia', reason: 'not_available', active_window: null, focused_control: null, controls: [], truncated: false, node_count: 0 },
    ocr: { available: false, method: 'tesseract', reason: 'ocr_unavailable', text_spans: [] },
    limitations: ['Visual target positions are estimates and have not been independently verified.']
  };
}


function fixture(options = {}) {
  let state = {
    protocol: DIRECT_VISION_PROTOCOL,
    status: 'inactive',
    enabled: false,
    model_loaded: false,
    heartbeat_at: new Date().toISOString(),
    model: 'test-model',
    gpu: 'Test GPU',
    vram_mib: 16384
  };
  let clipboardText = options.initialClipboard || '';
  const calls = [];
  const inputCalls = [];
  const inputControl = {
    run: async (steps, frame) => { inputCalls.push({ steps, frame }); return { status: 'input_completed', actions_executed: steps.length, coordinate_frame: frame }; },
    releaseAll: async () => ({ released: 0 }),
    dispose: async () => {}
  };
  const githubAuth = {
    async requestApi(input) {
      calls.push(input);
      if (input.method !== 'GET') throw new Error('Unexpected GitHub write from vision service');
      if (input.path.endsWith('/bridge/state/windows-app.json')) {
        return {
          result: {
            encoding: 'base64',
            content: Buffer.from(JSON.stringify({ protocol: 'chatgpt-local-repo-state/v1', status: 'idle' })).toString('base64'),
            sha: 'state-sha'
          }
        };
      }
      throw new Error('404 Not Found');
    }
  };
  const service = createVisionService({
    githubAuth,
    getSettings: () => ({ repositoryBridge: { owner: 'hashin9973-ux', repo: 'qdqwg', branch: 'bridge-mailbox' } }),
    getWorkspaceRoot: () => '',
    captureScreenshot: async () => ({
      bytes: Buffer.from('desktop-source-image'), filename: 'desktop.png',
      ...(Number.isFinite(options.capturedAt) ? { captured_at: options.capturedAt } : {})
    }),
    getAccessibleSnapshot: options.getAccessibleSnapshot,
    encodeJpeg: async bytes => ({ bytes: Buffer.from('compressed-jpeg-' + bytes.toString()), width: 640, height: 360, quality: 72 }),
    openColabNotebook: async url => { calls.push({ type: 'opened_colab', url }); return { opened: true }; },
    readClipboardText: () => clipboardText,
    inputControl,
    clipboardPollIntervalMs: options.clipboardPollIntervalMs || 5,
    clipboardWatchTimeoutMs: options.clipboardWatchTimeoutMs || 2000,
    pollIntervalMs: 10,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      if (options.failHost && parsed.hostname === options.failHost) {
        throw new Error('test endpoint unavailable');
      }
      const prefix = '/' + API_KEY;
      const route = parsed.pathname.startsWith(prefix + '/') ? parsed.pathname.slice(prefix.length) : parsed.pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({
        type: 'direct_http',
        method: init.method || 'GET',
        path: parsed.pathname,
        route,
        authorization: init.headers && init.headers.Authorization,
        body
      });
      if (route === '/health') {
        if (options.healthDelayMs) await new Promise(resolve => setTimeout(resolve, options.healthDelayMs));
        if (options.healthStatus) {
          return { ok: false, status: options.healthStatus, json: async () => { throw new Error('non-JSON tunnel error page'); } };
        }
        return response(200, { ...state, heartbeat_at: new Date().toISOString() });
      }
      if (route === '/registration/ack') {
        if (options.failRegistrationAck) return response(503, { protocol: DIRECT_VISION_PROTOCOL, error: 'test HTTPS acknowledgement failure' });
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, desktop_registered: true });
      }
      if (route === '/activate') {
        state = { ...state, status: 'ready', enabled: true, model_loaded: true };
        return response(202, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: true });
      }
      if (route === '/deactivate') {
        state = { ...state, status: 'inactive', enabled: false };
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: false, runtime_kept_alive: true });
      }
      if (route === '/analyze') {
        return response(200, {
          protocol: 'chatgpt-colab-vision-result/v1',
          request_id: body.request_id,
          status: 'completed',
          input_sha256: body.sha256,
          model: 'test-model',
          model_repository: 'test-model-repo',
          inference_ms: 75,
          completed_at: new Date().toISOString(),
          report: JSON.stringify(createVisionReport(640, 360))
        });
      }
      return response(404, { error: 'not found' });
    }
  });
  serviceTestCalls.set(service, calls);
  return {
    service, calls, inputCalls,
    getState: () => state,
    setState: patch => { state = { ...state, ...patch }; },
    setClipboard: value => { clipboardText = value; },
    getClipboard: () => clipboardText
  };
}

async function waitForConnected(service) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const status = await service.status();
    if (status.connection_registered && status.runtime_fresh) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Windows app did not connect to the detected public endpoint');
}

async function openAndPublishEndpoint(f, endpoint = ENDPOINT) {
  const result = await f.service.connectColab();
  assert.equal(result.status, 'waiting_for_runtime');
  assert.equal(result.opened, true);
  assert.equal(result.endpoint_watch_active, true);
  const openedUrl = f.calls.find(call => call.type === 'opened_colab')?.url;
  assert.equal(openedUrl, 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb');
  f.setClipboard(endpoint);
  return waitForConnected(f.service);
}

test('endpoint validation accepts only HTTPS Quick Tunnel URLs with a secret path token', () => {
  assert.equal(safeTunnelUrl(ENDPOINT), ENDPOINT);
  assert.deepEqual(parseTunnelEndpoint(ENDPOINT), { url: ENDPOINT, apiKey: API_KEY });
  assert.equal(safeTunnelUrl(TUNNEL_HOST), null);
  assert.equal(safeTunnelUrl('http://direct-vision-test.trycloudflare.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl('https://example.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl('https://user:pass@direct-vision-test.trycloudflare.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl(TUNNEL_HOST + '/' + API_KEY + '/extra'), null);
  assert.equal(safeTunnelUrl(ENDPOINT + '?other=value'), null);
  assert.equal(safeApiKey(API_KEY), true);
  assert.equal(safeApiKey('short'), false);
});

test('manual endpoint paste connects directly without opening Colab or using the clipboard', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab(ENDPOINT);
  assert.equal(result.connected, true);
  assert.equal(result.manually_entered, true);
  assert.equal(result.connection_registered, true);
  assert.equal(result.status, 'starting');
  assert.equal(result.enabled, true);
  assert.equal(result.vision_activated, true);
  assert.equal(result.model_loaded, false, 'connect returns promptly while model loading continues');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate' && call.method === 'POST'));
  assert.equal(result.endpoint_watch_active, false);
  assert.equal(f.calls.some(call => call.type === 'opened_colab'), false);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'));
});

test('manual endpoint paste accepts the printed PUBLIC_VISION_ENDPOINT line and rejects other hosts', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab('PUBLIC_VISION_ENDPOINT=' + ENDPOINT);
  assert.equal(result.connected, true);
  assert.equal(result.manually_entered, true);
  assert.equal(f.calls.some(call => call.type === 'opened_colab'), false);

  const invalid = fixture();
  t.after(() => invalid.service.dispose());
  const rejected = await invalid.service.connectColab('https://example.com/' + API_KEY);
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.connected, false);
  assert.match(rejected.message, /not a valid Colab endpoint/);
  assert.equal(invalid.calls.some(call => call.type === 'direct_http'), false);
});

test('Connect Colab watches the clipboard and connects when the notebook copies its public endpoint', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const status = await openAndPublishEndpoint(f);
  assert.equal(status.connection_registered, true);
  assert.equal(status.status, 'ready');
  assert.equal(status.enabled, true);
  assert.equal(status.model_loaded, true);
  assert.equal(status.transport, 'direct_https_tunnel');
  assert.equal(f.service.constants.COLAB_NOTEBOOK_URL, 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health' && call.method === 'GET'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack' && call.method === 'POST'));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.authorization === 'Bearer ' + API_KEY));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.path.startsWith('/' + API_KEY + '/')));
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('the app verifies a valid endpoint already on the clipboard after explicit Connect Colab', async t => {
  const f = fixture({ initialClipboard: 'PUBLIC_VISION_ENDPOINT=' + ENDPOINT });
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab();
  assert.equal(result.endpoint_watch_active, true);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
  assert.equal(connected.runtime_fresh, true);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'));
});

test('the watcher continues after a stale clipboard endpoint fails verification', async t => {
  const stale = 'https://stale-vision-test.trycloudflare.com/' + API_KEY;
  const f = fixture({ initialClipboard: stale, failHost: 'stale-vision-test.trycloudflare.com' });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  await new Promise(resolve => setTimeout(resolve, 30));
  const waiting = await f.service.status();
  assert.equal(waiting.connection_registered, false);
  assert.equal(waiting.status, 'waiting_for_endpoint');
  assert.match(waiting.message, /test endpoint unavailable/);
  f.setClipboard('PUBLIC_VISION_ENDPOINT=' + ENDPOINT);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
});

test('the app refuses a clipboard endpoint that does not contain the secret path key', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(TUNNEL_HOST);
  await new Promise(resolve => setTimeout(resolve, 30));
  const status = await f.service.status();
  assert.equal(status.connection_registered, false);
  assert.equal(f.calls.some(call => call.type === 'direct_http'), false);
});

test('status exposes the endpoint-validation phase while the HTTPS request is in flight', async t => {
  const f = fixture({ healthDelayMs: 100 });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  const deadline = Date.now() + 1000;
  let checking = null;
  while (Date.now() < deadline) {
    const status = await f.service.status();
    if (status.status === 'checking_endpoint') { checking = status; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(checking, 'status should report endpoint validation while it is running');
  assert.equal(checking.endpoint_test_in_progress, true);
  assert.match(checking.message, /Testing the authenticated HTTPS health response/);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
});

test('status reports the real HTTP status when the Colab tunnel returns a non-JSON error page', async t => {
  const f = fixture({ healthStatus: 530 });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  const deadline = Date.now() + 1500;
  let status;
  while (Date.now() < deadline) {
    status = await f.service.status();
    if (status.message && /HTTP 530/.test(status.message)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(status && /HTTP 530/.test(status.message), 'the failed endpoint check should surface HTTP 530');
  assert.equal(status.endpoint_watch_active, true);
  assert.equal(status.runtime_fresh, false);
  assert.match(status.message, /Last detection attempt:.*HTTP 530/);
});

test('the clipboard watcher reports an actionable timeout and stops watching', async t => {
  const f = fixture({ clipboardWatchTimeoutMs: 35, clipboardPollIntervalMs: 5 });
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab();
  assert.equal(result.endpoint_watch_active, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  const status = await f.service.status();
  assert.equal(status.endpoint_watch_active, false);
  assert.equal(status.endpoint_test_in_progress, false);
  assert.match(status.message, /Timed out waiting for the notebook to copy its public HTTPS endpoint/);
  assert.match(status.message, /Rerun the cell/i);
});

test('connection fails safely when the server-to-server acknowledgement is unsuccessful', async t => {
  const f = fixture({ failRegistrationAck: true });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  await new Promise(resolve => setTimeout(resolve, 50));
  const status = await f.service.status();
  assert.equal(status.connection_registered, false);
  assert.equal(status.runtime_fresh, false);
  assert.match(status.message, /Could not connect to the detected Colab endpoint/);
});

test('activation and deactivation are explicit and deactivation never shuts down Colab', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  const activated = await f.service.activate({}, 'activation-1');
  assert.equal(activated.status, 'ready');
  assert.equal(activated.enabled, true);
  assert.equal(activated.model_loaded, true);
  const deactivated = await f.service.deactivate({}, 'deactivation-1');
  assert.equal(deactivated.status, 'inactive');
  assert.equal(deactivated.runtime_kept_alive, true);
  assert.equal(deactivated.runtime_shutdown_attempted, undefined);
  assert.equal(f.getState().model_loaded, true);
});

test('screenshot bytes upload directly to the Colab endpoint and its report returns to the app', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.status, 'report_available');
  assert.match(result.report, /A test window is visible/);
  assert.equal(result.input_sha256, result.input_image.sha256);
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.ok(analyzeCall);
  assert.equal(analyzeCall.body.protocol, DIRECT_VISION_PROTOCOL);
  assert.equal(analyzeCall.body.sha256, result.input_sha256);
  assert.ok(typeof analyzeCall.body.image_base64 === 'string');
  assert.match(analyzeCall.body.prompt, /Screenshot frame: 640x360/);
  assert.equal(result.input_image.width, 640);
  assert.equal(result.input_image.height, 360);
  const report = JSON.parse(result.report);
  assert.equal(report.schema_version, 'windows-vision-context/v1');
  assert.equal(report.frame.width_px, 640);
  assert.deepEqual(report.controls[0].center_px, [
    (report.controls[0].bbox_px[0] + report.controls[0].bbox_px[2]) / 2,
    (report.controls[0].bbox_px[1] + report.controls[0].bbox_px[3]) / 2
  ], 'centers must be recalculated from the validated bounding boxes');
  assert.match(analyzeCall.body.prompt, /Screenshot frame: 640x360/);
  assert.equal(analyzeCall.body.frame.coordinate_space, 'screenshot_jpeg_px');
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.accessibility.available, false);
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('focused screenshot observation crops only within the screenshot frame and keeps the output frame explicit', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-focused-observation');
  const result = await f.service.analyzeScreenshot({
    source: 'desktop',
    region: [80, 40, 400, 300],
    prompt: 'Inspect the dialog and describe the important controls.'
  }, 'computer-eeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.deepEqual(analyzeCall.body.region_px, [80, 40, 400, 300]);
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.frame.height_px, 360);
});

test('focused observation rejects an invalid or too-small crop before uploading', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-invalid-focused-observation');
  const result = await f.service.analyzeScreenshot({
    source: 'desktop', region: [0, 0, 20, 20]
  }, 'computer-ffffffffffffffffffffffff');
  assert.equal(result.status, 'error');
  assert.match(result.error, /at least 48×48 pixels/i);
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/analyze'), false);
});

test('fresh Windows accessibility bounds are sent with the exact screenshot frame', async t => {
  const f = fixture({
    getAccessibleSnapshot: async ({ screen, frame }) => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Test app', process_id: 42, bbox_px: [0, 0, frame.width, frame.height], bbox_1000: [0, 0, 1000, 1000] },
      focused_control: null,
      controls: [{
        id: 'uia-1', label: 'OK', role: 'Button', enabled: true, focused: false,
        bbox_px: [100, 100, 200, 140], bbox_1000: [156, 278, 313, 389],
        center_px: [150, 120], source: 'windows_uia', grounding: 'windows_accessibility_bounds'
      }],
      truncated: false, node_count: 4,
      received_screen: screen, received_frame: frame
    })
  });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-uia-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-cccccccccccccccccccccccc');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.equal(analyzeCall.body.accessibility.available, true);
  assert.equal(analyzeCall.body.accessibility.controls[0].source, 'windows_uia');
  assert.deepEqual(analyzeCall.body.accessibility.controls[0].bbox_px, [100, 100, 200, 140]);
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.frame.height_px, 360);
});

test('stale accessibility snapshots are not attached to a newer screenshot', async t => {
  const f = fixture({
    capturedAt: Date.now() - 6000,
    getAccessibleSnapshot: async ({ frame }) => ({
      available: true, active_window: null, focused_control: null, controls: [],
      truncated: false, node_count: 0, frame
    })
  });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-stale-uia-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-dddddddddddddddddddddddd');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.equal(analyzeCall.body.accessibility.available, false);
  assert.equal(analyzeCall.body.accessibility.reason, 'snapshot_too_old_for_frame');
});

test('setup check keeps GitHub mailbox verification separate and requires no Colab secret', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  const result = await f.service.setupCheck({ authenticated: true, login: 'tester' });
  assert.equal(result.checks.github.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'passed');
  assert.ok(result.next_steps.every(step => !/QDQWG_TOKEN|Colab Secret|fine-grained token/i.test(step)));
});

test('successful Colab connection activates the model automatically and supports batched local input with observation', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const connected = await f.service.connectColab(ENDPOINT);
  assert.equal(connected.connected, true);
  assert.equal(connected.enabled, true);
  assert.equal(connected.vision_activated, true);
  assert.equal(connected.model_loaded, false);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'));

  const started = await f.service.inputAction({ action: 'start_control' }, 'control-1');
  assert.equal(started.status, 'control_ready');
  assert.equal(f.service.isControlSessionActive(), true);
  const sequence = await f.service.inputAction({
    action: 'sequence',
    steps: [
      { type: 'hotkey', keys: ['CTRL', 'S'] },
      { type: 'click', x: 120, y: 80, button: 'right' }
    ],
    observe: true,
    waitMs: 1000
  }, 'computer-bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(sequence.status, 'input_completed');
  assert.equal(sequence.observation.status, 'report_available');
  assert.deepEqual(f.inputCalls[0].frame, { width: 1920, height: 1080 });
  assert.equal(f.inputCalls[0].steps.length, 2);

  const stopped = await f.service.inputAction({ action: 'stop_control' });
  assert.equal(stopped.status, 'control_stopped');
  assert.equal(f.service.isControlSessionActive(), false);
});

test('notebook output clipboard-copy JavaScript parses and contains a direct endpoint, not an app-link handoff', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  const marker = 'js = r"""';
  const start = source.indexOf(marker);
  const end = source.indexOf('""".replace("__ENDPOINT__", json.dumps(endpoint_url))', start);
  assert.ok(start >= 0 && end > start, 'endpoint clipboard script template must be extractable');
  const browserSource = source.slice(start + marker.length, end).replaceAll('__ENDPOINT__', JSON.stringify(ENDPOINT));
  assert.doesNotMatch(browserSource, /__ENDPOINT__/);
  assert.doesNotThrow(() => new vm.Script(browserSource), 'browser clipboard script must parse');
  assert.match(browserSource, /navigator\.clipboard\.writeText/);
  assert.match(browserSource, /Copy endpoint for Windows Bridge/);
  assert.doesNotMatch(browserSource, /windowsrepositorybridge:\/\/connect-colab|wrb_pair_nonce|targetAddressSpace|navigator\.permissions/);
});

test('notebook scopes its public API to the random URL path token and keeps the model off', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  assert.match(source, /PUBLIC_VISION_ENDPOINT=/);
  assert.match(source, /def display_public_endpoint/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /def _route_path\(self\)/);
  assert.match(source, /requests\.get\(url, headers=\{"Authorization": "Bearer " \+ API_KEY\}, timeout=2\)/);
  assert.match(source, /DIRECT_PROTOCOL/);
  assert.match(source, /registration\/ack/);
  assert.doesNotMatch(source, /register_tunnel_with_desktop|display_desktop_pairing_link|windowsrepositorybridge:\/\/connect-colab|wrb_pair_nonce|targetAddressSpace/);
  assert.doesNotMatch(source, /QDQWG_TOKEN|userdata\.get|api\.github\.com\/repos\/hashin9973-ux\/qdqwg/);
});

test('the desktop uses a clipboard reader only for the explicit Colab connect flow', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'colab-direct-service.js'), 'utf8');
  assert.match(main, /readClipboardText: \(\) => clipboard\.readText\(\)/);
  assert.match(service, /async function watchClipboardForEndpoint/);
  assert.match(service, /if \(text\) \{\s*const endpoint = endpointFromClipboard\(text\)/);
  assert.doesNotMatch(service, /text !== watch\.baseline/);
  assert.match(service, /parseTunnelEndpoint\(match\[0\]\)/);
  assert.doesNotMatch(main, /setAsDefaultProtocolClient|COLAB_PROTOCOL_SCHEME|receiveColabProtocolLink/);
  assert.doesNotMatch(service, /http\.createServer|ensureReceiver|vision\/challenge|vision\/register|wrb_pair_nonce/);
});

test('structured vision context rejects truncated JSON and mismatched frames', () => {
  assert.throws(() => validateVisionContext('{"schema_version":"windows-vision-context/v1"', { width_px: 640, height_px: 360 }), /malformed or truncated JSON/i);
  assert.throws(() => validateVisionContext(JSON.stringify(createVisionReport(320, 180)), { width_px: 640, height_px: 360 }), /does not match the submitted screenshot/i);
});

test('structured vision context rejects invalid control bounds instead of accepting unreliable coordinates', () => {
  const report = createVisionReport(640, 360);
  report.controls[0].bbox_px = [630, 350, 650, 370];
  assert.throws(() => validateVisionContext(JSON.stringify(report), { width_px: 640, height_px: 360 }), /outside the submitted screenshot frame/i);
});
