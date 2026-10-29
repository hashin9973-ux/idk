'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PROTOCOL,
  RESULT_PROTOCOL,
  DEFAULT_BRANCH,
  DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS,
  validateConfig,
  validateRequest,
  sanitizeForRepository,
  createRepositoryBridge
} = require('../desktop/repository-bridge');
const { getExecutionFootprint, executionFootprintsConflict } = require('../desktop/tool-bridge');

function encode(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8').toString('base64');
}

function decode(value) {
  return JSON.parse(Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8'));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous mailbox work.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fakeGitHub({ privateRepo = true, initial = [], requestCommitShaOverride = null, falseConflictCreatePaths = [], transientCreateConflictPaths = [] } = {}) {
  const files = new Map();
  let nextSha = 1;
  for (const [path, value] of initial) {
    files.set(path, { name: path.split('/').pop(), type: 'file', encoding: 'base64', content: encode(value), sha: 'sha-' + nextSha++ });
  }
  const calls = [];
  let requestTreeFailuresRemaining = 0;
  const falseConflictPaths = new Set(falseConflictCreatePaths);
  const transientCreateConflictTargets = new Set(transientCreateConflictPaths);
  let headCommitSha = 'f'.repeat(40);
  let gitObjectCounter = 1;
  const treePathsBySha = new Map();
  function treeShaForPath(relativePath) {
    const sha = require('node:crypto').createHash('sha1').update(relativePath || '/').digest('hex');
    treePathsBySha.set(sha, relativePath || '');
    return sha;
  }
  const pendingTrees = new Map();
  const gitCommits = new Map([[headCommitSha, { treeSha: treeShaForPath(''), parents: [] }]]);
  const githubAuth = {
    getState: async () => ({ authenticated: true, login: 'worker-test' }),
    requestApi: async ({ method, path, body, query }) => {
      calls.push({ method, path, body, query });
      if (method === 'GET' && path === '/repos/test-owner/test-repo') {
        return { status: 200, result: { private: privateRepo } };
      }
      if (method === 'GET' && path === '/repos/test-owner/test-repo/git/ref/heads/bridge-mailbox') {
        return { status: 200, result: { ref: 'refs/heads/bridge-mailbox', object: { sha: headCommitSha } } };
      }
      const gitCommitPrefix = '/repos/test-owner/test-repo/git/commits/';
      if (method === 'GET' && path.startsWith(gitCommitPrefix)) {
        const sha = path.slice(gitCommitPrefix.length);
        const entry = gitCommits.get(sha);
        if (!entry) throw new Error('Not Found (404)');
        return { status: 200, result: { sha, tree: { sha: entry.treeSha }, parents: entry.parents.map(parent => ({ sha: parent })) } };
      }
      if (method === 'POST' && path === '/repos/test-owner/test-repo/git/trees') {
        const sha = String(gitObjectCounter++).padStart(40, '0');
        pendingTrees.set(sha, body.tree || []);
        return { status: 201, result: { sha } };
      }
      if (method === 'POST' && path === '/repos/test-owner/test-repo/git/commits') {
        const sha = String(gitObjectCounter++).padStart(40, '0');
        gitCommits.set(sha, { treeSha: body.tree, parents: body.parents || [], message: body.message });
        return { status: 201, result: { sha } };
      }
      if (method === 'PATCH' && path === '/repos/test-owner/test-repo/git/refs/heads/bridge-mailbox') {
        const commit = gitCommits.get(body.sha);
        if (!commit || !Array.isArray(commit.parents) || commit.parents[0] !== headCommitSha) {
          throw new Error('non-fast-forward reference update rejected');
        }
        for (const entry of pendingTrees.get(commit.treeSha) || []) {
          if (entry.sha === null) files.delete(entry.path);
        }
        headCommitSha = body.sha;
        return { status: 200, result: { ref: 'refs/heads/bridge-mailbox', object: { sha: headCommitSha } } };
      }
      if (method === 'GET' && path === '/repos/test-owner/test-repo/commits') {
        assert.equal(query.sha, 'bridge-mailbox');
        assert.equal(query.path, 'bridge/requests');
        assert.ok([1, 20].includes(query.per_page));
        const requestPaths = [...files.keys()]
          .filter(filePath => filePath.startsWith('bridge/requests/') && filePath.endsWith('.json'))
          .sort();
        return {
          status: 200,
          result: requestCommitShaOverride
            ? [{ sha: requestCommitShaOverride }]
            : requestPaths.length
              ? [{ sha: String(requestPaths.length).padStart(40, '0') }]
              : []
        };
      }
      const restCommitPrefix = '/repos/test-owner/test-repo/commits/';
      if (method === 'GET' && path.startsWith(restCommitPrefix)) {
        const requestPaths = [...files.keys()]
          .filter(filePath => filePath.startsWith('bridge/requests/') && filePath.endsWith('.json'))
          .sort();
        return { status: 200, result: { sha: path.slice(restCommitPrefix.length), files: requestPaths.map(filename => ({ filename, status: 'added' })) } };
      }
      const treePrefix = '/repos/test-owner/test-repo/git/trees/';
      if (method === 'GET' && path.startsWith(treePrefix)) {
        const treeRef = path.slice(treePrefix.length);
        const treePath = treeRef === 'bridge-mailbox' ? '' : treePathsBySha.get(treeRef);
        if (treePath === undefined) throw new Error('Not Found (404)');
        if (treePath === 'bridge/requests' && requestTreeFailuresRemaining > 0) {
          requestTreeFailuresRemaining--;
          throw new Error('fetch failed: simulated mailbox network timeout');
        }
        const prefix = treePath ? treePath + '/' : '';
        const children = new Map();
        for (const [filePath, value] of files) {
          if (!filePath.startsWith(prefix)) continue;
          const remainder = filePath.slice(prefix.length);
          if (!remainder) continue;
          const child = remainder.split('/')[0];
          const childPath = prefix + child;
          const isFile = files.has(childPath);
          children.set(child, {
            path: child,
            type: isFile ? 'blob' : 'tree',
            sha: isFile ? files.get(childPath).sha : treeShaForPath(childPath),
            ...(isFile ? { size: Buffer.from(value.content || '', 'base64').length } : {})
          });
        }
        return {
          status: 200,
          result: { sha: treeShaForPath(treePath), tree: [...children.values()], truncated: false }
        };
      }
      const contentsPrefix = '/repos/test-owner/test-repo/contents/';
      if (!path.startsWith(contentsPrefix)) throw new Error('Unexpected API path: ' + path);
      const rel = path.slice(contentsPrefix.length);
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
            type: isFile ? 'file' : 'dir',
            sha: isFile ? files.get(childPath).sha : treeShaForPath(childPath)
          });
        }
        if (children.size) return { status: 200, result: Array.from(children.values()) };
        throw new Error('Not Found (404)');
      }
      if (method === 'PUT') {
        const existing = files.get(rel);
        // Test double: model a one-time GitHub 422 response even though no target
        // file was created, to catch false "already exists" conflict handling.
        if (!existing && !body.sha && transientCreateConflictTargets.has(rel)) {
          transientCreateConflictTargets.delete(rel);
          throw new Error('GitHub HTTP 409: branch head advanced during create-only upload');
        }
        if (!existing && !body.sha && falseConflictPaths.has(rel)) {
          falseConflictPaths.delete(rel);
          throw new Error('GitHub HTTP 422: Validation Failed');
        }
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
  return {
    githubAuth, files, calls,
    treeRef: relativePath => treeShaForPath(relativePath),
    failNextRequestTreeReads: count => { requestTreeFailuresRemaining = Math.max(0, Number(count) || 0); }
  };
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
    owner: 'test-owner', repo: 'test-repo', branch: DEFAULT_BRANCH, allowPublicMailbox: false, retentionDays: 30
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
  const identified = { ...base, agent_id: 'agent-001', agent_token: 'a'.repeat(64) };
  assert.equal(validateRequest(base.request_id, identified).agent_id, 'agent-001');
  assert.equal(validateRequest(base.request_id, identified).agent_token, 'a'.repeat(64));
  assert.throws(() => validateRequest(base.request_id, { ...base, agent_id: 'agent-001' }), /requires both/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, agent_token: 'a'.repeat(64) }), /requires both/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, agent_id: '../agent', agent_token: 'a'.repeat(64) }), /invalid format/i);
  assert.throws(() => validateRequest(base.request_id, { ...base, tool: 'agent_register', args: { arbitraryShell: 'whoami' } }), /unsupported argument/i);
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

