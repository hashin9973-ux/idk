'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROTOCOL,
  RESULT_PROTOCOL,
  DEFAULT_BRANCH,
  validateConfig,
  validateRequest,
  sanitizeForRepository,
  createRepositoryBridge
} = require('../desktop/repository-bridge');

function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8').toString('base64');
}

function decode(value) {
  return JSON.parse(Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8'));
}

function fakeGitHub({ privateRepo = true, initial = [] } = {}) {
  const files = new Map();
  let nextSha = 1;
  for (const [path, value] of initial) {
    files.set(path, { name: path.split('/').pop(), type: 'file', encoding: 'base64', content: encode(value), sha: 'sha-' + nextSha++ });
  }
  const calls = [];
  const githubAuth = {
    getState: async () => ({ authenticated: true, login: 'worker-test' }),
    requestApi: async ({ method, path, body, query }) => {
      calls.push({ method, path, body, query });
      if (method === 'GET' && path === '/repos/test-owner/test-repo') {
        return { status: 200, result: { private: privateRepo } };
      }
      const match = path.match(/^\/repos\/test-owner\/test-repo\/contents\/(.+)$/);
      if (!match) throw new Error('Unexpected API path: ' + path);
      const rel = match[1];
      if (method === 'GET') {
        const exact = files.get(rel);
        if (exact) {
          return { status: 200, result: { ...exact } };
        }
        const prefix = rel + '/';
        const children = new Map();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const child = key.slice(prefix.length).split('/')[0];
          const childPath = prefix + child;
          const isFile = files.has(childPath);
          children.set(child, {
            name: child,
            path: childPath,
            type: isFile ? 'file' : 'dir'
          });
        }
        if (children.size) return { status: 200, result: Array.from(children.values()) };
        throw new Error('Not Found (404)');
      }
      if (method === 'PUT') {
        const existing = files.get(rel);
        if (existing && !body.sha) throw new Error("Validation Failed: sha wasn't supplied");
        if (existing && body.sha !== existing.sha) throw new Error('sha does not match the current file');
        if (!existing && body.sha) throw new Error('Not Found (404)');
        const sha = 'sha-' + nextSha++;
        files.set(rel, {
          name: rel.split('/').pop(),
          path: rel,
          type: 'file',
          encoding: 'base64',
          content: body.content,
          sha
        });
        return { status: 201, result: { content: { sha } } };
      }
      throw new Error('Unexpected method: ' + method);
    }
  };
  return { githubAuth, files, calls };
}

function settingsFixture(allowPublicMailbox = false) {
  const settings = {
    repositoryBridge: {
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'bridge-mailbox',
      allowPublicMailbox
    }
  };
  return { settings, getSettings: () => settings, persistSettings: () => {} };
}

test('config validation rejects invalid owner, repository and branch input', () => {
  assert.deepEqual(validateConfig({ owner: 'test-owner', repo: 'test-repo' }), {
    owner: 'test-owner', repo: 'test-repo', branch: DEFAULT_BRANCH, allowPublicMailbox: false
  });
  assert.throws(() => validateConfig({ owner: '../owner', repo: 'repo', branch: 'bridge-mailbox' }), /owner/i);
  assert.throws(() => validateConfig({ owner: 'owner', repo: '..', branch: 'bridge-mailbox' }), /repository/i);
  assert.throws(() => validateConfig({ owner: 'owner', repo: 'repo', branch: 'feature/../main' }), /branch/i);
  assert.throws(() => validateConfig({ owner: 'owner', repo: 'repo', branch: '/main' }), /branch/i);
});

test('request validation requires matching protocol/ID and rejects extra arguments and unsupported GitHub tools', () => {
  const base = {
    protocol: PROTOCOL,
    request_id: 'req-20261024-001',
    created_at: '2026-10-24T04:00:00Z',
    tool: 'project_status',
    args: {}
  };
  assert.deepEqual(validateRequest(base.request_id, base), {
    request_id: base.request_id,
    tool: 'project_status',
    args: {}
  });
  assert.throws(() => validateRequest('different-id', base), /does not match/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, protocol: 'wrong' }), /protocol/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, args: { arbitraryShell: 'whoami' } }), /unsupported argument/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, tool: 'github_api', args: { method: 'PUT' } }), /unsupported local tool/i);
  assert.throws(() => validateRequest('../bad-id', { ...base, request_id: '../bad-id' }), /invalid ID/i);
});

