'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VISION_CONTROL_PROTOCOL = 'chatgpt-colab-vision-control/v1';
const VISION_RUNTIME_PROTOCOL = 'chatgpt-colab-vision-runtime/v1';
const VISION_REQUEST_PROTOCOL = 'chatgpt-colab-vision-request/v1';
const VISION_RESULT_PROTOCOL = 'chatgpt-colab-vision-result/v1';
const DEFAULT_MAILBOX = Object.freeze({ owner: 'hashin9973-ux', repo: 'qdqwg', branch: 'bridge-mailbox' });
const COLAB_NOTEBOOK_URL = 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb';
const MODEL_ID = 'Qwen/Qwen3-VL-8B-Instruct-GGUF';
const MODEL_FILE = 'Qwen3VL-8B-Instruct-Q4_K_M.gguf';
const PROJECTOR_FILE = 'mmproj-Qwen3VL-8B-Instruct-F16.gguf';
const MAX_SCREENSHOT_BYTES = 600 * 1024;
const MAX_INPUT_FILE_BYTES = 32 * 1024 * 1024;
const RUNTIME_FRESH_MS = 8 * 60 * 1000;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 120000;

function messageOf(error) {
  return String(error && error.message || error || 'Unknown vision error').slice(0, 1600);
}

function isNotFound(error) {
  return /(^|\D)404(\D|$)|not found|does not exist/i.test(messageOf(error));
}

function isConflict(error) {
  return /409|422|already exists|does not match|sha wasn.t supplied|conflict/i.test(messageOf(error));
}

function validJobId(value) {
  return typeof value === 'string' && /^vision-[a-f0-9]{24}$/.test(value);
}

