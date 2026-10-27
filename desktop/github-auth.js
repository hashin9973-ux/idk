'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{10,100}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MAILBOX_CONTENT_BYTES = 12 * 1024 * 1024;

function cleanError(value) {
  return String(value || 'GitHub request failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function createGitHubAuth({ safeStorage, getSettings, persistSettings, fetchImpl = globalThis.fetch, execFileAsyncImpl = promisify(execFile) }) {
  let pendingDevice = null;

  function githubSettings() {
    const settings = getSettings();
    if (!settings.github || typeof settings.github !== 'object') settings.github = {};
    return settings.github;
  }

  function getToken() {
    const entry = githubSettings();
    if (typeof entry.encryptedToken !== 'string' || !entry.encryptedToken) return null;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure credential storage is unavailable. No GitHub token was read.');
    }
    try {
      return safeStorage.decryptString(Buffer.from(entry.encryptedToken, 'base64'));
    } catch {
      throw new Error('The saved GitHub token could not be decrypted. Sign in again.');
    }
  }

  function hasSavedToken() {
    try { return Boolean(getToken()); } catch { return false; }
  }

  function saveToken(token) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure credential storage is unavailable. GitHub login was not saved.');
    }
    const entry = githubSettings();
    entry.encryptedToken = safeStorage.encryptString(token).toString('base64');
    persistSettings();
  }

  function setClientId(raw) {
    const clientId = String(raw || '').trim();
    if (!OAUTH_CLIENT_ID_PATTERN.test(clientId)) {
      throw new Error('Enter a valid GitHub OAuth App client ID (10–100 letters, numbers, dots, underscores, or hyphens).');
    }
    const entry = githubSettings();
    if (entry.clientId !== clientId) {
      delete entry.encryptedToken;
      pendingDevice = null;
    }
    entry.clientId = clientId;
    persistSettings();
    return { configured: true, clientId };
  }

  async function readJson(response) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('GitHub response exceeded the 1 MiB limit.');
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { throw new Error('GitHub returned an unexpected non-JSON response.'); }
    if (!response.ok) {
      const message = cleanError(value.message || value.error_description || value.error || response.statusText);
      throw new Error('GitHub HTTP ' + response.status + ': ' + message);
    }
    return value;
  }

  function validateMailboxRequest(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Repository API request must be an object.');
    }
    const method = String(input.method || 'GET').toUpperCase();
    const pathValue = input.path;
    if (!['GET', 'PUT', 'POST', 'PATCH'].includes(method)) throw new Error('The repository bridge only permits GitHub GET and PUT for mailbox contents, plus narrowly scoped retention-cleanup Git-data operations.');
    if (typeof pathValue !== 'string' || !pathValue.startsWith('/') || pathValue.includes('\\') ||
        pathValue.includes('%') || pathValue.includes('?') || pathValue.includes('#')) {
      throw new Error('Invalid GitHub repository API path.');
    }
    const rootSettings = getSettings() || {};
    const bridge = rootSettings.repositoryBridge || {};
    const owner = String(bridge.owner || '').trim();
    const repository = String(bridge.repo || '').trim();
    const branch = validateBranch(bridge.branch || 'bridge-mailbox');
    const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;
    if (!namePattern.test(owner) || owner === '.' || owner === '..' ||
        !namePattern.test(repository) || repository === '.' || repository === '..') {
      throw new Error('Configure a valid shared GitHub repository before using the mailbox API.');
    }
    const base = '/repos/' + owner + '/' + repository;
    const allowedFolders = new Set(['bridge/requests', 'bridge/results', 'bridge/claims', 'bridge/state', 'bridge/context', 'bridge/artifacts', 'bridge/vision', 'bridge/vision/requests', 'bridge/vision/results', 'bridge/vision/reports', 'bridge/vision/claims']);
    let relative = '';
    let kind = '';

    if (pathValue === base) {
      if (method !== 'GET' || input.body !== undefined || input.query !== undefined) {
        throw new Error('Only repository metadata GET is allowed at this endpoint.');
      }
      return { method, path: base, query: undefined, body: undefined, url: 'https://api.github.com' + base };
    }

    const treePrefix = base + '/git/trees/';
    if (pathValue.startsWith(treePrefix)) {
      const treeRef = pathValue.slice(treePrefix.length);
      if (method !== 'GET' || input.body !== undefined || input.query !== undefined ||
          (treeRef !== branch && !/^[a-f0-9]{40}$/i.test(treeRef))) {
        throw new Error('Git tree reads must use the configured branch or a valid tree SHA without extra query parameters.');
      }
      return { method, path: pathValue, query: undefined, body: undefined, url: 'https://api.github.com' + pathValue };
    }

    if (pathValue === base + '/commits') {
      const query = input.query;
      const keys = query && typeof query === 'object' && !Array.isArray(query) ? Object.keys(query).sort() : [];
      if (method !== 'GET' || input.body !== undefined ||
          keys.join(',') !== 'path,per_page,sha' ||
          query.sha !== branch || query.path !== 'bridge/requests' ||
          query.per_page !== 1) {
        throw new Error('Commit polling is limited to the latest commit touching bridge/requests on the configured branch.');
      }
      return {
        method, path: pathValue, query: undefined, body: undefined,
        url: 'https://api.github.com' + pathValue +
          '?sha=' + encodeURIComponent(branch) + '&path=bridge%2Frequests&per_page=1'
      };
    }

    const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
    const cleanupMessage = '[local bridge] retention cleanup of completed mailbox records';
    const validCleanupPath = value => {
      if (typeof value !== 'string') return false;
      const parts = value.split('/');
      if (parts.some(part => !part || part === '.' || part === '..')) return false;
      const requestName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/;
      if (parts.length === 3 && ['requests', 'results', 'claims'].includes(parts[1]) &&
          parts[0] === 'bridge' && requestName.test(parts[2])) return true;
      if (parts.length === 3 && parts[0] === 'bridge' && parts[1] === 'artifacts' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}-batch-output-\d{3}\.json$/.test(parts[2])) return true;
      if (parts.length === 4 && parts[0] === 'bridge' && parts[1] === 'artifacts' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(parts[2]) &&
          /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(parts[3])) return true;
      return false;
    };
    const gitRefReadPath = base + '/git/ref/heads/' + branch;
    if (pathValue === gitRefReadPath) {
      if (method !== 'GET' || input.body !== undefined || input.query !== undefined) {
        throw new Error('Retention cleanup may only read the configured mailbox branch reference.');
      }
      return { method, path: pathValue, query: undefined, body: undefined, url: 'https://api.github.com' + pathValue };
    }
    const gitCommitPrefix = base + '/git/commits/';
    if (pathValue.startsWith(gitCommitPrefix)) {
      const sha = pathValue.slice(gitCommitPrefix.length);
      if (method !== 'GET' || !validSha(sha) || input.body !== undefined || input.query !== undefined) {
        throw new Error('Retention cleanup may only read a Git commit by its full SHA.');
      }
      return { method, path: pathValue, query: undefined, body: undefined, url: 'https://api.github.com' + pathValue };
    }
    if (pathValue === base + '/git/trees') {
      const body = input.body;
      if (method !== 'POST' || input.query !== undefined || !body || typeof body !== 'object' ||
          Array.isArray(body) || Object.keys(body).sort().join(',') !== 'base_tree,tree' ||
          !validSha(body.base_tree) || !Array.isArray(body.tree) || body.tree.length < 1 || body.tree.length > 1000 ||
          body.tree.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
            Object.keys(entry).sort().join(',') !== 'mode,path,sha,type' ||
            entry.mode !== '100644' || entry.type !== 'blob' || entry.sha !== null ||
            !validCleanupPath(entry.path))) {
        throw new Error('Git tree writes are limited to bounded deletions of eligible mailbox request/result/claim/artifact files.');
      }
      return { method, path: pathValue, query: undefined, body, url: 'https://api.github.com' + pathValue };
    }
    if (pathValue === base + '/git/commits') {
      const body = input.body;
      if (method !== 'POST' || input.query !== undefined || !body || typeof body !== 'object' ||
          Array.isArray(body) || Object.keys(body).sort().join(',') !== 'message,parents,tree' ||
          body.message !== cleanupMessage || !validSha(body.tree) || !Array.isArray(body.parents) ||
          body.parents.length !== 1 || !validSha(body.parents[0])) {
        throw new Error('Git commits are limited to a single-parent mailbox retention-cleanup commit.');
      }
      return { method, path: pathValue, query: undefined, body, url: 'https://api.github.com' + pathValue };
    }
    const gitRefUpdatePath = base + '/git/refs/heads/' + branch;
    if (pathValue === gitRefUpdatePath) {
      const body = input.body;
      if (method !== 'PATCH' || input.query !== undefined || !body || typeof body !== 'object' ||
          Array.isArray(body) || Object.keys(body).sort().join(',') !== 'force,sha' ||
          body.force !== false || !validSha(body.sha)) {
        throw new Error('Mailbox cleanup may only advance the configured branch reference without force.');
      }
      return { method, path: pathValue, query: undefined, body, url: 'https://api.github.com' + pathValue };
    }

    const prefix = base + '/contents/';
    if (!pathValue.startsWith(prefix)) throw new Error('GitHub route is outside the configured repository mailbox.');
    relative = pathValue.slice(prefix.length);
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) {
      throw new Error('Invalid repository mailbox path segment.');
    }
    if (relative === 'bridge/README.md') {
      kind = 'documentation';
    } else if (allowedFolders.has(relative)) {
      kind = 'directory';
    } else if (parts.length === 3 && parts[0] === 'bridge' && parts[1] === 'vision' &&
        ['control.json', 'runtime.json'].includes(parts[2])) {
      kind = parts[2] === 'control.json' ? 'vision-control' : 'vision-runtime';
    } else if (parts.length === 3 && allowedFolders.has(parts.slice(0, 2).join('/')) &&
        (parts[2] === '.gitkeep' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(parts[2]))) {
      kind = 'file';
    } else if (parts.length === 4 && parts[0] === 'bridge' && parts[1] === 'vision' &&
        ['requests', 'results', 'reports', 'claims'].includes(parts[2]) &&
        /^vision-[a-f0-9]{24}\.(json|txt)$/.test(parts[3]) &&
        (parts[2] === 'reports' ? parts[3].endsWith('.txt') : parts[3].endsWith('.json'))) {
      kind = parts[2] === 'reports' ? 'vision-report' : 'vision-record';
    } else if (parts.length === 3 && parts[0] === 'bridge' && parts[1] === 'artifacts' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}-batch-output-\d{3}\.json$/.test(parts[2])) {
      kind = 'legacy-artifact';
    } else if (parts.length === 4 && parts[0] === 'bridge' && parts[1] === 'artifacts' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(parts[2]) &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(parts[3])) {
      kind = 'artifact';
    } else if (relative === 'bridge/state/windows-app.json') {
      kind = 'state';
    } else {
      throw new Error('Path is outside the supported repository mailbox folders.');
    }

    if (method === 'GET') {
      if (input.body !== undefined) throw new Error('GET requests cannot include a body.');
      if (!input.query || typeof input.query !== 'object' || Array.isArray(input.query) ||
          Object.keys(input.query).length !== 1 || input.query.ref !== branch) {
        throw new Error('Mailbox reads must target the configured branch only.');
      }
      return {
        method, path: pathValue, query: { ref: branch }, body: undefined,
        url: 'https://api.github.com' + pathValue + '?ref=' + encodeURIComponent(branch)
      };
    }

    if (!['file', 'state', 'artifact', 'vision-control', 'vision-runtime', 'vision-record', 'vision-report'].includes(kind)) throw new Error('PUT is only permitted for mailbox file records, vision state/job paths and approved artifact paths.');
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) throw new Error('Mailbox writes require a JSON body.');
    const allowedBodyKeys = ['message', 'content', 'branch', 'sha'];
    if (Object.keys(input.body).some(key => !allowedBodyKeys.includes(key)) ||
        typeof input.body.message !== 'string' || input.body.message.length > 200 ||
        typeof input.body.content !== 'string' || input.body.content.length > MAX_MAILBOX_CONTENT_BYTES ||
        input.body.branch !== branch ||
        (input.body.sha !== undefined && (typeof input.body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(input.body.sha)))) {
      throw new Error('Invalid or unsupported mailbox write payload.');
    }
    if (kind === 'artifact' || kind === 'vision-report') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.body.content)) throw new Error('Artifact/report content must be Base64-encoded bytes.');
      return { method, path: pathValue, body: input.body, url: 'https://api.github.com' + pathValue };
    }
    let payload;
    try {
      const decoded = Buffer.from(input.body.content, 'base64').toString('utf8');
      payload = JSON.parse(decoded);
    } catch {
      throw new Error('Mailbox write content must be Base64-encoded JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Mailbox file content must be a JSON object.');
    if (kind === 'vision-control' && payload.protocol !== 'chatgpt-colab-vision-control/v1') throw new Error('Vision control must use chatgpt-colab-vision-control/v1.');
    if (kind === 'vision-runtime' && payload.protocol !== 'chatgpt-colab-vision-runtime/v1') throw new Error('Vision runtime state must use chatgpt-colab-vision-runtime/v1.');
    if (kind === 'vision-record') {
      const expectedProtocol = parts[2] === 'requests' ? 'chatgpt-colab-vision-request/v1'
        : parts[2] === 'results' ? 'chatgpt-colab-vision-result/v1'
          : parts[2] === 'claims' ? 'chatgpt-colab-vision-claim/v1' : null;
      if (!expectedProtocol || payload.protocol !== expectedProtocol) throw new Error('Vision job records must use the protocol designated for their mailbox folder.');
      if (payload.request_id && payload.request_id !== parts[3].replace(/\.json$/, '')) throw new Error('Vision record request ID must match its filename.');
    }
    const isFolderMarker = parts.length === 3 && parts[2] === '.gitkeep';
    if (relative.startsWith('bridge/requests/') && !isFolderMarker) {
      throw new Error('The Windows worker cannot create or overwrite ChatGPT request files.');
    }
    if (!isFolderMarker && relative.startsWith('bridge/results/') && payload.protocol !== 'chatgpt-local-repo-result/v1') {
      throw new Error('Result files must use the supported result protocol.');
    }
    if (!isFolderMarker && relative.startsWith('bridge/claims/') && payload.protocol !== 'chatgpt-local-repo-claim/v1') {
      throw new Error('Claim files must use the supported claim protocol.');
    }
    if (!isFolderMarker && relative.startsWith('bridge/context/') && payload.protocol !== 'chatgpt-local-environment-context/v1') {
      throw new Error('Environment context files must use the supported context protocol.');
    }
    if (relative === 'bridge/state/windows-app.json' && payload.protocol !== 'chatgpt-local-repo-state/v1') {
      throw new Error('Shared state files must use the supported state protocol.');
    }
    const body = {
      message: input.body.message,
      content: input.body.content,
      branch,
      ...(input.body.sha ? { sha: input.body.sha } : {})
    };
    return { method, path: pathValue, body, query: undefined, url: 'https://api.github.com' + pathValue };
  }

  async function requestApi(input = {}) {
    const route = validateMailboxRequest(input);
    const token = getToken();
    if (!token) throw new Error("Sign in with GitHub in the app's GitHub access section before using the repository mailbox.");
    const response = await fetchImpl(route.url, {
      method: route.method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(route.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    return { status: response.status, result: await readJson(response) };
  }

  async function getState() {
    const settings = githubSettings();
    const state = {
      configured: typeof settings.clientId === 'string' && OAUTH_CLIENT_ID_PATTERN.test(settings.clientId),
      clientId: typeof settings.clientId === 'string' ? settings.clientId : '',
      authenticated: false,
      login: '',
    };
    const token = getToken();
    if (!token) return state;
    try {
      const response = await fetchImpl('https://api.github.com/user', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(12000)
      });
      const profile = await readJson(response);
      state.authenticated = true;
      state.login = typeof profile.login === 'string' ? profile.login : '';
      return state;
    } catch (error) {
      state.authenticated = false;
      state.error = cleanError(error.message);
      return state;
    }
  }

  async function startLogin() {
    const settings = githubSettings();
    const clientId = settings.clientId;
    if (!clientId || !OAUTH_CLIENT_ID_PATTERN.test(clientId)) throw new Error('Configure your GitHub OAuth App client ID first.');
    const form = new URLSearchParams({ client_id: clientId, scope: 'repo read:user' });
    const response = await fetchImpl('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    const data = await readJson(response);
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      throw new Error(cleanError(data.error_description || data.error || 'GitHub Device Flow is not enabled for this OAuth App.'));
    }
    const interval = Math.max(5, Number(data.interval) || 5);
    pendingDevice = {
      deviceCode: data.device_code,
      interval,
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 900) * 1000,
      slowDownUntil: 0
    };
    return {
      userCode: String(data.user_code),
      verificationUrl: 'https://github.com/login/device',
      verificationUrlComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : '',
      intervalSeconds: interval,
      expiresInSeconds: Math.max(60, Number(data.expires_in) || 900)
    };
  }

  async function pollLogin() {
    if (!pendingDevice) throw new Error('No GitHub login is waiting for authorization. Start login again.');
    if (Date.now() >= pendingDevice.expiresAt) {
      pendingDevice = null;
      return { status: 'expired', message: 'The GitHub device code expired. Start login again.' };
    }
    if (Date.now() < pendingDevice.slowDownUntil) return { status: 'pending', intervalSeconds: pendingDevice.interval };
    const clientId = githubSettings().clientId;
    const form = new URLSearchParams({
      client_id: clientId,
      device_code: pendingDevice.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    });
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    const data = await readJson(response);
    if (data.error === 'authorization_pending') return { status: 'pending', intervalSeconds: pendingDevice.interval };
    if (data.error === 'slow_down') {
      pendingDevice.interval += 5;
      pendingDevice.slowDownUntil = Date.now() + pendingDevice.interval * 1000;
      return { status: 'pending', intervalSeconds: pendingDevice.interval };
    }
    if (data.error === 'expired_token') {
      pendingDevice = null;
      return { status: 'expired', message: 'The GitHub device code expired. Start login again.' };
    }
    if (data.error === 'access_denied') {
      pendingDevice = null;
      return { status: 'denied', message: 'GitHub authorization was denied.' };
    }
    if (!data.access_token) {
      if (data.error) throw new Error(cleanError(data.error_description || data.error));
      throw new Error('GitHub did not return an access token.');
    }
    saveToken(data.access_token);
    pendingDevice = null;
    const state = await getState();
    if (!state.authenticated) throw new Error('Token was received but could not be validated with GitHub: ' + (state.error || 'unknown error'));
    return { status: 'authenticated', login: state.login };
  }

  async function importToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (token.length < 20 || token.length > 8192 || /\s/.test(token)) {
      throw new Error('GitHub did not return a valid access token.');
    }
    const response = await fetchImpl('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(12000)
    });
    const profile = await readJson(response);
    if (typeof profile.login !== 'string' || !profile.login) {
      throw new Error('GitHub token validation did not return an account name.');
    }
    saveToken(token);
    return { authenticated: true, login: profile.login };
  }

  function logout() {
    const entry = githubSettings();
    delete entry.encryptedToken;
    pendingDevice = null;
    persistSettings();
    return { authenticated: false, loggedOut: true };
  }

  function validateRepository(value) {
    if (typeof value !== 'string') throw new Error('repository must be owner/repository.');
    const repository = value.trim().replace(/\.git$/i, '');
    const parts = repository.split('/');
    const partPattern = /^[A-Za-z0-9_.-]{1,100}$/;
    if (parts.length !== 2 || parts.some(part => !partPattern.test(part) || part === '.' || part === '..')) {
      throw new Error('repository must be a valid GitHub owner/repository name.');
    }
    return parts[0] + '/' + parts[1];
  }

  function validateBranch(value) {
    const branch = String(value || '').trim();
    const parts = branch.split('/');
    const forbidden = ['~', '^', ':', '?', '*', '[', ']', '\\'];
    if (!branch || branch.length > 200 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
        branch.includes('//') || branch.includes('..') || branch.includes('@{') ||
        /[\x00-\x20\x7f]/.test(branch) || forbidden.some(character => branch.includes(character)) ||
        parts.some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
      throw new Error('branch must be a valid Git branch name.');
    }
    return branch;
  }

  function validateRemoteName(value) {
    const remote = String(value || 'origin').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(remote)) {
      throw new Error('remote must be a simple Git remote name such as origin.');
    }
    return remote;
  }

  function normalizeGitHubRemote(raw) {
    const value = String(raw || '').trim();
    let repositoryPath = '';
    if (/^git@github\.com:/i.test(value)) {
      repositoryPath = value.replace(/^git@github\.com:/i, '');
    } else {
      let url;
      try { url = new URL(value); } catch { throw new Error('The selected Git remote is not a valid GitHub URL.'); }
      const credentialsAreValid = url.protocol === 'ssh:'
        ? url.username.toLowerCase() === 'git' && !url.password
        : !url.username && !url.password;
      if (url.hostname.toLowerCase() !== 'github.com' || !credentialsAreValid ||
          !['https:', 'ssh:', 'git:'].includes(url.protocol) || url.port || url.search || url.hash ||
          url.pathname.includes('//')) {
        throw new Error('Authenticated local Git operations are restricted to credential-free GitHub remotes.');
      }
      repositoryPath = url.pathname.replace(/^\/+/, '');
    }
    repositoryPath = repositoryPath.replace(/\/+$/, '').replace(/\.git$/i, '');
    const repository = validateRepository(repositoryPath);
    return {
      repository,
      url: 'https://github.com/' + repository + '.git'
    };
  }

  function redactOutput(value, token) {
    let text = String(value || '');
    if (token) {
      text = text.split(token).join('[REDACTED]');
      const encoded = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
      if (encoded) text = text.split(encoded).join('[REDACTED]');
    }
    return text.replace(/authorization:\s*basic\s+\S+/ig, 'Authorization: [REDACTED]')
      .slice(0, MAX_RESPONSE_BYTES);
  }

  async function runGitOperation(input = {}) {
    const operation = String(input.operation || '');
    if (!['fetch', 'pull', 'push', 'clone'].includes(operation)) {
      throw new Error('Git operation must be fetch, pull, push, or clone.');
    }
    const token = getToken();
    if (!token) throw new Error("Sign in with GitHub in the app's GitHub access section before using authenticated Git operations.");

    const cwd = path.resolve(String(input.cwd || ''));
    if (!input.cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error('The selected local workspace is unavailable.');
    }
    const timeoutMs = Number.isInteger(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1000), 180000) : 120000;
    async function executeGit(args, commandCwd = cwd) {
      // Git hooks inherit a process environment. Use a fresh, empty hooks directory
      // for each authenticated command so repository-configured hooks cannot read
      // the temporary HTTP authorization header from their parent environment.
      const emptyHooksPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-assistant-git-hooks-'));
      const authEnvironment = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token, 'utf8').toString('base64'),
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '',
        GIT_CONFIG_KEY_2: 'core.hooksPath',
        GIT_CONFIG_VALUE_2: emptyHooksPath
      };
      try {
        try {
          const result = await execFileAsyncImpl('git', args, {
            cwd: commandCwd,
            env: authEnvironment,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 2 * MAX_RESPONSE_BYTES,
            windowsHide: true,
            shell: false
          });
          return {
            exitCode: 0,
            stdout: redactOutput(result.stdout, token),
            stderr: redactOutput(result.stderr, token),
            timedOut: false
          };
        } catch (error) {
          if (error && error.code === 'ENOENT') throw new Error('Git for Windows was not found on PATH.');
          const timedOut = Boolean(error && (error.killed || error.code === 'ETIMEDOUT'));
          return {
            exitCode: timedOut ? 124 : (Number.isInteger(error && error.code) ? error.code : 1),
            stdout: redactOutput(error && error.stdout, token),
            stderr: redactOutput(error && error.stderr, token),
            timedOut
          };
        }
      } finally {
        try { fs.rmSync(emptyHooksPath, { recursive: true, force: true }); } catch {}
      }
    }

    if (operation === 'clone') {
      const repository = validateRepository(input.repository);
      const destination = path.resolve(String(input.destination || ''));
      if (!input.destination || destination === cwd) {
        throw new Error('clone requires a new relative destination inside the selected workspace.');
      }
      const relative = path.relative(cwd, destination);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('clone destination must stay inside the selected workspace.');
      }
      const parent = path.dirname(destination);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        throw new Error('clone destination parent must already exist inside the workspace.');
      }
      if (fs.existsSync(destination)) {
        const stat = fs.lstatSync(destination);
        if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(destination).length) {
          throw new Error('clone destination must not exist or must be an empty, non-symlink directory.');
        }
      }
      const args = ['clone'];
      if (input.branch !== undefined && input.branch !== null && String(input.branch).trim()) {
        args.push('--branch', validateBranch(input.branch));
      }
      args.push('--', 'https://github.com/' + repository + '.git', destination);
      const result = await executeGit(args, parent);
      return {
        operation,
        repository,
        path: relative.split(path.sep).join('/'),
        cwd,
        ...result
      };
    }

    if (!fs.existsSync(path.join(cwd, '.git'))) {
      throw new Error('The selected workspace is not a Git checkout.');
    }
    const remote = validateRemoteName(input.remote || 'origin');
    const remoteResult = await executeGit(['remote', 'get-url', remote]);
    if (remoteResult.exitCode !== 0) throw new Error('The local Git checkout has no readable remote named "' + remote + '".');
    const normalized = normalizeGitHubRemote(remoteResult.stdout.trim());
    let branch = '';

    if (operation === 'pull' || operation === 'push') {
      const branchResult = await executeGit(['branch', '--show-current']);
      const currentBranch = branchResult.stdout.trim();
      if (branchResult.exitCode !== 0 || !currentBranch) {
        throw new Error(operation + ' requires a checked-out local branch; detached HEAD is not supported.');
      }
      branch = input.branch !== undefined && String(input.branch).trim()
        ? validateBranch(input.branch)
        : validateBranch(currentBranch);
      if (operation === 'pull' && branch !== currentBranch) {
        throw new Error('pull only updates the currently checked-out branch. Select "' + branch + '" first or omit the branch argument.');
      }
    }

    let args;
    if (operation === 'fetch') {
      args = ['fetch', '--prune', normalized.url, '+refs/heads/*:refs/remotes/' + remote + '/*'];
    } else if (operation === 'pull') {
      args = ['pull', '--ff-only', normalized.url, branch];
    } else {
      args = ['push', normalized.url, 'HEAD:refs/heads/' + branch];
    }
    const result = await executeGit(args);
    return {
      operation,
      repository: normalized.repository,
      remote,
      ...(branch ? { branch } : {}),
      cwd,
      ...result
    };
  }

  return { getState, setClientId, startLogin, pollLogin, logout, hasSavedToken, importToken, runGitOperation, requestApi };
}

module.exports = { createGitHubAuth, OAUTH_CLIENT_ID_PATTERN };