test('concurrent agent registration allocates unique IDs and stores only token hashes in registry records', async () => {
  const makeRegistration = requestId => ({ protocol: PROTOCOL, request_id: requestId, created_at: new Date().toISOString(), tool: 'agent_register', args: {} });
  const first = makeRegistration('register-agent-first');
  const second = makeRegistration('register-agent-second');
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/' + first.request_id + '.json', first],
    ['bridge/requests/' + second.request_id + '.json', second]
  ] });
  const fixture = settingsFixture();
  let localExecutions = 0;
  const bridge = createRepositoryBridge({ githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => { localExecutions++; return { ok: true, tool, call_id: id }; }, intervalMs: 5000 });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + first.request_id + '.json') && fake.files.has('bridge/results/' + second.request_id + '.json'));
    const resultA = decode(fake.files.get('bridge/results/' + first.request_id + '.json'));
    const resultB = decode(fake.files.get('bridge/results/' + second.request_id + '.json'));
    const agentA = resultA.result.result;
    const agentB = resultB.result.result;
    assert.notEqual(agentA.agent_id, agentB.agent_id);
    assert.deepEqual([agentA.agent_id, agentB.agent_id].sort(), ['agent-001', 'agent-002']);
    assert.notEqual(agentA.agent_token, agentB.agent_token);
    assert.equal(resultA.agent_id, agentA.agent_id);
    assert.equal(resultB.agent_id, agentB.agent_id);
    const claimA = decode(fake.files.get('bridge/claims/' + first.request_id + '.json'));
    const claimB = decode(fake.files.get('bridge/claims/' + second.request_id + '.json'));
    assert.equal(claimA.agent_id, agentA.agent_id, 'registration claim must expose the newly allocated Agent ID');
    assert.equal(claimB.agent_id, agentB.agent_id, 'registration claim must expose the newly allocated Agent ID');
    assert.equal(claimA.result.agent_id, agentA.agent_id);
    assert.equal(claimB.result.agent_id, agentB.agent_id);
    for (const agent of [agentA, agentB]) {
      const record = decode(fake.files.get('bridge/agents/' + agent.agent_id + '.json'));
      assert.equal(record.status, 'idle');
      assert.equal(JSON.stringify(record).includes(agent.agent_token), false);
      assert.match(record.token_hash, /^[a-f0-9]{64}$/);
    }
    assert.equal(localExecutions, 0, 'mailbox agent management never enters the workspace tool runner');
  } finally { await bridge.stop(); }
});

