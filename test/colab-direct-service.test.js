'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createVisionService,
  DIRECT_VISION_PROTOCOL,
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
    captureScreenshot: async () => ({ bytes: Buffer.from('desktop-source-image'), filename: 'desktop.png' }),
    encodeJpeg: async bytes => ({ bytes: Buffer.from('compressed-jpeg-' + bytes.toString()), width: 640, height: 360, quality: 72 }),
    openColabNotebook: async url => { calls.push({ type: 'opened_colab', url }); return { opened: true }; },
    readClipboardText: () => clipboardText,
    clipboardPollIntervalMs: options.clipboardPollIntervalMs || 5,
    clipboardWatchTimeoutMs: options.clipboardWatchTimeoutMs || 2000,
    pollIntervalMs: 10,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
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
      if (route === '/health') return response(200, { ...state, heartbeat_at: new Date().toISOString() });
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
          report: 'Overview\nA test window is visible.\n\nUncertainty\nSmall text is not legible.'
        });
      }
      return response(404, { error: 'not found' });
    }
  });
  serviceTestCalls.set(service, calls);
  return {
    service, calls,
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

test('Connect Colab watches the clipboard and connects when the notebook copies its public endpoint', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const status = await openAndPublishEndpoint(f);
  assert.equal(status.connection_registered, true);
  assert.equal(status.status, 'inactive');
  assert.equal(status.model_loaded, false);
  assert.equal(status.transport, 'direct_https_tunnel');
  assert.equal(f.service.constants.COLAB_NOTEBOOK_URL, 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health' && call.method === 'GET'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack' && call.method === 'POST'));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.authorization === 'Bearer ' + API_KEY));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.path.startsWith('/' + API_KEY + '/')));
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('the app ignores stale clipboard content and waits for a new notebook endpoint', async t => {
  const f = fixture({ initialClipboard: ENDPOINT });
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab();
  assert.equal(result.endpoint_watch_active, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  const waiting = await f.service.status();
  assert.equal(waiting.connection_registered, false);
  assert.equal(waiting.status, 'waiting_for_endpoint');
  assert.equal(f.calls.some(call => call.type === 'direct_http'), false);
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
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('setup check keeps GitHub mailbox verification separate and requires no Colab secret', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  const result = await f.service.setupCheck({ authenticated: true, login: 'tester' });
  assert.equal(result.checks.github.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'not_verified');
  assert.ok(result.next_steps.every(step => !/QDQWG_TOKEN|Colab Secret|fine-grained token/i.test(step)));
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
  assert.match(service, /text !== watch\.baseline/);
  assert.match(service, /parseTunnelEndpoint\(match\[0\]\)/);
  assert.doesNotMatch(main, /setAsDefaultProtocolClient|COLAB_PROTOCOL_SCHEME|receiveColabProtocolLink/);
  assert.doesNotMatch(service, /http\.createServer|ensureReceiver|vision\/challenge|vision\/register|wrb_pair_nonce/);
});
