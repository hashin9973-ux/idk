'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DIRECT_VISION_PROTOCOL = 'chatgpt-colab-vision-direct/v1';
const RESULT_PROTOCOL = 'chatgpt-colab-vision-result/v1';
const DEFAULT_MAILBOX = Object.freeze({ owner: 'hashin9973-ux', repo: 'qdqwg', branch: 'bridge-mailbox' });
const COLAB_NOTEBOOK_URL = 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb';
const COLAB_ORIGIN = 'https://colab.research.google.com';
const CALLBACK_PORT_START = 17843;
const CALLBACK_PORT_COUNT = 12;
const MODEL_ID = 'Qwen/Qwen3-VL-8B-Instruct-GGUF';
const MODEL_FILE = 'Qwen3VL-8B-Instruct-Q4_K_M.gguf';
const PROJECTOR_FILE = 'mmproj-Qwen3VL-8B-Instruct-F16.gguf';
const MAX_SCREENSHOT_BYTES = 600 * 1024;
const MAX_INPUT_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 120000;
const DIRECT_TIMEOUT_MS = 360000;
const CALLBACK_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROMPT = 'Describe the screenshot using only visible evidence. Include: (1) overview, (2) important visible objects, panels, controls and layout, (3) accurate transcription of visible text, (4) visible errors or anomalies, (5) the screenshot evidence supporting each observation, and (6) explicit uncertainty where text/details are unclear. Do not infer unseen state or perform debugging/reasoning.';

function messageOf(error) {
  return String(error && error.message || error || 'Unknown vision error').slice(0, 1600);
}

function validJobId(value) {
  return typeof value === 'string' && /^vision-[a-f0-9]{24}$/.test(value);
}

function safeTunnelUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(parsed.hostname) ||
        parsed.port || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeApiKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,100}$/.test(value);
}

