'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createVisionService,
  DIRECT_VISION_PROTOCOL,
  COLAB_PROTOCOL_SCHEME,
  safeTunnelUrl,
  safeApiKey
} = require('../desktop/colab-direct-service');

const TUNNEL = 'https://direct-vision-test.trycloudflare.com';
const API_KEY = 'a'.repeat(43);
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
    pollIntervalMs: 10,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({
        type: 'direct_http',
        method: init.method || 'GET',
        path: parsed.pathname,
        authorization: init.headers && init.headers.Authorization,
        body
      });
      if (parsed.pathname === '/health') return response(200, { ...state, heartbeat_at: new Date().toISOString() });
      if (parsed.pathname === '/registration/ack') {
        if (options.failRegistrationAck) return response(503, { protocol: DIRECT_VISION_PROTOCOL, error: 'test tunnel acknowledgement failure' });
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, desktop_registered: true });
      }
      if (parsed.pathname === '/activate') {
        state = { ...state, status: 'ready', enabled: true, model_loaded: true };
        return response(202, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: true });
      }
      if (parsed.pathname === '/deactivate') {
        state = { ...state, status: 'inactive', enabled: false };
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: false, runtime_kept_alive: true });
      }
      if (parsed.pathname === '/analyze') {
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
  return { service, calls, getState: () => state, setState: patch => { state = { ...state, ...patch }; } };
}

async function startPairing(service, calls) {
  const result = await service.connectColab();
  assert.equal(result.status, 'waiting_for_runtime');
  assert.equal(result.opened, true);
  const openedUrl = calls.find(call => call.type === 'opened_colab')?.url;
  assert.ok(openedUrl, 'Connect Colab should open the notebook');
  const nonce = new URL(openedUrl).searchParams.get('wrb_pair_nonce');
  assert.match(nonce || '', /^[a-f0-9]{64}$/);
  return { result, openedUrl, nonce };
}

async function registerColab(service, calls, options = {}) {
  const pairing = await startPairing(service, calls);
  const result = await service.registerColabTunnel({
    protocol: options.protocol || DIRECT_VISION_PROTOCOL,
    nonce: options.nonce || pairing.nonce,
    tunnel_url: options.url || TUNNEL,
    api_key: options.apiKey || API_KEY
  });
  return { ...pairing, registration: result };
}

test('tunnel validation rejects non-HTTPS, non-Cloudflare, and credential-bearing URLs', () => {
  assert.equal(safeTunnelUrl(TUNNEL), TUNNEL);
  assert.equal(safeTunnelUrl('http://direct-vision-test.trycloudflare.com'), null);
  assert.equal(safeTunnelUrl('https://example.com'), null);
  assert.equal(safeTunnelUrl('https://user:pass@direct-vision-test.trycloudflare.com'), null);
  assert.equal(safeTunnelUrl('https://direct-vision-test.trycloudflare.com/path'), null);
  assert.equal(safeApiKey(API_KEY), true);
  assert.equal(safeApiKey('short'), false);
  assert.equal(COLAB_PROTOCOL_SCHEME, 'windowsrepositorybridge');
});

test('app opens a nonce-paired Colab URL and pairs over the public HTTPS endpoint without a local listener', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const pairing = await registerColab(f.service, f.calls);
  assert.equal(new URL(pairing.openedUrl).origin, 'https://colab.research.google.com');
  assert.equal(pairing.registration.connected, true);
  assert.equal(pairing.registration.connection_registered, true);
  assert.equal(pairing.registration.status, 'inactive');
  assert.equal(pairing.registration.model_loaded, false);
  assert.equal(pairing.registration.transport, 'direct_https_tunnel');
  assert.equal(f.service.getRegistrationPort, undefined, 'the desktop no longer hosts a localhost registration server');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.path === '/health' && call.method === 'GET'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.path === '/registration/ack' && call.method === 'POST'));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.authorization === 'Bearer ' + API_KEY));
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.method !== 'GET' && call.path?.includes('/contents/')).length, 0);
});