test('repository sanitization strips local identity fields and redacts credentials and local paths', () => {
  const workspace = process.platform === 'win32'
    ? 'C:\\Users\\PrivateUser\\Projects\\fixture'
    : '/home/privateuser/Projects/fixture';
  const home = process.platform === 'win32' ? 'C:\\Users\\PrivateUser' : '/home/privateuser';
  const input = {
    ok: true,
    workspace,
    result: {
      homeDirectory: home,
      tempDirectory: home + '/AppData/Local/Temp',
      hostname: 'workstation-secret-name',
      output: 'Path=' + workspace + '\nToken=ghp_abcdefghijklmnopqrstuvwxyz1234567890\nAPI=sk-abcdefghijklmnopqrstuvwxyz0123456789',
      nested: { value: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' }
    }
  };
  const safe = sanitizeForRepository(input, workspace);
  const json = JSON.stringify(safe);
  assert.equal('workspace' in safe, false);
  assert.equal('homeDirectory' in safe.result, false);
  assert.equal('tempDirectory' in safe.result, false);
  assert.equal('hostname' in safe.result, false);
  assert.equal(json.includes(workspace), false);
  assert.equal(json.includes(home), false);
  assert.equal(json.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), false);
  assert.equal(json.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.equal(json.includes('Bearer abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.match(json, /REDACTED_GITHUB_TOKEN/);
});

test('worker executes a request once, writes the actual result, claim and heartbeat via the repository', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-project-status-1',
    created_at: '2026-10-24T04:00:00Z',
    tool: 'project_status',
    args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-project-status-1.json', request]] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth,
    ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      assert.equal(tool, 'project_status');
      assert.deepEqual(args, {});
      assert.equal(id, request.request_id);
      return { protocol: 'local-tool-result', ok: true, call_id: id, result: { isGitRepository: false, currentDirectory: process.cwd() } };
    },
    intervalMs: 5000
  });

  try {
    const started = await bridge.start();
    assert.equal(started.running, true);
    assert.equal(executions, 1);
    const resultFile = fake.files.get('bridge/results/' + request.request_id + '.json');
    assert.ok(resultFile, 'the result should be written to the shared repository');
    const result = decode(resultFile);
    assert.equal(result.protocol, RESULT_PROTOCOL);
    assert.equal(result.request_id, request.request_id);
    assert.equal(result.tool, 'project_status');
    assert.equal(result.status, 'completed');
    assert.equal(result.result.ok, true);
    assert.equal(JSON.stringify(result).includes(process.cwd()), false, 'local absolute path is redacted');
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    assert.equal(claim.status, 'completed');
    const state = decode(fake.files.get('bridge/state/windows-app.json'));
    assert.match(state.status, /idle|processing/);
    assert.ok(state.updated_at);
    assert.equal(state.workspace_selected, true);
    assert.equal('workspace_name' in state, false, 'shared state does not disclose the local workspace folder name');
    const createCommits = fake.calls.filter(call => call.method === 'PUT');
    assert.ok(createCommits.length >= 5, 'folder markers, claim, result and state are committed');
  } finally {
    await bridge.stop();
  }
});

test('invalid request JSON is reported and does not block later work', async () => {
  const first = { protocol: PROTOCOL, request_id: 'req-a-bad', created_at: new Date().toISOString(), tool: 'project_status', args: {} };
  const second = { protocol: PROTOCOL, request_id: 'req-z-good', created_at: new Date().toISOString(), tool: 'project_status', args: {} };
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/req-a-bad.json', first],
    ['bridge/requests/req-z-good.json', second]
  ] });
  fake.files.set('bridge/requests/req-a-bad.json', {
    name: 'req-a-bad.json', type: 'file', encoding: 'base64',
    content: Buffer.from('not-json', 'utf8').toString('base64'), sha: 'sha-corrupt'
  });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true, result: 'actual result' }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    assert.equal(decode(fake.files.get('bridge/results/req-a-bad.json')).status, 'rejected');
    assert.equal(decode(fake.files.get('bridge/results/req-z-good.json')).status, 'completed');
    assert.equal(executions, 1);
  } finally {
    await bridge.stop();
  }
});

