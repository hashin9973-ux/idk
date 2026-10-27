'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIRECT_VISION_PROTOCOL = 'chatgpt-colab-vision-direct/v1';
const RESULT_PROTOCOL = 'chatgpt-colab-vision-result/v1';
const DEFAULT_MAILBOX = Object.freeze({ owner: 'hashin9973-ux', repo: 'qdqwg', branch: 'bridge-mailbox' });
const COLAB_NOTEBOOK_URL = 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb';
const MODEL_ID = 'ollama/qwen3-vl';
const MODEL_FILE = 'qwen3-vl:4b';
const PROJECTOR_FILE = null;
const MAX_SCREENSHOT_BYTES = 600 * 1024;
const MAX_INPUT_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_WAIT_MS = 15000;
const MAX_WAIT_MS = 120000;
const DIRECT_TIMEOUT_MS = 360000;
const PAIRING_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROMPT = 'Fast computer-use observation. Return a concise, structured report, not a long essay. State the visible screen/application/game state first. Use this screenshot coordinate frame: origin (0,0) at top-left, x increases right, y increases down, pixel dimensions are supplied in metadata. For each actionable target, give label, approximate bounding box [left,top,right,bottom], center [x,y], and confidence; never invent precise geometry when unclear. Transcribe only important visible text and report visible controls, cursor, player/target/status HUD, errors, and uncertainty. Distinguish observed facts from estimates. Do not infer unseen state or perform general reasoning.';

function messageOf(error) {
  return String(error && error.message || error || 'Unknown vision error').slice(0, 1600);
}

function validJobId(value) {
  return typeof value === 'string' && /^computer-[a-f0-9]{24}$/.test(value);
}

function safeApiKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,100}$/.test(value);
}

function parseTunnelEndpoint(value) {
  if (typeof value !== 'string' || value.length > 400) return null;
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{40,100})$/);
    if (parsed.protocol !== 'https:' ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(parsed.hostname) ||
        parsed.port || parsed.username || parsed.password ||
        !match || parsed.search || parsed.hash || !safeApiKey(match[1])) return null;
    return { url: parsed.origin + parsed.pathname, apiKey: match[1] };
  } catch {
    return null;
  }
}

function safeTunnelUrl(value) {
  const endpoint = parseTunnelEndpoint(value);
  return endpoint ? endpoint.url : null;
}