test('agent identity appears in claim/result and status returns to idle after execution', async () => {
  const { createHash } = require('node:crypto');
  const agentId = 'agent-001';
  const agentToken = 'b'.repeat(64);
  const now = new Date().toISOString();
  const record = { protocol: 'chatgpt-local-agent-record/v1', agent_id: agentId,
    token_hash: createHash('sha256').update(agentToken).digest('hex'), label: 'Agent 1', status: 'idle',
    created_at: now, updated_at: now, last_seen_at: now, last_completed_at: null, last_request_id: null,
    recent_request_ids: [], active_request_ids: [] };
  const request = { protocol: PROTOCOL, request_id: 'agent-001-project-status-test', agent_id: agentId, agent_token: agentToken,
    created_at: new Date().toISOString(), tool: 'project_status', args: {} };
  const fake = fakeGitHub({ initial: [
    ['bridge/agents/' + agentId + '.json', record],
    ['bridge/requests/' + request.request_id + '.json', request]
  ] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({ githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => { executions++; return { ok: true, tool, call_id: id, result: { ready: true } }; }, intervalMs: 5000 });
  try {
    await bridge.start();
    await waitFor(() => {
      if (!fake.files.has('bridge/results/' + request.request_id + '.json')) return false;
      const agentEntry = fake.files.get('bridge/agents/' + agentId + '.json');
      if (!agentEntry) return false;
      const currentAgent = decode(agentEntry);
      return currentAgent.status === 'idle' && currentAgent.active_request_ids.length === 0;
    });
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    const updatedAgent = decode(fake.files.get('bridge/agents/' + agentId + '.json'));
    assert.equal(executions, 1);
    assert.equal(result.agent_id, agentId);
    assert.equal(claim.agent_id, agentId);
    assert.equal(updatedAgent.status, 'idle');
    assert.equal(updatedAgent.last_request_id, request.request_id);
    assert.ok(updatedAgent.recent_request_ids.includes(request.request_id));
    assert.deepEqual(updatedAgent.active_request_ids, []);
    const agentMailbox = bridge.getState().agentMailboxes.find(item => item.agent_id === agentId);
    assert.ok(agentMailbox, 'agent appears in the mailbox monitor');
    const task = agentMailbox.requests.find(item => item.request_id === request.request_id);
    assert.ok(task, 'executed request appears in its agent mailbox');
    assert.equal(task.tool, 'project_status', 'the monitor uses the registered local tool name');
    assert.equal(task.status, 'completed');
    assert.equal(task.progress, 100);
    assert.ok(task.request_json.includes('"agent_token": "[REDACTED]"'));
    assert.doesNotMatch(task.request_json, /b{64}/);
    assert.ok(task.claim_json.includes('[REDACTED]'));
    assert.doesNotMatch(task.claim_json, /b{64}/);
    assert.ok(task.result_json.includes('"status": "completed"'));
    assert.doesNotMatch(task.result_json, /b{64}/);
  } finally { await bridge.stop(); }
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
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
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
    assert.ok(result.timing_ms, 'worker latency diagnostics should be published with each result');
    assert.equal(Number.isInteger(result.timing_ms.bridge_api_calls_before_result_publish), true);
    assert.equal(Number.isInteger(result.timing_ms.bridge_api_ms_before_result_publish), true);
    assert.equal(Number.isInteger(result.timing_ms.tool_wall_time), true);
    assert.equal(fake.calls.filter(call => call.method === 'GET' && call.path.endsWith('/contents/bridge/claims/' + request.request_id + '.json')).length, 0, 'new claims should use create-only fast path');
    assert.equal(fake.calls.filter(call => call.method === 'GET' && call.path.endsWith('/contents/bridge/results/' + request.request_id + '.json')).length, 0, 'result publication should use create-only fast path');
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    assert.equal(claim.status, 'completed');
    assert.ok(claim.result, 'completed claim is a recovery journal for interrupted result publication');
    const state = decode(fake.files.get('bridge/state/windows-app.json'));
    assert.match(state.status, /idle|processing/);
    assert.ok(state.updated_at);
    assert.equal(state.workspace_selected, true);
    assert.equal('workspace_name' in state, false, 'shared state does not disclose the local workspace folder name');
    const createCommits = fake.calls.filter(call => call.method === 'PUT');
    assert.ok(createCommits.length >= 5, 'folder markers, claim, result and state are committed');
    const resultsTreePath = '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/results');
    const resultFolderTreeGetsBefore = fake.calls.filter(call => call.method === 'GET' && call.path === resultsTreePath).length;
    await bridge.pollOnce();
    const resultFolderTreeGetsAfter = fake.calls.filter(call => call.method === 'GET' && call.path === resultsTreePath).length;
    assert.equal(resultFolderTreeGetsAfter, resultFolderTreeGetsBefore, 'normal polling must not reload the historical results tree');
    assert.equal(executions, 1, 'cached completed result must not rerun');
  } finally {
    await bridge.stop();
  }
});

test('create-only HTTP 422 without an existing result is verified and retried', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-result-false-conflict',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const resultPath = 'bridge/results/' + request.request_id + '.json';
  const fake = fakeGitHub({
    initial: [['bridge/requests/' + request.request_id + '.json', request]],
    falseConflictCreatePaths: [resultPath]
  });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      assert.equal(tool, 'project_status');
      assert.equal(id, request.request_id);
      return { ok: true, result: { observed: true } };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await waitFor(() => fake.files.has(resultPath));
    const result = decode(fake.files.get(resultPath));
    assert.equal(executions, 1, 'the local operation must not run twice while recovering publication');
    assert.equal(result.request_id, request.request_id);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.ok, true);
    assert.equal(
      fake.calls.filter(call => call.method === 'GET' && call.path === '/repos/test-owner/test-repo/contents/' + resultPath).length,
      1,
      'a create-only HTTP 422 must read the exact target and must not be treated as success when it is absent'
    );
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    assert.equal(claim.status, 'completed');
    assert.equal(bridge.getState().lastError, '');
  } finally {
    await bridge.stop();
  }
});

test('mailbox transport health is tracked separately from ordinary tool errors', async () => {
  const fake = fakeGitHub();
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true }),
    intervalMs: 5000,
    requestReconciliationIntervalMs: 1
  });

  try {
    const started = await bridge.start();
    assert.equal(started.running, true);
    assert.ok(started.lastPollAt, 'a successful request-tree scan records the last successful poll');
    assert.equal(started.lastPollError, '');

    fake.failNextRequestTreeReads(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await bridge.pollOnce();
    const failedPoll = bridge.getState();
    assert.equal(failedPoll.lastPollAt, started.lastPollAt, 'a failed scan must not refresh the successful-poll timestamp');
    assert.match(failedPoll.lastPollError, /simulated mailbox network timeout/i);

    await bridge.pollOnce();
    const recovered = bridge.getState();
    assert.ok(recovered.lastPollAt);
    assert.equal(recovered.lastPollError, '', 'a successful scan clears the separate transport error');
  } finally {
    await bridge.stop();
  }
});

test('large historical mailbox folders are listed with bounded Git trees, not Contents API', async () => {
  const initial = [];
  const count = 900;
  for (let index = 1; index <= count; index++) {
    const id = 'req-historical-' + String(index).padStart(4, '0');
    initial.push(['bridge/requests/' + id + '.json', {
      protocol: PROTOCOL,
      request_id: id,
      created_at: '2026-10-27T00:00:00.000Z',
      tool: 'project_status',
      args: {}
    }]);
    initial.push(['bridge/results/' + id + '.json', {
      protocol: RESULT_PROTOCOL,
      request_id: id,
      status: 'completed',
      completed_at: '2026-10-27T00:00:01.000Z',
      result: { ok: true, result: { historical: true } }
    }]);
  }
  const fake = fakeGitHub({ initial });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true }; },
    intervalMs: 5000
  });

  try {
    const started = await bridge.start();
    assert.equal(started.running, true);
    assert.equal(executions, 0, 'historical requests with matching results must never be rerun');
    assert.equal(bridge.getState().lastError, '');
    assert.ok(fake.calls.some(call =>
      call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/requests')
    ), 'the worker must list the compact request-directory tree');
    assert.ok(fake.calls.some(call =>
      call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/results')
    ), 'the worker must build its historical result index from the compact result-directory tree');
    assert.equal(fake.calls.some(call =>
      call.method === 'GET' &&
      ['/repos/test-owner/test-repo/contents/bridge/requests', '/repos/test-owner/test-repo/contents/bridge/results'].includes(call.path)
    ), false, 'large mailbox folders must never use the Contents API directory endpoint');
    assert.ok(fake.calls.some(call =>
      call.method === 'GET' && call.path === '/repos/test-owner/test-repo/contents/bridge' &&
      call.query && call.query.ref === 'bridge-mailbox'
    ), 'the poller should use the small bridge directory listing to resolve the child tree SHA');
    assert.equal(fake.calls.some(call =>
      call.method === 'GET' && call.path === '/repos/test-owner/test-repo/git/trees/bridge-mailbox'
    ), false, 'a known mailbox subdirectory should avoid a sequential full-root tree lookup');
  } finally {
    await bridge.stop();
  }
});