test('pairing rejects bad nonces, unsupported URLs, and invalid API keys', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const pairing = await startPairing(f.service, f.calls);
  const valid = { protocol: DIRECT_VISION_PROTOCOL, nonce: pairing.nonce, tunnel_url: TUNNEL, api_key: API_KEY };
  await assert.rejects(
    f.service.registerColabTunnel({ ...valid, nonce: 'b'.repeat(64) }),
    /pairing link is invalid|expired|does not match/i
  );
  await assert.rejects(
    f.service.registerColabTunnel({ ...valid, tunnel_url: 'https://example.com' }),
    /public HTTPS URL or bearer key is invalid/i
  );
  await assert.rejects(
    f.service.registerColabTunnel({ ...valid, api_key: 'short' }),
    /public HTTPS URL or bearer key is invalid/i
  );
  const state = await f.service.status();
  assert.equal(state.connection_registered, false);
  assert.equal(state.runtime_fresh, false);
});

test('pairing rolls back if the authenticated server-to-server acknowledgement fails', async t => {
  const f = fixture({ failRegistrationAck: true });
  t.after(() => f.service.dispose());
  const pairing = await startPairing(f.service, f.calls);
  await assert.rejects(f.service.registerColabTunnel({
    protocol: DIRECT_VISION_PROTOCOL,
    nonce: pairing.nonce,
    tunnel_url: TUNNEL,
    api_key: API_KEY
  }), /Could not pair with the public Colab server.*HTTP 503/);
  const status = await f.service.status();
  assert.equal(status.connection_registered, false);
  assert.equal(status.runtime_fresh, false);
});

test('activation and deactivation are explicit and deactivation never shuts down the runtime', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await registerColab(f.service, f.calls);
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
  await registerColab(f.service, f.calls);
  await f.service.activate({}, 'activate-for-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.status, 'report_available');
  assert.match(result.report, /A test window is visible/);
  assert.equal(result.input_sha256, result.input_image.sha256);
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.path === '/analyze');
  assert.ok(analyzeCall);
  assert.equal(analyzeCall.body.protocol, DIRECT_VISION_PROTOCOL);
  assert.equal(analyzeCall.body.sha256, result.input_sha256);
  assert.ok(typeof analyzeCall.body.image_base64 === 'string');
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('setup check never asks for QDQWG_TOKEN and keeps GitHub mailbox verification separate', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await registerColab(f.service, f.calls);
  const result = await f.service.setupCheck({ authenticated: true, login: 'tester' });
  assert.equal(result.checks.github.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'not_verified');
  assert.ok(result.next_steps.every(step => !/QDQWG_TOKEN|Colab Secret|fine-grained token/i.test(step)));
});

test('notebook pairing JavaScript parses and opens the Windows app protocol link', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  const marker = 'js = r"""';
  const start = source.indexOf(marker);
  const end = source.indexOf('""".replace("__PAYLOAD__", payload_json)', start);
  assert.ok(start >= 0 && end > start, 'browser script template must be extractable');
  const browserSource = source.slice(start + marker.length, end).replace('const payload = __PAYLOAD__;', 'const payload = {};');
  assert.doesNotMatch(browserSource, /__PAYLOAD__/);
  assert.doesNotThrow(() => new vm.Script(browserSource), 'browser pairing script must parse');
  assert.match(browserSource, /windowsrepositorybridge:\/\/connect-colab/);
  assert.match(browserSource, /wrb_pair_nonce/);
  assert.doesNotMatch(browserSource, /navigator\.permissions|targetAddressSpace|http:\/\/127\.0\.0\.1/);
});

test('notebook and desktop service no longer use browser-to-localhost registration', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  assert.match(source, /cloudflared/);
  assert.match(source, /DirectVisionHandler/);
  assert.match(source, /display_desktop_pairing_link/);
  assert.match(source, /registration\/ack/);
  assert.doesNotMatch(source, /QDQWG_TOKEN|userdata\.get|api\.github\.com\/repos\/hashin9973-ux\/qdqwg/);
  const desktopService = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'colab-direct-service.js'), 'utf8');
  assert.doesNotMatch(desktopService, /http\.createServer|ensureReceiver|vision\/challenge|vision\/register|CALLBACK_PORT/);
});

test('Windows app registers and handles only the intended Colab deep-link route', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  assert.match(main, /setAsDefaultProtocolClient\(COLAB_PROTOCOL_SCHEME/);
  assert.match(main, /second-instance/);
  assert.match(main, /windowsrepositorybridge:\/\/connect-colab/);
  assert.match(main, /registerColabTunnel\(payload\)/);
  assert.match(main, /app:vision-connect-colab/);
});
