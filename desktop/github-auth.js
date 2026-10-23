'use strict';

const OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{10,100}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BLOCKED_PATH_SEGMENTS = new Set([
  'secrets', 'dependabot', 'secret-scanning', 'code-scanning', 'billing',
  'audit-log', 'scim', 'public-keys', 'ssh-signing-keys', 'codespaces-secrets'
]);

function cleanError(value) {
  return String(value || 'GitHub request failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function createGitHubAuth({ safeStorage, getSettings, persistSettings, fetchImpl = globalThis.fetch }) {
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
      login: ''
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

  function validateApiPath(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > 500 || !raw.startsWith('/') ||
        raw.includes('://') || raw.includes('\\') || raw.includes('//') || raw.split('/').includes('..') ||
        /[\r\n?#]/.test(raw) || /%2f|%5c|%2e/i.test(raw)) {
      throw new Error('GitHub API path must be a relative API path beginning with / and must not contain traversal or query syntax.');
    }
    const allowed = /^\/(?:user(?:\/repos)?|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?|search\/(?:repositories|code|issues|commits)|rate_limit)(?:\/[A-Za-z0-9_.-]+)*$/;
    if (!allowed.test(raw)) throw new Error('This GitHub API path is not in the app allowlist.');
    const segments = raw.toLowerCase().split('/').filter(Boolean);
    if (segments.some(segment => BLOCKED_PATH_SEGMENTS.has(segment))) {
      throw new Error('This GitHub API path is blocked because it accesses sensitive security or account-management resources.');
    }
    return raw;
  }

  async function requestApi(args = {}) {
    const method = String(args.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('method must be GET, POST, PUT, PATCH, or DELETE.');
    const apiPath = validateApiPath(args.path);
    if (args.body !== undefined && (!args.body || typeof args.body !== 'object' || Array.isArray(args.body))) {
      throw new Error('body must be a JSON object.');
    }
    if (args.query !== undefined && (!args.query || typeof args.query !== 'object' || Array.isArray(args.query))) {
      throw new Error('query must be a JSON object.');
    }
    if (method === 'GET' && args.body !== undefined) throw new Error('GET requests must not include a body.');
    const token = getToken();
    if (!token) throw new Error('Sign in to GitHub from the app Accounts dialog before using github_api.');
    const url = new URL('https://api.github.com' + apiPath);
    if (args.query) {
      for (const [key, value] of Object.entries(args.query)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(key)) throw new Error('Invalid GitHub query parameter name.');
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }
    const options = {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(30000)
    };
    if (args.body !== undefined && method !== 'GET') {
      const body = JSON.stringify(args.body);
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('GitHub request body exceeds the 1 MiB limit.');
      options.headers['Content-Type'] = 'application/json';
      options.body = body;
    }
    const response = await fetchImpl(url, options);
    const data = await readJson(response);
    return {
      method,
      path: apiPath,
      status: response.status,
      rateLimitRemaining: response.headers?.get?.('x-ratelimit-remaining') || null,
      result: data
    };
  }

  return { getState, setClientId, startLogin, pollLogin, logout, requestApi };
}

module.exports = { createGitHubAuth, OAUTH_CLIENT_ID_PATTERN };
