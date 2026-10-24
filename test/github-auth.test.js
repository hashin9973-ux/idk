'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function fixture(fetchImpl, execFileAsyncImpl) {
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
    fetchImpl,
    execFileAsyncImpl
  });
  return { auth, settings };
}

function loginServer(token = 'gho-test-token') {
  return async url => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) {
      return response({ device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (target.endsWith('/login/oauth/access_token')) return response({ access_token: token });
    if (target.endsWith('/user')) return response({ login: 'example-user' });
    throw new Error('Unexpected test URL: ' + target);
  };
}

async function connect(auth) {
  auth.setClientId('Iv1.example-client-id');
  await auth.startLogin();
  return auth.pollLogin();
}

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-assistant-git-auth-'));
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
    throw new Error('Unexpected test URL: ' + target);
  };
  const { auth, settings } = fixture(mockFetch);
  await assert.rejects(auth.startLogin(), /client ID/i);
  auth.setClientId('Iv1.example-client-id');
  const flow = await auth.startLogin();
  assert.equal(flow.userCode, 'ABCD-EFGH');
  assert.equal(flow.verificationUrl, 'https://github.com/login/device');
  assert.equal((await auth.pollLogin()).status, 'pending');
  assert.deepEqual(await auth.pollLogin(), { status: 'authenticated', login: 'example-user' });
  assert.equal(settings.github.encryptedToken.includes('gho-not-a-real-token'), false);
  assert.equal(settings.github.encryptedToken.startsWith('ZW5jcnlwdGVk'), true);
  const state = await auth.getState();
  assert.equal(state.authenticated, true);
  assert.equal(state.login, 'example-user');
  assert.ok(calls.some(c => c.url.endsWith('/login/device/code')));
  assert.ok(calls.some(c => c.url.endsWith('/login/oauth/access_token')));
});

