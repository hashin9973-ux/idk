'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{10,100}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
    if (!response.ok) throw new Error(cleanError(value.message || value.error_description || value.error || response.statusText));
    return value;
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
    if (!token) throw new Error('Sign in with GitHub in the app Accounts window before using authenticated Git operations.');

    const cwd = path.resolve(String(input.cwd || ''));
    if (!input.cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error('The selected local workspace is unavailable.');
    }
    const timeoutMs = Number.isInteger(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1000), 180000) : 120000;
    const authEnvironment = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token, 'utf8').toString('base64'),
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: ''
    };

    async function executeGit(args, commandCwd = cwd) {
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

  return { getState, setClientId, startLogin, pollLogin, logout, hasSavedToken, runGitOperation };
}

module.exports = { createGitHubAuth, OAUTH_CLIENT_ID_PATTERN };