test('malformed claim records are quarantined and do not block valid requests', async () => {
  const badRequest = {
    protocol: PROTOCOL, request_id: 'req-a-malformed-claim',
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const goodRequest = {
    protocol: PROTOCOL, request_id: 'req-z-valid-after-claim',
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/' + badRequest.request_id + '.json', badRequest],
    ['bridge/requests/' + goodRequest.request_id + '.json', goodRequest],
    ['bridge/claims/' + badRequest.request_id + '.json', null]
  ] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true, result: 'completed' }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    assert.equal(decode(fake.files.get('bridge/results/' + badRequest.request_id + '.json')).status, 'needs_manual_recovery');
    assert.equal(decode(fake.files.get('bridge/results/' + goodRequest.request_id + '.json')).status, 'completed');
    assert.equal(executions, 1, 'the malformed claim must not block later queue entries');
  } finally {
    await bridge.stop();
  }
});

test('a terminal claim with a missing result is quarantined instead of re-executed', async () => {
  const request = {
    protocol: PROTOCOL, request_id: 'req-terminal-no-result',
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const priorClaim = {
    protocol: 'chatgpt-local-repo-claim/v1',
    request_id: request.request_id,
    worker_id: 'previous-worker',
    status: 'completed',
    completed_at: new Date().toISOString()
  };
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/' + request.request_id + '.json', request],
    ['bridge/claims/' + request.request_id + '.json', priorClaim]
  ] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    assert.equal(executions, 0, 'terminal claims are never replayed');
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'needs_manual_recovery');
    assert.match(result.error, /result file is missing/i);
  } finally {
    await bridge.stop();
  }
});

test('duplicate polls do not execute a request again after its result exists', async () => {
  const request = {
    protocol: PROTOCOL, request_id: 'req-once', created_at: new Date().toISOString(),
    tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-once.json', request]] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true, result: { count: executions } }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await bridge.pollOnce();
    assert.equal(executions, 1);
  } finally {
    await bridge.stop();
  }
});

test('public repositories require explicit opt-in before the worker can start', async () => {
  const fake = fakeGitHub({ privateRepo: false });
  const fixture = settingsFixture(false);
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { throw new Error('should not execute'); }
  });
  await assert.rejects(bridge.start(), /public.*checkbox/i);
  assert.equal(bridge.getState().running, false);
  assert.equal(fake.calls.some(call => call.method === 'PUT'), false);
});

test('graceful stop waits for the active operation and publishes its result', async () => {
  const request = {
    protocol: PROTOCOL, request_id: 'req-graceful-stop',
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-graceful-stop.json', request]] });
  const fixture = settingsFixture();
  let releaseExecution;
  let markExecutionStarted;
  const executionStarted = new Promise(resolve => { markExecutionStarted = resolve; });
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => {
      markExecutionStarted();
      return new Promise(resolve => { releaseExecution = resolve; });
    },
    intervalMs: 5000
  });

  const startPromise = bridge.start();
  await executionStarted;
  let stopResolved = false;
  const stopPromise = bridge.stop().then(state => {
    stopResolved = true;
    return state;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopResolved, false, 'stop should wait while the tool is still running');
  releaseExecution({ ok: true, result: 'finished before shutdown' });
  const [startState, stopState] = await Promise.all([startPromise, stopPromise]);
  assert.equal(startState.running, false);
  assert.equal(stopState.running, false);
  assert.equal(decode(fake.files.get('bridge/results/req-graceful-stop.json')).status, 'completed');
  assert.equal(decode(fake.files.get('bridge/state/windows-app.json')).status, 'stopped');
});

test('a started worker can be stopped cleanly', async () => {
  const fake = fakeGitHub();
  const fixture = settingsFixture(true);
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true }),
    intervalMs: 5000
  });
  const started = await bridge.start();
  assert.equal(started.running, true);
  const stopped = await bridge.stop();
  assert.equal(stopped.running, false);
  assert.equal(decode(fake.files.get('bridge/state/windows-app.json')).status, 'stopped');
});


test('large textual tool output is stored as a retrievable artifact and previewed in the result', async () => {
  const longText = 'Header line\\n' + 'A'.repeat(18000) + '\\n' + 'λ🙂'.repeat(8000);
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-large-output',
    created_at: new Date().toISOString(),
    tool: 'read_file',
    args: { path: 'large.txt' }
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-large-output.json', request]] });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true, result: { path: 'large.txt', content: longText } }),
    intervalMs: 5000
  });

  try {
    await bridge.start();
    const record = decode(fake.files.get('bridge/results/req-large-output.json'));
    assert.equal(record.status, 'completed');
    assert.equal(record.artifacts.length, 1);
    const artifact = record.artifacts[0];
    assert.ok(artifact.path.startsWith('bridge/artifacts/req-large-output/'));
    const stored = fake.files.get(artifact.path);
    assert.ok(stored, 'full output must be retrievable by the artifact path');
    assert.equal(Buffer.from(stored.content, 'base64').toString('utf8'), longText);
    assert.match(record.result.result.content, /Retrieve the artifact file/);
    assert.equal(artifact.bytes, Buffer.byteLength(longText, 'utf8'));
  } finally {
    await bridge.stop();
  }
});

