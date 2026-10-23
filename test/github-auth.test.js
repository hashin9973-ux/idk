const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubAuth } = require('../desktop/github-auth');

function response(value, status = 200, headers = {}) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'HTTP ' + status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    text: async () => payload
  };
}

function fixture(fetchImpl) {
  const settings = {};
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('encrypted:' + value, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('encrypted:')) throw new Error('not encrypted');
      return text.slice('encrypted:'.length);
    }
  };
  const auth = createGitHubAuth({
    safeStorage,
    getSettings: () => settings,
    persistSettings: () => {},
    fetchImpl
  });
  return { auth, settings };
}

test('GitHub device flow stores credentials encrypted and validates the account', async () => {
  let tokenPolls = 0;
  const calls = [];
  const mockFetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET', headers: options.headers || {} });
    if (target.endsWith('/login/device/code')) {
      return response({ device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (target.endsWith('/login/oauth/access_token')) {
      tokenPolls++;
      return tokenPolls === 1 ? response({ error: 'authorization_pending' }) : response({ access_token: 'gho-not-a-real-token' });
    }
    if (target.endsWith('/user')) return response({ login: 'example-user' });
    if (target.endsWith('/repos/example-user/demo')) return response({ full_name: 'example-user/demo', private: false }, 200, { 'x-ratelimit-remaining': '4999' });
    throw new Error('Unexpected test URL: ' + target);
  };
  const { auth, settings } = fixture(mockFetch);
  await assert.rejects(auth.startLogin(), /client ID/i);
  auth.setClientId('Iv1.example-client-id');
  const flow = await auth.startLogin();
  assert.equal(flow.userCode, 'ABCD-EFGH');
  assert.equal(flow.verificationUrl, 'https://github.com/login/device');
  assert.equal((await auth.pollLogin()).status, 'pending');
  const done = await auth.pollLogin();
  assert.deepEqual(done, { status: 'authenticated', login: 'example-user' });
  assert.equal(settings.github.encryptedToken.includes('gho-not-a-real-token'), false);
  assert.equal(settings.github.encryptedToken.startsWith('ZW5jcnlwdGVk'), true);
  const state = await auth.getState();
  assert.equal(state.authenticated, true);
  assert.equal(state.login, 'example-user');
  const api = await auth.requestApi({ method: 'GET', path: '/repos/example-user/demo' });
  assert.equal(api.result.full_name, 'example-user/demo');
  assert.equal(api.rateLimitRemaining, '4999');
  assert.ok(calls.some(c => c.url.endsWith('/login/device/code')));
  assert.ok(calls.some(c => c.url.endsWith('/login/oauth/access_token')));
});

test('GitHub API paths reject host injection, traversal and sensitive secret routes', async () => {
  const mockFetch = async url => {
    if (String(url).endsWith('/user')) return response({ login: 'example-user' });
    return response({ ok: true });
  };
  const { auth } = fixture(mockFetch);
  auth.setClientId('Ov23li.example-client-id');
  // Populate an encrypted credential through a successful device login.
  const original = mockFetch;
  void original;
  await assert.rejects(auth.requestApi({ method: 'GET', path: 'https://evil.example/repos/x/y' }), /relative API path/i);
  await assert.rejects(auth.requestApi({ method: 'GET', path: '/repos/x/y/../z' }), /relative API path/i);
  await assert.rejects(auth.requestApi({ method: 'GET', path: '/repos/x/y/actions/secrets' }), /blocked/i);
  await assert.rejects(auth.requestApi({ method: 'GET', path: '/orgs/example' }), /allowlist/i);
});

test('GitHub logout removes the encrypted credential', async () => {
  let access = false;
  const mockFetch = async url => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) return response({ device_code: 'device', user_code: 'AAAA-BBBB', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (target.endsWith('/login/oauth/access_token')) return response({ access_token: 'gho-test' });
    if (target.endsWith('/user')) return response({ login: 'example-user' });
    throw new Error('Unexpected URL: ' + target);
  };
  const { auth, settings } = fixture(mockFetch);
  auth.setClientId('Iv1.example-client-id');
  await auth.startLogin();
  await auth.pollLogin();
  access = Boolean(settings.github.encryptedToken);
  assert.equal(access, true);
  auth.logout();
  assert.equal(settings.github.encryptedToken, undefined);
  assert.equal((await auth.getState()).authenticated, false);
});