test('request-tree reconciliation remains authoritative when the fast commit endpoint is stale', async () => {
  assert.equal(DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS, 10000);
  // A deliberately stale response from the old path-filtered commit endpoint must not delay request discovery.
  const fake = fakeGitHub({ requestCommitShaOverride: 'a'.repeat(40) });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      return { ok: true, result: { id, tool } };
    },
    intervalMs: 5000
  });

  const originalDateNow = Date.now;
  try {
    await bridge.start();
    const lastScanAt = Date.parse(bridge.getState().requestPolling.lastRequestTreeScanAt);
    assert.ok(Number.isFinite(lastScanAt), 'the initial request-tree scan should be timestamped');
    const requestsTreePath = '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/requests');
    const initialTreeReads = fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length;
    await waitFor(() => fake.calls.some(call =>
      call.method === 'GET' && call.path === '/repos/test-owner/test-repo/commits'), 1000);
    assert.ok(
      fake.calls.some(call => call.method === 'GET' && call.path === '/repos/test-owner/test-repo/commits'),
      'the commit fast path runs separately from the full-tree scan'
    );

    Date.now = () => lastScanAt + DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS - 1;
    await bridge.pollOnce();
    assert.equal(
      fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length,
      initialTreeReads,
      'a poll before the scan interval must not perform another GitHub tree read'
    );

    // Simulate the next request-tree scan deadline without sleeping.
    Date.now = () => lastScanAt + DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS + 1;
    const request = {
      protocol: PROTOCOL,
      request_id: 'req-cursor-stale-reconcile',
      created_at: new Date().toISOString(),
      tool: 'project_status',
      args: {}
    };
    const requestPath = 'bridge/requests/' + request.request_id + '.json';
    fake.files.set(requestPath, {
      name: request.request_id + '.json',
      path: requestPath,
      type: 'file',
      encoding: 'base64',
      content: encode(request),
      sha: 'sha-injected-stale-cursor-request'
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    await bridge.pollOnce();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));

    assert.equal(executions, 1, 'the new request should execute exactly once');
    assert.ok(
      fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length > initialTreeReads,
      'a due scan must re-read the bounded request tree without needing a commit-cursor result'
    );
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'completed');
    assert.equal(result.request_id, request.request_id);
    const polling = bridge.getState().requestPolling;
    assert.equal(polling.requestTreeScanCount, 2, 'initialization and due scan should be counted');
    assert.ok(Number.isFinite(polling.lastRequestTreeScanDurationMs));
    assert.ok(
      fake.calls.some(call => call.method === 'GET' && call.path === '/repos/test-owner/test-repo/commits'),
      'request commit polling should remain enabled while full-tree reconciliation recovers the deliberately stale result'
    );
  } finally {
    Date.now = originalDateNow;
    await bridge.stop();
  }
});

test('fast request-commit probe executes a new request before full-tree reconciliation is due', async () => {
  const initial = {
    protocol: PROTOCOL,
    request_id: 'req-fast-probe-initial',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const fake = fakeGitHub();
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      return { ok: true, result: { id, tool } };
    },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    const initialTreeScanCount = bridge.getState().requestPolling.requestTreeScanCount;
    const requestPath = 'bridge/requests/' + initial.request_id + '.json';
    fake.files.set(requestPath, {
      name: initial.request_id + '.json',
      path: requestPath,
      type: 'file',
      encoding: 'base64',
      content: encode(initial),
      sha: 'sha-fast-probe-request'
    });

    await waitFor(() => fake.files.has('bridge/results/' + initial.request_id + '.json'), 3500);
    assert.equal(executions, 1, 'the request from the recent commit should execute exactly once');
    assert.equal(bridge.getState().requestPolling.requestTreeScanCount, initialTreeScanCount,
      'fast pickup must not require another full request-folder tree read');
    assert.ok(fake.calls.some(call => call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/commits/' + String(1).padStart(40, '0')),
    'the fast path should inspect the changed commit file list');
    assert.equal(decode(fake.files.get('bridge/results/' + initial.request_id + '.json')).status, 'completed');
  } finally {
    await bridge.stop();
  }
});


test('worker drains queued mailbox requests without a folder re-read for every completion', async () => {
  const requests = Array.from({ length: 40 }, (_, index) => ({
    protocol: PROTOCOL,
    request_id: 'req-parallel-' + String(index + 1).padStart(2, '0'),
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  }));
  const fake = fakeGitHub({ initial: requests.map(request => ['bridge/requests/' + request.request_id + '.json', request]) });
  const fixture = settingsFixture();
  let active = 0;
  let maximumActive = 0;
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 35));
      active--;
      return { ok: true, result: { id } };
    },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    const requestsTreePath = '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/requests');
    const requestFolderTreeGetsAtDispatch = fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length;
    await waitFor(() => requests.every(request => fake.files.has('bridge/results/' + request.request_id + '.json')), 5000);
    await new Promise(resolve => setTimeout(resolve, 25));
    const requestFolderTreeGetsAfterDrain = fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length;
    assert.equal(executions, 40);
    assert.equal(maximumActive, 32, 'the worker should fill its configured 32-request limit, then refill from its local queue');
    assert.equal(requestFolderTreeGetsAfterDrain, requestFolderTreeGetsAtDispatch, 'request completion should drain queued work without another tree listing when the request-commit cursor is unchanged');
    for (const request of requests) {
      const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
      assert.equal(result.status, 'completed');
      assert.equal(result.result.result.id, request.request_id);
    }
  } finally {
    await bridge.stop();
  }
});


test('execution footprints serialize ambiguous aliases but allow disjoint paths to run concurrently', () => {
  const readFile = getExecutionFootprint('read_file', { path: 'same.txt' });
  const writeFile = getExecutionFootprint('write_file', { path: 'same.txt', content: 'new' });
  const readOther = getExecutionFootprint('read_file', { path: 'other.txt' });
  const aliasRead = getExecutionFootprint('read_file', { path: 'folder/../same.txt' });
  const absoluteRead = getExecutionFootprint('read_file', { path: 'C:\\workspace\\same.txt' });
  const desktopClick = getExecutionFootprint('computer', { action: 'click', x: 10, y: 10 });
  const anotherDesktopAction = getExecutionFootprint('computer', { action: 'screenshot' });
  const unknownSideEffect = getExecutionFootprint('new_tool_not_in_the_catalog', {});

  assert.equal(executionFootprintsConflict(readFile, writeFile), true);
  assert.equal(executionFootprintsConflict(readFile, readOther), false);
  assert.equal(aliasRead.barrier, true, 'parent-traversal aliases must not bypass conflict detection');
  assert.equal(absoluteRead.barrier, true, 'absolute paths cannot be safely matched without the canonical workspace root');
  assert.equal(unknownSideEffect.barrier, true, 'unknown tools must block concurrent execution conservatively');
  assert.equal(executionFootprintsConflict(aliasRead, readOther), true);
  assert.equal(executionFootprintsConflict(desktopClick, readOther), false,
    'desktop input and independent file reads do not conflict');
  assert.equal(executionFootprintsConflict(desktopClick, anotherDesktopAction), true,
    'two desktop operations must not overlap on the same interactive session');
});