test('workspace file upload stores raw bytes and returns a repository locator', async () => {
  const fake = fakeGitHub();
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true })
  });
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const artifact = await bridge.publishWorkspaceFile('req-upload-binary', {
    path: 'output/sample.bin',
    artifactName: '../sample.bin',
    bytes
  });
  assert.equal(artifact.path, 'bridge/artifacts/req-upload-binary/sample.bin');
  assert.equal(artifact.bytes, bytes.length);
  assert.ok(artifact.url.includes('/blob/bridge-mailbox/bridge/artifacts/'));
  const stored = fake.files.get(artifact.path);
  assert.ok(stored);
  assert.deepEqual(Buffer.from(stored.content, 'base64'), bytes);
});

test('environment refresh publishes a compact context index and keeps instruction contents on-demand', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-refresh-context',
    created_at: new Date().toISOString(),
    tool: 'refresh_environment_context',
    args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-refresh-context.json', request]] });
  const fixture = settingsFixture();
  const calls = [];
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async tool => {
      calls.push(tool);
      if (tool === 'discover_instructions') {
        return { ok: true, result: { count: 1, instructions: [{ path: 'AGENTS.md', content: 'do not publish this instruction body' }] } };
      }
      return { ok: true, result: { tool, summary: 'captured' } };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    const index = decode(fake.files.get('bridge/context/latest.json'));
    assert.equal(index.protocol, 'chatgpt-local-environment-context/v1');
    assert.ok(index.files.environment);
    assert.ok(index.files.project);
    assert.ok(index.files.capabilities);
    assert.ok(index.files.directory_tree);
    assert.ok(index.files.instructions);
    const instructions = decode(fake.files.get('bridge/context/instructions.json'));
    assert.deepEqual(instructions.data.result.instructions, [{
      path: 'AGENTS.md',
      bytes: Buffer.byteLength('do not publish this instruction body', 'utf8'),
      sha256: require('node:crypto').createHash('sha256').update('do not publish this instruction body').digest('hex')
    }]);
    assert.equal(JSON.stringify(instructions).includes('do not publish this instruction body'), false);
    assert.ok(calls.includes('environment_info'));
    assert.ok(calls.includes('directory_tree'));
    const result = decode(fake.files.get('bridge/results/req-refresh-context.json'));
    assert.equal(result.status, 'completed');
  } finally {
    await bridge.stop();
  }
});


test('oversized structured results are split into retrievable artifact parts', async () => {
  const entries = Array.from({ length: 600 }, (_, index) => ({
    id: index,
    detail: String(index).padStart(3, '0') + '-' + 'x'.repeat(620)
  }));
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-structured-result',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-structured-result.json', request]] });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true, result: { entries } }),
    intervalMs: 5000
  });

  try {
    await bridge.start();
    const result = decode(fake.files.get('bridge/results/req-structured-result.json'));
    assert.equal(result.status, 'completed');
    assert.ok(result.artifacts.length > 1);
    assert.ok(result.artifacts.every(item => item.kind === 'structured_result_part'));
    assert.deepEqual(
      result.artifacts.map(item => item.part).sort((a, b) => a - b),
      Array.from({ length: result.artifacts.length }, (_, index) => index + 1)
    );
    const fullText = result.artifacts
      .slice()
      .sort((a, b) => a.part - b.part)
      .map(item => {
        const stored = fake.files.get(item.path);
        assert.ok(stored, 'every result part must be retrievable');
        assert.equal(Buffer.byteLength(Buffer.from(stored.content, 'base64')), item.bytes);
        return Buffer.from(stored.content, 'base64').toString('utf8');
      })
      .join('');
    const full = JSON.parse(fullText);
    assert.equal(full.result.result.entries.length, entries.length);
    assert.equal(full.result.result.entries[599].detail, entries[599].detail);
    assert.equal(Buffer.byteLength(fullText, 'utf8'), result.result.bytes);
  } finally {
    await bridge.stop();
  }
});