function createVisionService(deps) {
  const {
    githubAuth,
    getSettings,
    getWorkspaceRoot,
    captureScreenshot,
    encodeJpeg,
    openColabNotebook,
    readClipboardText,
    inputControl,
    fsImpl = fs,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollIntervalMs = 250,
    clipboardPollIntervalMs = 1000,
    clipboardWatchTimeoutMs = 20 * 60 * 1000,
    fetchImpl = globalThis.fetch
  } = deps || {};

  let lastColabOpenAt = 0;
  let colabConnection = null;
  let endpointWatch = null;
  let endpointWatchPromise = null;
  let endpointWatchError = '';
  let endpointWatchAttemptInProgress = false;
  let connectionAttemptSequence = 0;
  let visionEnabled = false;
  let disposed = false;
  let controlSessionActive = false;
  let controlSessionTimer = null;
  let latestScreenFrame = { width: 1920, height: 1080 };
  const CONTROL_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
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

  function endpointFromClipboard(text) {
    if (typeof text !== 'string' || text.length > 4096) return null;
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[A-Za-z0-9_-]{40,100}(?![A-Za-z0-9_-])/i);
    return match ? parseTunnelEndpoint(match[0]) : null;
  }

  async function connectPublicEndpoint(endpointText, source = 'detected') {
    const endpoint = parseTunnelEndpoint(endpointText);
    if (!endpoint) throw new Error('Enter the full HTTPS URL printed by the Colab server cell. It must be a trycloudflare.com URL and include its trailing secret path token.');
    const attemptId = ++connectionAttemptSequence;
    const previousConnection = colabConnection;
    const previousEnabled = visionEnabled;
    const candidate = { ...endpoint, registeredAt: now(), lastHealthAt: 0 };
    colabConnection = candidate;
    try {
      const health = await directRequest('/health', { timeoutMs: 15000, connection: candidate });
      if (attemptId !== connectionAttemptSequence) throw new Error('A newer Colab URL connection attempt replaced this one.');
      if (health.protocol !== DIRECT_VISION_PROTOCOL ||
          typeof health.enabled !== 'boolean' ||
          typeof health.model_loaded !== 'boolean') {
        throw new Error('The public Colab endpoint returned an invalid health response.');
      }
      const ack = await directRequest('/registration/ack', {
        method: 'POST',
        timeoutMs: 15000,
        connection: candidate,
        body: { protocol: DIRECT_VISION_PROTOCOL, connected_at: new Date(now()).toISOString() }
      });
      if (attemptId !== connectionAttemptSequence) throw new Error('A newer Colab URL connection attempt replaced this one.');
      if (ack.accepted !== true || ack.desktop_registered !== true) {
        throw new Error('Colab did not confirm the authenticated HTTPS connection.');
      }
      // A successful connection is the user's request to prepare vision: activate immediately,
      // then let the existing runtime worker load the model in the background.
      const activation = await directRequest('/activate', {
        method: 'POST',
        timeoutMs: 10000,
        connection: candidate,
        body: { protocol: DIRECT_VISION_PROTOCOL, request_id: 'connect-' + String(now()) }
      });
      if (activation.accepted !== true || activation.enabled !== true) {
        throw new Error('Colab connected, but it did not accept automatic vision activation.');
      }
      visionEnabled = true;
      endpointWatchError = '';
      endpointWatchAttemptInProgress = false;
      if (endpointWatch) endpointWatch.active = false;
      endpointWatch = null;
      return {
        ...stateFromRemote({ ...health, enabled: true, status: health.model_loaded ? 'ready' : 'starting',
          stage: health.model_loaded ? (health.stage || 'ready') : 'activation',
          message: health.model_loaded ? 'Colab is connected and the vision model is ready.' : 'Colab is connected. Vision setup/model download is running in the background.' }),
        connected: true,
        opened: false,
        manually_entered: source === 'manual',
        vision_activated: true,
        notebook_url: COLAB_NOTEBOOK_URL,
        message: health.model_loaded
          ? 'Colab is connected and the vision model is ready.'
          : 'Colab is connected and vision has been activated automatically. Ollama setup/model download continues in the background; computer(action=status) reports progress.'
      };
    } catch (error) {
      if (attemptId === connectionAttemptSequence && colabConnection === candidate) {
        colabConnection = previousConnection;
        visionEnabled = previousEnabled;
      }
      throw new Error('Could not connect to the ' + (source === 'manual' ? 'pasted Colab endpoint: ' : 'detected Colab endpoint: ') + messageOf(error));
    }
  }

  async function watchClipboardForEndpoint(watch) {
    let lastAttemptedUrl = '';
    let lastAttemptAt = 0;
    const deadline = watch.startedAt + clipboardWatchTimeoutMs;
    try {
      while (!disposed && endpointWatch === watch && now() < deadline) {
        let text = '';
        try {
          text = typeof readClipboardText === 'function' ? String(readClipboardText() || '') : '';
        } catch (error) {
          endpointWatchError = 'Could not read the Windows clipboard: ' + messageOf(error);
        }
        // Connect Colab is an explicit user action. A valid endpoint may already be
        // on the clipboard if the notebook cell copied it just before this watcher
        // started, so do not require it to differ from the initial snapshot. The
        // authenticated health/ack handshake safely rejects a stale endpoint; the
        // watcher remains active for a newly copied URL after any failed attempt.
        if (text) {
          const endpoint = endpointFromClipboard(text);
          if (endpoint && (endpoint.url !== lastAttemptedUrl || now() - lastAttemptAt >= 5000)) {
            lastAttemptedUrl = endpoint.url;
            lastAttemptAt = now();
            endpointWatchAttemptInProgress = true;
            endpointWatchError = '';
            try {
              await connectPublicEndpoint(endpoint.url);
              endpointWatchAttemptInProgress = false;
              return;
            } catch (error) {
              endpointWatchAttemptInProgress = false;
              if (endpointWatch === watch) endpointWatchError = messageOf(error);
            }
          }
        }
        await sleep(clipboardPollIntervalMs);
      }
      if (endpointWatch === watch) {
        watch.active = false;
        if (!endpointWatchError) {
          endpointWatchError = 'Timed out waiting for the notebook to copy its public HTTPS endpoint. Rerun the cell; if automatic clipboard copy is blocked, use the notebook’s Copy endpoint fallback button.';
        }
      }
    } catch (error) {
      endpointWatchAttemptInProgress = false;
      endpointWatchError = messageOf(error);
    } finally {
      endpointWatchAttemptInProgress = false;
      if (endpointWatch === watch) endpointWatchPromise = null;
    }
  }

  async function openColabIfNeeded() {
    if (endpointWatch && endpointWatch.active) return { opened: false, watching: true };
    if (typeof openColabNotebook !== 'function') throw new Error('Opening the Colab notebook is unavailable in this app build.');

    let baseline = '';
    try { baseline = typeof readClipboardText === 'function' ? String(readClipboardText() || '') : ''; } catch {}
    const watch = { baseline, startedAt: now(), active: true };
    endpointWatch = watch;
    endpointWatchError = '';

    // If the tab was opened recently but its clipboard watcher timed out, re-arm
    // the watcher without spawning another browser tab.
    if (lastColabOpenAt && now() - lastColabOpenAt < 60000) {
      endpointWatchPromise = watchClipboardForEndpoint(watch);
      void endpointWatchPromise;
      return { opened: false, reused: true, watching: true };
    }

    try {
      const result = await openColabNotebook(COLAB_NOTEBOOK_URL);
      lastColabOpenAt = now();
      endpointWatchPromise = watchClipboardForEndpoint(watch);
      void endpointWatchPromise;
      return { opened: true, result: result || null, watching: true };
    } catch (error) {
      if (endpointWatch === watch) endpointWatch = null;
      throw error;
    }
  }

  async function connectColab(endpointText = '') {
    try {
      const pastedText = typeof endpointText === 'string' ? endpointText.trim() : '';
      if (pastedText) {
        const endpoint = parseTunnelEndpoint(pastedText) || endpointFromClipboard(pastedText);
        if (!endpoint) {
          return {
            status: 'error', connected: false, opened: false, vision_activated: false,
            endpoint_watch_active: Boolean(endpointWatch && endpointWatch.active),
            notebook_url: COLAB_NOTEBOOK_URL,
            message: 'That is not a valid Colab endpoint. Paste the complete PUBLIC_VISION_ENDPOINT URL printed by the notebook, including the long path after trycloudflare.com. The URL is checked before it is accepted.'
          };
        }
        if (endpointWatch) endpointWatch.active = false;
        endpointWatch = null;
        endpointWatchError = '';
        endpointWatchAttemptInProgress = true;
        try {
          const connected = await connectPublicEndpoint(endpoint.url, 'manual');
          return { ...connected, endpoint_watch_active: false };
        } catch (error) {
          const message = messageOf(error);
          endpointWatchError = message;
          return {
            status: 'error', connected: false, opened: false, vision_activated: false,
            endpoint_watch_active: false, endpoint_watch_error: message,
            notebook_url: COLAB_NOTEBOOK_URL, error: message, message
          };
        } finally {
          endpointWatchAttemptInProgress = false;
          endpointWatchPromise = null;
        }
      }
      const state = await queryRuntime();
      if (state.runtime_fresh) {
        if (!state.enabled || !state.model_loaded || state.status !== 'ready') {
          const activated = await activate({}, 'connect-existing-' + String(now()));
          return {
            ...activated, connected: true, opened: false,
            vision_activated: activated.enabled === true,
            notebook_url: COLAB_NOTEBOOK_URL,
            message: activated.model_loaded
              ? 'Colab is connected and the vision model is ready.'
              : 'Colab is connected. Vision is active while Ollama setup/model download continues in the background.'
          };
        }
        return {
          ...state, connected: true, opened: false, vision_activated: true,
          notebook_url: COLAB_NOTEBOOK_URL,
          message: 'Colab is connected and vision is enabled; Qwen3-VL 4B is downloaded and ready for screenshot analysis. The first screenshot may take longer while Ollama warms up.'
        };
      }
      const opened = await openColabIfNeeded();
      return {
        ...state, status: 'waiting_for_runtime', connected: false,
        opened: Boolean(opened.opened), open_throttled: Boolean(opened.throttled),
        endpoint_watch_active: Boolean(opened.watching),
        vision_activated: false, notebook_url: COLAB_NOTEBOOK_URL,
        message: opened.watching
          ? 'The app is watching the Windows clipboard for the random public HTTPS endpoint from Colab. Run the server cell; if automatic detection keeps waiting, click Paste URL in this app and paste the complete PUBLIC_VISION_ENDPOINT line from the notebook output. The app verifies the endpoint over authenticated HTTPS. Vision remains off.'
          : opened.throttled
            ? 'The app is already watching for a public endpoint or recently opened the notebook. Run the server cell in Colab; click Paste URL here if automatic detection does not work.'
            : 'The app could not start watching for the notebook endpoint.',
        next_steps: ['Run the notebook cell titled “Start the direct Colab vision server”.', 'If clipboard auto-detection fails, copy the full PUBLIC_VISION_ENDPOINT line and paste it using Paste URL in this app. The endpoint is a temporary secret; keep it private. Vision remains off until explicitly enabled.']
      };
    } catch (error) {
      return { status: 'error', connected: false, opened: false, vision_activated: false, error: messageOf(error), message: 'Could not initialize direct Colab connection: ' + messageOf(error) };
    }
  }

  async function directRequest(route, options = {}) {
    const connection = options.connection || colabConnection;
    if (!connection) throw new Error('Colab is not registered. Click Connect Colab and run the notebook cell.');
    if (typeof fetchImpl !== 'function') throw new Error('This app does not provide an HTTPS client for direct Colab vision.');
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(connection.url + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + connection.apiKey,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error'
      });
      let data;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          throw new Error('Colab direct endpoint returned HTTP ' + response.status + ' (non-JSON response).');
        }
        throw new Error('Colab returned malformed JSON for ' + route + '.');
      }
      if (!response.ok) throw new Error('Colab direct endpoint returned HTTP ' + response.status + ': ' + String(data.error || data.message || 'request failed').slice(0, 600));
      if (data.protocol && data.protocol !== DIRECT_VISION_PROTOCOL &&
          !(route === '/analyze' && data.protocol === RESULT_PROTOCOL)) {
        throw new Error('Colab response protocol did not match the direct vision protocol.');
      }
      if (route === '/health') connection.lastHealthAt = now();
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
      stage_started_at: data.stage_started_at || null,
      stage_elapsed_seconds: Number.isFinite(data.stage_elapsed_seconds) ? Math.max(0, Math.floor(data.stage_elapsed_seconds)) : null,
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

  async function activate(args = {}, callId = null) {
    try {
      let state = await queryRuntime();
      if (!state.connection_registered || !state.runtime_fresh) {
        const opened = await openColabIfNeeded();
        return {
          ...state, status: 'starting', enabled: false, opened: Boolean(opened.opened),
          notebook_url: COLAB_NOTEBOOK_URL,
          message: 'Run the Colab worker cell to establish the direct connection, then call computer(action=enable) again. The model will not load before explicit activation.'
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
        message: state.message || 'Colab accepted activation. Ollama setup and model download are starting.',
        manual_steps: manualSteps(state.status)
      };
    } catch (error) {
      return { status: 'error', enabled: visionEnabled, error: messageOf(error), notebook_url: COLAB_NOTEBOOK_URL };
    }
  }

  function manualSteps(status) {
    const common = [
      'Keep the Colab notebook tab open with its worker cell running. Screenshots and reports travel through the authenticated HTTPS tunnel; Colab does not need a GitHub token or Colab Secret.',
      'The first activation installs the prebuilt Ollama runtime and downloads about 3.3 GB of Qwen3-VL 4B weights to the temporary local disk in Colab. There is no llama.cpp build or Google Drive model copy. A fresh Colab runtime must download the model again; status reports setup progress. Startup does not run inference on a synthetic image, so the first real screenshot request may take longer while Ollama loads the model into GPU memory.'
    ];
    if (status === 'gpu_unavailable') return ['Select a Colab GPU runtime if one is offered; free GPU access is not guaranteed.', ...common];
    if (status === 'needs_authentication') return ['Complete any Google Colab runtime authorization requested in the Colab tab.', ...common];
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
        message: 'Future screenshot requests are disabled. The Colab runtime, tunnel, and downloaded model cache are left running.',
        next_step: 'Call computer(action=enable) to re-enable requests; the downloaded model will be reused, though the first screenshot may need warm-up.'
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
    if (state.runtime_fresh && state.model_loaded) checks.model = { status: 'passed', message: 'Ollama is healthy and Qwen3-VL 4B is downloaded in the connected Colab runtime. The first real screenshot request may take longer while Ollama loads the model into GPU memory.' };
    else if (state.runtime_fresh && ['gpu_unavailable', 'needs_authentication', 'error'].includes(state.status)) checks.model = { status: 'failed', message: state.message };
    else if (state.runtime_fresh && state.enabled) checks.model = { status: 'in_progress', message: 'Vision is active and Ollama is installing or downloading the model. Keep the Colab cell running and check status again.' };
    else checks.model = { status: 'not_verified', message: 'The model is not ready yet. Reconnect Colab to automatically activate vision, or use computer(action=enable) to retry an inactive runtime.' };
    checks.vision = state.enabled
      ? { status: 'enabled', message: state.model_loaded ? 'Vision is enabled and Qwen3-VL 4B is downloaded and ready for inference.' : 'Vision is enabled; model setup is still in progress.' }
      : { status: 'disabled', message: 'Vision is disabled; connecting alone does not load the model.' };
    const passed = checks.github.status === 'passed' && checks.mailbox.status === 'passed' && checks.colab.status === 'passed' && checks.model.status === 'passed';
    const failed = checks.github.status === 'failed' || checks.mailbox.status === 'failed' || checks.colab.status === 'failed' || checks.model.status === 'failed';
    const loading = state.runtime_fresh && state.enabled && !state.model_loaded && !failed &&
      checks.github.status === 'passed' && checks.mailbox.status === 'passed' && checks.colab.status === 'passed';
    const next_steps = [];
    if (checks.github.status !== 'passed') next_steps.push('Use Sign in to GitHub in the app. GitHub is still used for normal tool requests and results.');
    if (checks.mailbox.status !== 'passed') next_steps.push('Verify that the app can read hashin9973-ux/qdqwg on the bridge-mailbox branch.');
    if (checks.colab.status !== 'passed') next_steps.push('Open Colab, connect a runtime if needed, and run the notebook cell. It automatically registers the authenticated HTTPS tunnel with the app.');
    if (checks.model.status === 'in_progress') next_steps.push('Vision is already active. Ollama setup/model download is still in progress; check computer(action=status) again for progress.');
    else if (checks.model.status !== 'passed') next_steps.push('After the direct tunnel connects, vision activates and model setup starts automatically. Use computer(action=enable) only to retry activation if status shows inactive.');
    if (checks.vision.status === 'disabled') next_steps.push('The runtime is connected but inactive. Call computer(action=enable) to retry activation.');
    return {
      status: passed ? 'ready' : failed ? 'failed' : loading ? 'loading' : 'action_required',
      checked_at: checkedAt, notebook_url: COLAB_NOTEBOOK_URL, checks, next_steps,
      note: 'The tunnel URL and random bearer key are held only in app/notebook memory for the current runtime. Screenshot bytes and vision reports bypass GitHub; the report returns through the app’s normal bridge result.'
    };
  }

  async function status() {
    if (endpointWatch && endpointWatch.active && endpointWatchAttemptInProgress) {
      return {
        status: 'checking_endpoint',
        enabled: false,
        runtime_fresh: false,
        runtime_alive: false,
        connection_registered: false,
        model_loaded: false,
        endpoint_watch_active: true,
        endpoint_test_in_progress: true,
        endpoint_watch_error: '',
        notebook_url: COLAB_NOTEBOOK_URL,
        transport: 'direct_https_tunnel',
        message: 'A new Colab endpoint was detected. Testing the authenticated HTTPS health response and registration acknowledgement.'
      };
    }
    const remote = await queryRuntime();
    if (!colabConnection && endpointWatch && endpointWatch.active) {
      return {
        ...remote,
        status: 'waiting_for_endpoint',
        endpoint_watch_active: true,
        endpoint_test_in_progress: false,
        endpoint_watch_error: endpointWatchError || '',
        connection_registered: false,
        enabled: false,
        model_loaded: false,
        message: endpointWatchError
          ? 'Waiting for the Colab endpoint. Last detection attempt: ' + endpointWatchError
          : 'Waiting for the notebook to copy its public HTTPS endpoint. Run the server cell; the app will test the URL automatically.'
      };
    }
    if (!colabConnection && endpointWatch && !endpointWatch.active && endpointWatchError) {
      return {
        ...remote,
        endpoint_watch_active: false,
        endpoint_test_in_progress: false,
        endpoint_watch_error: endpointWatchError,
        notebook_url: COLAB_NOTEBOOK_URL,
        transport: 'direct_https_tunnel',
        message: 'The Colab connection attempt failed: ' + endpointWatchError
      };
    }
    return {
      ...remote,
      endpoint_watch_active: Boolean(endpointWatch && endpointWatch.active),
      endpoint_test_in_progress: false,
      endpoint_watch_error: endpointWatchError || '',
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
    const width = encoded && encoded.width || null;
    const height = encoded && encoded.height || null;
    if (source === 'desktop' && Number.isInteger(width) && Number.isInteger(height)) {
      latestScreenFrame = { width, height };
    }
    return {
      bytes,
      metadata: {
        request_id: requestId, source, source_name: sourceName,
        ...(sourcePath ? { workspace_path: sourcePath } : {}),
        content_type: 'image/jpeg', width, height,
        coordinate_system: source === 'desktop' ? 'pixels, origin top-left; coordinates refer to this JPEG frame' : null,
        jpeg_quality: encoded && encoded.quality || null,
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
          prompt: [
            'Screenshot pixel frame: ' + String(screenshot.metadata.width || 'unknown') + 'x' + String(screenshot.metadata.height || 'unknown') + '; origin (0,0) is the top-left corner, x increases right, y increases down. Report coordinate estimates in this exact frame.',
            String(prompt || DEFAULT_PROMPT)
          ].join('\n').slice(0, 2000)
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
      if (!job) return { status: 'error', request_id: jobId, error: 'No local screenshot job with this ID exists in the current app session. If the app restarted, submit a new screenshot request.' };
      if (job.result) return job.result;
      if (now() >= deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
    const current = await queryRuntime();
    return {
      status: 'inference_in_progress', request_id: jobId, pending: true,
      wait_timeout_ms: duration, runtime_status: current.runtime_status || current.status,
      message: 'Colab is analyzing the screenshot. This is pending, not success; call computer(action=wait) again with the same request_id.',
      input_image: job.metadata
    };
  }

  async function analyzeScreenshot(args = {}, callId = null) {
    let jobId;
    try {
      jobId = 'computer-' + crypto.createHash('sha256').update(String(callId || crypto.randomUUID())).digest('hex').slice(0, 24);
      const previous = jobs.get(jobId);
      if (previous) return previous.result || waitForJob(jobId, safeWaitMs(args.waitMs));
      const state = await queryRuntime();
      if (!state.runtime_fresh || !state.enabled || !state.model_loaded || state.status !== 'ready') {
        return { ...state, request_id: jobId, error: 'Colab is not connected, activated, and model-ready. No screenshot was captured or sent.', next_step: 'Call computer(action=enable) and wait until computer(action=status) reports ready.' };
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
      if (!validJobId(args.request_id)) throw new Error('request_id must be the screenshot job ID returned by computer(action=screenshot) (computer- followed by 24 hexadecimal characters).');
      return await waitForJob(args.request_id, safeWaitMs(args.waitMs));
    } catch (error) {
      return { status: 'error', request_id: args.request_id || null, error: messageOf(error) };
    }
  }

  function armControlSessionExpiry() {
    if (controlSessionTimer) clearTimeout(controlSessionTimer);
    controlSessionTimer = setTimeout(() => {
      controlSessionActive = false;
      controlSessionTimer = null;
      if (inputControl && typeof inputControl.releaseAll === 'function') {
        void inputControl.releaseAll().catch(() => {});
      }
    }, CONTROL_SESSION_TIMEOUT_MS);
    if (typeof controlSessionTimer.unref === 'function') controlSessionTimer.unref();
  }

  async function inputAction(args = {}, callId = null) {
    const action = args.action;
    if (action === 'start_control') {
      if (!inputControl || typeof inputControl.run !== 'function') {
        return { status: 'error', error: 'Windows mouse/keyboard control is unavailable in this build.' };
      }
      controlSessionActive = true;
      armControlSessionExpiry();
      return {
        status: 'control_ready', active: true, expires_after_inactivity_ms: CONTROL_SESSION_TIMEOUT_MS,
        message: 'Computer control is enabled for this app session. Use screenshot for visual context, then batch mouse/keyboard actions with computer(action=sequence). Stop control when finished.'
      };
    }
    if (action === 'stop_control') {
      controlSessionActive = false;
      if (controlSessionTimer) clearTimeout(controlSessionTimer);
      controlSessionTimer = null;
      let released = { released: 0 };
      if (inputControl && typeof inputControl.releaseAll === 'function') released = await inputControl.releaseAll();
      return { status: 'control_stopped', active: false, ...released };
    }
    if (!inputControl || typeof inputControl.run !== 'function') {
      return { status: 'error', error: 'Windows mouse/keyboard control is unavailable in this build.' };
    }
    const inputTypes = new Set(['click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey', 'mouse_down', 'mouse_up', 'key_down', 'key_up']);
    const sequence = action === 'sequence';
    const steps = sequence ? args.steps : inputTypes.has(action) ? [{ ...args, type: action }] : null;
    if (!Array.isArray(steps)) return { status: 'error', error: 'Unsupported computer input action.' };
    if (controlSessionActive) armControlSessionExpiry();
    const result = await inputControl.run(steps, latestScreenFrame);
    if (!sequence || args.observe === false) {
      return {
        ...result, action, control_active: controlSessionActive,
        message: 'Input executed on the local Windows desktop. Coordinates use the most recent desktop screenshot frame.'
      };
    }
    const observation = await analyzeScreenshot({
      source: 'desktop',
      prompt: typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt : DEFAULT_PROMPT,
      waitMs: args.waitMs
    }, callId);
    return {
      ...result, action, control_active: controlSessionActive,
      observation,
      message: observation && observation.status === 'report_available'
        ? 'Input sequence completed and a fresh visual observation is available.'
        : 'Input sequence completed; the requested follow-up observation is not yet ready. Use computer(action=wait) with its request_id if one was returned.'
    };
  }

  async function dispose() {
    disposed = true;
    endpointWatch = null;
    if (controlSessionTimer) clearTimeout(controlSessionTimer);
    controlSessionTimer = null;
    controlSessionActive = false;
    if (inputControl && typeof inputControl.dispose === 'function') {
      try { await inputControl.dispose(); } catch {}
    }
  }

  return {
    activate, deactivate, status, setupCheck, connectColab, connectPublicEndpoint, analyzeScreenshot, wait, inputAction,
    isControlSessionActive: () => controlSessionActive,
    dispose,
    constants: { DIRECT_VISION_PROTOCOL, RESULT_PROTOCOL, DEFAULT_MAILBOX, COLAB_NOTEBOOK_URL, MODEL_ID, MODEL_FILE, PROJECTOR_FILE, MAX_SCREENSHOT_BYTES }
  };
}

module.exports = {
  createVisionService, DIRECT_VISION_PROTOCOL, RESULT_PROTOCOL, COLAB_NOTEBOOK_URL,
  MODEL_ID, MODEL_FILE, PROJECTOR_FILE, MAX_SCREENSHOT_BYTES, validJobId,
  safeTunnelUrl, safeApiKey, parseTunnelEndpoint
};