test('worker runs disjoint workspace operations concurrently and serializes conflicting paths across requests', async () => {
  const requests = [
    { protocol: PROTOCOL, request_id: 'req-conflict-a-read', created_at: new Date().toISOString(), tool: 'read_file', args: { path: 'same.txt' } },
    { protocol: PROTOCOL, request_id: 'req-conflict-b-write', created_at: new Date().toISOString(), tool: 'write_file', args: { path: 'same.txt', content: 'new' } },
    { protocol: PROTOCOL, request_id: 'req-disjoint-c-read', created_at: new Date().toISOString(), tool: 'read_file', args: { path: 'other.txt' } }
  ];
  const fake = fakeGitHub({ initial: requests.map(request => ['bridge/requests/' + request.request_id + '.json', request]) });
  const fixture = settingsFixture();
  const activePaths = [];
  let active = 0;
  let maximumActive = 0;
  let conflictingOverlap = false;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      const isWrite = tool === 'write_file' || tool === 'delete_path' || tool === 'create_directory';
      if (activePaths.some(item => item.path === args.path && (item.isWrite || isWrite))) conflictingOverlap = true;
      activePaths.push({ path: args.path, isWrite });
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 50));
      active--;
      activePaths.splice(activePaths.findIndex(item => item.path === args.path && item.isWrite === isWrite), 1);
      return { ok: true, result: { id, path: args.path } };
    },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => requests.every(request => fake.files.has('bridge/results/' + request.request_id + '.json')), 5000);
    assert.equal(conflictingOverlap, false, 'reads and writes touching the same path must never overlap');
    assert.ok(maximumActive >= 2, 'independent paths should still execute concurrently');
    for (const request of requests) {
      const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
      assert.equal(result.status, 'completed');
      assert.equal(result.result.result.id, request.request_id);
    }
  } finally {
    await bridge.stop();
  }
});


test('large batch outputs are preserved in bounded artifacts with an inline index', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-batch-output-bundle',
    created_at: new Date().toISOString(),
    tool: 'batch',
    args: { steps: [{ id: 'placeholder', tool: 'project_status', args: {} }] }
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + request.request_id + '.json', request]] });
  const fixture = settingsFixture();
  const steps = Array.from({ length: 80 }, (_, index) => ({
    id: 'step' + String(index + 1).padStart(3, '0'),
    tool: 'read_file',
    call_id: 'req-batch-output-bundle-step' + index,
    ok: true,
    status: 'success',
    result: {
      path: 'file-' + index + '.txt',
      content: String(index).padStart(3, '0') + 'x'.repeat(11997),
      bytes: 12000,
      sha256: 'abc123',
      totalLines: 1
    }
  }));
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({
      ok: true,
      result: { steps, completed_steps: steps.length, skipped_steps: 0, requested_steps: steps.length, max_concurrency: 100 }
    }),
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'), 10000);
    const record = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(record.status, 'completed');
    assert.equal(record.output_truncated, false);
    const result = record.result.result;
    assert.equal(result.output_bundled, true);
    assert.equal(result.steps.length, 80);
    assert.ok(result.steps.every(step => step.output_in_artifact === true));
    assert.ok(result.output_artifacts.length >= 2, 'large output should split into Contents-API-safe parts');
    const allSteps = [];
    for (const ref of result.output_artifacts) {
      const entry = fake.files.get(ref.path);
      assert.ok(entry, 'artifact part was published: ' + ref.path);
      const part = decode(entry);
      assert.equal(part.protocol, 'chatgpt-local-batch-output/v1');
      assert.equal(part.request_id, request.request_id);
      allSteps.push(...part.steps);
    }
    assert.equal(allSteps.length, 80);
    assert.equal(allSteps[0].result.content.length, 12000);
    assert.ok(allSteps[79].result.content.endsWith('x'));
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
    await waitFor(() => fake.files.has('bridge/results/req-a-bad.json') && fake.files.has('bridge/results/req-z-good.json'));
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
    await waitFor(() => fake.files.has('bridge/results/' + badRequest.request_id + '.json') && fake.files.has('bridge/results/' + goodRequest.request_id + '.json'));
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
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    assert.equal(executions, 0, 'terminal claims are never replayed');
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'needs_manual_recovery');
    assert.match(result.error, /result file is missing/i);
  } finally {
    await bridge.stop();
  }
});