function createVisionService(deps) {
  const {
    githubAuth,
    getSettings,
    getWorkspaceRoot,
    captureScreenshot,
    encodeJpeg,
    openColabNotebook,
    fsImpl = fs,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollIntervalMs = 250,
    fetchImpl = globalThis.fetch,
    callbackPortStart = CALLBACK_PORT_START,
    callbackPortCount = CALLBACK_PORT_COUNT
  } = deps || {};

  let lastColabOpenAt = 0;
  let colabConnection = null;
  let receiverServer = null;
  let receiverPort = null;
  let receiverPromise = null;
  let pendingNonce = null;
  let visionEnabled = false;
  const jobs = new Map();

  function mailboxConfig() {
    const settings = typeof getSettings === 'function' ? getSettings() || {} : {};
    const configured = settings.repositoryBridge || {};
    const result = {
      owner: String(configured.owner || DEFAULT_MAILBOX.owner),
      repo: String(configured.repo || DEFAULT_MAILBOX.repo),
      branch: String(configured.branch || DEFAULT_MAILBOX.branch)
    };
    if (result.owner !== DEFAULT_MAILBOX.owner || result.repo !== DEFAULT_MAILBOX.repo || result.branch !== DEFAULT_MAILBOX.branch) {
      throw new Error('Vision uses the existing hashin9973-ux/qdqwg mailbox on branch bridge-mailbox.');
    }
    return result;
  }

  async function readMailboxJson(relativePath) {
    if (!githubAuth || typeof githubAuth.requestApi !== 'function') throw new Error('The app GitHub connection is unavailable.');
    if (typeof relativePath !== 'string' || relativePath.startsWith('/') ||
        relativePath.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) {
      throw new Error('Unsafe internal mailbox path.');
    }
    const cfg = mailboxConfig();
    let response;
    try {
      response = await githubAuth.requestApi({
        method: 'GET',
        path: '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + relativePath,
        query: { ref: cfg.branch }
      });
    } catch (error) {
      if (/(^|\D)404(\D|$)|not found|does not exist/i.test(messageOf(error))) return null;
      throw error;
    }
    const entry = response && response.result;
    if (!entry || typeof entry.content !== 'string' || entry.encoding !== 'base64') return null;
    try {
      return { value: JSON.parse(Buffer.from(entry.content.replace(/\s/g, ''), 'base64').toString('utf8')), sha: entry.sha || null };
    } catch {
      throw new Error('Malformed JSON in mailbox path ' + relativePath + '.');
    }
  }

  function sendJson(res, status, value, cors = false) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', COLAB_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.end(JSON.stringify(value));
  }

  async function readBody(req, maxBytes = 32000) {
    if (Number(req.headers['content-length'] || 0) > maxBytes) throw new Error('Registration payload is too large.');
    const pieces = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > maxBytes) throw new Error('Registration payload is too large.');
      pieces.push(part);
    }
    return JSON.parse(Buffer.concat(pieces).toString('utf8'));
  }

  async function handleRegistration(req, res) {
    const origin = req.headers.origin;
    if (origin !== COLAB_ORIGIN) {
      sendJson(res, 403, { ok: false, error: 'Only the official Google Colab origin can register this connection.' });
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return sendJson(res, 204, {}, true);
    if (req.method === 'GET' && url.pathname === '/vision/handshake') {
      pendingNonce = { value: crypto.randomBytes(32).toString('hex'), expiresAt: now() + CALLBACK_NONCE_TTL_MS };
      return sendJson(res, 200, { protocol: DIRECT_VISION_PROTOCOL, nonce: pendingNonce.value }, true);
    }
    if (req.method !== 'POST' || url.pathname !== '/vision/register') {
      return sendJson(res, 404, { ok: false, error: 'Unknown registration route.' }, true);
    }
    let payload;
    try {
      payload = await readBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: messageOf(error) }, true);
    }
    if (!pendingNonce || pendingNonce.expiresAt < now() || payload.nonce !== pendingNonce.value) {
      return sendJson(res, 403, { ok: false, error: 'The one-time registration challenge is missing, expired, or incorrect.' }, true);
    }
    const tunnelUrl = safeTunnelUrl(payload.tunnel_url);
    if (payload.protocol !== DIRECT_VISION_PROTOCOL || !tunnelUrl || !safeApiKey(payload.api_key)) {
      return sendJson(res, 400, { ok: false, error: 'The Colab endpoint or protocol is invalid.' }, true);
    }
    pendingNonce = null;
    colabConnection = { url: tunnelUrl, apiKey: payload.api_key, registeredAt: now(), lastHealthAt: 0 };
    visionEnabled = false;
    return sendJson(res, 200, { ok: true, protocol: DIRECT_VISION_PROTOCOL }, true);
  }

  async function ensureReceiver() {
    if (receiverServer && receiverServer.listening) return receiverPort;
    if (receiverPromise) return receiverPromise;
    receiverPromise = new Promise((resolve, reject) => {
      let offset = 0;
      const tryPort = () => {
        if (offset >= callbackPortCount) {
          receiverPromise = null;
          reject(new Error('No free localhost port was available for Colab registration. Close duplicate app instances and retry.'));
          return;
        }
        const port = callbackPortStart + offset++;
        const server = http.createServer((req, res) => {
          void handleRegistration(req, res).catch(error => {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: messageOf(error) });
            else res.destroy();
          });
        });
        server.on('error', error => {
          server.close();
          if (error && error.code === 'EADDRINUSE') return tryPort();
          receiverPromise = null;
          reject(error);
        });
        server.listen(port, '127.0.0.1', () => {
          receiverServer = server;
          receiverPort = port;
          receiverPromise = null;
          resolve(port);
        });
      };
      tryPort();
    });
    return receiverPromise;
  }

  async function directRequest(route, options = {}) {
    if (!colabConnection) throw new Error('Colab is not registered. Click Connect Colab and run the notebook cell.');
    if (typeof fetchImpl !== 'function') throw new Error('This app does not provide an HTTPS client for direct Colab vision.');
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(colabConnection.url + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + colabConnection.apiKey,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error'
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Colab returned malformed JSON for ' + route + '.'); }
      if (!response.ok) throw new Error('Colab direct endpoint returned HTTP ' + response.status + ': ' + String(data.error || data.message || 'request failed').slice(0, 600));
      if (data.protocol && data.protocol !== DIRECT_VISION_PROTOCOL &&
          !(route === '/analyze' && data.protocol === RESULT_PROTOCOL)) {
        throw new Error('Colab response protocol did not match the direct vision protocol.');
      }
      if (route === '/health') colabConnection.lastHealthAt = now();
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function stateFromRemote(data) {
    const enabled = data.enabled === true;
    const loaded = data.model_loaded === true;
    const reported = String(data.status || 'starting');
    let status;
    if (!enabled) status = 'inactive';
    else if (reported === 'processing' || reported === 'inference_in_progress') status = 'inference_in_progress';
    else if (['gpu_unavailable', 'needs_authentication', 'error'].includes(reported)) status = reported;
    else status = loaded ? 'ready' : 'starting';
    return {
      status, enabled, runtime_fresh: true, runtime_alive: true, connection_registered: true,
      runtime_status: reported, heartbeat_at: data.heartbeat_at || new Date(now()).toISOString(),
      gpu: data.gpu || null, vram_mib: Number.isFinite(data.vram_mib) ? data.vram_mib : null,
      model_loaded: loaded, model: data.model || MODEL_FILE, stage: data.stage || null,
      active_request_id: data.active_request_id || null, last_completed_request_id: data.last_completed_request_id || null,
      message: String(data.message || ''), transport: 'direct_https_tunnel'
    };
  }

  async function queryRuntime() {
    if (!colabConnection) {
      return {
        status: 'disconnected', enabled: visionEnabled, runtime_fresh: false, runtime_alive: false,
        connection_registered: false, model_loaded: false,
        message: 'No direct Colab connection is registered. Click Connect Colab and run the notebook cell; no GitHub token is needed in Colab.'
      };
    }
    try {
      const data = await directRequest('/health', { timeoutMs: 8000 });
      if (data.protocol !== DIRECT_VISION_PROTOCOL) throw new Error('The Colab health protocol is invalid.');
      visionEnabled = data.enabled === true;
      return stateFromRemote(data);
    } catch (error) {
      return {
        status: 'disconnected', enabled: visionEnabled, runtime_fresh: false, runtime_alive: false,
        connection_registered: true, model_loaded: false,
        message: 'The Colab tunnel was registered but is not responding: ' + messageOf(error)
      };
    }
  }

  async function openColabIfNeeded() {
    if (now() - lastColabOpenAt < 60000) return { opened: false, throttled: true };
    if (typeof openColabNotebook !== 'function') throw new Error('Opening the Colab notebook is unavailable in this app build.');
    await ensureReceiver();
    const result = await openColabNotebook(COLAB_NOTEBOOK_URL);
    lastColabOpenAt = now();
    return { opened: true, result: result || null, callback_port: receiverPort };
  }

  async function connectColab() {
    try {
      const state = await queryRuntime();
      if (state.runtime_fresh) {
        return {
          ...state, connected: true, opened: false, vision_activated: state.enabled,
          notebook_url: COLAB_NOTEBOOK_URL,
          message: state.model_loaded
            ? 'Colab is connected directly through its authenticated HTTPS tunnel. Vision ' + (state.enabled ? 'is enabled.' : 'is off.')
            : 'Colab is connected directly. Vision is off; the model will not download until vision_activate is requested.'
        };
      }
      const opened = await openColabIfNeeded();
      return {
        ...state, status: 'waiting_for_runtime', connected: false,
        opened: Boolean(opened.opened), open_throttled: Boolean(opened.throttled),
        vision_activated: false, notebook_url: COLAB_NOTEBOOK_URL,
        message: opened.throttled
          ? 'The notebook was opened recently but has not registered its HTTPS tunnel. Switch to Colab and run the notebook cell; no Colab Secret or GitHub token is needed.'
          : 'Colab was opened. Connect a runtime if needed and run the notebook cell. It will automatically register an authenticated HTTPS tunnel with this app. Vision stays off.',
        next_steps: ['Run the notebook cell titled “Start the direct Colab vision server”.', 'Wait until the app reports Colab connected. Call vision_activate only when you want the model loaded.']
      };
    } catch (error) {
      return { status: 'error', connected: false, opened: false, vision_activated: false, error: messageOf(error), message: 'Could not initialize direct Colab connection: ' + messageOf(error) };
    }
  }

  async function activate(args = {}, callId = null) {
    try {
      let state = await queryRuntime();
      if (!state.connection_registered || !state.runtime_fresh) {
        const opened = await openColabIfNeeded();
        return {
          ...state, status: 'starting', enabled: false, opened: Boolean(opened.opened),
          notebook_url: COLAB_NOTEBOOK_URL,
          message: 'Run the Colab worker cell to establish the direct connection, then call vision_activate again. The model will not load before explicit activation.'
        };
      }
      if (state.enabled && state.model_loaded && state.status === 'ready') {
        return { ...state, already_ready: true, model_reload_requested: false, notebook_url: COLAB_NOTEBOOK_URL };
      }
      await directRequest('/activate', {
        method: 'POST', timeoutMs: 10000,
        body: { protocol: DIRECT_VISION_PROTOCOL, request_id: String(callId || '').slice(0, 120) }
      });
      visionEnabled = true;
      await sleep(200);
      state = await queryRuntime();
      return {
        ...state,
        status: state.model_loaded ? (state.enabled ? 'ready' : state.status) : (['gpu_unavailable', 'needs_authentication', 'error'].includes(state.status) ? state.status : 'starting'),
        enabled: true, model_reload_requested: false, notebook_url: COLAB_NOTEBOOK_URL,
        message: state.message || 'Colab accepted activation. Model setup/download and compilation are beginning; this may take several minutes.',
        manual_steps: manualSteps(state.status)
      };
    } catch (error) {
      return { status: 'error', enabled: visionEnabled, error: messageOf(error), notebook_url: COLAB_NOTEBOOK_URL };
    }
  }

  function manualSteps(status) {
    const common = [
      'Keep the Colab notebook tab open with its worker cell running. Screenshots and reports travel through the authenticated HTTPS tunnel; Colab does not need a GitHub token or Colab Secret.',
      'The first activation may download about 6.2 GB of model/projector weights and compile llama.cpp. Later activations in this runtime reuse the loaded model.'
    ];
    if (status === 'gpu_unavailable') return ['Select a Colab GPU runtime if one is offered; free GPU access is not guaranteed.', ...common];
    if (status === 'needs_authentication') return ['Complete any Google Colab or Google Drive authorization requested in the Colab tab.', ...common];
    if (status === 'disconnected') return ['Reconnect the Colab runtime and rerun the notebook cell to create a fresh tunnel.', ...common];
    return common;
  }

  async function deactivate(args = {}, callId = null) {
    const before = await queryRuntime();
    visionEnabled = false;
    try {
      if (before.runtime_fresh) {
        await directRequest('/deactivate', {
          method: 'POST', timeoutMs: 10000,
          body: { protocol: DIRECT_VISION_PROTOCOL, request_id: String(callId || '').slice(0, 120) }
        });
      }
      return {
        status: 'inactive', enabled: false, runtime_status: before.runtime_status || null,
        runtime_alive: before.runtime_alive === true, runtime_kept_alive: true,
        in_progress_request_id: before.active_request_id || null,
        in_progress_may_finish: Boolean(before.active_request_id),
        message: 'Future screenshot requests are disabled. The Colab runtime, tunnel, and loaded model are left running.',
        next_step: 'Call vision_activate to re-enable requests; the loaded model should be reused.'
      };
    } catch (error) {
      return { status: 'error', error: messageOf(error), runtime_shutdown_attempted: false };
    }
  }

  async function setupCheck(githubState = {}) {
    const checkedAt = new Date(now()).toISOString();
    const githubConnected = githubState && githubState.authenticated === true;
    const checks = {
      github: {
        status: githubConnected ? 'passed' : 'action_required',
        message: githubConnected
          ? (githubState.login ? 'Signed in to GitHub as @' + String(githubState.login).slice(0, 80) + '.' : 'The app has a saved GitHub sign-in.')
          : 'Sign in to GitHub in the desktop app so normal tool results can be written to the mailbox.'
      },
      mailbox: { status: githubConnected ? 'not_verified' : 'action_required', message: githubConnected ? 'Checking access to the configured private mailbox.' : 'Sign in to GitHub before checking mailbox access.' },
      colab: { status: 'not_verified', message: 'Waiting for the notebook to register its temporary HTTPS tunnel with the app.' },
      model: { status: 'not_verified', message: 'Model readiness has not been confirmed by a live Colab runtime.' },
      vision: { status: 'disabled', message: 'Setup check does not enable vision or download model weights.' }
    };
    if (githubConnected) {
      try {
        const mailbox = await readMailboxJson('bridge/state/windows-app.json');
        checks.mailbox = mailbox && mailbox.value && mailbox.value.protocol === 'chatgpt-local-repo-state/v1'
          ? { status: 'passed', message: 'The app can read a valid Windows worker state record from the configured mailbox branch.' }
          : { status: 'failed', message: 'The mailbox state record is missing or has an invalid protocol.' };
      } catch (error) {
        checks.mailbox = { status: 'failed', message: 'Could not read the configured GitHub mailbox: ' + messageOf(error) };
      }
    }
    const state = await queryRuntime();
    if (state.runtime_fresh) checks.colab = { status: 'passed', message: 'Colab responds through an authenticated direct HTTPS tunnel. No GitHub token is stored in Colab.' };
    else if (state.connection_registered) checks.colab = { status: 'failed', message: state.message };
    else checks.colab = { status: 'not_verified', message: 'Run the notebook cell; it automatically registers its temporary HTTPS endpoint with the app. No token copy/paste is required.' };
    if (state.runtime_fresh && state.model_loaded) checks.model = { status: 'passed', message: 'The vision model and projector are loaded in the connected Colab runtime.' };
    else if (state.runtime_fresh && ['gpu_unavailable', 'needs_authentication', 'error'].includes(state.status)) checks.model = { status: 'failed', message: state.message };
    else checks.model = { status: 'not_verified', message: 'The model is not loaded. Call vision_activate when visual analysis is needed.' };
    checks.vision = state.enabled
      ? { status: 'enabled', message: state.model_loaded ? 'Vision is enabled and the model is loaded.' : 'Vision is enabled; model setup is still in progress.' }
      : { status: 'disabled', message: 'Vision is disabled; connecting alone does not load the model.' };
    const passed = checks.github.status === 'passed' && checks.mailbox.status === 'passed' && checks.colab.status === 'passed' && checks.model.status === 'passed';
    const failed = checks.github.status === 'failed' || checks.mailbox.status === 'failed' || checks.colab.status === 'failed' || checks.model.status === 'failed';
    const next_steps = [];
    if (checks.github.status !== 'passed') next_steps.push('Use Sign in to GitHub in the app. GitHub is still used for normal ChatGPT tool requests and results.');
    if (checks.mailbox.status !== 'passed') next_steps.push('Verify that the app can read hashin9973-ux/qdqwg on the bridge-mailbox branch.');
    if (checks.colab.status !== 'passed') next_steps.push('Open Colab, connect a runtime if needed, and run the notebook cell. It automatically registers the authenticated HTTPS tunnel with the app.');
    if (checks.model.status !== 'passed') next_steps.push('Setup check does not activate vision. Call vision_activate only when you want model setup/loading.');
    if (checks.vision.status === 'disabled') next_steps.push('Vision remains disabled until vision_activate is explicitly called.');
    return {
      status: passed ? 'ready' : failed ? 'failed' : 'action_required',
      checked_at: checkedAt, notebook_url: COLAB_NOTEBOOK_URL, checks, next_steps,
      note: 'The tunnel URL and random bearer key are held only in app/notebook memory for the current runtime. Screenshot bytes and vision reports bypass GitHub; the report returns through the app’s normal bridge result.'
    };
  }

  async function status() {
    return {
      ...(await queryRuntime()),
      notebook_url: COLAB_NOTEBOOK_URL,
      transport: 'direct_https_tunnel',
      report_location_hint: 'Returned through the normal GitHub mailbox tool result; there is no separate vision result artifact.'
    };
  }

  async function prepareScreenshot(args, requestId) {
    let raw;
    let sourceName;
    let sourcePath = null;
    const source = args.source || 'desktop';
    if (source === 'desktop') {
      if (typeof captureScreenshot !== 'function') throw new Error('Desktop screenshot capture is unavailable.');
      const captured = await captureScreenshot();
      raw = Buffer.isBuffer(captured) ? captured : captured && captured.bytes;
      sourceName = captured && captured.filename || 'desktop-screenshot';
      if (!Buffer.isBuffer(raw)) throw new Error('Desktop screenshot capture returned no image bytes.');
    } else if (source === 'workspace_file') {
      if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('source=workspace_file requires a workspace-relative path.');
      const root = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : '';
      if (!root) throw new Error('No workspace folder is selected.');
      const target = require('./tool-runner').safePath(root, args.path, false);
      if (!fsImpl.existsSync(target)) throw new Error('Screenshot file was not found: ' + args.path);
      const stat = fsImpl.statSync(target);
      if (!stat.isFile()) throw new Error('Screenshot input must be a regular file.');
      if (stat.size > MAX_INPUT_FILE_BYTES) throw new Error('Screenshot input exceeds the 32 MiB file limit.');
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(path.extname(target).toLowerCase())) {
        throw new Error('Unsupported screenshot file type. Use PNG, JPG, JPEG, WEBP, GIF, or BMP.');
      }
      raw = fsImpl.readFileSync(target);
      sourceName = path.basename(target);
      sourcePath = args.path;
    } else throw new Error('source must be either desktop or workspace_file.');
    if (!Buffer.isBuffer(raw) || !raw.length) throw new Error('Screenshot input is empty.');
    if (typeof encodeJpeg !== 'function') throw new Error('JPEG conversion is unavailable.');
    const encoded = await encodeJpeg(raw);
    const bytes = Buffer.isBuffer(encoded) ? encoded : encoded && encoded.bytes;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Image conversion returned no JPEG bytes.');
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot could not be compressed below the 600 KiB direct Colab transfer limit.');
    return {
      bytes,
      metadata: {
        request_id: requestId, source, source_name: sourceName,
        ...(sourcePath ? { workspace_path: sourcePath } : {}),
        content_type: 'image/jpeg', width: encoded && encoded.width || null,
        height: encoded && encoded.height || null, jpeg_quality: encoded && encoded.quality || null,
        bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    };
  }

  function safeWaitMs(value, defaultValue = DEFAULT_WAIT_MS) {
    if (value === undefined) return defaultValue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) throw new Error('waitMs must be an integer between 0 and 120000.');
    return value;
  }

  async function performInference(jobId, screenshot, prompt) {
    const job = jobs.get(jobId);
    if (!job) return;
    const started = now();
    try {
      const data = await directRequest('/analyze', {
        method: 'POST', timeoutMs: DIRECT_TIMEOUT_MS,
        body: {
          protocol: DIRECT_VISION_PROTOCOL, request_id: jobId,
          sha256: screenshot.metadata.sha256, content_type: 'image/jpeg',
          bytes: screenshot.bytes.length, image_base64: screenshot.bytes.toString('base64'),
          prompt: String(prompt || DEFAULT_PROMPT).slice(0, 2000)
        }
      });
      if (data.request_id !== jobId || data.input_sha256 !== screenshot.metadata.sha256) {
        throw new Error('The Colab response did not match the submitted request ID and screenshot SHA-256; the output was rejected.');
      }
      if (data.status !== 'completed' || typeof data.report !== 'string' || !data.report.trim()) {
        throw new Error(String(data.error || 'Colab returned no complete vision report.'));
      }
      job.result = {
        status: 'report_available', analysis_completed: true, request_id: jobId,
        model: data.model || MODEL_FILE, model_repository: data.model_repository || MODEL_ID,
        created_at: job.createdAt, completed_at: data.completed_at || new Date(now()).toISOString(),
        inference_ms: Number.isFinite(data.inference_ms) ? data.inference_ms : now() - started,
        input_image: screenshot.metadata, input_sha256: data.input_sha256,
        report: data.report.slice(0, 30000), result_protocol: RESULT_PROTOCOL,
        evidence_policy: 'The model report describes visible evidence only. ChatGPT should perform the reasoning and preserve uncertainty.',
        report_transport: 'direct Colab HTTPS response, returned by the app through its normal GitHub mailbox result'
      };
    } catch (error) {
      job.result = { status: 'inference_failed', request_id: jobId, error: messageOf(error), success: false };
    }
    job.finishedAt = now();
  }

  async function waitForJob(jobId, waitMs) {
    const duration = safeWaitMs(waitMs);
    const deadline = now() + duration;
    while (true) {
      const job = jobs.get(jobId);
      if (!job) return { status: 'error', request_id: jobId, error: 'No local vision job with this ID exists in the current app session. If the app restarted, submit a new screenshot request.' };
      if (job.result) return job.result;
      if (now() >= deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
    const current = await queryRuntime();
    return {
      status: 'inference_in_progress', request_id: jobId, pending: true,
      wait_timeout_ms: duration, runtime_status: current.runtime_status || current.status,
      message: 'Colab is analyzing the screenshot. This is pending, not success; call vision_wait again with the same request_id.',
      input_image: job.metadata
    };
  }

  async function analyzeScreenshot(args = {}, callId = null) {
    let jobId;
    try {
      jobId = 'vision-' + crypto.createHash('sha256').update(String(callId || crypto.randomUUID())).digest('hex').slice(0, 24);
      const previous = jobs.get(jobId);
      if (previous) return previous.result || waitForJob(jobId, safeWaitMs(args.waitMs));
      const state = await queryRuntime();
      if (!state.runtime_fresh || !state.enabled || !state.model_loaded || state.status !== 'ready') {
        return { ...state, request_id: jobId, error: 'Colab is not connected, activated, and model-loaded. No screenshot was captured or sent.', next_step: 'Call vision_activate and wait until vision_status reports ready.' };
      }
      const screenshot = await prepareScreenshot(args, jobId);
      const job = { request_id: jobId, metadata: screenshot.metadata, createdAt: new Date(now()).toISOString(), result: null };
      jobs.set(jobId, job);
      void performInference(jobId, screenshot, args.prompt);
      return waitForJob(jobId, safeWaitMs(args.waitMs));
    } catch (error) {
      return { status: 'error', request_id: jobId || null, error: messageOf(error), success: false };
    }
  }

  async function wait(args = {}) {
    try {
      if (!validJobId(args.request_id)) throw new Error('request_id must be the vision job ID returned by vision_analyze_screenshot (vision- followed by 24 hexadecimal characters).');
      return await waitForJob(args.request_id, safeWaitMs(args.waitMs));
    } catch (error) {
      return { status: 'error', request_id: args.request_id || null, error: messageOf(error) };
    }
  }

  async function dispose() {
    pendingNonce = null;
    if (receiverServer) {
      const server = receiverServer;
      receiverServer = null;
      receiverPort = null;
      await new Promise(resolve => server.close(() => resolve()));
    }
  }

  void ensureReceiver().catch(() => {});

  return {
    activate, deactivate, status, setupCheck, connectColab, analyzeScreenshot, wait, dispose,
    constants: { DIRECT_VISION_PROTOCOL, RESULT_PROTOCOL, DEFAULT_MAILBOX, COLAB_NOTEBOOK_URL, MODEL_ID, MODEL_FILE, PROJECTOR_FILE, MAX_SCREENSHOT_BYTES, CALLBACK_PORT_START, CALLBACK_PORT_COUNT },
    getRegistrationPort: () => receiverPort
  };
}

module.exports = {
  createVisionService, DIRECT_VISION_PROTOCOL, RESULT_PROTOCOL, COLAB_NOTEBOOK_URL,
  MODEL_ID, MODEL_FILE, PROJECTOR_FILE, MAX_SCREENSHOT_BYTES, validJobId, safeTunnelUrl, safeApiKey
};
