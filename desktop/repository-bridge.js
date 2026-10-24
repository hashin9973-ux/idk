'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseRepositoryToolRequest, validateRepositoryName, validateBranchName } = require('./repository-protocol');

const BRIDGE_DIR = '.chatgpt-bridge';
const REQUEST_DIR = BRIDGE_DIR + '/requests';
const RESULT_DIR = BRIDGE_DIR + '/results';
const MAX_REQUEST_BYTES = 600 * 1024;
const MAX_RESULT_BYTES = 600 * 1024;
const POLL_INTERVAL_MS = 5000;
const MAX_LEDGER_ENTRIES = 1000;

function createRepositoryBridge(deps) {
  const {
    githubAuth,
    dataDir,
    getWorkspaceRepositories,
    executeRequest,
    notifyResult = async () => {},
    onStatus = () => {},
    pollIntervalMs = POLL_INTERVAL_MS,
    now = () => new Date()
  } = deps;

  if (!githubAuth || typeof githubAuth.requestApi !== 'function') throw new TypeError('githubAuth.requestApi is required.');
  if (typeof executeRequest !== 'function') throw new TypeError('executeRequest is required.');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required for durable request de-duplication.');

  const ledgerPath = path.join(dataDir, 'repository-bridge-ledger.json');
  const pendingDir = path.join(dataDir, 'repository-bridge-pending');
  let timer = null;
  let busy = false;
  let privacyCache = { key: '', checkedAt: 0, isPrivate: null };
  let lastStatus = { state: 'stopped', message: 'Repository bridge is stopped.' };

  function readLedger() {
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object' ? parsed : { records: {} };
    } catch {
      return { records: {} };
    }
  }

  function writeLedger(ledger) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const temporary = ledgerPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, ledgerPath);
  }

  function updateRecord(id, patch) {
    const ledger = readLedger();
    ledger.records[id] = { ...(ledger.records[id] || {}), ...patch, updatedAt: now().toISOString() };
    const entries = Object.entries(ledger.records).sort((a, b) =>
      String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
    ledger.records = Object.fromEntries(entries.slice(0, MAX_LEDGER_ENTRIES));
    writeLedger(ledger);
    return ledger.records[id];
  }

  function pendingPath(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id === '.' || id === '..') {
      throw new Error('Unsafe pending result ID.');
    }
    return path.join(pendingDir, id + '.json');
  }

  function savePendingResult(id, record) {
    fs.mkdirSync(pendingDir, { recursive: true });
    const target = pendingPath(id);
    const temp = target + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return target;
  }

  function readPendingResult(id) {
    try {
      return JSON.parse(fs.readFileSync(pendingPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  function deletePendingResult(id) {
    try { fs.rmSync(pendingPath(id), { force: true }); } catch {}
  }

  function emitStatus(state, message, extra = {}) {
    lastStatus = { state, message, ...extra, updatedAt: now().toISOString() };
    try { onStatus(lastStatus); } catch {}
    return lastStatus;
  }

  function getStatus() {
    return { ...lastStatus };
  }

  function getConfig() {
    return typeof githubAuth.getBridgeConfig === 'function' ? githubAuth.getBridgeConfig() : {};
  }

  function normalizeGitHubRemote(remote) {
    let value = String(remote || '').trim();
    value = value.replace(/^git@github\.com:/i, '');
    value = value.replace(/^ssh:\/\/git@github\.com\//i, '');
    value = value.replace(/^https?:\/\/github\.com\//i, '');
    value = value.replace(/^git:\/\/github\.com\//i, '');
    value = value.replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return match ? (match[1] + '/' + match[2]).toLowerCase() : null;
  }

  async function verifyWorkspaceRepository(repository) {
    if (typeof getWorkspaceRepositories !== 'function') return;
    let remotes;
    try { remotes = await getWorkspaceRepositories(); }
    catch {
      throw new Error('The selected workspace is not a Git checkout with a GitHub remote. Select the local clone of ' + repository + ' before allowing the bridge to run tools.');
    }
    const configured = repository.toLowerCase();
    const matches = Array.isArray(remotes) && remotes.some(remote => normalizeGitHubRemote(remote) === configured);
    if (!matches) {
      throw new Error('The selected workspace does not have a GitHub remote matching ' + repository + '. Select the matching local checkout so the bridge cannot run against the wrong project.');
    }
  }

  async function api(method, apiPath, body, query) {
    const args = { method, path: apiPath };
    if (body !== undefined) args.body = body;
    if (query !== undefined) args.query = query;
    return githubAuth.requestApi(args);
  }

  async function listJsonFiles(repository, branch, directory) {
    try {
      const response = await api('GET', '/repos/' + repository + '/contents/' + directory, undefined, { ref: branch });
      if (!Array.isArray(response.result)) throw new Error('Expected a GitHub directory listing at ' + directory + '.');
      return response.result.filter(item => item && item.type === 'file' && typeof item.name === 'string' &&
        item.name.toLowerCase().endsWith('.json'));
    } catch (error) {
      if (/not found|404/i.test(String(error && error.message || error))) return [];
      throw error;
    }
  }

  async function readTextFile(repository, branch, filePath) {
    const response = await api('GET', '/repos/' + repository + '/contents/' + filePath, undefined, { ref: branch });
    const file = response.result;
    if (!file || typeof file.content !== 'string') throw new Error('GitHub did not return file content for ' + filePath + '.');
    let content;
    if (file.encoding === 'base64') content = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
    else if (file.encoding === 'utf-8' || file.encoding === 'utf8') content = file.content;
    else throw new Error('Unsupported GitHub content encoding: ' + String(file.encoding));
    if (Buffer.byteLength(content, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Repository bridge request exceeded the safe 600 KiB limit.');
    return content;
  }

  async function publishResult(repository, branch, id, record) {
    const serialized = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error('Repository bridge result exceeded the safe 600 KiB limit; narrow the tool output and retry with a new request ID.');
    }
    const resultPath = RESULT_DIR + '/' + id + '.json';

    // Idempotency check before writing: a crash after GitHub accepted the commit
    // must not cause a result to be overwritten or local work to be repeated.
    try {
      const existingText = await readTextFile(repository, branch, resultPath);
      let existing;
      try { existing = JSON.parse(existingText); } catch { throw new Error('A result file already exists but contains invalid JSON: ' + resultPath); }
      if (existing.call_id !== id || existing.protocol !== 'chatgpt-windows-bridge/result-v1') {
        throw new Error('A conflicting repository result already exists for call_id ' + id + '.');
      }
      return resultPath;
    } catch (error) {
      if (!/not found|404/i.test(String(error && error.message || error))) throw error;
    }

    const body = {
      message: 'ChatGPT Windows bridge result: ' + id,
      content: Buffer.from(serialized, 'utf8').toString('base64'),
      branch
    };
    try {
      await api('PUT', '/repos/' + repository + '/contents/' + resultPath, body);
    } catch (error) {
      // Verify before reporting a write failure: GitHub might have accepted the
      // request even if the client lost the response.
      try {
        const existing = JSON.parse(await readTextFile(repository, branch, resultPath));
        if (existing.call_id === id && existing.protocol === 'chatgpt-windows-bridge/result-v1') return resultPath;
      } catch {}
      throw error;
    }
    return resultPath;
  }
  async function verifyRepositoryPrivacy(repository, config) {
    if (privacyCache.key === repository && Date.now() - privacyCache.checkedAt < 5 * 60 * 1000 &&
        typeof privacyCache.isPrivate === 'boolean') {
      if (!privacyCache.isPrivate && config.allowPublicRepository !== true) {
        throw new Error('The selected GitHub repository is public. Repository bridge results can contain local source or command output. Explicitly enable public-repository use in Accounts to proceed.');
      }
      return privacyCache.isPrivate;
    }
    const response = await api('GET', '/repos/' + repository);
    const isPrivate = response.result && response.result.private === true;
    if (!response.result || typeof response.result.private !== 'boolean') {
      throw new Error('GitHub did not report whether the bridge repository is private.');
    }
    privacyCache = { key: repository, checkedAt: Date.now(), isPrivate };
    if (!isPrivate && config.allowPublicRepository !== true) {
      throw new Error('The selected GitHub repository is public. Repository bridge results can contain local source or command output. Explicitly enable public-repository use in Accounts to proceed.');
    }
    return isPrivate;
  }

  async function notify(record, resultPath) {
    try {
      const outcome = await notifyResult({ ...record, resultPath });
      if (outcome && outcome.ok === false) {
        throw new Error('The result could not be inserted into the active ChatGPT conversation: ' + String(outcome.reason || 'unknown reason'));
      }
      updateRecord(record.call_id, { notificationState: 'sent', nextNotificationAt: null });
      deletePendingResult(record.call_id);
      return true;
    } catch (error) {
      updateRecord(record.call_id, {
        notificationState: 'pending',
        notificationError: String(error && error.message || error),
        nextNotificationAt: Date.now() + 30000
      });
      return false;
    }
  }
  async function publishPendingRecord(id, repository, branch, record) {
    const resultPath = await publishResult(repository, branch, id, record);
    updateRecord(id, { state: 'published', resultPath, repository, branch });
    await notify(record, resultPath);
    return resultPath;
  }

  async function recoverPending(config, repository) {
    const ledger = readLedger();
    for (const [id, entry] of Object.entries(ledger.records)) {
      if (entry.state !== 'running') continue;
      // We cannot know whether a command already had side effects when the app stopped.
      // Do not silently rerun it: publish an explicit indeterminate result instead.
      let record = readPendingResult(id);
      if (!record) {
        record = {
          protocol: 'chatgpt-windows-bridge/result-v1',
          call_id: id,
          repository: entry.repository || repository,
          branch: entry.branch || config.branch,
          status: 'indeterminate',
          completed_at: now().toISOString(),
          error: 'The app stopped after marking this request as running. It was not rerun automatically because the tool may already have had side effects.',
          retry_guidance: 'Inspect the local workspace. If the operation did not complete, submit a new request with a new call_id.'
        };
        savePendingResult(id, record);
      }
      updateRecord(id, { state: 'pending_publish', requestPath: entry.requestPath });
    }

    const latest = readLedger();
    for (const [id, entry] of Object.entries(latest.records)) {
      if (entry.state === 'pending_publish') {
        const record = readPendingResult(id);
        if (!record) {
          emitStatus('error', 'A pending repository result is missing from the local result cache; the request will not be executed again.', {
            repository, branch: config.branch, call_id: id
          });
          continue;
        }
        const targetRepository = entry.repository || record.repository || repository;
        const targetBranch = entry.branch || record.branch || config.branch || 'main';
        try {
          await verifyRepositoryPrivacy(targetRepository, config);
          await publishPendingRecord(id, targetRepository, targetBranch, record);
        } catch (error) {
          emitStatus('error', 'A completed local request is waiting for its result to be written to GitHub.', {
            repository: targetRepository, branch: targetBranch, call_id: id, error: String(error && error.message || error)
          });
          return false;
        }
      } else if (entry.state === 'published' && entry.notificationState !== 'sent' &&
          (!entry.nextNotificationAt || Date.now() >= entry.nextNotificationAt)) {
        const record = readPendingResult(id);
        if (record) await notify(record, entry.resultPath || (RESULT_DIR + '/' + id + '.json'));
      }
    }
    return true;
  }

  async function processRequest(repository, branch, file) {
    const id = path.posix.basename(file.path || file.name, '.json');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id === '.' || id === '..') {
      return { ignored: true, reason: 'invalid_request_filename' };
    }
    const existing = readLedger().records[id];
    if (existing && ['running', 'pending_publish', 'published'].includes(existing.state)) {
      return { ignored: true, reason: 'already_tracked' };
    }

    updateRecord(id, {
      state: 'running',
      repository,
      branch,
      requestPath: file.path || (REQUEST_DIR + '/' + file.name),
      startedAt: now().toISOString()
    });

    let resultRecord;
    try {
      const content = await readTextFile(repository, branch, file.path || (REQUEST_DIR + '/' + file.name));
      const request = parseRepositoryToolRequest(content, id);
      // Repository writes request local access; they do not waive local approval.
      const report = await executeRequest(request, { requireApproval: true, repository, branch });
      resultRecord = {
        protocol: 'chatgpt-windows-bridge/result-v1',
        call_id: id,
        request_path: file.path || (REQUEST_DIR + '/' + file.name),
        repository,
        branch,
        tool: request.tool,
        status: report && report.ok ? 'completed' : (report && report.cancelled ? 'cancelled' : 'failed'),
        created_at: request.created_at || null,
        completed_at: now().toISOString(),
        result: report
      };
    } catch (error) {
      resultRecord = {
        protocol: 'chatgpt-windows-bridge/result-v1',
        call_id: id,
        request_path: file.path || (REQUEST_DIR + '/' + file.name),
        repository,
        branch,
        status: 'rejected',
        completed_at: now().toISOString(),
        error: String(error && error.message || error)
      };
    }

    savePendingResult(id, resultRecord);
    updateRecord(id, { state: 'pending_publish' });
    try {
      const resultPath = await publishPendingRecord(id, repository, branch, resultRecord);
      emitStatus('active', 'Processed a repository request and published its result.', {
        repository, branch, call_id: id, tool: resultRecord.tool || null, resultPath
      });
      return { processed: true, call_id: id, resultPath, status: resultRecord.status };
    } catch (error) {
      emitStatus('error', 'A local request finished, but its result could not yet be published to GitHub. It is saved locally and will be retried.', {
        repository, branch, call_id: id, error: String(error && error.message || error)
      });
      return { processed: true, call_id: id, resultPending: true };
    }
  }

  async function pollOnce() {
    if (busy) return { skipped: true, reason: 'poll_already_running' };
    busy = true;
    try {
      const config = getConfig();
      const repository = config.repository ? validateRepositoryName(String(config.repository).trim()) : '';
      const branch = validateBranchName(String(config.branch || 'main').trim() || 'main');
      if (!repository) return emitStatus('not_configured', 'Choose the GitHub repository used as the local development bridge.');
      if (typeof githubAuth.hasSavedToken === 'function' && !githubAuth.hasSavedToken()) {
        return emitStatus('not_authenticated', 'Sign in to GitHub in Accounts to enable the repository bridge.', { repository, branch });
      }
      await verifyWorkspaceRepository(repository);
      await verifyRepositoryPrivacy(repository, config);
      if (!(await recoverPending(config, repository))) return getStatus();

      const [requestFiles, resultFiles] = await Promise.all([
        listJsonFiles(repository, branch, REQUEST_DIR),
        listJsonFiles(repository, branch, RESULT_DIR)
      ]);
      const completedRemote = new Set(resultFiles.map(item => item.name.replace(/\.json$/i, '')));
      for (const file of requestFiles.sort((a, b) => a.name.localeCompare(b.name))) {
        const id = file.name.replace(/\.json$/i, '');
        if (completedRemote.has(id)) {
          const record = readLedger().records[id];
          if (!record || record.state !== 'published') {
            updateRecord(id, { state: 'published', resultPath: RESULT_DIR + '/' + id + '.json' });
          }
          continue;
        }
        const tracked = readLedger().records[id];
        if (tracked && ['running', 'pending_publish', 'published'].includes(tracked.state)) continue;
        return await processRequest(repository, branch, file);
      }
      return emitStatus('idle', 'Repository bridge is connected and waiting for a request.', { repository, branch });
    } catch (error) {
      return emitStatus('error', 'Repository bridge could not check GitHub.', { error: String(error && error.message || error) });
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    emitStatus('starting', 'Starting repository bridge poller.');
    pollOnce().catch(() => {});
    timer = setInterval(() => { pollOnce().catch(() => {}); }, Math.max(1000, Number(pollIntervalMs) || POLL_INTERVAL_MS));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    emitStatus('stopped', 'Repository bridge is stopped.');
  }

  return { start, stop, pollOnce, getStatus };
}

module.exports = {
  BRIDGE_DIR,
  REQUEST_DIR,
  RESULT_DIR,
  normalizeGitHubRemote: (remote) => {
    let value = String(remote || '').trim();
    value = value.replace(/^git@github\.com:/i, '').replace(/^ssh:\/\/git@github\.com\//i, '');
    value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/^git:\/\/github\.com\//i, '');
    value = value.replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return match ? (match[1] + '/' + match[2]).toLowerCase() : null;
  },
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  createRepositoryBridge
};