test('processing claims from a confirmed previous worker restart are quarantined without replay', async () => {
  const claimedAt = Date.now() - 20_000;
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-abandoned-worker-claim',
    created_at: new Date(claimedAt).toISOString(),
    tool: 'project_status',
    args: {}
  };
  const priorClaim = {
    protocol: 'chatgpt-local-repo-claim/v1',
    request_id: request.request_id,
    worker_id: 'previous-worker',
    tool: 'project_status',
    status: 'processing',
    claimed_at: new Date(claimedAt).toISOString(),
    lease_expires_at_ms: Date.now() + 30 * 60 * 1000
  };
  const priorState = {
    protocol: 'chatgpt-local-repo-state/v1',
    worker_id: 'previous-worker',
    updated_at: new Date(claimedAt + 1_000).toISOString(),
    status: 'processing',
    active_request_id: request.request_id
  };
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/' + request.request_id + '.json', request],
    ['bridge/claims/' + request.request_id + '.json', priorClaim],
    ['bridge/state/windows-app.json', priorState]
  ] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => { executions++; return { ok: true, result: 'must not run' }; },
    intervalMs: 1000,
    requestReconciliationIntervalMs: 1
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    assert.equal(executions, 0, 'the abandoned local action must never be replayed');
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'needs_manual_recovery');
    assert.match(result.error, /previous worker stopped before publishing/i);
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    assert.equal(claim.status, 'needs_manual_recovery');
    assert.equal(claim.previous_worker_id, 'previous-worker');
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
    await waitFor(() => fake.files.has('bridge/results/req-once.json'));
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
  // The tool can start during poll dispatch, just before start() finishes its
  // heartbeat write. Let that poll return before stop flips the running flag.
  await new Promise(resolve => setImmediate(resolve));
  let stopResolved = false;
  const stopPromise = bridge.stop().then(state => {
    stopResolved = true;
    return state;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopResolved, false, 'stop should wait while the tool is still running');
  releaseExecution({ ok: true, result: 'finished before shutdown' });
  const [startState, stopState] = await Promise.all([startPromise, stopPromise]);
  assert.equal(startState.running, true, 'start returns after dispatching queued requests rather than waiting for them');
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


test('large textual tool output is preserved in retrievable text artifacts with an inline preview', async () => {
  const longText = 'Header line\\n' + 'A'.repeat(1500000) + '\\n' + 'λ🙂'.repeat(8000);
  assert.ok(Buffer.byteLength(longText, 'utf8') > 128 * 1024, 'fixture must exceed the former 128 KiB capture ceiling');
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-large-output',
    created_at: new Date().toISOString(),
    tool: 'read_file',
    args: { path: 'large.txt' }
  };
  const artifactName = 'output-' + require('node:crypto').createHash('sha256').update('output.result.content').digest('hex').slice(0, 12) + '-part-001.txt';
  const artifactPath = 'bridge/artifacts/' + request.request_id + '/' + artifactName;
  const fake = fakeGitHub({
    initial: [['bridge/requests/req-large-output.json', request]],
    transientCreateConflictPaths: [artifactPath]
  });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true, result: { path: 'large.txt', content: longText } }),
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/req-large-output.json'));
    const record = decode(fake.files.get('bridge/results/req-large-output.json'));
    assert.equal(record.status, 'completed', 'the operation completed and the full output was archived');
    assert.equal(record.output_truncated, true, 'the inline field is only a preview');
    const inline = record.result.result.content;
    assert.match(inline, /OUTPUT EXTERNALIZED/);
    assert.match(inline, /Read every listed part in ascending part order/);
    assert.ok(Buffer.byteLength(inline, 'utf8') <= 32 * 1024 + 256);
    const refs = record.artifacts.filter(item => item.kind === 'tool_output_part' && item.field === 'output.result.content');
    assert.ok(refs.length >= 2 && refs.length <= 3,
      'about 1.55 MB of output should require only three artifacts at the 700 KiB payload bound');
    assert.ok(refs.every(ref => ref.bytes <= 700 * 1024 - 1024),
      'every artifact must stay below the Content API bound before base64 encoding');
    assert.equal(record.artifact_errors.length, 0, 'a transient unrelated branch-head conflict must not break artifact publication');
    assert.ok(fake.files.has(artifactPath), 'the artifact should be published after retrying the transient 409');
    assert.equal(
      fake.calls.filter(call => call.method === 'PUT' && call.path === '/repos/test-owner/test-repo/contents/' + artifactPath).length,
      2,
      'the same immutable artifact target should be retried exactly once after the branch-head conflict'
    );
    const recovered = refs.sort((a, b) => a.part - b.part).map(ref => {
      const artifact = fake.files.get(ref.path);
      assert.ok(artifact, 'full output artifact must exist: ' + ref.path);
      return Buffer.from(artifact.content, 'base64').toString('utf8');
    }).join('');
    assert.equal(recovered, longText, 'artifact text must preserve every original byte');
  } finally {
    await bridge.stop();
  }
});


test('mailbox cleanup removes only old terminal request groups and associated artifacts', async () => {
  const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const recentDate = new Date().toISOString();
  function request(id, createdAt) {
    return { protocol: PROTOCOL, request_id: id, created_at: createdAt, tool: 'project_status', args: {} };
  }
  function result(id, completedAt) {
    return { protocol: RESULT_PROTOCOL, request_id: id, tool: 'project_status', status: 'completed',
      output_truncated: false, created_at: oldDate, completed_at: completedAt, result: { ok: true, result: { id } }, artifacts: [], artifact_errors: [] };
  }
  function claim(id, status, completedAt) {
    return { protocol: 'chatgpt-local-repo-claim/v1', request_id: id, worker_id: 'test',
      tool: 'project_status', status, claimed_at: oldDate, completed_at: completedAt, result: { ok: true } };
  }
  const initial = [
    ['bridge/requests/req-cleanup-old.json', request('req-cleanup-old', oldDate)],
    ['bridge/results/req-cleanup-old.json', result('req-cleanup-old', oldDate)],
    ['bridge/claims/req-cleanup-old.json', claim('req-cleanup-old', 'completed', oldDate)],
    ['bridge/artifacts/req-cleanup-old/report.txt', 'old report artifact'],
    ['bridge/artifacts/req-cleanup-old-batch-output-001.json', { request_id: 'req-cleanup-old', steps: [] }],
    ['bridge/requests/req-cleanup-recent.json', request('req-cleanup-recent', recentDate)],
    ['bridge/results/req-cleanup-recent.json', result('req-cleanup-recent', recentDate)],
    ['bridge/claims/req-cleanup-recent.json', claim('req-cleanup-recent', 'completed', recentDate)],
    ['bridge/requests/req-cleanup-processing.json', request('req-cleanup-processing', oldDate)],
    ['bridge/results/req-cleanup-processing.json', result('req-cleanup-processing', oldDate)],
    ['bridge/claims/req-cleanup-processing.json', claim('req-cleanup-processing', 'processing', oldDate)]
  ];
  const fake = fakeGitHub({ initial });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true, result: {} }),
    intervalMs: 5000,
    cleanupIntervalMs: 1000,
    cleanupScanLimit: 100,
    cleanupRecordLimit: 25
  });
  try {
    await bridge.start();
    await waitFor(() => !fake.files.has('bridge/requests/req-cleanup-old.json'), 5000);
    for (const path of [
      'bridge/results/req-cleanup-old.json',
      'bridge/claims/req-cleanup-old.json',
      'bridge/artifacts/req-cleanup-old/report.txt',
      'bridge/artifacts/req-cleanup-old-batch-output-001.json'
    ]) assert.equal(fake.files.has(path), false, 'eligible mailbox record/artifact should be cleaned: ' + path);
    for (const path of [
      'bridge/requests/req-cleanup-recent.json',
      'bridge/results/req-cleanup-recent.json',
      'bridge/claims/req-cleanup-recent.json',
      'bridge/requests/req-cleanup-processing.json',
      'bridge/results/req-cleanup-processing.json',
      'bridge/claims/req-cleanup-processing.json',
      'bridge/state/windows-app.json'
    ]) assert.equal(fake.files.has(path), true, 'recent, active/nonterminal, or state files must be preserved: ' + path);
    const cleanupCalls = fake.calls.filter(call => call.path === '/repos/test-owner/test-repo/git/trees' && call.method === 'POST');
    assert.equal(cleanupCalls.length, 1, 'all eligible deletions should be committed atomically in one Git tree transaction');
    assert.ok(decode(fake.files.get('bridge/state/windows-app.json')).mailbox_cleanup);
  } finally {
    await bridge.stop();
  }
});