function createVisionService(deps) {
  const {
    githubAuth,
    getSettings,
    getWorkspaceRoot,
    captureScreenshot,
    encodeJpeg,
    openColabNotebook,
    publishWorkspaceFile,
    fsImpl = fs,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollIntervalMs = 2500
  } = deps || {};
  let lastColabOpenAt = 0;

  function mailboxConfig() {
    const settings = typeof getSettings === 'function' ? getSettings() || {} : {};
    const configured = settings.repositoryBridge || {};
    const value = {
      owner: String(configured.owner || DEFAULT_MAILBOX.owner),
      repo: String(configured.repo || DEFAULT_MAILBOX.repo),
      branch: String(configured.branch || DEFAULT_MAILBOX.branch)
    };
    if (value.owner !== DEFAULT_MAILBOX.owner || value.repo !== DEFAULT_MAILBOX.repo || value.branch !== DEFAULT_MAILBOX.branch) {
      throw new Error('Colab vision currently requires the existing mailbox hashin9973-ux/qdqwg on branch bridge-mailbox. Restore that mailbox configuration before activating vision.');
    }
    return value;
  }

  function contentPath(relativePath) {
    if (typeof relativePath !== 'string' ||
        relativePath.startsWith('/') ||
        relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment))) {
      throw new Error('Unsafe internal vision mailbox path.');
    }
    const config = mailboxConfig();
    return '/repos/' + config.owner + '/' + config.repo + '/contents/' + relativePath;
  }

  async function api(method, relativePath, body = null) {
    if (!githubAuth || typeof githubAuth.requestApi !== 'function') {
      throw new Error('The app GitHub connection is unavailable.');
    }
    const config = mailboxConfig();
    const request = {
      method,
      path: contentPath(relativePath),
      ...(body ? { body } : {}),
      ...(method === 'GET' ? { query: { ref: config.branch } } : {})
    };
    return githubAuth.requestApi(request);
  }

  async function readJson(relativePath) {
    let response;
    try {
      response = await api('GET', relativePath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const entry = response && response.result;
    if (!entry || typeof entry.content !== 'string' || entry.encoding !== 'base64') {
      throw new Error('Malformed mailbox JSON file at ' + relativePath + '.');
    }
    let value;
    try {
      value = JSON.parse(Buffer.from(entry.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    } catch {
      throw new Error('Malformed JSON in mailbox path ' + relativePath + '.');
    }
    return { value, sha: typeof entry.sha === 'string' ? entry.sha : null };
  }

  async function writeJson(relativePath, value, createOnly = false) {
    const config = mailboxConfig();
    const content = Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await readJson(relativePath);
      if (existing && createOnly) {
        if (JSON.stringify(existing.value) === JSON.stringify(value)) return { ok: true, unchanged: true };
        return { ok: false, conflict: true, existing: existing.value };
      }
      const body = {
        message: '[vision bridge] ' + relativePath,
        content,
        branch: config.branch,
        ...(existing && existing.sha ? { sha: existing.sha } : {})
      };
      try {
        await api('PUT', relativePath, body);
        return { ok: true, unchanged: false };
      } catch (error) {
        if (attempt < 2 && isConflict(error)) continue;
        throw error;
      }
    }
    throw new Error('Could not update vision mailbox path ' + relativePath + ' after resolving conflicts.');
  }

  function currentTimeIso() {
    return new Date(now()).toISOString();
  }

  function runtimeIsFresh(runtime) {
    const heartbeat = Date.parse(runtime && (runtime.heartbeat_at || runtime.updated_at) || '');
    return Number.isFinite(heartbeat) && now() - heartbeat >= 0 && now() - heartbeat <= RUNTIME_FRESH_MS;
  }

  function publicRuntime(runtime, control) {
    const enabled = Boolean(control && control.enabled === true);
    const fresh = runtimeIsFresh(runtime);
    let status;
    let message;
    if (!enabled) {
      status = 'inactive';
      message = 'Vision is disabled. The Colab runtime, if connected, is left running.';
    } else if (!runtime) {
      status = 'starting';
      message = 'Vision activation is recorded, but the notebook has not published a runtime heartbeat yet.';
    } else if (!fresh) {
      status = runtime.status === 'starting' ? 'starting' : 'disconnected';
      message = 'No recent Colab heartbeat is available. Reconnect the Colab runtime and run the notebook worker cell.';
    } else {
      const reported = String(runtime.status || 'error');
      status = reported === 'processing' ? 'inference_in_progress'
        : ['ready', 'starting', 'needs_authentication', 'gpu_unavailable', 'disconnected',
           'error', 'inference_in_progress', 'report_available'].includes(reported)
          ? reported : 'starting';
      message = String(runtime.message || '');
    }
    return {
      status,
      enabled,
      runtime_fresh: fresh,
      runtime_alive: fresh,
      runtime_status: runtime && typeof runtime.status === 'string' ? runtime.status : null,
      heartbeat_at: runtime && (runtime.heartbeat_at || runtime.updated_at) || null,
      gpu: runtime && runtime.gpu || null,
      vram_mib: runtime && Number.isFinite(runtime.vram_mib) ? runtime.vram_mib : null,
      model_loaded: runtime && runtime.model_loaded === true,
      model: runtime && runtime.model || MODEL_FILE,
      last_completed_request_id: runtime && runtime.last_completed_request_id || null,
      active_request_id: runtime && runtime.active_request_id || null,
      stage: runtime && runtime.stage || null,
      message
    };
  }

  async function readControlAndRuntime() {
    const [controlRecord, runtimeRecord] = await Promise.all([
      readJson('bridge/vision/control.json'),
      readJson('bridge/vision/runtime.json')
    ]);
    const control = controlRecord && controlRecord.value &&
      controlRecord.value.protocol === VISION_CONTROL_PROTOCOL ? controlRecord.value : null;
    const runtime = runtimeRecord && runtimeRecord.value &&
      runtimeRecord.value.protocol === VISION_RUNTIME_PROTOCOL ? runtimeRecord.value : null;
    return { control, runtime, state: publicRuntime(runtime, control) };
  }

  async function setControl(enabled, requestId, reason) {
    const existing = await readJson('bridge/vision/control.json');
    const previous = existing && existing.value && existing.value.protocol === VISION_CONTROL_PROTOCOL
      ? existing.value : null;
    const value = {
      protocol: VISION_CONTROL_PROTOCOL,
      enabled,
      updated_at: currentTimeIso(),
      revision: Number.isSafeInteger(previous && previous.revision) ? previous.revision + 1 : 1,
      ...(requestId ? { last_request_id: String(requestId).slice(0, 120) } : {}),
      ...(reason ? { reason: String(reason).slice(0, 300) } : {}),
      model: { repository: MODEL_ID, file: MODEL_FILE, projector: PROJECTOR_FILE },
      runtime_policy: 'deactivation disables new jobs only; it never stops or disconnects Colab'
    };
    await writeJson('bridge/vision/control.json', value);
    return value;
  }

  async function openColabIfNeeded() {
    if (now() - lastColabOpenAt < 60000) return { opened: false, throttled: true };
    if (typeof openColabNotebook !== 'function') throw new Error('Opening the Colab notebook is unavailable in this app build.');
    const result = await openColabNotebook(COLAB_NOTEBOOK_URL);
    lastColabOpenAt = now();
    return { opened: true, result: result || null };
  }

  function latestStateHasFreshRuntimeForActivation(snapshot) {
    // A fresh heartbeat proves the notebook worker is running. Do not open
    // another Colab tab merely because the model is still initializing.
    return Boolean(snapshot && snapshot.state && snapshot.state.runtime_fresh);
  }

  async function activate(args = {}, callId = null) {
    try {
      let { control, runtime, state } = await readControlAndRuntime();
      const wasEnabled = control && control.enabled === true;
      if (!wasEnabled) {
        await setControl(true, callId, 'vision_activate');
        ({ control, runtime, state } = await readControlAndRuntime());
      }
      if (state.status === 'ready' && state.model_loaded && state.runtime_fresh) {
        return { ...state, status: 'ready', already_ready: true, model_reload_requested: false, notebook_url: COLAB_NOTEBOOK_URL };
      }
      // A healthy runtime can be intentionally inactive while its model remains
      // loaded. Re-enable its mailbox control without opening a second notebook.
      if (state.runtime_fresh && state.model_loaded &&
          ['inactive', 'inference_in_progress'].includes(state.runtime_status)) {
        return {
          ...state,
          status: state.runtime_status === 'inference_in_progress' ? 'inference_in_progress' : 'starting',
          already_ready: false,
          reused_runtime: true,
          model_reload_requested: false,
          notebook_url: COLAB_NOTEBOOK_URL,
          message: state.runtime_status === 'inference_in_progress'
            ? 'The loaded Colab model is processing a request; activation was enabled without reopening Colab.'
            : 'Vision was enabled. The already-loaded Colab runtime is being reused.'
        };
      }
      if (['needs_authentication', 'gpu_unavailable', 'error'].includes(state.status) && state.runtime_fresh) {
        return { ...state, notebook_url: COLAB_NOTEBOOK_URL, manual_steps: manualSteps(state.status) };
      }
      let browser;
      const latestSnapshot = await readControlAndRuntime();
      const hasLiveRuntime = latestStateHasFreshRuntimeForActivation(latestSnapshot);
      if (!hasLiveRuntime && (!wasEnabled || now() - lastColabOpenAt >= 60000)) {
        try {
          browser = await openColabIfNeeded();
        } catch (error) {
          return {
            ...state,
            status: 'error',
            error: 'Vision was enabled in the mailbox, but the Colab notebook could not be opened: ' + messageOf(error),
            notebook_url: COLAB_NOTEBOOK_URL
          };
        }
      }
      const latest = await readControlAndRuntime();
      const responseState = latest.state.status === 'inactive' ? { ...latest.state, status: 'starting' } : latest.state;
      return {
        ...responseState,
        status: responseState.status === 'ready' ? 'ready' : responseState.status,
        already_ready: false,
        model_reload_requested: false,
        notebook_url: COLAB_NOTEBOOK_URL,
        ...(browser ? { browser } : {}),
        manual_steps: manualSteps(responseState.status)
      };
    } catch (error) {
      return { status: 'error', enabled: false, error: messageOf(error), notebook_url: COLAB_NOTEBOOK_URL };
    }
  }

  function manualSteps(status) {
    const common = [
      'In Google Colab, select Connect or reconnect a runtime, then run the notebook worker cell.',
      'In Colab Secrets, add QDQWG_TOKEN and enable notebook access. Use a fine-grained GitHub token restricted to hashin9973-ux/qdqwg with Contents read/write permission; never paste it into the mailbox or notebook source.',
      'Wait for the notebook to publish a fresh runtime heartbeat, then call vision_status again.'
    ];
    if (status === 'needs_authentication') return ['Complete Google sign-in if Colab asks for it.', ...common];
    if (status === 'gpu_unavailable') return ['Select a Colab GPU runtime if one is offered. GPU access is not guaranteed on free Colab.', ...common];
    if (status === 'disconnected') return ['Reconnect the Colab runtime and re-run the notebook worker cell.', ...common];
    if (status === 'starting') return ['The notebook must be actively running; opening the browser alone does not mean the model is ready.', ...common];
    return common;
  }

  async function deactivate(args = {}, callId = null) {
    try {
      const before = await readControlAndRuntime();
      await setControl(false, callId, 'vision_deactivate');
      return {
        status: 'inactive',
        enabled: false,
        runtime_status: before.runtime && before.runtime.status || null,
        runtime_alive: before.state.runtime_alive,
        runtime_kept_alive: true,
        in_progress_request_id: before.runtime && before.runtime.active_request_id || null,
        in_progress_may_finish: Boolean(before.runtime && before.runtime.active_request_id),
        message: 'Future screenshot requests are disabled. The Colab runtime, browser and loaded model were not shut down.',
        next_step: 'Call vision_activate to re-enable requests; a still-connected model should be reused.'
      };
    } catch (error) {
      return { status: 'error', error: messageOf(error), runtime_shutdown_attempted: false };
    }
  }

  async function setupCheck(githubState = {}) {
    const checkedAt = currentTimeIso();
    const githubConnected = githubState && githubState.authenticated === true;
    const checks = {
      github: {
        status: githubConnected ? 'passed' : 'action_required',
        message: githubConnected
          ? (githubState.login ? 'Signed in to GitHub as @' + String(githubState.login).slice(0, 80) + '.' : 'The app has a saved GitHub sign-in.')
          : (githubState && githubState.error
            ? 'GitHub sign-in is not verified: ' + messageOf(githubState.error)
            : 'Sign in with GitHub in the app to verify mailbox access.')
      },
      mailbox: {
        status: githubConnected ? 'not_verified' : 'action_required',
        message: githubConnected
          ? 'Checking read access to the configured private mailbox.'
          : 'Mailbox access cannot be checked until the app is signed in to GitHub.'
      },
      colab: { status: 'not_verified', message: 'Google/Colab sign-in is not inferable from this app; a live notebook heartbeat is required to verify the runtime.' },
      model: { status: 'not_verified', message: 'Model readiness has not been confirmed by a live Colab runtime.' },
      vision: { status: 'disabled', message: 'Setup check does not enable vision or trigger model downloads.' }
    };

    if (githubConnected) {
      try {
        const mailbox = await readJson('bridge/state/windows-app.json');
        if (mailbox && mailbox.value && mailbox.value.protocol === 'chatgpt-local-repo-state/v1') {
          checks.mailbox = {
            status: 'passed',
            message: 'The configured mailbox branch is readable and contains a valid Windows worker state record. This read-only check does not test write permission.'
          };
        } else {
          checks.mailbox = {
            status: 'failed',
            message: 'The mailbox state record is missing or its protocol is invalid on the configured branch.'
          };
        }
      } catch (error) {
        checks.mailbox = {
          status: 'failed',
          message: 'Could not read the configured GitHub mailbox: ' + messageOf(error)
        };
      }
    }

    let snapshot = null;
    try {
      snapshot = await readControlAndRuntime();
    } catch (error) {
      const message = 'Could not read Colab vision records: ' + messageOf(error);
      checks.colab = { status: 'failed', message };
      checks.model = { status: 'not_verified', message: 'Model readiness could not be checked because the runtime records were not readable.' };
    }

    if (snapshot) {
      const runtime = snapshot.runtime;
      const state = snapshot.state;
      const fresh = state.runtime_fresh === true;
      const runtimeStatus = runtime && String(runtime.status || 'unknown');
      checks.vision = {
        status: snapshot.control && snapshot.control.enabled === true ? 'enabled' : 'disabled',
        message: snapshot.control && snapshot.control.enabled === true
          ? 'Vision requests are enabled in the mailbox.'
          : 'Vision requests are disabled. Setup check has not enabled them.'
      };

      if (fresh && runtimeStatus === 'needs_authentication') {
        checks.colab = { status: 'action_required', message: 'Colab is publishing a heartbeat but reports that Google/Drive authentication is required.' };
      } else if (fresh && runtimeStatus === 'gpu_unavailable') {
        checks.colab = { status: 'action_required', message: 'Colab is connected, but this runtime has no suitable GPU.' };
      } else if (fresh && runtimeStatus === 'error') {
        checks.colab = { status: 'failed', message: state.message || 'The Colab worker reported an error.' };
      } else if (fresh && ['starting', 'inference_in_progress', 'processing'].includes(runtimeStatus)) {
        checks.colab = { status: 'in_progress', message: 'The Colab worker heartbeat is fresh; current stage: ' + String(runtime.stage || runtimeStatus) + '.' };
      } else if (fresh) {
        checks.colab = {
          status: 'passed',
          message: 'A recent Colab worker heartbeat is present (' + runtimeStatus + '). Google sign-in/runtime presence is verified by the worker, not by browser-cookie inspection.'
        };
      } else if (runtime) {
        checks.colab = {
          status: 'action_required',
          message: 'The last Colab heartbeat is stale (' + String(runtime.heartbeat_at || runtime.updated_at || 'timestamp unavailable') + '). Reconnect the runtime and rerun the notebook worker cell.'
        };
      } else {
        checks.colab = {
          status: 'not_verified',
          message: 'No Colab runtime heartbeat has been published yet. This does not prove Google is signed out; open the notebook, sign in if prompted, connect a runtime, and run the worker cell.'
        };
      }

      if (fresh && state.model_loaded === true) {
        checks.model = {
          status: 'passed',
          message: 'The runtime reports that ' + String(state.model || MODEL_FILE) + ' is loaded.'
        };
      } else if (fresh) {
        checks.model = {
          status: 'action_required',
          message: 'The Colab worker is alive, but the vision model is not loaded. Model loading starts only after vision is explicitly enabled.'
        };
      } else {
        checks.model = {
          status: 'not_verified',
          message: 'Model readiness cannot be confirmed without a fresh Colab heartbeat.'
        };
      }
    }

    const failed = checks.mailbox.status === 'failed' || checks.colab.status === 'failed';
    const passed = checks.github.status === 'passed' &&
      checks.mailbox.status === 'passed' &&
      checks.colab.status === 'passed' &&
      checks.model.status === 'passed';
    const nextSteps = [];
    if (checks.github.status !== 'passed') nextSteps.push('Use the existing Sign in to GitHub button and finish the device sign-in.');
    if (checks.mailbox.status !== 'passed') nextSteps.push('Verify GitHub access to hashin9973-ux/qdqwg on the bridge-mailbox branch; the app needs Contents read/write permission for vision requests.');
    if (checks.colab.status !== 'passed') nextSteps.push('Use Sign in to open the Colab notebook, complete Google sign-in if asked, connect a runtime, and run its worker cell.');
    if (checks.model.status !== 'passed') nextSteps.push('Once the mailbox is verified, call vision_activate from the ChatGPT bridge tools to enable setup/model loading; the setup check itself never starts downloads.');
    if (checks.vision.status === 'disabled') nextSteps.push('Vision remains disabled until vision_activate is explicitly called.');

    return {
      status: passed ? 'ready' : failed ? 'failed' : 'action_required',
      checked_at: checkedAt,
      notebook_url: COLAB_NOTEBOOK_URL,
      checks,
      next_steps: nextSteps,
      note: 'Google account sign-in cannot be read from browser cookies. Colab is considered connected only when its notebook worker publishes a fresh, protocol-valid heartbeat.'
    };
  }

  async function status() {
    try {
      const snapshot = await readControlAndRuntime();
      return {
        ...snapshot.state,
        enabled: Boolean(snapshot.control && snapshot.control.enabled === true),
        control_updated_at: snapshot.control && snapshot.control.updated_at || null,
        control_revision: snapshot.control && snapshot.control.revision || null,
        notebook_url: COLAB_NOTEBOOK_URL,
        report_location_hint: 'bridge/vision/results/<request_id>.json and bridge/vision/reports/<request_id>.txt'
      };
    } catch (error) {
      return { status: 'error', error: messageOf(error), enabled: false };
    }
  }

  async function prepareScreenshot(args, requestId) {
    let raw;
    let sourceName;
    let sourcePath = null;
    const source = args.source || 'desktop';
    if (source === 'desktop') {
      if (typeof captureScreenshot !== 'function') throw new Error('Desktop screenshot capture is not available in this app build.');
      const captured = await captureScreenshot();
      raw = Buffer.isBuffer(captured) ? captured : captured && captured.bytes;
      sourceName = captured && captured.filename || 'desktop-screenshot';
      if (!Buffer.isBuffer(raw)) throw new Error('Desktop screenshot capture returned no image bytes.');
    } else if (source === 'workspace_file') {
      if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('source=workspace_file requires a workspace-relative path argument.');
      const root = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : '';
      if (!root) throw new Error('No workspace folder is selected.');
      const target = require('./tool-runner').safePath(root, args.path, false);
      if (!fsImpl.existsSync(target)) throw new Error('Screenshot file was not found: ' + args.path);
      const stat = fsImpl.statSync(target);
      if (!stat.isFile()) throw new Error('Screenshot input must be a regular file.');
      if (stat.size > MAX_INPUT_FILE_BYTES) throw new Error('Screenshot input exceeds the 32 MiB file limit.');
      const ext = path.extname(target).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
        throw new Error('Unsupported screenshot file type. Use PNG, JPG, JPEG, WEBP, GIF, or BMP.');
      }
      raw = fsImpl.readFileSync(target);
      sourceName = path.basename(target);
      sourcePath = args.path;
    } else {
      throw new Error('source must be either desktop or workspace_file.');
    }
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new Error('Screenshot input is empty.');
    if (typeof encodeJpeg !== 'function') throw new Error('JPEG image conversion is unavailable in this app build.');
    const encoded = await encodeJpeg(raw);
    const bytes = Buffer.isBuffer(encoded) ? encoded : encoded && encoded.bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Image conversion returned no JPEG data.');
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot could not be compressed below the 900 KiB GitHub mailbox transfer limit; use a smaller image.');
    return {
      bytes,
      metadata: {
        source,
        source_name: sourceName,
        ...(sourcePath ? { workspace_path: sourcePath } : {}),
        content_type: 'image/jpeg',
        width: encoded && encoded.width || null,
        height: encoded && encoded.height || null,
        jpeg_quality: encoded && encoded.quality || null,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    };
  }

  function safeWaitMs(value, defaultValue = DEFAULT_WAIT_MS) {
    if (value === undefined) return defaultValue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) {
      throw new Error('waitMs must be an integer between 0 and 120000.');
    }
    return value;
  }

  function mailboxUrl(relativePath) {
    const config = mailboxConfig();
    return 'https://github.com/' + config.owner + '/' + config.repo + '/blob/' +
      encodeURIComponent(config.branch) + '/' + relativePath.split('/').map(encodeURIComponent).join('/');
  }

  async function getResult(jobId) {
    const record = await readJson('bridge/vision/results/' + jobId + '.json');
    if (!record) return null;
    const value = record.value;
    if (!value || value.protocol !== VISION_RESULT_PROTOCOL || value.request_id !== jobId) {
      return { status: 'inference_failed', request_id: jobId, error: 'Vision result protocol or request ID did not match the submitted job; the output was rejected.' };
    }
    if (value.status === 'completed') {
      if (typeof value.report !== 'string' || !value.report.trim()) {
        return { status: 'inference_failed', request_id: jobId, error: 'The inference result was marked complete but contained no non-empty report.' };
      }
      const request = await readJson('bridge/vision/requests/' + jobId + '.json');
      const submittedHash = request && request.value && request.value.sha256;
      if (typeof submittedHash !== 'string' || value.input_sha256 !== submittedHash) {
        return { status: 'inference_failed', request_id: jobId, error: 'The result did not prove it was generated from the screenshot submitted with this request ID; the output was rejected.' };
      }
      return {
        status: 'report_available',
        analysis_completed: true,
        request_id: jobId,
        model: value.model || MODEL_FILE,
        model_repository: value.model_repository || MODEL_ID,
        created_at: value.created_at || null,
        completed_at: value.completed_at || null,
        inference_ms: Number.isFinite(value.inference_ms) ? value.inference_ms : null,
        input_image: value.input_image || { sha256: value.input_sha256, content_type: 'image/jpeg' },
        report: value.report,
        report_path: value.report_path || 'bridge/vision/reports/' + jobId + '.txt',
        report_url: mailboxUrl(value.report_path || 'bridge/vision/reports/' + jobId + '.txt'),
        result_path: 'bridge/vision/results/' + jobId + '.json',
        result_url: mailboxUrl('bridge/vision/results/' + jobId + '.json'),
        evidence_policy: 'The model report describes visible evidence only. ChatGPT should perform the reasoning and explicitly preserve uncertainty.'
      };
    }
    if (value.status === 'failed') {
      return {
        status: 'inference_failed',
        request_id: jobId,
        model: value.model || MODEL_FILE,
        completed_at: value.completed_at || null,
        error: String(value.error || 'The vision runtime reported inference failure.'),
        result_path: 'bridge/vision/results/' + jobId + '.json',
        result_url: mailboxUrl('bridge/vision/results/' + jobId + '.json')
      };
    }
    return { status: 'inference_in_progress', request_id: jobId, runtime_status: value.status || 'processing' };
  }

  async function waitForResult(jobId, waitMs) {
    const deadline = now() + safeWaitMs(waitMs);
    while (true) {
      const result = await getResult(jobId);
      if (result) return result;
      const request = await readJson('bridge/vision/requests/' + jobId + '.json');
      if (!request) return { status: 'error', request_id: jobId, error: 'No vision request with that ID exists in the mailbox.' };
      if (now() >= deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
    const snapshot = await readControlAndRuntime();
    if (snapshot.state.status === 'disconnected' || snapshot.state.status === 'gpu_unavailable' ||
        snapshot.state.status === 'needs_authentication' || snapshot.state.status === 'error') {
      return {
        status: snapshot.state.status,
        request_id: jobId,
        message: snapshot.state.message,
        runtime_status: snapshot.state.runtime_status,
        pending: true,
        next_step: 'Recover the Colab runtime, then call vision_wait again with this request_id. Do not resubmit the screenshot.'
      };
    }
    return {
      status: 'inference_in_progress',
      request_id: jobId,
      pending: true,
      wait_timeout_ms: safeWaitMs(waitMs),
      runtime_status: snapshot.state.runtime_status,
      message: 'No matching inference result has been retrieved yet. This is pending, not success.',
      result_path: 'bridge/vision/results/' + jobId + '.json'
    };
  }

  async function analyzeScreenshot(args = {}, callId = null) {
    let jobId;
    try {
      jobId = 'vision-' + crypto.createHash('sha256').update(String(callId || crypto.randomUUID())).digest('hex').slice(0, 24);
      const snapshot = await readControlAndRuntime();
      if (!snapshot.control || snapshot.control.enabled !== true) {
        return { status: 'inactive', enabled: false, error: 'Vision is inactive. Call vision_activate and wait until vision_status reports ready before requesting screenshot analysis.' };
      }
      if (!snapshot.state.runtime_fresh ||
          !['ready', 'inference_in_progress', 'report_available', 'processing'].includes(snapshot.state.runtime_status)) {
        return {
          ...snapshot.state,
          request_id: jobId,
          error: 'The Colab vision runtime is not ready. No screenshot was captured or uploaded.',
          next_step: 'Call vision_activate/vision_status and resolve the reported runtime state first.'
        };
      }
      // A retry with the same mailbox request ID reuses the same job and never
      // captures another screenshot or queues a duplicate inference.
      const priorResult = await getResult(jobId);
      if (priorResult) return priorResult;
      const priorRequest = await readJson('bridge/vision/requests/' + jobId + '.json');
      if (priorRequest) return waitForResult(jobId, safeWaitMs(args.waitMs));
      const screenshot = await prepareScreenshot(args, jobId);
      if (typeof publishWorkspaceFile !== 'function') throw new Error('Image upload to the shared mailbox is unavailable.');
      const upload = await publishWorkspaceFile(jobId, {
        path: screenshot.metadata.workspace_path || screenshot.metadata.source_name,
        artifactName: 'screenshot.jpg',
        bytes: screenshot.bytes
      });
      if (!upload || typeof upload.path !== 'string' || !upload.path.startsWith('bridge/artifacts/' + jobId + '/')) {
        throw new Error('Screenshot upload did not return a validated mailbox artifact path.');
      }
      const request = {
        protocol: VISION_REQUEST_PROTOCOL,
        request_id: jobId,
        created_at: currentTimeIso(),
        status: 'queued',
        model_repository: MODEL_ID,
        model_file: MODEL_FILE,
        projector_file: PROJECTOR_FILE,
        image_path: upload.path,
        image_url: upload.url || null,
        content_type: 'image/jpeg',
        bytes: screenshot.metadata.bytes,
        sha256: screenshot.metadata.sha256,
        image: screenshot.metadata,
        prompt: typeof args.prompt === 'string' && args.prompt.trim()
          ? args.prompt.trim().slice(0, 2000)
          : 'Describe the screenshot using only visible evidence. Include: (1) overview, (2) important visible objects, panels, controls and layout, (3) accurate transcription of visible text, (4) visible errors or anomalies, (5) the screenshot evidence supporting each observation, and (6) explicit uncertainty where text/details are unclear. Do not infer unseen state or perform debugging/reasoning.',
        idempotency_key: jobId
      };
      const published = await writeJson('bridge/vision/requests/' + jobId + '.json', request, true);
      if (!published.ok && published.conflict) return waitForResult(jobId, safeWaitMs(args.waitMs));
      return waitForResult(jobId, safeWaitMs(args.waitMs));
    } catch (error) {
      return { status: 'error', request_id: jobId || null, error: messageOf(error), success: false };
    }
  }

  async function wait(args = {}) {
    try {
      if (!validJobId(args.request_id)) throw new Error('request_id must be the vision job ID returned by vision_analyze_screenshot (format vision- followed by 24 hexadecimal characters).');
      return await waitForResult(args.request_id, safeWaitMs(args.waitMs));
    } catch (error) {
      return { status: 'error', request_id: args.request_id || null, error: messageOf(error) };
    }
  }

  return {
    activate,
    deactivate,
    status,
    setupCheck,
    analyzeScreenshot,
    wait,
    constants: {
      VISION_CONTROL_PROTOCOL,
      VISION_RUNTIME_PROTOCOL,
      VISION_REQUEST_PROTOCOL,
      VISION_RESULT_PROTOCOL,
      DEFAULT_MAILBOX,
      COLAB_NOTEBOOK_URL,
      MODEL_ID,
      MODEL_FILE,
      PROJECTOR_FILE,
      MAX_SCREENSHOT_BYTES,
      RUNTIME_FRESH_MS
    }
  };
}

module.exports = {
  createVisionService,
  VISION_CONTROL_PROTOCOL,
  VISION_RUNTIME_PROTOCOL,
  VISION_REQUEST_PROTOCOL,
  VISION_RESULT_PROTOCOL,
  COLAB_NOTEBOOK_URL,
  MODEL_ID,
  MODEL_FILE,
  PROJECTOR_FILE,
  MAX_SCREENSHOT_BYTES,
  validJobId
};
