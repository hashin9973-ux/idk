'use strict';

const { randomUUID } = require('node:crypto');
const { TOOL_ARGUMENT_KEYS } = require('./tool-bridge');

const PROTOCOL = 'chatgpt-local-repo-bridge/v1';
const RESULT_PROTOCOL = 'chatgpt-local-repo-result/v1';
const DEFAULT_BRANCH = 'bridge-mailbox';
const DEFAULT_INTERVAL_MS = 15000;
const CLAIM_LEASE_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 90 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const BLOCKED_TOOLS = new Set(['github_api', 'github_status']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cleanError(value) {
  return String(value || 'Unknown bridge error').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function validateConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const owner = String(config.owner || '').trim();
  const repo = String(config.repo || '').trim();
  const branch = String(config.branch || DEFAULT_BRANCH).trim();
  if (!SAFE_SEGMENT.test(owner) || owner === '.' || owner === '..') {
    throw new Error('GitHub owner must be a simple account or organization name.');
  }
  if (!SAFE_SEGMENT.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Repository name must be a simple GitHub repository name.');
  }
  if (!branch || branch.length > 120 || branch.startsWith('/') || branch.endsWith('/') ||
      branch.includes('..') || branch.includes('//') || !/^[A-Za-z0-9_.\/-]+$/.test(branch)) {
    throw new Error('Branch must be a valid simple branch name.');
  }
  return { owner, repo, branch, allowPublicMailbox: config.allowPublicMailbox === true };
}

function validateRequest(requestId, request) {
  if (!SAFE_ID.test(requestId)) throw new Error('Request filename has an invalid ID.');
  if (!isPlainObject(request)) throw new Error('Request must be a JSON object.');
  if (request.protocol !== PROTOCOL) throw new Error('Unsupported request protocol.');
  if (request.request_id !== requestId) throw new Error('Request ID does not match its filename.');
  if (typeof request.created_at !== 'string' || request.created_at.length > 80) {
    throw new Error('Request must include a created_at timestamp.');
  }
  if (typeof request.tool !== 'string' || !Object.hasOwn(TOOL_ARGUMENT_KEYS, request.tool) ||
      BLOCKED_TOOLS.has(request.tool)) {
    throw new Error('Unknown or unsupported local tool.');
  }
  if (!isPlainObject(request.args)) throw new Error('Request args must be a JSON object.');
  const allowed = TOOL_ARGUMENT_KEYS[request.tool].filter(key => key !== 'approved');
  const extra = Object.keys(request.args).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error('Unsupported argument field(s): ' + extra.join(', '));
  return { request_id: requestId, tool: request.tool, args: { ...request.args } };
}

function redactText(text, workspaceRoot) {
  let value = String(text);
  const os = require('node:os');
  const roots = [...new Set([workspaceRoot, os.homedir(), os.tmpdir()].filter(item => typeof item === 'string' && item.length > 3))];
  for (const root of roots) {
    const needle = root.toLowerCase();
    const lowerValue = value.toLowerCase();
    let cursor = 0;
    let result = '';
    let found;
    while ((found = lowerValue.indexOf(needle, cursor)) !== -1) {
      result += value.slice(cursor, found) + (root === workspaceRoot ? '<workspace>' : '<local-path>');
      cursor = found + needle.length;
    }
    if (cursor) value = result + value.slice(cursor);
  }
  return value
    .replace(/\bgh[a-z]{1,2}_[A-Za-z0-9_]{20,}\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAuthorization:\s*Bearer\s+[^\s,;]{16,}/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function sanitizeForRepository(value, workspaceRoot) {
  if (typeof value === 'string') return redactText(value, workspaceRoot);
  if (Array.isArray(value)) return value.map(item => sanitizeForRepository(item, workspaceRoot));
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [name, item] of Object.entries(value)) {
    if (['homeDirectory', 'tempDirectory', 'hostname', 'workspaceRoot', 'workspace'].includes(name)) continue;
    output[name] = sanitizeForRepository(item, workspaceRoot);
  }
  return output;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8').toString('base64');
}

function parseRemoteJson(entry) {
  if (!entry || entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string') {
    throw new Error('GitHub returned an unexpected file format.');
  }
  const text = Buffer.from(entry.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Mailbox JSON file exceeds the 1 MiB limit.');
  return JSON.parse(text);
}

function isNotFound(error) {
  return /not found|404/i.test(String(error && error.message || error));
}

function isConflict(error) {
  return /already exists|sha wasn.t supplied|does not match|409|422|conflict/i.test(String(error && error.message || error));
}

function isCorruptMailboxFile(error) {
  return error instanceof SyntaxError ||
    /unexpected file format|exceeds the 1 MiB limit/i.test(String(error && error.message || error));
}

function createRepositoryBridge(deps) {
  const {
    githubAuth,
    getSettings,
    persistSettings,
    getWorkspaceRoot,
    executeTool,
    onState = () => {},
    intervalMs = DEFAULT_INTERVAL_MS
  } = deps;

  const workerId = randomUUID();
  let running = false;
  let timer = null;
  let pollInFlight = false;
  let activeRequestId = null;
  let lastPollAt = null;
  let lastError = '';
  let publicRepository = null;
  let pendingCount = 0;
  let lastStatePublishAt = 0;
  const inMemoryClaims = new Set();

  function currentConfig() {
    const settings = getSettings() || {};
    return validateConfig(settings.repositoryBridge || {});
  }

  function apiPath(relativePath) {
    const config = currentConfig();
    const relative = String(relativePath || '').replace(/^\/+/, '');
    const parts = relative.split('/');
    if (!parts.length || parts.some(part => !SAFE_ID.test(part) && !SAFE_SEGMENT.test(part)) ||
        parts.some(part => part === '.' || part === '..')) {
      throw new Error('Unsafe mailbox path.');
    }
    return '/repos/' + config.owner + '/' + config.repo + '/contents/' + parts.join('/');
  }

  function stateSnapshot() {
    const config = (() => {
      try { return currentConfig(); } catch { return { owner: '', repo: '', branch: DEFAULT_BRANCH, allowPublicMailbox: false }; }
    })();
    return {
      running,
      configured: Boolean(config.owner && config.repo),
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      allowPublicMailbox: config.allowPublicMailbox,
      publicRepository,
      workerId,
      lastPollAt,
      lastError,
      activeRequestId,
      pendingCount
    };
  }

  function announce() {
    try { onState(stateSnapshot()); } catch {}
  }

  async function api(method, path, body, query) {
    return githubAuth.requestApi({ method, path, ...(body ? { body } : {}), ...(query ? { query } : {}) });
  }

  async function readRemoteFile(relativePath) {
    const config = currentConfig();
    try {
      const response = await api('GET', apiPath(relativePath), null, { ref: config.branch });
      return { value: parseRemoteJson(response.result), sha: response.result.sha, entry: response.result };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function listFolder(relativePath) {
    const config = currentConfig();
    try {
      const response = await api('GET', apiPath(relativePath), null, { ref: config.branch });
      if (!Array.isArray(response.result)) throw new Error('Mailbox folder listing was not an array.');
      return response.result.filter(item => item && item.type === 'file' && typeof item.name === 'string');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async function writeRemoteJson(relativePath, value, existingSha = null, createOnly = false) {
    const config = currentConfig();
    const body = {
      message: '[local bridge] ' + relativePath,
      content: encodeJson(value),
      branch: config.branch,
      ...(existingSha ? { sha: existingSha } : {})
    };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES && relativePath.startsWith('bridge/results/')) {
      throw new Error('Result exceeded the repository mailbox limit.');
    }
    try {
      const response = await api('PUT', apiPath(relativePath), body);
      return { ok: true, sha: response.result && response.result.content && response.result.content.sha };
    } catch (error) {
      if (createOnly && isConflict(error)) return { ok: false, conflict: true };
      throw error;
    }
  }

  async function ensureFolders() {
    for (const folder of ['bridge/requests', 'bridge/results', 'bridge/claims', 'bridge/state']) {
      const entries = await listFolder(folder);
      if (entries.length) continue;
      const placeholder = folder + '/.gitkeep';
      const existing = await readRemoteFile(placeholder);
      if (existing) continue;
      await writeRemoteJson(placeholder, {
        purpose: 'Repository mailbox folder marker. Requests and results are stored as JSON files.'
      }, null, true);
    }
  }

  async function publishState(force = false) {
    const now = Date.now();
    const snapshot = {
      protocol: 'chatgpt-local-repo-state/v1',
      worker_id: workerId,
      updated_at: new Date(now).toISOString(),
      status: running ? (activeRequestId ? 'processing' : 'idle') : 'stopped',
      active_request_id: activeRequestId,
      pending_count: pendingCount,
      last_poll_at: lastPollAt,
      last_error: lastError || null,
      workspace_selected: Boolean(getWorkspaceRoot && getWorkspaceRoot()),
      workspace_name: getWorkspaceRoot ? require('node:path').basename(getWorkspaceRoot()) : null
    };
    if (!force && now - lastStatePublishAt < 60 * 1000) return;
    try {
      const file = await readRemoteFile('bridge/state/windows-app.json');
      await writeRemoteJson('bridge/state/windows-app.json', snapshot, file && file.sha, false);
      lastStatePublishAt = now;
    } catch (error) {
      lastError = 'Could not publish shared state: ' + cleanError(error.message);
      announce();
    }
  }

  async function acquireClaim(requestId) {
    const claimPath = 'bridge/claims/' + requestId + '.json';
    const now = Date.now();
    let prior;
    try {
      prior = await readRemoteFile(claimPath);
    } catch (error) {
      if (!isCorruptMailboxFile(error)) throw error;
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'The request claim file is corrupt. The app refused to execute this request again; inspect the workspace and claim file manually.'
      });
      return { acquired: false, recovered: true };
    }
    if (prior && ['completed', 'needs_manual_recovery'].includes(prior.value.status)) {
      return { acquired: false, terminal: true };
    }
    if (prior && prior.value.status === 'result_pending' && prior.value.result) {
      const publish = await writeRemoteJson('bridge/results/' + requestId + '.json', prior.value.result, null, true);
      if (publish.ok) {
        await writeRemoteJson(claimPath, {
          protocol: 'chatgpt-local-repo-claim/v1',
          request_id: requestId,
          worker_id: workerId,
          status: 'completed',
          completed_at: new Date().toISOString()
        }, prior.sha, false);
      }
      return { acquired: false, recovered: true };
    }
    if (prior && Number(prior.value.lease_expires_at_ms) > now) return { acquired: false };
    if (prior && prior.value.status === 'processing') {
      const recovery = {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'A previous worker claim expired. This request was not replayed automatically because the local operation may already have had side effects. Check the workspace before creating a new request ID.'
      };
      const result = await publishResult(requestId, recovery);
      const latestClaim = await readRemoteFile(claimPath);
      if (latestClaim) {
        await writeRemoteJson(claimPath, {
          protocol: 'chatgpt-local-repo-claim/v1',
          request_id: requestId,
          worker_id: workerId,
          status: 'needs_manual_recovery',
          completed_at: new Date().toISOString()
        }, latestClaim.sha, false);
      }
      return { acquired: false, recovered: result.published };
    }
    const claim = {
      protocol: 'chatgpt-local-repo-claim/v1',
      request_id: requestId,
      worker_id: workerId,
      tool: null,
      status: 'processing',
      claimed_at: new Date(now).toISOString(),
      lease_expires_at_ms: now + CLAIM_LEASE_MS
    };
    const written = await writeRemoteJson(claimPath, claim, prior && prior.sha, !prior);
    return written.ok ? { acquired: true, sha: written.sha, value: claim } : { acquired: false };
  }

  async function publishResult(requestId, result) {
    const path = 'bridge/results/' + requestId + '.json';
    const existing = await readRemoteFile(path);
    if (existing) return { published: true, alreadyExists: true };
    const written = await writeRemoteJson(path, result, null, true);
    return { published: written.ok, conflict: written.conflict === true };
  }

  async function processRequest(filename) {
    const requestId = filename.slice(0, -'.json'.length);
    if (!SAFE_ID.test(requestId) || inMemoryClaims.has(requestId)) return;
    const requestPath = 'bridge/requests/' + filename;
    let remote;
    try {
      remote = await readRemoteFile(requestPath);
    } catch (error) {
      if (!isCorruptMailboxFile(error)) throw error;
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'rejected',
        completed_at: new Date().toISOString(),
        error: 'Request file is malformed or exceeds the supported file format/size limit: ' + cleanError(error.message)
      });
      return;
    }
    if (!remote) return;
    let request;
    try {
      const raw = JSON.stringify(remote.value);
      if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Request exceeds the 1 MiB limit.');
      request = validateRequest(requestId, remote.value);
    } catch (error) {
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'rejected',
        completed_at: new Date().toISOString(),
        error: cleanError(error.message)
      });
      return;
    }

    const claim = await acquireClaim(requestId);
    if (!claim.acquired) return;
    inMemoryClaims.add(requestId);
    activeRequestId = requestId;
    announce();
    await publishState(true);

    let report;
    try {
      report = await executeTool(request.tool, request.args, requestId, { deliverToChat: false, publishToRepository: true });
    } catch (error) {
      report = { ok: false, error: cleanError(error.message), tool: request.tool, call_id: requestId };
    }

    const safeReport = sanitizeForRepository(report, getWorkspaceRoot ? getWorkspaceRoot() : '');
    let resultRecord = {
      protocol: RESULT_PROTOCOL,
      request_id: requestId,
      tool: request.tool,
      status: safeReport && safeReport.ok ? 'completed' : safeReport && safeReport.cancelled ? 'cancelled' : 'failed',
      created_at: remote.value.created_at,
      completed_at: new Date().toISOString(),
      result: safeReport
    };
    if (Buffer.byteLength(JSON.stringify(resultRecord), 'utf8') > MAX_RESULT_BYTES) {
      resultRecord = {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        tool: request.tool,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: 'Local result exceeded the size limit and was not uploaded. Retry with a narrower read or search.'
      };
    }

    const pendingClaim = {
      protocol: 'chatgpt-local-repo-claim/v1',
      request_id: requestId,
      worker_id: workerId,
      tool: request.tool,
      status: 'result_pending',
      claimed_at: claim.value.claimed_at,
      lease_expires_at_ms: Date.now() + 24 * 60 * 60 * 1000,
      result: resultRecord
    };
    try {
      await writeRemoteJson('bridge/claims/' + requestId + '.json', pendingClaim, claim.sha, false);
      const published = await publishResult(requestId, resultRecord);
      if (published.published) {
        const file = await readRemoteFile('bridge/claims/' + requestId + '.json');
        if (file) await writeRemoteJson('bridge/claims/' + requestId + '.json', {
          protocol: 'chatgpt-local-repo-claim/v1',
          request_id: requestId,
          worker_id: workerId,
          status: 'completed',
          completed_at: new Date().toISOString()
        }, file.sha, false);
      } else {
        lastError = 'Result for ' + requestId + ' is waiting to be published; the claim preserves it for retry.';
      }
    } catch (error) {
      lastError = 'Tool ran; result publication failed: ' + cleanError(error.message);
      try {
        const published = await publishResult(requestId, resultRecord);
        if (published.published) lastError = '';
      } catch (retryError) {
        lastError += '; retry failed: ' + cleanError(retryError.message);
      }
    } finally {
      activeRequestId = null;
      inMemoryClaims.delete(requestId);
      announce();
      await publishState(true);
    }
  }

  async function pollOnce() {
    if (pollInFlight || !running) return;
    pollInFlight = true;
    try {
      const [files, resultFiles] = await Promise.all([
        listFolder('bridge/requests'),
        listFolder('bridge/results')
      ]);
      const sorted = files
        .map(file => file.name)
        .filter(name => name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)))
        .sort();
      const completedIds = new Set(resultFiles
        .map(file => file.name)
        .filter(name => name.endsWith('.json')));
      const pending = sorted.filter(filename => !completedIds.has(filename));
      pendingCount = pending.length;
      lastPollAt = new Date().toISOString();
      lastError = '';
      announce();
      await publishState(false);
      for (const filename of pending) {
        if (!running) break;
        await processRequest(filename);
        if (pendingCount > 0) pendingCount--;
        announce();
      }
    } catch (error) {
      lastError = cleanError(error.message);
      announce();
    } finally {
      pollInFlight = false;
      announce();
    }
  }

  function scheduleNextPoll() {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await pollOnce();
      scheduleNextPoll();
    }, Math.max(5000, intervalMs));
  }

  async function start() {
    if (running) return stateSnapshot();
    const config = currentConfig();
    if (!config.owner || !config.repo) throw new Error('Configure a shared GitHub repository before starting the bridge.');
    const auth = await githubAuth.getState();
    if (!auth.authenticated) throw new Error('Sign in to GitHub in Accounts before starting the repository bridge.');
    const metadata = await api('GET', '/repos/' + config.owner + '/' + config.repo);
    publicRepository = metadata.result.private === false;
    if (publicRepository && !config.allowPublicMailbox) {
      throw new Error('The configured repository is public. Enable the explicit public-mailbox warning checkbox before allowing local results to be committed there.');
    }
    await ensureFolders();
    running = true;
    lastError = '';
    announce();
    await publishState(true);
    await pollOnce();
    scheduleNextPoll();
    return stateSnapshot();
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
    announce();
    try { await publishState(true); } catch {}
    return stateSnapshot();
  }

  function setConfig(input) {
    const config = validateConfig(input);
    const settings = getSettings();
    settings.repositoryBridge = config;
    persistSettings();
    announce();
    return stateSnapshot();
  }

  return { start, stop, pollOnce, setConfig, getState: stateSnapshot };
}

module.exports = {
  PROTOCOL,
  RESULT_PROTOCOL,
  DEFAULT_BRANCH,
  validateConfig,
  validateRequest,
  sanitizeForRepository,
  createRepositoryBridge
};