test('filesystem index publishes to a stable path and skips unchanged snapshots', async () => {
  const fake = fakeGitHub();
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true })
  });
  const path = 'bridge/context/filesystem-index.md';
  const firstText = '# Filesystem index\n\n"src/"\n"src/app.js"\n';
  const first = await bridge.publishFilesystemIndex({ content: firstText });
  assert.equal(first.path, path);
  assert.equal(first.unchanged, false);
  assert.equal(first.bytes, Buffer.byteLength(firstText, 'utf8'));
  assert.equal(fake.files.has(path), true);

  const putCountAfterFirst = fake.calls.filter(call =>
    call.method === 'PUT' && call.path.endsWith('/contents/' + path)
  ).length;
  const repeated = await bridge.publishFilesystemIndex({ content: firstText });
  assert.equal(repeated.unchanged, true);
  const putCountAfterRepeat = fake.calls.filter(call =>
    call.method === 'PUT' && call.path.endsWith('/contents/' + path)
  ).length;
  assert.equal(putCountAfterRepeat, putCountAfterFirst, 'unchanged filesystem names must not create another commit');

  const secondText = firstText + '"src/new-file.js"\n';
  const second = await bridge.publishFilesystemIndex({ content: secondText });
  assert.equal(second.unchanged, false);
  const indexPuts = fake.calls.filter(call =>
    call.method === 'PUT' && call.path.endsWith('/contents/' + path)
  );
  assert.equal(indexPuts.length, putCountAfterFirst + 1);
  assert.equal(typeof indexPuts.at(-1).body.sha, 'string', 'updates must use the current content SHA');
  assert.equal(Buffer.from(fake.files.get(path).content, 'base64').toString('utf8'), secondText);
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

test('mailbox polling dispatches new requests while a background context refresh is stalled', async () => {
  const fake = fakeGitHub();
  const fixture = settingsFixture();
  let releaseContext;
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  let contextStarted = false;
  let projectStarted = false;
  const requestId = 'req-context-refresh-nonblocking';
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args = {}, callId = '') => {
      if (tool === 'environment_info' && String(callId).startsWith('context-')) {
        contextStarted = true;
        await contextGate;
        return { ok: true, result: { platform: 'win32', os: 'Windows_NT', workspace: process.cwd() } };
      }
      if (tool === 'project_status') {
        projectStarted = true;
        return { ok: true, result: { isGitRepository: false, detectedTechnologies: ['.NET'], topLevelEntries: [] } };
      }
      if (tool === 'get_capabilities') {
        return { ok: true, result: { protocol: 'chatgpt-local-tools-v2', tools: [], tool_calling: { mode: 'repository-mailbox-batch', catalog_version: 1 } } };
      }
      if (tool === 'discover_instructions') return { ok: true, result: { count: 0, instructions: [] } };
      if (tool === 'read_file') return { ok: false, error: 'package.json is not present' };
      return { ok: true, result: { tool } };
    },
    intervalMs: 5000,
    publishContextOnStart: true,
    contextRefreshIntervalMs: 5 * 60 * 1000
  });

  let startPromise;
  try {
    startPromise = bridge.start();
    await waitFor(() => contextStarted, 1500);
    const startupReturned = await Promise.race([
      startPromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 250))
    ]);
    assert.equal(startupReturned, true, 'startup must not wait for the full context refresh');

    const request = {
      protocol: PROTOCOL,
      request_id: requestId,
      created_at: new Date().toISOString(),
      tool: 'project_status',
      args: {}
    };
    const requestPath = 'bridge/requests/' + requestId + '.json';
    fake.files.set(requestPath, {
      name: requestId + '.json',
      path: requestPath,
      type: 'file',
      encoding: 'base64',
      content: encode(request),
      sha: 'sha-injected-request'
    });

    const originalDateNow = Date.now;
    const lastScanAt = Date.parse(bridge.getState().requestPolling.lastRequestTreeScanAt);
    assert.ok(Number.isFinite(lastScanAt), 'the initial request-tree scan should be timestamped');
    Date.now = () => lastScanAt + DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS + 1;
    let pollReturned;
    try {
      pollReturned = await Promise.race([
        bridge.pollOnce().then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 250))
      ]);
    } finally {
      Date.now = originalDateNow;
    }
    assert.equal(pollReturned, true, 'polling must dispatch without awaiting background context collection');
    await waitFor(() => projectStarted, 1500);
    await waitFor(() => fake.files.has('bridge/results/' + requestId + '.json'), 1500);
    const result = decode(fake.files.get('bridge/results/' + requestId + '.json'));
    assert.equal(result.status, 'completed');
    assert.equal(result.result.ok, true);

    releaseContext();
    await waitFor(() => fake.files.has('bridge/context/latest.json'), 2000);
  } finally {
    releaseContext();
    if (startPromise) {
      try { await startPromise; } catch {}
    }
    await bridge.stop();
  }
});

