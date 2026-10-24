const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepositoryBridge, REQUEST_DIR, RESULT_DIR } = require('../desktop/repository-bridge');
const { REQUEST_PROTOCOL, RESULT_PROTOCOL } = require('../desktop/repository-protocol');

const REPOSITORY = 'example/project';
const BRANCH = 'main';

function makeRequest(callId, tool = 'project_status', args = {}) {
  return JSON.stringify({
    protocol: REQUEST_PROTOCOL,
    call_id: callId,
    tool,
    args,
    created_at: '2026-10-24T00:00:00.000Z'
  });
}

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-bridge-test-'));
  const files = new Map();
  if (options.request) files.set(REQUEST_DIR + '/' + (options.callId || 'call-001') + '.json', options.request);
  const apiCalls = [];
  const executions = [];
  const notifications = [];
  let failNextPut = false;
  const githubAuth = {
    hasSavedToken: () => options.authenticated !== false,
    getBridgeConfig: () => ({
      repository: options.repository === undefined ? REPOSITORY : options.repository,
      branch: options.branch === undefined ? BRANCH : options.branch,
      allowPublicRepository: options.allowPublicRepository === true
    }),
    requestApi: async args => {
      apiCalls.push({ ...args });
      const method = String(args.method || 'GET').toUpperCase();
      const prefix = '/repos/' + REPOSITORY + '/';
      if (method === 'GET' && args.path === '/repos/' + REPOSITORY) {
        return { result: { full_name: REPOSITORY, private: options.privateRepository !== false } };
      }
      if (method === 'GET' && args.path === prefix + 'contents/' + REQUEST_DIR) {
        return { result: [...files.keys()].filter(p => p.startsWith(REQUEST_DIR + '/') && p.endsWith('.json'))
          .map(p => ({ type: 'file', name: path.posix.basename(p), path: p })) };
      }
      if (method === 'GET' && args.path === prefix + 'contents/' + RESULT_DIR) {
        return { result: [...files.keys()].filter(p => p.startsWith(RESULT_DIR + '/') && p.endsWith('.json'))
          .map(p => ({ type: 'file', name: path.posix.basename(p), path: p })) };
      }
      if (method === 'GET' && args.path.startsWith(prefix + 'contents/')) {
        const target = args.path.slice((prefix + 'contents/').length);
        if (!files.has(target)) throw new Error('Not Found');
        return { result: { encoding: 'base64', content: Buffer.from(files.get(target), 'utf8').toString('base64'), path: target } };
      }
      if (method === 'PUT' && args.path.startsWith(prefix + 'contents/')) {
        if (failNextPut) {
          failNextPut = false;
          throw new Error('Temporary GitHub write failure');
        }
        const target = args.path.slice((prefix + 'contents/').length);
        if (files.has(target)) throw new Error('File already exists (422)');
        files.set(target, Buffer.from(args.body.content, 'base64').toString('utf8'));
        return { result: { path: target } };
      }
      throw new Error('Unexpected GitHub API request: ' + method + ' ' + args.path);
    }
  };
  const bridge = createRepositoryBridge({
    githubAuth,
    dataDir,
    pollIntervalMs: 60_000,
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    executeRequest: async (request, context) => {
      executions.push({ request, context });
      if (options.executeRequest) return options.executeRequest(request, context);
      return { ok: true, result: { value: 'actual local result', exitCode: 0 } };
    },
    notifyResult: async record => {
      notifications.push(record);
      if (options.notifyResult) return options.notifyResult(record);
      return { ok: true, submitted: true };
    },
    onStatus: options.onStatus || (() => {})
  });
  return {
    bridge, files, apiCalls, executions, notifications, dataDir,
    failNextWrite: () => { failNextPut = true; },
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true })
  };
}

test('poller executes a queued request, commits the result, and notifies the active conversation', async () => {
  const f = fixture({ request: makeRequest('call-001'), callId: 'call-001' });
  try {
    const outcome = await f.bridge.pollOnce();
    assert.equal(outcome.processed, true);
    assert.equal(outcome.call_id, 'call-001');
    assert.equal(outcome.status, 'completed');
    assert.equal(f.executions.length, 1);
    assert.equal(f.executions[0].context.requireApproval, undefined);
    const resultPath = RESULT_DIR + '/call-001.json';
    assert.ok(f.files.has(resultPath));
    const result = JSON.parse(f.files.get(resultPath));
    assert.equal(result.protocol, RESULT_PROTOCOL);
    assert.equal(result.call_id, 'call-001');
    assert.equal(result.status, 'completed');
    assert.equal(result.result.result.exitCode, 0);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].resultPath, resultPath);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});

test('a published request is not executed a second time', async () => {
  const f = fixture({ request: makeRequest('call-002'), callId: 'call-002' });
  try {
    await f.bridge.pollOnce();
    await f.bridge.pollOnce();
    assert.equal(f.executions.length, 1);
    assert.equal(f.files.has(RESULT_DIR + '/call-002.json'), true);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});

test('public repositories are blocked unless explicitly enabled', async () => {
  const f = fixture({
    request: makeRequest('public-001'),
    callId: 'public-001',
    privateRepository: false,
    allowPublicRepository: false
  });
  try {
    const result = await f.bridge.pollOnce();
    assert.equal(result.state, 'error');
    assert.match(result.error, /repository is public/i);
    assert.equal(f.executions.length, 0);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});

test('missing GitHub login prevents polling local requests', async () => {
  const f = fixture({ request: makeRequest('auth-001'), callId: 'auth-001', authenticated: false });
  try {
    const result = await f.bridge.pollOnce();
    assert.equal(result.state, 'not_authenticated');
    assert.equal(f.executions.length, 0);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});

test('an interrupted running request becomes indeterminate instead of being re-executed', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dataDir, 'repository-bridge-ledger.json'), JSON.stringify({
      records: {
        'interrupted-001': {
          state: 'running',
          repository: REPOSITORY,
          branch: BRANCH,
          requestPath: REQUEST_DIR + '/interrupted-001.json'
        }
      }
    }));
    await f.bridge.pollOnce();
    assert.equal(f.executions.length, 0);
    const resultPath = RESULT_DIR + '/interrupted-001.json';
    assert.ok(f.files.has(resultPath));
    const result = JSON.parse(f.files.get(resultPath));
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.protocol, RESULT_PROTOCOL);
    assert.equal(f.notifications.length, 1);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});

test('a failed result publish is recoverable without rerunning the command', async () => {
  const f = fixture({ request: makeRequest('retry-001'), callId: 'retry-001' });
  try {
    f.failNextWrite();
    const first = await f.bridge.pollOnce();
    assert.equal(first.resultPending, true);
    assert.equal(f.executions.length, 1);
    await f.bridge.pollOnce();
    assert.equal(f.executions.length, 1);
    assert.ok(f.files.has(RESULT_DIR + '/retry-001.json'));
    assert.equal(f.notifications.length, 1);
  } finally {
    f.bridge.stop();
    f.cleanup();
  }
});
