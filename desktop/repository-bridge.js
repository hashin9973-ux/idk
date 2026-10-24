'use strict';

const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { TOOL_ARGUMENT_KEYS } = require('./tool-bridge');

const PROTOCOL = 'chatgpt-local-repo-bridge/v1';
const RESULT_PROTOCOL = 'chatgpt-local-repo-result/v1';
const CONTEXT_PROTOCOL = 'chatgpt-local-environment-context/v1';
const CONTEXT_REQUEST_TOOL = 'refresh_environment_context';
const DEFAULT_BRANCH = 'bridge-mailbox';
const DEFAULT_INTERVAL_MS = 15000;
const CLAIM_LEASE_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 90 * 1024;
const MAX_INLINE_TEXT_BYTES = 12 * 1024;
const MAX_ARTIFACT_PART_BYTES = 256 * 1024;
const MAX_WORKSPACE_UPLOAD_BYTES = 8 * 1024 * 1024;
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
    publishContextOnStart = false
  } = deps;

  const workerId = randomUUID();
  let running = false;
  let timer = null;
  let pollInFlight = false;
  let pollPromise = null;
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
    for (const folder of ['bridge/requests', 'bridge/results', 'bridge/claims', 'bridge/state', 'bridge/context', 'bridge/artifacts']) {
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
      context_path: 'bridge/context/latest.json',
      artifact_root: 'bridge/artifacts/'
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

  async function readRemoteContent(relativePath) {
    const config = currentConfig();
    try {
      const response = await api('GET', apiPath(relativePath), null, { ref: config.branch });
      const entry = response && response.result;
      if (!entry || entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string') {
        throw new Error('GitHub returned an unexpected artifact file format.');
      }
      return {
        content: Buffer.from(entry.content.replace(/\\s/g, ''), 'base64'),
        sha: entry.sha || null,
        entry
      };
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
      const existingHash = createHash('sha256').update(existing.content).digest('hex');
      if (existingHash === contentHash) {
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
      if (reread && createHash('sha256').update(reread.content).digest('hex') === contentHash) {
        return { ok: true, unchanged: true, sha: reread.sha, bytes: bytes.length, sha256: contentHash };
      }
      throw error;
    }
  }

  function safeArtifactName(raw, fallback) {
    let value = String(raw || fallback || 'artifact.bin')
      .replace(/[\\/\\\\]/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/^\\.+/, '')
      .slice(0, 120);
    if (!value || value === '.' || value === '..') value = 'artifact.bin';
    return value;
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

  async function externalizeLargeText(requestId, value, artifactManifest, artifactErrors, keyPath = 'output') {
    if (typeof value === 'string') {
      const byteCount = Buffer.byteLength(value, 'utf8');
      if (byteCount <= MAX_INLINE_TEXT_BYTES) return value;
      const chunks = splitUtf8Text(value, MAX_ARTIFACT_PART_BYTES);
      const slug = String(keyPath).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 36) || 'output';
      const paths = [];
      for (let index = 0; index < chunks.length; index++) {
        const partName = slug + (chunks.length > 1 ? '-part-' + String(index + 1).padStart(3, '0') : '') + '.txt';
        const relativePath = 'bridge/artifacts/' + requestId + '/' + String(artifactManifest.length + 1).padStart(3, '0') + '-' + partName;
        try {
          const stored = await writeRemoteContent(relativePath, chunks[index], '[local bridge] publish text output ' + partName);
          const entry = {
            path: relativePath,
            media_type: 'text/plain; charset=utf-8',
            bytes: stored.bytes,
            sha256: stored.sha256,
            part: index + 1,
            parts: chunks.length,
            field: keyPath
          };
          artifactManifest.push(entry);
          paths.push(relativePath);
        } catch (error) {
          artifactErrors.push({ path: relativePath, message: cleanError(error.message) });
        }
      }
      const preview = value.slice(0, 900);
      const storedPaths = paths.length ? paths.join(', ') : '(artifact publication failed)';
      return preview + (value.length > preview.length ? '\\n\\n[Output truncated in this result. Full output location: ' + storedPaths + '. Retrieve the artifact file(s) through GitHub.]' : '\\n\\n[Output externalized to ' + storedPaths + '. Retrieve the artifact file(s) through GitHub.]');
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

  async function upsertContextJson(relativePath, value) {
    const existing = await readRemoteFile(relativePath);
    return writeRemoteJson(relativePath, value, existing && existing.sha, false);
  }

  async function publishEnvironmentContext() {
    const generatedAt = new Date().toISOString();
    const root = getWorkspaceRoot ? getWorkspaceRoot() : '';
    const files = {};
    const collectors = [
      ['environment', 'environment_info', {}],
      ['project', 'project_status', {}],
      ['capabilities', 'get_capabilities', {}],
      ['directory_tree', 'directory_tree', { path: '.', maxDepth: 3, maxEntries: 250 }],
      ['instructions', 'discover_instructions', {}]
    ];
    for (const [name, tool, args] of collectors) {
      const relativePath = 'bridge/context/' + name + '.json';
      let report;
      try {
        report = await executeTool(tool, args, 'context-' + randomUUID());
        report = sanitizeForRepository(report, root);
        if (name === 'instructions' && report && report.result && Array.isArray(report.result.instructions)) {
          report.result.instructions = report.result.instructions.map(item => ({
            path: item.path,
            bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
            sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex')
          }));
          report.result.note = 'Instruction contents are intentionally not included in the environment snapshot. Request discover_instructions or read the relevant AGENTS.md file to retrieve content on demand.';
        }
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
    const index = {
      protocol: CONTEXT_PROTOCOL,
      generated_at: generatedAt,
      worker_id: workerId,
      workspace_selected: Boolean(root),
      retrieval_policy: 'Read this index first; retrieve only the context file(s) and source files relevant to the task. The snapshot may become stale; use refresh_environment_context or request live inspection.',
      files
    };
    await upsertContextJson('bridge/context/latest.json', index);
    return index;
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
    if (prior && (!isPlainObject(prior.value) ||
        prior.value.protocol !== 'chatgpt-local-repo-claim/v1' ||
        prior.value.request_id !== requestId ||
        !['processing', 'result_pending', 'completed', 'needs_manual_recovery'].includes(prior.value.status))) {
      await publishResult(requestId, {
        protocol: RESULT_PROTOCOL,
        request_id: requestId,
        status: 'needs_manual_recovery',
        completed_at: new Date().toISOString(),
        error: 'The existing claim file is malformed or has an unknown state. The local operation was not replayed; inspect the workspace and claim file before retrying.'
      });
      return { acquired: false, recovered: true };
    }
    if (prior && ['completed', 'needs_manual_recovery'].includes(prior.value.status)) {
      const missingResult = await readRemoteFile('bridge/results/' + requestId + '.json');
      if (!missingResult) {
        await publishResult(requestId, {
          protocol: RESULT_PROTOCOL,
          request_id: requestId,
          status: 'needs_manual_recovery',
          completed_at: new Date().toISOString(),
          error: 'The claim is terminal but its result file is missing. The local operation was not replayed; inspect the workspace before retrying with a new request ID.'
        });
      }
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
      if (request.tool === CONTEXT_REQUEST_TOOL) {
        report = { ok: true, result: await publishEnvironmentContext() };
      } else {
        report = await executeTool(request.tool, request.args, requestId);
      }
    } catch (error) {
      report = { ok: false, error: cleanError(error.message), tool: request.tool, call_id: requestId };
    }

    const sanitizedReport = sanitizeForRepository(report, getWorkspaceRoot ? getWorkspaceRoot() : '');
    const artifactManifest = [];
    const artifactErrors = [];
    const safeReport = await externalizeLargeText(requestId, sanitizedReport, artifactManifest, artifactErrors);
    let resultRecord = {
      protocol: RESULT_PROTOCOL,
      request_id: requestId,
      tool: request.tool,
      status: safeReport && safeReport.ok ? 'completed' : safeReport && safeReport.cancelled ? 'cancelled' : 'failed',
      created_at: remote.value.created_at,
      completed_at: new Date().toISOString(),
      result: safeReport,
      artifacts: artifactManifest,
      artifact_errors: artifactErrors
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
    const task = (async () => {
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
        const firstPoll = !lastPollAt;
        lastPollAt = new Date().toISOString();
        lastError = '';
        announce();
        await publishState(firstPoll);
        for (const filename of pending) {
          if (!running) break;
          try {
            await processRequest(filename);
          } catch (error) {
            lastError = 'Could not process request ' + filename.slice(0, -5) + ': ' + cleanError(error.message);
            announce();
          }
        }
        if (pending.length) {
          const finalResults = await listFolder('bridge/results');
          const finalCompletedIds = new Set(finalResults.map(file => file.name));
          pendingCount = sorted.filter(filename => !finalCompletedIds.has(filename)).length;
          announce();
          await publishState(true);
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
    if (publishContextOnStart) {
      try {
        await publishEnvironmentContext();
      } catch (error) {
        lastError = 'Environment context publication failed: ' + cleanError(error.message);
      }
    }
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
    const activePoll = pollPromise;
    if (activePoll) {
      try { await activePoll; } catch {}
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

  return { start, stop, pollOnce, setConfig, getState: stateSnapshot, publishEnvironmentContext, publishWorkspaceFile };
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