test('environment refresh publishes one compact agent entry and refreshes after workspace changes', async () => {
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
  let workspaceRoot = process.cwd();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => workspaceRoot,
    executeTool: async (tool, args = {}) => {
      calls.push({ tool, args });
      if (tool === 'discover_instructions') {
        return { ok: true, result: { count: 1, instructions: [{ path: 'AGENTS.md', content: 'do not publish this instruction body' }] } };
      }
      if (tool === 'read_file' && args.path === 'package.json') {
        return { ok: true, result: { path: 'package.json', content: JSON.stringify({ name: 'fixture-app', scripts: { test: 'node --test', check: 'node --check index.js' } }) } };
      }
      if (tool === 'get_capabilities') {
        return { ok: true, result: {
          protocol: 'chatgpt-local-tools-v2',
          tools: [{ name: 'read_file', mode: 'read', description: 'Read UTF-8 text', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'], additionalProperties: false } }],
          tool_calling: { mode: 'repository-mailbox-batch', catalog_version: 1 }
        } };
      }
      if (tool === 'project_status') return { ok: true, result: { detectedTechnologies: ['Node.js'], topLevelEntries: ['package.json', 'src', '.git'], isGitRepository: true } };
      if (tool === 'environment_info') return { ok: true, result: { platform: 'win32', os: 'Windows_NT', workspace: workspaceRoot, homeDirectory: 'C:/Users/Private', hostname: 'private-host' } };
      return { ok: true, result: { tool, summary: 'captured' } };
    },
    intervalMs: 5000,
    publishContextOnStart: true,
    contextRefreshIntervalMs: 5 * 60 * 1000
  });

  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/req-refresh-context.json'));
    const index = decode(fake.files.get('bridge/context/latest.json'));
    assert.equal(index.protocol, 'chatgpt-local-environment-context/v1');
    assert.ok(index.files.environment);
    assert.ok(index.files.project);
    assert.ok(index.files.capabilities);
    assert.ok(index.files.project_commands);
    assert.ok(index.files.directory_tree);
    assert.ok(index.files.instructions);
    assert.equal(index.agent_context.protocol, 'chatgpt-local-agent-context/v1');
    assert.match(index.agent_context.tool_failure_contract.no_request, /worker never received/i);
    assert.match(index.agent_context.tool_failure_contract.rejected, /status rejected/i);
    assert.match(index.agent_context.tool_failure_contract.failed, /not automatically safety blocks/i);
    assert.equal(index.agent_context.project_commands.name, 'fixture-app');
    assert.equal(index.agent_context.project_commands.scripts.test, 'node --test');
    assert.ok(index.agent_context.project_commands.suggested.some(item => item.command === 'npm test'));
    assert.equal(index.agent_context.tool_catalog.catalog_version, 1);
    assert.ok(index.agent_context.operating_rules.some(rule => /no request file exists.*do not attribute.*Windows worker/i.test(rule)));
    assert.ok(index.agent_context.operating_rules.some(rule => /not native GitHub MCP function names/i.test(rule)));
    assert.ok(index.agent_context.operating_rules.some(rule => /targeted read-only Windows discovery/i.test(rule)));
    assert.ok(index.agent_context.operating_rules.some(rule => /measurable acceptance criteria and a short implementation plan/i.test(rule)));
    assert.ok(index.agent_context.operating_rules.some(rule => /do not collapse a complex game.*one file/i.test(rule)));
    assert.ok(index.agent_context.operating_rules.some(rule => /run project-native checks and tests/i.test(rule)));
    const invocation = index.agent_context.bridge_invocation;
    assert.equal(invocation.protocol, PROTOCOL);
    assert.equal(invocation.repository.split('/').length, 2);
    assert.ok(invocation.repository.split('/').every(Boolean));
    assert.equal(invocation.branch, 'bridge-mailbox');
    assert.equal(invocation.request_path_template, 'bridge/requests/<request_id>.json');
    assert.equal(invocation.result_path_template, 'bridge/results/<same-request-id>.json');
    assert.equal(invocation.request_example.protocol, PROTOCOL);
    assert.equal(invocation.request_example.tool, 'get_agent_context');
    assert.deepEqual(invocation.request_example.args, {});
    assert.match(invocation.calling_contract, /publish the request JSON.*read the result/i);
    assert.equal(index.agent_context.tool_catalog.tools[0].parameters.properties.path.description, 'Workspace-relative path');
    assert.equal(JSON.stringify(index.agent_context).includes('do not publish this instruction body'), false);
    assert.equal(JSON.stringify(index.agent_context).includes('private-host'), false);
    const instructions = decode(fake.files.get('bridge/context/instructions.json'));
    assert.deepEqual(instructions.data.result.instructions, [{
      path: 'AGENTS.md',
      bytes: Buffer.byteLength('do not publish this instruction body', 'utf8'),
      sha256: require('node:crypto').createHash('sha256').update('do not publish this instruction body').digest('hex')
    }]);
    assert.equal(JSON.stringify(instructions).includes('do not publish this instruction body'), false);
    assert.ok(calls.some(call => call.tool === 'environment_info'));
    assert.equal(calls.some(call => call.tool === 'directory_tree'), false,
      'context refresh must use the maintained index instead of rescanning the workspace');
    assert.equal(index.files.filesystem_index, 'bridge/context/filesystem-index.md');
    assert.equal(index.agent_context.filesystem_index.contents_included, false);
    assert.equal(index.agent_context.filesystem_index.mode, 'names-only');
    const directoryReference = decode(fake.files.get('bridge/context/directory_tree.json'));
    assert.equal(directoryReference.data.result.path, 'bridge/context/filesystem-index.md');
    assert.ok(calls.some(call => call.tool === 'read_file' && call.args.path === 'package.json'));
    const result = decode(fake.files.get('bridge/results/req-refresh-context.json'));
    assert.equal(result.status, 'completed');

    const beforeRefreshes = calls.filter(call => call.tool === 'environment_info').length;
    const firstGeneratedAt = index.generated_at;
    workspaceRoot = path.join(process.cwd(), 'workspace-changed-during-test');
    await new Promise(resolve => setTimeout(resolve, 5));
    await bridge.pollOnce();
    const refreshed = decode(fake.files.get('bridge/context/latest.json'));
    assert.equal(refreshed.generated_at, firstGeneratedAt, 'unchanged context must not generate pointless repository commits');
    assert.equal(calls.filter(call => call.tool === 'environment_info').length, beforeRefreshes + 1);
  } finally {
    await bridge.stop();
  }
});

test('oversized non-batch results are compacted into a bounded partial result', async () => {
  const entries = Array.from({ length: 1800 }, (_, index) => ({
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
    await waitFor(() => fake.files.has('bridge/results/req-structured-result.json'));
    const result = decode(fake.files.get('bridge/results/req-structured-result.json'));
    assert.equal(result.status, 'completed', 'the complete result JSON was archived');
    assert.equal(result.output_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 850 * 1024);
    assert.match(result.output_note, /concatenate UTF-8 parts in ascending part order/);
    const refs = result.artifacts.filter(item => item.kind === 'complete_result_part');
    assert.ok(refs.length >= 2, 'large structured output should be split into retrievable fallback parts');
    const completeJson = refs.sort((a, b) => a.part - b.part).map(ref => {
      const artifact = fake.files.get(ref.path);
      assert.ok(artifact, 'complete result part must exist: ' + ref.path);
      return Buffer.from(artifact.content, 'base64').toString('utf8');
    }).join('');
    const reconstructed = JSON.parse(completeJson);
    const completeEntries = reconstructed.result.result.entries;
    assert.equal(completeEntries.length, entries.length);
    assert.equal(completeEntries[0].detail, entries[0].detail);
    assert.equal(completeEntries[599].detail, entries[599].detail);
    assert.ok(!completeJson.includes('shortened to fit the two-operation result limit'));
  } finally {
    await bridge.stop();
  }
});