test('authenticated fetch normalizes SSH remotes to HTTPS without changing the saved remote', async () => {
  const calls = [];
  const workspace = tempWorkspace();
  fs.mkdirSync(path.join(workspace, '.git'));
  const mockExec = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (args[0] === 'remote' && args[1] === 'get-url') return { stdout: 'git@github.com:example/private-repo.git\n', stderr: '' };
    if (args[0] === 'fetch') {
      const hooksPath = options.env.GIT_CONFIG_VALUE_2;
      assert.ok(fs.existsSync(hooksPath));
      assert.deepEqual(fs.readdirSync(hooksPath), []);
      return { stdout: 'Fetched from GitHub\n', stderr: '' };
    }
    throw new Error('Unexpected Git command: ' + args.join(' '));
  };
  try {
    const { auth } = fixture(loginServer('gho-secret-token'), mockExec);
    assert.deepEqual(await connect(auth), { status: 'authenticated', login: 'example-user' });
    const result = await auth.runGitOperation({ operation: 'fetch', cwd: workspace, remote: 'origin' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.operation, 'fetch');
    assert.equal(result.repository, 'example/private-repo');
    assert.match(result.stdout, /Fetched from GitHub/);
    const netCall = calls.find(call => call.args[0] === 'fetch');
    assert.ok(netCall);
    assert.deepEqual(netCall.args, ['fetch', '--prune', 'https://github.com/example/private-repo.git', '+refs/heads/*:refs/remotes/origin/*']);
    assert.equal(netCall.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(netCall.options.env.GIT_CONFIG_COUNT, '3');
    assert.equal(netCall.options.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(netCall.options.env.GIT_CONFIG_KEY_2, 'core.hooksPath');
    assert.match(netCall.options.env.GIT_CONFIG_VALUE_2, /chatgpt-assistant-git-hooks-/);
    assert.equal(fs.existsSync(netCall.options.env.GIT_CONFIG_VALUE_2), false, 'temporary hook directory is removed after Git exits');
    assert.equal(netCall.options.env.GIT_CONFIG_VALUE_0,
      'AUTHORIZATION: basic ' + Buffer.from('x-access-token:gho-secret-token').toString('base64'));
    assert.equal(JSON.stringify(result).includes('gho-secret-token'), false);
    assert.equal(netCall.args.join(' ').includes('gho-secret-token'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('authenticated pull is fast-forward-only and refuses a different local branch', async () => {
  const workspace = tempWorkspace();
  const calls = [];
  const mockExec = async (file, args, options) => {
    calls.push({ args: [...args], options });
    if (args[0] === 'remote') return { stdout: 'https://github.com/example/project.git\n', stderr: '' };
    if (args[0] === 'branch') return { stdout: 'main\n', stderr: '' };
    if (args[0] === 'pull') return { stdout: 'Already up to date.\n', stderr: '' };
    throw new Error('Unexpected Git command: ' + args.join(' '));
  };
  fs.mkdirSync(path.join(workspace, '.git'));
  try {
    const { auth } = fixture(loginServer(), mockExec);
    await connect(auth);
    const result = await auth.runGitOperation({ operation: 'pull', cwd: workspace, remote: 'origin' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.at(-1).args, ['pull', '--ff-only', 'https://github.com/example/project.git', 'main']);
    await assert.rejects(auth.runGitOperation({
      operation: 'pull', cwd: workspace, remote: 'origin', branch: 'develop'
    }), /only updates the currently checked-out branch/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('authenticated push never forces and targets the intended branch explicitly', async () => {
  const workspace = tempWorkspace();
  const calls = [];
  const mockExec = async (file, args, options) => {
    calls.push({ args: [...args], options });
    if (args[0] === 'remote') return { stdout: 'https://github.com/example/project.git\n', stderr: '' };
    if (args[0] === 'branch') return { stdout: 'feature/example\n', stderr: '' };
    if (args[0] === 'push') return { stdout: 'To https://github.com/example/project.git\n', stderr: '' };
    throw new Error('Unexpected Git command: ' + args.join(' '));
  };
  fs.mkdirSync(path.join(workspace, '.git'));
  try {
    const { auth } = fixture(loginServer(), mockExec);
    await connect(auth);
    const result = await auth.runGitOperation({ operation: 'push', cwd: workspace, remote: 'origin' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.at(-1).args, ['push', 'https://github.com/example/project.git', 'HEAD:refs/heads/feature/example']);
    assert.equal(calls.at(-1).args.includes('--force'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('clone validates destination and uses the app credential in process configuration only', async () => {
  const workspace = tempWorkspace();
  const calls = [];
  const mockExec = async (file, args, options) => {
    calls.push({ args: [...args], options });
    return { stdout: 'Cloning into project…\n', stderr: '' };
  };
  try {
    const { auth } = fixture(loginServer('gho-clone-token'), mockExec);
    await connect(auth);
    const result = await auth.runGitOperation({
      operation: 'clone',
      cwd: workspace,
      repository: 'example/private-repo',
      destination: path.join(workspace, 'project'),
      branch: 'main'
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.path, 'project');
    assert.deepEqual(calls[0].args, [
      'clone', '--branch', 'main', '--',
      'https://github.com/example/private-repo.git',
      path.join(workspace, 'project')
    ]);
    assert.equal(calls[0].args.join(' ').includes('gho-clone-token'), false);
    assert.equal(JSON.stringify(result).includes('gho-clone-token'), false);
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
    await assert.rejects(auth.runGitOperation({
      operation: 'clone',
      cwd: workspace,
      repository: 'example/private-repo',
      destination: path.resolve(workspace, '..', 'outside')
    }), /inside the selected workspace/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('authenticated Git operations reject non-GitHub remotes and missing credentials', async () => {
  const workspace = tempWorkspace();
  const calls = [];
  const mockExec = async (file, args, options) => {
    calls.push([...args]);
    if (args[0] === 'remote') return { stdout: 'https://evil.example/private/repo.git\n', stderr: '' };
    throw new Error('The network operation should not run.');
  };
  fs.mkdirSync(path.join(workspace, '.git'));
  try {
    const { auth } = fixture(loginServer(), mockExec);
    await connect(auth);
    await assert.rejects(auth.runGitOperation({ operation: 'fetch', cwd: workspace }), /restricted to credential-free GitHub remotes/i);
    assert.equal(calls.some(args => args[0] === 'fetch' || args[0] === 'pull' || args[0] === 'push'), false);
    auth.logout();
    await assert.rejects(auth.runGitOperation({ operation: 'fetch', cwd: workspace }), /Sign in with GitHub/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('GitHub logout removes the encrypted credential', async () => {
  const mockFetch = loginServer('gho-test');
  const { auth, settings } = fixture(mockFetch);
  await connect(auth);
  assert.equal(Boolean(settings.github.encryptedToken), true);
  auth.logout();
  assert.equal(settings.github.encryptedToken, undefined);
  assert.equal((await auth.getState()).authenticated, false);
});
