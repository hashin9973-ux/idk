'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { TOOL_ARGUMENT_KEYS } = require('./tool-bridge');

const PROTOCOL = 'chatgpt-local-repo-bridge/v1';
const RESULT_PROTOCOL = 'chatgpt-local-repo-result/v1';
const CONTEXT_PROTOCOL = 'chatgpt-local-environment-context/v1';
const CONTEXT_REQUEST_TOOL = 'refresh_environment_context';
const DEFAULT_BRANCH = 'bridge-mailbox';
const DEFAULT_INTERVAL_MS = 1000;
const MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_CONTEXT_REFRESH_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
// Keep inline JSON under GitHub Contents API's 1 MiB response/content boundary.
const MAX_RESULT_BYTES = 850 * 1024;
const MAX_INLINE_BATCH_RESULT_BYTES = 600 * 1024;
const MAX_BATCH_OUTPUT_PART_BYTES = 700 * 1024;
const MAX_INLINE_TEXT_BYTES = 32 * 1024;
const MAX_ARTIFACT_PART_BYTES = 256 * 1024;
const MAX_WORKSPACE_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_FILESYSTEM_INDEX_BYTES = 4 * 1024 * 1024;
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
  const isContextRequest = request.tool === CONTEXT_REQUEST_TOOL;
  if (typeof request.tool !== 'string' ||
      (!isContextRequest && !Object.hasOwn(TOOL_ARGUMENT_KEYS, request.tool)) ||
      BLOCKED_TOOLS.has(request.tool)) {
    throw new Error('Unknown or unsupported local tool.');
  }
  if (!isPlainObject(request.args)) throw new Error('Request args must be a JSON object.');
  const allowed = isContextRequest ? [] : TOOL_ARGUMENT_KEYS[request.tool].filter(key => key !== 'approved');
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
    intervalMs = DEFAULT_INTERVAL_MS,
    contextRefreshIntervalMs = DEFAULT_CONTEXT_REFRESH_MS,
    publishContextOnStart = false
  } = deps;

  const workerId = randomUUID();
  let running = false;
  let timer = null;
  let pollInFlight = false;
  let pollPromise = null;
  const activeRequestIds = new Set();
  const pendingRequestQueue = [];
  const pendingRequestQueueSet = new Set();
  const inFlightRequestIds = new Set();
  const requestTasks = new Map();
  const requestTelemetry = new AsyncLocalStorage();
  let lastPollAt = null;
  let lastError = '';
  let publicRepository = null;
  let pendingCount = 0;
  let lastStatePublishAt = 0;
  const inMemoryClaims = new Set();
  let knownResultFiles = null;
  let lastContextRefreshAt = 0;
  let lastContextWorkspace = '';
  let contextRefreshInFlight = false;

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
      activeRequestId: activeRequestIds.size === 1 ? activeRequestIds.values().next().value : null,
      activeRequestIds: [...activeRequestIds],
      activeCount: activeRequestIds.size,
      pendingCount
    };
  }

  function announce() {
    try { onState(stateSnapshot()); } catch {}
  }

  async function api(method, path, body, query) {
    const telemetry = requestTelemetry.getStore() || null;
    const startedAt = Date.now();
    try {
      return await githubAuth.requestApi({ method, path, ...(body ? { body } : {}), ...(query ? { query } : {}) });
    } finally {
      if (telemetry) {
        telemetry.githubApiCalls++;
        telemetry.githubApiMs += Date.now() - startedAt;
      }
    }
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
    const folders = ['bridge/requests', 'bridge/results', 'bridge/claims', 'bridge/state', 'bridge/context', 'bridge/artifacts'];
    // Folder discovery is read-only, so fetch all six independently instead of
    // making app startup pay six sequential GitHub round trips.
    const discovered = await Promise.all(folders.map(async folder => ({
      folder,
      entries: await listFolder(folder)
    })));
    // Missing folder markers are writes to the shared branch; keep these serial
    // to avoid unnecessary Contents API commit races during first-time setup.
    for (const { folder, entries } of discovered) {
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
      status: running ? (activeRequestIds.size ? 'processing' : 'idle') : 'stopped',
      active_request_id: activeRequestIds.size === 1 ? activeRequestIds.values().next().value : null,
      active_request_ids: [...activeRequestIds],
      active_count: activeRequestIds.size,
      pending_count: pendingCount,
      last_poll_at: lastPollAt,
      last_error: lastError || null,
      workspace_selected: Boolean(getWorkspaceRoot && getWorkspaceRoot()),
      context_path: 'bridge/context/latest.json',
      artifact_root: 'bridge/artifacts/'
    };
    if (!force && now - lastStatePublishAt < 60 * 1000) return;
    // Reserve the refresh window before network I/O so overlapping polls don't
    // queue duplicate state writes. Result dispatch must not wait for this heartbeat.
    lastStatePublishAt = now;
    try {
      const file = await readRemoteFile('bridge/state/windows-app.json');
      await writeRemoteJson('bridge/state/windows-app.json', snapshot, file && file.sha, false);
    } catch (error) {
      if (lastStatePublishAt === now) lastStatePublishAt = 0;
      lastError = 'Could not publish shared state: ' + cleanError(error.message);
      announce();
    }
  }

  async function readRemoteContent(relativePath) {
    const config = currentConfig();
    try {
      const response = await api('GET', apiPath(relativePath), null, { ref: config.branch });
      const entry = response && response.result;
      if (!entry || entry.type !== 'file') throw new Error('GitHub returned an unexpected artifact file format.');
      const content = entry.encoding === 'base64' && typeof entry.content === 'string'
        ? Buffer.from(entry.content.replace(/\\s/g, ''), 'base64')
        : null;
      return { content, sha: entry.sha || null, entry };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function writeRemoteContent(relativePath, content, message) {
    const config = currentConfig();
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const existing = await readRemoteContent(relativePath);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (existing) {
      const existingHash = existing.content
        ? createHash('sha256').update(existing.content).digest('hex')
        : null;
      const gitBlobSha = createHash('sha1')
        .update('blob ' + bytes.length + String.fromCharCode(0), 'utf8')
        .update(bytes)
        .digest('hex');
      if (existingHash === contentHash || (!existing.content && existing.sha === gitBlobSha)) {
        return { ok: true, unchanged: true, sha: existing.sha, bytes: bytes.length, sha256: contentHash };
      }
      throw new Error('Artifact path already exists with different content: ' + relativePath);
    }
    try {
      const response = await api('PUT', apiPath(relativePath), {
        message: message || '[local bridge] publish artifact ' + path.posix.basename(relativePath),
        content: bytes.toString('base64'),
        branch: config.branch
      });
      return {
        ok: true,
        sha: response.result && response.result.content && response.result.content.sha || null,
        bytes: bytes.length,
        sha256: contentHash
      };
    } catch (error) {
      // A previous attempt may have published the same immutable artifact but lost its response.
      const reread = await readRemoteContent(relativePath).catch(() => null);
      const gitBlobSha = createHash('sha1')
        .update('blob ' + bytes.length + String.fromCharCode(0), 'utf8')
        .update(bytes)
        .digest('hex');
      if (reread && (
        (reread.content && createHash('sha256').update(reread.content).digest('hex') === contentHash) ||
        (!reread.content && reread.sha === gitBlobSha)
      )) {
        return { ok: true, unchanged: true, sha: reread.sha, bytes: bytes.length, sha256: contentHash };
      }
      throw error;
    }
  }

  function safeArtifactName(raw, fallback) {
    let value = String(raw || fallback || 'artifact.bin')
      .replace(/[\\/\\\\]/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 120);
    if (!value || value === '.' || value === '..') value = 'artifact.bin';
    return value;
  }

  async function publishFilesystemIndex(snapshot) {
    if (!snapshot || typeof snapshot.content !== 'string') {
      throw new TypeError('Filesystem index publication requires rendered text content.');
    }
    const bytes = Buffer.from(snapshot.content, 'utf8');
    if (bytes.length > MAX_FILESYSTEM_INDEX_BYTES) {
      throw new Error('Filesystem index exceeds the 4 MiB repository publishing limit.');
    }
    const relativePath = 'bridge/context/filesystem-index.md';
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const gitBlobSha = createHash('sha1')
      .update('blob ' + bytes.length + String.fromCharCode(0), 'utf8')
      .update(bytes)
      .digest('hex');
    const config = currentConfig();

    // This is a mutable, stable path (unlike request artifacts). Compare first
    // to avoid a GitHub commit for a watcher burst that did not change names.
    // On a Contents API conflict, reread the current SHA and retry a few times.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await readRemoteContent(relativePath);
      if (existing && (
        (existing.content && existing.content.equals(bytes)) ||
        existing.sha === gitBlobSha
      )) {
        return {
          ok: true,
          unchanged: true,
          path: relativePath,
          bytes: bytes.length,
          sha256: contentHash,
          github_blob_sha: existing.sha || gitBlobSha
        };
      }
      const body = {
        message: '[local bridge] update names-only filesystem index',
        content: bytes.toString('base64'),
        branch: config.branch,
        ...(existing && existing.sha ? { sha: existing.sha } : {})
      };
      try {
        const response = await api('PUT', apiPath(relativePath), body);
        return {
          ok: true,
          unchanged: false,
          path: relativePath,
          bytes: bytes.length,
          sha256: contentHash,
          github_blob_sha: response.result && response.result.content && response.result.content.sha || null
        };
      } catch (error) {
        if (attempt < 2 && isConflict(error)) continue;
        throw error;
      }
    }
    throw new Error('Could not publish filesystem index after resolving repository update conflicts.');
  }

  async function publishWorkspaceFile(requestId, file) {
    if (typeof requestId !== 'string' || !SAFE_ID.test(requestId)) throw new Error('Invalid request ID for file upload.');
    if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('Workspace upload must include file bytes.');
    }
    if (file.bytes.length > MAX_WORKSPACE_UPLOAD_BYTES) {
      throw new Error('Workspace file exceeds the 8 MiB upload limit.');
    }
    const fileName = safeArtifactName(file.artifactName, path.basename(String(file.path || 'artifact.bin')));
    const relativePath = 'bridge/artifacts/' + requestId + '/' + fileName;
    const stored = await writeRemoteContent(relativePath, file.bytes, '[local bridge] upload ' + fileName);
    const config = currentConfig();
    const extension = path.extname(fileName).toLowerCase();
    const mediaTypes = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.js': 'text/javascript', '.ts': 'text/typescript', '.css': 'text/css',
      '.html': 'text/html', '.xml': 'application/xml', '.csv': 'text/csv',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.zip': 'application/zip', '.7z': 'application/x-7z-compressed',
      '.log': 'text/plain', '.patch': 'text/x-diff', '.diff': 'text/x-diff'
    };
    return {
      path: relativePath,
      url: 'https://github.com/' + config.owner + '/' + config.repo + '/blob/' +
        encodeURIComponent(config.branch) + '/' + relativePath.split('/').map(encodeURIComponent).join('/'),
      media_type: mediaTypes[extension] || 'application/octet-stream',
      bytes: stored.bytes,
      sha256: stored.sha256,
      github_blob_sha: stored.sha,
      repository_visibility: publicRepository === true ? 'public' : publicRepository === false ? 'private' : 'unknown',
      note: 'The full file is stored in the shared repository; ChatGPT should retrieve this path through its GitHub integration.'
    };
  }

  function splitUtf8Text(value, limitBytes) {
    const chunks = [];
    let chunk = '';
    let chunkBytes = 0;
    for (const character of value) {
      const bytes = Buffer.byteLength(character, 'utf8');
      if (chunk && chunkBytes + bytes > limitBytes) {
        chunks.push(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += character;
      chunkBytes += bytes;
    }
    if (chunk || chunks.length === 0) chunks.push(chunk);
    return chunks;
  }


  function summarizeBatchOutput(value, depth = 0) {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') <= 1800) return value;
      const preview = value.slice(0, 1100) + '\n[… complete value is in result.output_artifacts …]\n' + value.slice(-350);
      return preview;
    }
    if (Array.isArray(value)) {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (bytes > 6000) {
        return {
          item_count: value.length,
          preview: value.slice(0, 2).map(item => summarizeBatchOutput(item, depth + 1)),
          note: 'Complete array is stored in result.output_artifacts.'
        };
      }
      return value.map(item => summarizeBatchOutput(item, depth + 1));
    }
    if (!isPlainObject(value)) return value;
    if (depth >= 6) return '[nested output is in result.output_artifacts]';
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = summarizeBatchOutput(item, depth + 1);
    return output;
  }

  async function bundleLargeBatchOutput(requestId, report, artifactManifest, artifactErrors) {
    const steps = report && report.result && Array.isArray(report.result.steps) ? report.result.steps : null;
    if (!steps || Buffer.byteLength(JSON.stringify(report), 'utf8') <= MAX_INLINE_BATCH_RESULT_BYTES) return report;

    const groups = [];
    let current = [];
    let currentBytes = 1200;
    for (const step of steps) {
      const stepBytes = Buffer.byteLength(JSON.stringify(step), 'utf8') + 1;
      if (stepBytes + 1200 > MAX_BATCH_OUTPUT_PART_BYTES) {
        throw new Error('A single batch-step output is larger than the safe artifact-part size; narrow that operation or return its output in bounded pages.');
      }
      if (current.length && currentBytes + stepBytes > MAX_BATCH_OUTPUT_PART_BYTES) {
        groups.push(current);
        current = [];
        currentBytes = 1200;
      }
      current.push(step);
      currentBytes += stepBytes;
    }
    if (current.length) groups.push(current);

    const parts = [];
    for (let index = 0; index < groups.length; index++) {
      const partNumber = index + 1;
      const relativePath = 'bridge/artifacts/' + requestId + '-batch-output-' + String(partNumber).padStart(3, '0') + '.json';
      const payload = {
        protocol: 'chatgpt-local-batch-output/v1',
        request_id: requestId,
        part: partNumber,
        total_parts: groups.length,
        steps: groups[index]
      };
      const content = JSON.stringify(payload, null, 2) + '\n';
      const saved = await writeRemoteContent(relativePath, content, '[local bridge] publish complete batch output part');
      const stepIds = groups[index].map(step => step.id);
      const ref = { path: relativePath, bytes: saved.bytes, sha256: saved.sha256, step_ids: stepIds };
      parts.push(ref);
      artifactManifest.push({
        kind: 'batch_output_part',
        path: relativePath,
        bytes: saved.bytes,
        sha256: saved.sha256,
        step_ids: stepIds,
        field: 'result.result.output_artifacts'
      });
    }

    return {
      ...report,
      result: {
        ...report.result,
        steps: steps.map(step => ({
          id: step.id,
          tool: step.tool,
          call_id: step.call_id,
          ok: step.ok === true,
          status: step.status,
          ...(step.skipped ? { skipped: true } : {}),
          ...(step.cancelled ? { cancelled: true } : {}),
          ...(step.error ? { error: step.error } : {}),
          ...(step.message && !step.ok ? { message: step.message } : {}),
          ...(Number.isInteger(step.exit_code) ? { exit_code: step.exit_code } : {}),
          ...(step.timed_out ? { timed_out: true } : {}),
          ...(step.result !== undefined ? { result: summarizeBatchOutput(step.result) } : {}),
          output_in_artifact: true
        })),
        output_bundled: true,
        output_artifacts: parts
      }
    };
  }

  async function externalizeLargeText(requestId, value, artifactManifest, artifactErrors, keyPath = 'output') {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') <= MAX_INLINE_TEXT_BYTES) return value;
      // Keep normal tool calls to one request file plus one result file. Do not force
      // ChatGPT to fetch a third artifact just to inspect ordinary tool output.
      const chunks = splitUtf8Text(value, Math.floor(MAX_INLINE_TEXT_BYTES / 2));
      const first = chunks[0] || '';
      const last = chunks.length > 1 ? chunks[chunks.length - 1] : '';
      return first + '\n\n[OUTPUT SHORTENED TO KEEP THIS RESULT SELF-CONTAINED. Do not infer a safety block from truncation. Check exitCode/status/stderr; for listings, retry in stable pages using Sort-Object plus Select-Object -Skip/-First until all entries are retrieved.]\n\n' + last;
    }
    if (Array.isArray(value)) {
      const output = [];
      for (let index = 0; index < value.length; index++) {
        output.push(await externalizeLargeText(requestId, value[index], artifactManifest, artifactErrors, keyPath + '.' + index));
      }
      return output;
    }
    if (!isPlainObject(value)) return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = await externalizeLargeText(requestId, item, artifactManifest, artifactErrors, keyPath + '.' + key);
    }
    return output;
  }

  function compactRecordForInlineResult(record) {
    const output = JSON.parse(JSON.stringify(record));
    const marker = ' … [shortened to fit the two-operation result limit] … ';
    function collect(value, parent, key, strings, arrays) {
      if (typeof value === 'string') {
        if (value.length > 80) strings.push({ parent, key, value, length: value.length });
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        if (value.length > 3) {
          const estimate = Buffer.byteLength(JSON.stringify(value), 'utf8');
          arrays.push({ parent, key, value, estimate, length: value.length });
        }
        for (let index = 0; index < value.length; index++) collect(value[index], value, index, strings, arrays);
        return;
      }
      for (const [childKey, childValue] of Object.entries(value)) collect(childValue, value, childKey, strings, arrays);
    }
    let serialized = JSON.stringify(output);
    let rounds = 0;
    const targetBytes = MAX_RESULT_BYTES - 2048;
    while (Buffer.byteLength(serialized, 'utf8') > targetBytes && rounds++ < 4000) {
      const strings = [];
      const arrays = [];
      collect(output, null, null, strings, arrays);
      strings.sort((a, b) => b.length - a.length);
      if (strings.length) {
        for (const slot of strings) {
          const nextLength = Math.max(48, Math.floor(slot.length / 2));
          if (nextLength <= marker.length + 8) {
            slot.parent[slot.key] = slot.value.slice(0, Math.max(24, nextLength - 3)) + '…';
          } else {
            const keep = Math.floor((nextLength - marker.length) / 2);
            slot.parent[slot.key] = slot.value.slice(0, keep) + marker + slot.value.slice(-keep);
          }
        }
      } else {
        arrays.sort((a, b) => b.estimate - a.estimate);
        if (!arrays.length) break;
        const slot = arrays[0];
        const omitted = slot.value.length - 3;
        slot.parent[slot.key] = [slot.value[0], { _bridge_truncated: true, omitted_items: omitted }, slot.value[slot.value.length - 1]];
      }
      serialized = JSON.stringify(output);
    }
    if (Buffer.byteLength(serialized, 'utf8') > targetBytes) {
      return {
        protocol: RESULT_PROTOCOL,
        request_id: record.request_id,
        tool: record.tool,
        status: 'partial',
        created_at: record.created_at,
        completed_at: record.completed_at,
        output_truncated: true,
        result: { ok: Boolean(record.result && record.result.ok), note: 'The result was too large for one self-contained response. Repeat with narrower paths, line ranges, searches, or a smaller batch.' },
        artifacts: record.artifacts || [],
        artifact_errors: record.artifact_errors || []
      };
    }
    output.output_truncated = true;
    output.output_note = 'Some output fields were shortened to preserve the two-operation workflow. Truncation alone does not mean a safety check blocked execution; inspect status, ok, exitCode, stderr and explicit cancellation/rejection errors. For large listings, rerun bounded, stably sorted pages and continue until complete.';
    if (output.status === 'completed') output.status = 'partial';
    return output;
  }
  function contextComparable(value) {
    if (Array.isArray(value)) return value.map(contextComparable);
    if (!isPlainObject(value)) return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'generated_at' || key === 'freeMemoryBytes') continue;
      output[key] = contextComparable(item);
    }
    return output;
  }

  async function upsertContextJson(relativePath, value) {
    const existing = await readRemoteFile(relativePath);
    if (existing && JSON.stringify(contextComparable(existing.value)) === JSON.stringify(contextComparable(value))) {
      return { ok: true, unchanged: true, sha: existing.sha };
    }
    return writeRemoteJson(relativePath, value, existing && existing.sha, false);
  }

  async function publishEnvironmentContext() {
    const generatedAt = new Date().toISOString();
    const root = getWorkspaceRoot ? getWorkspaceRoot() : '';
    const files = {};
    const contextReports = {};
    const collectors = [
      ['environment', 'environment_info', {}],
      ['project', 'project_status', {}],
      ['capabilities', 'get_capabilities', {}],
      ['project_commands', 'read_file', { path: 'package.json' }],
      ['instructions', 'discover_instructions', {}]
    ];
    for (const [name, tool, args] of collectors) {
      const relativePath = 'bridge/context/' + name + '.json';
      let report;
      try {
        report = await executeTool(tool, args, 'context-' + randomUUID());
        report = sanitizeForRepository(report, root);
        if (name === 'environment' && report && report.result && typeof report.result === 'object') {
          delete report.result.freeMemoryBytes;
        }
        if (name === 'project_commands') {
          const content = report && report.ok && report.result && report.result.content;
          if (typeof content === 'string') {
            try {
              const manifest = JSON.parse(content);
              report = { ok: true, result: {
                available: true,
                manifest: 'package.json',
                name: typeof manifest.name === 'string' ? manifest.name : null,
                packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
                engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
                scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
              } };
            } catch { report = { ok: true, result: { available: false, parse_error: true, manifest: 'package.json' } }; }
          } else {
            report = { ok: true, result: { available: false, manifest: 'package.json' } };
          }
        }
        if (name === 'instructions' && report && report.result && Array.isArray(report.result.instructions)) {
          report.result.instructions = report.result.instructions.map(item => ({
            path: item.path,
            bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
            sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex')
          }));
          report.result.note = 'Instruction contents are intentionally not included in the environment snapshot. Request discover_instructions or read the relevant AGENTS.md file to retrieve content on demand.';
        }
        contextReports[name] = report;
      } catch (error) {
        report = { ok: false, error: cleanError(error.message) };
      }
      const record = {
        protocol: CONTEXT_PROTOCOL,
        name,
        tool,
        generated_at: generatedAt,
        data: report
      };
      await upsertContextJson(relativePath, record);
      files[name] = relativePath;
    }

    // The full file-name index is maintained separately by the filesystem watcher.
    // Do not recursively scan the workspace while creating the compact context.
    const directoryIndexReference = {
      ok: true,
      result: {
        path: 'bridge/context/filesystem-index.md',
        mode: 'names-only',
        scope: 'selected workspace',
        updates: 'debounced filesystem notifications with periodic full reconciliation',
        note: 'The maintained index lists relative paths and item types only; it never contains file contents.'
      }
    };
    contextReports.directory_tree = directoryIndexReference;
    await upsertContextJson('bridge/context/directory_tree.json', {
      protocol: CONTEXT_PROTOCOL,
      name: 'directory_tree',
      tool: 'filesystem-index-reference',
      generated_at: generatedAt,
      data: directoryIndexReference
    });
    files.directory_tree = 'bridge/context/directory_tree.json';
    files.filesystem_index = 'bridge/context/filesystem-index.md';

    const capabilityData = contextReports.capabilities && contextReports.capabilities.result || {};
    const instructionData = contextReports.instructions && contextReports.instructions.result || {};
    const projectCommandData = contextReports.project_commands && contextReports.project_commands.result || { available: false };
    const projectCommandList = [];
    const projectEntries = new Set((contextReports.project && contextReports.project.result && contextReports.project.result.topLevelEntries || []).map(String));
    const scripts = projectCommandData.scripts && typeof projectCommandData.scripts === 'object' ? projectCommandData.scripts : {};
    if (typeof scripts.test === 'string') projectCommandList.push({ name: 'test', command: 'npm test', source: 'package.json scripts.test' });
    if (typeof scripts.check === 'string') projectCommandList.push({ name: 'check', command: 'npm run check', source: 'package.json scripts.check' });
    if (typeof scripts.lint === 'string') projectCommandList.push({ name: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' });
    if (projectEntries.has('pyproject.toml') || projectEntries.has('pytest.ini') || projectEntries.has('tests')) projectCommandList.push({ name: 'test', command: 'python -m pytest', source: 'Python project marker; verify dependencies first' });
    if (projectEntries.has('Cargo.toml')) projectCommandList.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' });
    if (projectEntries.has('go.mod')) projectCommandList.push({ name: 'test', command: 'go test ./...', source: 'go.mod' });
    if (projectEntries.has('pom.xml')) projectCommandList.push({ name: 'test', command: 'mvn test', source: 'pom.xml' });
    if (projectEntries.has('gradlew.bat')) projectCommandList.push({ name: 'test', command: '.\\gradlew.bat test', source: 'gradlew.bat' });
    else if (projectEntries.has('build.gradle') || projectEntries.has('build.gradle.kts')) projectCommandList.push({ name: 'test', command: 'gradle test', source: 'Gradle build file' });
    if (projectEntries.has('global.json') || [...projectEntries].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) projectCommandList.push({ name: 'test', command: 'dotnet test', source: '.NET project marker' });
    const index = {
      protocol: CONTEXT_PROTOCOL,
      generated_at: generatedAt,
      worker_id: workerId,
      workspace_selected: Boolean(root),
      retrieval_policy: 'Use agent_context as the compact workspace and tool entry point. The names-only filesystem index is maintained separately at bridge/context/filesystem-index.md and updated after filesystem changes, with periodic reconciliation. Other detailed snapshots are available via files only when needed.',
      agent_context: {
        protocol: 'chatgpt-local-agent-context/v1',
        generated_at: generatedAt,
        environment: contextReports.environment && contextReports.environment.result || null,
        project: contextReports.project && contextReports.project.result || null,
        project_commands: { ...projectCommandData, suggested: projectCommandList },
        directory_overview: contextReports.directory_tree && contextReports.directory_tree.result || null,
        filesystem_index: {
          path: 'bridge/context/filesystem-index.md',
          mode: 'names-only',
          scope: 'selected workspace',
          contents_included: false,
          updates: 'filesystem events plus periodic reconciliation'
        },
        instruction_files: Array.isArray(instructionData.instructions) ? instructionData.instructions.map(item => ({ ...item, contents_included: false })) : [],
        tool_catalog: {
          protocol: capabilityData.protocol || null,
          catalog_version: capabilityData.catalog_version || 1,
          tools: Array.isArray(capabilityData.tools) ? capabilityData.tools : [],
          tool_calling: capabilityData.tool_calling || null
        },
        bridge_invocation: {
          repository: [currentConfig().owner, currentConfig().repo].filter(Boolean).join('/'),
          branch: currentConfig().branch || DEFAULT_BRANCH,
          protocol: PROTOCOL,
          request_path_template: 'bridge/requests/<request_id>.json',
          result_path_template: 'bridge/results/<same-request-id>.json',
          claim_path_template: 'bridge/claims/<same-request-id>.json',
          worker_state_path: 'bridge/state/windows-app.json',
          request_example: {
            protocol: PROTOCOL,
            request_id: 'req-YYYYMMDD-unique',
            created_at: '<current ISO-8601 timestamp>',
            tool: 'get_agent_context',
            args: {}
          },
          calling_contract: 'Local tools are mailbox-backed, not native GitHub MCP function names. Use GitHub MCP file operations to publish the request JSON on the configured branch, then read the result at the matching request ID. Use bridge/context/capabilities.json for exact tool schemas.'
        },
        tool_failure_contract: {
        no_request: 'If bridge/requests/<request_id>.json was never published on the configured mailbox branch, the Windows worker never received the operation. Do not say the worker blocked it; publish a correctly formed request using the current tool catalog.',
        pending: 'If the request exists but its matching result is missing, inspect the same request claim and bridge/state/windows-app.json, then reread the same result. A delay or missing result is not proof of a safety rejection. Never replay an uncertain side effect.',
        rejected: 'Only a matching result with status rejected and a concrete error proves that the bridge rejected the request envelope or tool registration. Report the exact reason and correct the request.',
        failed: 'A result with status failed is an execution/tool error. Inspect nested ok, exitCode, timedOut, stdout, stderr, and error. Compiler errors, non-zero builds, missing files, invalid paths, and patch-context mismatches are not automatically safety blocks.',
        cancelled: 'A result with status cancelled means the operation was cancelled or local approval was declined. Check the exact result and current execution_policy.auto_accept_all before describing an approval issue.',
        partial: 'A partial result or output_truncated flag means output was shortened; it does not by itself mean the operation was blocked.',
        protections: 'Never bypass tool schemas, workspace and symlink boundaries, secret-file protections, privacy rules, or genuine local approval requirements.'
        },
        operating_rules: [
          'Local tools are not native GitHub MCP function names. For any Windows action, use GitHub MCP file operations to read the published context and publish the mailbox request; do not look only for native local-tool functions.',
          'To invoke a local tool, create a unique immutable JSON file at bridge/requests/<request_id>.json using bridge_invocation.request_example as the envelope, replace both placeholders, then read bridge/results/<same-request-id>.json. The request is not a result.',
          'Immediately request get_agent_context through the mailbox, then act through the exact local tool catalog and schemas it returns. Do not stop because get_agent_context, read_file, or shell is absent from the native GitHub MCP function list.',
          'Before asking for machine-discoverable facts such as installed applications/games, executable versions, install paths, frameworks, files, or configuration, perform targeted read-only Windows discovery. Prefer manifests, executable metadata, registry/package metadata, and bounded searches; avoid unnecessary whole-drive crawls.',
          'Ask only for genuinely missing user intent or preferences after safe discovery. For a build/mod request, discover the installed environment first, then ask at most one concise question about the desired behavior.',
          'If a result is missing, inspect the matching claim and bridge/state/windows-app.json, then re-read the same result. Do not declare access blocked or create a duplicate while the operation may be running.',
          'Only describe a tool or permission as unavailable after a matching request/result supplies a concrete rejection or failure. Preserve native approval, argument-validation and workspace restrictions; do not bypass them.',
          'Do not claim the mailbox rejected a request unless its matching result has status rejected and a concrete rejection error. If a tool result failed due to a path, secret, schema, or permission check, report that exact error; a missing result or compiler error is not a generic safety block.',
          'A project compile error, patch-context mismatch, timeout, unsupported argument, and output truncation each have different remedies; name and address the actual result instead of making a generic safety-block claim.',
          'Context snapshots refresh in the background while the request queue is idle. Do not wait for context refresh to dispatch an already-published request.',
          'Use workspace-relative paths or absolute Windows paths that remain inside the selected workspace.',
          'Use mailbox evidence to diagnose delivery: a request file proves it was committed to the shared mailbox; a matching claim proves the worker claimed it; a matching result records its outcome. If no request file exists on the configured branch, do not attribute the failure to the Windows worker.',
          'Inspect relevant project instructions and source before editing.',
          'For substantial tasks, define measurable acceptance criteria and a short implementation plan; keep the plan proportional to the task.',
          'Match architecture to scope. Do not collapse a complex game, app, or multi-system feature into one file unless the user explicitly requests it.',
          'Implement integrated vertical slices with clear module boundaries. After edits, run project-native checks and tests, and an end-to-end smoke test for user-facing behavior when available; fix failures and rerun verification.',
          'Report only verified results and distinguish tested behavior from anything that remains unverified.',
          'Batch up to 100 known operations in one request. For up to 100 independent, lightweight file operations set maxConcurrency to 100; the default is 32. Output preserves per-step status, and large batches expose result.output_artifacts. Fetch every listed part concurrently, then review/process the results together.',
          'Protected operations may prompt for native Windows approval unless Auto-accept everything is enabled; tool registration, argument, and workspace-path validation still apply.',
          'PowerShell is not sandboxed and runs as the signed-in Windows user.',
          'Ordinary tool results are self-contained in their matching result file; large outputs may be shortened instead of requiring a third artifact fetch.',
          'After creating a request, wait for bridge/results/<same-request-id>.json before treating it as finished or starting dependent work. A request or processing claim is not a result; if the result is missing, inspect windows-app state and the matching claim, then poll again rather than creating duplicates.',
          'shell and run_tests wait for the foreground process to exit or for the timeout watchdog to return partial output. Inspect exitCode, timedOut, stdout, and stderr. A timeout or non-zero exit is not success. For background servers, redirect logs, poll readiness with a bounded deadline, and separate server lifetime from the smoke-test process.'
        ]
      },
      files
    };
    await upsertContextJson('bridge/context/latest.json', index);
    lastContextRefreshAt = Date.now();
    lastContextWorkspace = String(root || '');
    return index;
  }

  function scheduleContextRefresh() {
    if (!running || contextRefreshInFlight) return;
    contextRefreshInFlight = true;
    Promise.resolve()
      .then(() => publishEnvironmentContext())
      .catch(error => {
        lastError = 'Background context refresh failed: ' + cleanError(error.message);
        announce();
      })
      .finally(() => {
        contextRefreshInFlight = false;
        announce();
      });
  }

  async function acquireClaim(requestId) {
    const claimPath = 'bridge/claims/' + requestId + '.json';
    const now = Date.now();
    const claim = {
      protocol: 'chatgpt-local-repo-claim/v1',
      request_id: requestId,
      worker_id: workerId,
      tool: null,
      status: 'processing',
      claimed_at: new Date(now).toISOString(),
      lease_expires_at_ms: now + CLAIM_LEASE_MS
    };

    // Fast path: creating an immutable claim is one API request. Only read the
    // existing claim when the create conflicts, which is the exceptional path.
    const created = await writeRemoteJson(claimPath, claim, null, true);
    if (created.ok) return { acquired: true, sha: created.sha, value: claim };
    if (!created.conflict) return { acquired: false };

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
    if (!prior) return { acquired: false };

    if (!isPlainObject(prior.value) ||
        prior.value.protocol !== 'chatgpt-local-repo-claim/v1' ||
        prior.value.request_id !== requestId ||
        !['processing', 'result_pending', 'completed', 'needs_manual_recovery'].includes(prior.value.status)) {
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'The existing claim file is malformed or has an unknown state. The local operation was not replayed; inspect the workspace and claim file before retrying.'
      });
      return { acquired: false, recovered: true };
    }

    // A completed claim now stores its result as a recovery journal. If result
    // publication was interrupted, republish that exact result, never rerun work.
    if (prior.value.status === 'completed' && prior.value.result) {
      const published = await publishResult(requestId, prior.value.result);
      return { acquired: false, recovered: published.published, terminal: published.published };
    }

    if (prior.value.status === 'result_pending' && prior.value.result) {
      const published = await publishResult(requestId, prior.value.result);
      if (published.published) {
        await writeRemoteJson(claimPath, {
          protocol: 'chatgpt-local-repo-claim/v1',
          request_id: requestId,
          worker_id: workerId,
          status: 'completed',
          completed_at: new Date().toISOString(),
          result: prior.value.result
        }, prior.sha, false);
      }
      return { acquired: false, recovered: published.published };
    }

    if (['completed', 'needs_manual_recovery'].includes(prior.value.status)) {
      const resultIsKnown = Boolean(knownResultFiles && knownResultFiles.has(requestId + '.json'));
      const existingResult = resultIsKnown ? true : await readRemoteFile('bridge/results/' + requestId + '.json');
      if (existingResult && knownResultFiles) knownResultFiles.add(requestId + '.json');
      if (!existingResult) {
        await publishResult(requestId, {
          protocol: RESULT_PROTOCOL,
          request_id: requestId,
          status: 'needs_manual_recovery',
          completed_at: new Date().toISOString(),
          error: 'The claim is terminal but its result file is missing. The local operation was not replayed; inspect the workspace before retrying with a new request ID.'
        });
        if (prior.value.status === 'completed') {
          await writeRemoteJson(claimPath, {
            protocol: 'chatgpt-local-repo-claim/v1',
            request_id: requestId,
            worker_id: workerId,
            status: 'needs_manual_recovery',
            completed_at: new Date().toISOString()
          }, prior.sha, false).catch(() => {});
        }
      }
      return { acquired: false, terminal: true };
    }

    if (prior.value.status === 'result_pending') {
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'The previous worker finished without a recoverable result payload. The local operation was not replayed; inspect the workspace before retrying with a new request ID.'
      });
      return { acquired: false, recovered: true, terminal: true };
    }

    if (Number(prior.value.lease_expires_at_ms) > now) return { acquired: false };
    if (prior.value.status === 'processing') {
      const recovery = {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'A previous worker claim expired. This request was not replayed automatically because the local operation may already have had side effects. Check the workspace before creating a new request ID.'
      };
      const result = await publishResult(requestId, recovery);
      await writeRemoteJson(claimPath, {
        protocol: 'chatgpt-local-repo-claim/v1',
        request_id: requestId,
        worker_id: workerId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString()
      }, prior.sha, false).catch(() => {});
      return { acquired: false, recovered: result.published };
    }

    return { acquired: false };
  }

  async function publishResult(requestId, result) {
    const resultPath = 'bridge/results/' + requestId + '.json';
    // Result files are immutable. Try create-only directly rather than making a
    // separate GET to check existence first.
    const written = await writeRemoteJson(resultPath, result, null, true);
    if (written.ok || written.conflict) {
      if (knownResultFiles) knownResultFiles.add(requestId + '.json');
      return { published: true, alreadyExists: written.conflict === true };
    }
    return { published: false, conflict: false };
  }

  async function processRequest(filename) {
    const telemetry = { startedAt: Date.now(), githubApiCalls: 0, githubApiMs: 0 };
    return requestTelemetry.run(telemetry, () => processRequestInner(filename, telemetry));
  }

  async function processRequestInner(filename, telemetry) {
    const workerStartedAt = telemetry.startedAt;
    let requestLoadedAt = workerStartedAt;
    let claimStartedAt = workerStartedAt;
    let claimAcquiredAt = workerStartedAt;
    let toolStartedAt = workerStartedAt;
    let toolFinishedAt = workerStartedAt;
    const requestId = filename.slice(0, -'.json'.length);
    if (!SAFE_ID.test(requestId) || inMemoryClaims.has(requestId)) return;
    const requestPath = 'bridge/requests/' + filename;
    let remote;
    try {
      remote = await readRemoteFile(requestPath);
      requestLoadedAt = Date.now();
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

    claimStartedAt = Date.now();
    const claim = await acquireClaim(requestId);
    claimAcquiredAt = Date.now();
    if (!claim.acquired) return;
    inMemoryClaims.add(requestId);
    activeRequestIds.add(requestId);
    announce();
    toolStartedAt = Date.now();

    let report;
    try {
      if (request.tool === CONTEXT_REQUEST_TOOL) {
        report = { ok: true, result: await publishEnvironmentContext() };
      } else {
        report = await executeTool(request.tool, request.args, requestId);
      }
    } catch (error) {
      report = { ok: false, error: cleanError(error.message), tool: request.tool, call_id: requestId };
    }

    toolFinishedAt = Date.now();
    const sanitizedReport = sanitizeForRepository(report, getWorkspaceRoot ? getWorkspaceRoot() : '');
    const artifactManifest = [];
    const artifactErrors = [];
    let reportForInline = sanitizedReport;
    if (request.tool === 'batch') {
      try {
        reportForInline = await bundleLargeBatchOutput(requestId, sanitizedReport, artifactManifest, artifactErrors);
      } catch (error) {
        artifactErrors.push({ kind: 'batch_output_bundle', error: cleanError(error.message) });
      }
    }
    const safeReport = await externalizeLargeText(requestId, reportForInline, artifactManifest, artifactErrors);
    const uploadedArtifact = safeReport && safeReport.result && typeof safeReport.result.path === 'string' &&
      safeReport.result.path.startsWith('bridge/artifacts/') ? safeReport.result : null;
    const outputWasShortened = JSON.stringify(safeReport).includes('[OUTPUT SHORTENED TO KEEP THIS RESULT SELF-CONTAINED.') ||
      JSON.stringify(safeReport).includes('shortened to fit the two-operation result limit');
    if (uploadedArtifact) {
      artifactManifest.unshift({
        kind: 'uploaded_workspace_file',
        path: uploadedArtifact.path,
        url: uploadedArtifact.url,
        media_type: uploadedArtifact.media_type,
        bytes: uploadedArtifact.bytes,
        sha256: uploadedArtifact.sha256,
        field: 'result.artifact'
      });
    }
    let resultRecord = {
      protocol: RESULT_PROTOCOL,
      request_id: requestId,
      tool: request.tool,
      status: safeReport && safeReport.ok ? (artifactErrors.length || outputWasShortened ? 'partial' : 'completed') : safeReport && safeReport.cancelled ? 'cancelled' : 'failed',
      output_truncated: outputWasShortened,
      created_at: remote.value.created_at,
      completed_at: new Date().toISOString(),
      timing_ms: {
        created_to_worker_start: Number.isFinite(Date.parse(remote.value.created_at)) ? Math.max(0, workerStartedAt - Date.parse(remote.value.created_at)) : null,
        request_fetch: Math.max(0, requestLoadedAt - workerStartedAt),
        claim_acquisition: Math.max(0, claimAcquiredAt - claimStartedAt),
        tool_wall_time: Math.max(0, toolFinishedAt - toolStartedAt),
        result_preparation: Math.max(0, Date.now() - toolFinishedAt),
        worker_before_result_publish: Math.max(0, Date.now() - workerStartedAt),
        bridge_api_calls_before_result_publish: telemetry.githubApiCalls,
        bridge_api_ms_before_result_publish: telemetry.githubApiMs
      },
      result: safeReport,
      artifacts: artifactManifest,
      artifact_errors: artifactErrors
    };
    if (Buffer.byteLength(JSON.stringify(resultRecord), 'utf8') > MAX_RESULT_BYTES) {
      resultRecord = compactRecordForInlineResult(resultRecord);
    }

    // Store the completed result in the claim journal before publishing the
    // result file. This preserves crash recovery while eliminating the old
    // result-pending PUT + claim reread + final claim PUT sequence.
    const completedClaim = {
      protocol: 'chatgpt-local-repo-claim/v1',
      request_id: requestId,
      worker_id: workerId,
      tool: request.tool,
      status: 'completed',
      claimed_at: claim.value.claimed_at,
      completed_at: new Date().toISOString(),
      result: resultRecord
    };
    try {
      await writeRemoteJson('bridge/claims/' + requestId + '.json', completedClaim, claim.sha, false);
      const published = await publishResult(requestId, resultRecord);
      if (!published.published) {
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
      activeRequestIds.delete(requestId);
      inMemoryClaims.delete(requestId);
      announce();
    }
  }


  function enqueuePendingRequests(filenames) {
    for (const filename of filenames) {
      const requestId = filename.slice(0, -'.json'.length);
      if (!SAFE_ID.test(requestId)) continue;
      if (knownResultFiles && knownResultFiles.has(filename)) continue;
      if (inFlightRequestIds.has(requestId) || requestTasks.has(requestId) || pendingRequestQueueSet.has(filename)) continue;
      pendingRequestQueue.push(filename);
      pendingRequestQueueSet.add(filename);
    }
  }

  function dispatchPendingRequests() {
    if (!running) return;
    while (running && requestTasks.size < MAX_CONCURRENT_REQUESTS && pendingRequestQueue.length) {
      const filename = pendingRequestQueue.shift();
      pendingRequestQueueSet.delete(filename);
      const requestId = filename.slice(0, -'.json'.length);
      if (!SAFE_ID.test(requestId) || inFlightRequestIds.has(requestId) ||
          (knownResultFiles && knownResultFiles.has(filename))) continue;

      // Reserve the ID before the first await so overlapping poll cycles cannot
      // start two executions of the same request.
      inFlightRequestIds.add(requestId);
      const task = processRequest(filename)
        .catch(error => {
          lastError = 'Could not process request ' + requestId + ': ' + cleanError(error.message);
          announce();
        })
        .finally(() => {
          inFlightRequestIds.delete(requestId);
          requestTasks.delete(requestId);
          const queued = pendingRequestQueue.filter(name => !(knownResultFiles && knownResultFiles.has(name))).length;
          const active = [...requestTasks.keys()].filter(id => !(knownResultFiles && knownResultFiles.has(id + '.json'))).length;
          pendingCount = queued + active;
          announce();
          // Use the already-discovered queue to refill a freed slot; don't spend
          // another GitHub folder-list API call for every completed request.
          dispatchPendingRequests();
        });
      requestTasks.set(requestId, task);
    }
    const queued = pendingRequestQueue.filter(name => !(knownResultFiles && knownResultFiles.has(name))).length;
    const active = [...requestTasks.keys()].filter(id => !(knownResultFiles && knownResultFiles.has(id + '.json'))).length;
    pendingCount = queued + active;
    announce();
  }

  async function pollOnce() {
    if (pollInFlight || !running) return;
    pollInFlight = true;
    const task = (async () => {
      try {
        let files;
        if (knownResultFiles === null) {
          // Load the historical result index only once at startup. Re-fetching
          // the growing results folder every poll doubles request traffic.
          const [requestFiles, resultFiles] = await Promise.all([
            listFolder('bridge/requests'),
            listFolder('bridge/results')
          ]);
          files = requestFiles;
          knownResultFiles = new Set(resultFiles
            .map(file => file.name)
            .filter(name => name.endsWith('.json')));
        } else {
          files = await listFolder('bridge/requests');
        }
        const sorted = files
          .map(file => file.name)
          .filter(name => name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)))
          .sort();
        const pending = sorted.filter(filename => !knownResultFiles.has(filename));
        enqueuePendingRequests(pending);
        const firstPoll = !lastPollAt;
        lastPollAt = new Date().toISOString();
        lastError = '';
        announce();

        // Dispatch immediately after the request directory read. Publishing a
        // heartbeat is maintenance work and must not add a round trip to pickup.
        dispatchPendingRequests();
        void publishState(firstPoll);

        const currentWorkspace = String(getWorkspaceRoot ? getWorkspaceRoot() : '');
        const contextExpired = Date.now() - lastContextRefreshAt >= Math.max(60000, contextRefreshIntervalMs);
        const contextWorkspaceChanged = Boolean(lastContextRefreshAt) && currentWorkspace !== lastContextWorkspace;
        const contextRefreshRequired = publishContextOnStart && (contextWorkspaceChanged || contextExpired);
        if (contextRefreshRequired && pendingCount === 0 && requestTasks.size === 0 && pendingRequestQueue.length === 0) {
          scheduleContextRefresh();
        }
      } catch (error) {
        lastError = cleanError(error.message);
        announce();
      } finally {
        pollInFlight = false;
        pollPromise = null;
        announce();
      }
    })();
    pollPromise = task;
    return task;
  }

  function scheduleNextPoll() {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await pollOnce();
      scheduleNextPoll();
    }, Math.max(1000, intervalMs));
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
    // The first poll publishes the initial heartbeat; avoid a duplicate GET+PUT.
    await pollOnce();
    scheduleNextPoll();
    return stateSnapshot();
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
    const activePoll = pollPromise;
    if (activePoll) {
      try { await activePoll; } catch {}
    }
    // Stop accepting new work first, then wait for already-claimed requests so
    // the app is not torn down while a command is running or its result is publishing.
    if (requestTasks.size) {
      await Promise.allSettled([...requestTasks.values()]);
    }
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

  return { start, stop, pollOnce, setConfig, getState: stateSnapshot, publishEnvironmentContext, publishWorkspaceFile, publishFilesystemIndex };
}

module.exports = {
  PROTOCOL,
  RESULT_PROTOCOL,
  CONTEXT_PROTOCOL,
  CONTEXT_REQUEST_TOOL,
  DEFAULT_BRANCH,
  validateConfig,
  validateRequest,
  sanitizeForRepository,
  createRepositoryBridge
};
