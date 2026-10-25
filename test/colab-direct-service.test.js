'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createVisionService,
  DIRECT_VISION_PROTOCOL,
  safeTunnelUrl,
  safeApiKey
} = require('../desktop/colab-direct-service');

const ORIGIN = 'https://colab.research.google.com';
const serviceTestCalls = new WeakMap();
const TUNNEL = 'https://direct-vision-test.trycloudflare.com';
const API_KEY = 'a'.repeat(43);

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
    callbackPortStart: options.callbackPortStart || (22000 + Math.floor(Math.random() * 10000)),
    callbackPortCount: 8,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ type: 'direct_http', method: init.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/health') return response(200, { ...state, heartbeat_at: new Date().toISOString() });
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

async function waitForPort(service) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = service.getRegistrationPort();
    if (port) return port;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Local registration listener did not start');
}

async function registerColab(service, port, options = {}) {
  const origin = options.origin || ORIGIN;
  const base = 'http://127.0.0.1:' + port;
  const opened = [...serviceTestCalls.get(service) || []];
  const openedUrl = opened.find(call => call.type === 'opened_colab')?.url;
  if (!openedUrl) throw new Error('The app did not open Colab with a registration nonce.');
  const nonce = new URL(openedUrl).searchParams.get('bridge_registration_nonce');
  return fetch(base + '/vision/register', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: DIRECT_VISION_PROTOCOL,
      nonce,
      tunnel_url: options.url || TUNNEL,
      api_key: options.apiKey || API_KEY
    })
  });
}

test('tunnel validation rejects non-HTTPS, non-Cloudflare, and credential-bearing URLs', () => {
  assert.equal(safeTunnelUrl(TUNNEL), TUNNEL);
  assert.equal(safeTunnelUrl('http://direct-vision-test.trycloudflare.com'), null);
  assert.equal(safeTunnelUrl('https://example.com'), null);
  assert.equal(safeTunnelUrl('https://user:pass@direct-vision-test.trycloudflare.com'), null);
  assert.equal(safeTunnelUrl('https://direct-vision-test.trycloudflare.com/path'), null);
  assert.equal(safeApiKey(API_KEY), true);
  assert.equal(safeApiKey('short'), false);
});

test('Colab can register a direct tunnel via one-time browser handshake; health checks bypass GitHub', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const port = await waitForPort(f.service);
  const result = await f.service.connectColab();
  assert.equal(result.status, 'waiting_for_runtime');
  assert.equal(result.opened, true);

  const registered = await registerColab(f.service, port);
  assert.equal(registered.status, 200);
  const status = await f.service.status();
  assert.equal(status.runtime_fresh, true);
  assert.equal(status.connection_registered, true);
  assert.equal(status.status, 'inactive');
  assert.equal(status.model_loaded, false);
  assert.equal(status.transport, 'direct_https_tunnel');
  assert.equal(f.calls.filter(call => call.method && call.method !== 'GET' && call.path?.includes('/contents/')).length, 0);
});

test('local registration rejects requests from an untrusted origin and rejects an invalid tunnel URL', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const port = await waitForPort(f.service);
  const blocked = await registerColab(f.service, port, { origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  const invalid = await registerColab(f.service, port, { url: 'https://example.com' });
  assert.equal(invalid.status, 400);
  assert.equal((await f.service.status()).runtime_fresh, false);
});

test('activation and deactivation are explicit and deactivation never shuts down the runtime', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const port = await waitForPort(f.service);
  assert.equal((await registerColab(f.service, port)).status, 200);
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

test('screenshot bytes travel through the direct Colab endpoint and report is returned to the app', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const port = await waitForPort(f.service);
  assert.equal((await registerColab(f.service, port)).status, 200);
  await f.service.activate({}, 'activate-for-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'analysis-direct-1');
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
  const port = await waitForPort(f.service);
  await registerColab(f.service, port);
  const result = await f.service.setupCheck({ authenticated: true, login: 'tester' });
  assert.equal(result.checks.github.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'not_verified');
  assert.ok(result.next_steps.every(step => !/QDQWG_TOKEN|Colab Secret|fine-grained token/i.test(step)));
});

test('notebook no longer depends on GitHub secrets or GitHub mailbox APIs', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  assert.match(source, /cloudflared/);
  assert.match(source, /DirectVisionHandler/);
  assert.match(source, /register_tunnel_with_desktop/);
  assert.doesNotMatch(source, /QDQWG_TOKEN|userdata\.get|api\.github\.com\/repos\/hashin9973-ux\/qdqwg/);
});
