'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous mailbox work.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fakeGitHub({ privateRepo = true, initial = [], requestCommitShaOverride = null, falseConflictCreatePaths = [] } = {}) {
  const files = new Map();
  let nextSha = 1;
  for (const [path, value] of initial) {
    files.set(path, { name: path.split('/').pop(), type: 'file', encoding: 'base64', content: encode(value), sha: 'sha-' + nextSha++ });
  }
  const calls = [];
  const falseConflictPaths = new Set(falseConflictCreatePaths);
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
        assert.deepEqual(query, { sha: 'bridge-mailbox', path: 'bridge/requests', per_page: 1 });
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
      const treePrefix = '/repos/test-owner/test-repo/git/trees/';
      if (method === 'GET' && path.startsWith(treePrefix)) {
        const treeRef = path.slice(treePrefix.length);
        const treePath = treeRef === 'bridge-mailbox' ? '' : treePathsBySha.get(treeRef);
        if (treePath === undefined) throw new Error('Not Found (404)');
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
            ...(isFile ? { sha: files.get(childPath).sha } : {})
          });
        }
        if (children.size) return { status: 200, result: Array.from(children.values()) };
        throw new Error('Not Found (404)');
      }
      if (method === 'PUT') {
        const existing = files.get(rel);
        // Test double: model a one-time GitHub 422 response even though no target
        // file was created, to catch false "already exists" conflict handling.
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
    treeRef: relativePath => treeShaForPath(relativePath)
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
  } finally {
    await bridge.stop();
  }
});

test('periodic request-tree reconciliation finds new requests when the commit cursor is stale', async () => {
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
    intervalMs: 5000,
    requestReconciliationIntervalMs: 1
  });

  try {
    await bridge.start();
    const requestsTreePath = '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/requests');
    const initialTreeReads = fake.calls.filter(call => call.method === 'GET' && call.path === requestsTreePath).length;
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
      'a due reconciliation must re-read the bounded request tree even when the commit cursor is unchanged'
    );
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'completed');
    assert.equal(result.request_id, request.request_id);
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
  const longText = 'Header line\\n' + 'A'.repeat(200000) + '\\n' + 'λ🙂'.repeat(8000);
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
    await waitFor(() => fake.files.has('bridge/results/req-large-output.json'));
    const record = decode(fake.files.get('bridge/results/req-large-output.json'));
    assert.equal(record.status, 'completed', 'the operation completed and the full output was archived');
    assert.equal(record.output_truncated, true, 'the inline field is only a preview');
    const inline = record.result.result.content;
    assert.match(inline, /OUTPUT EXTERNALIZED/);
    assert.match(inline, /Read every listed part in ascending part order/);
    assert.ok(Buffer.byteLength(inline, 'utf8') <= 32 * 1024 + 256);
    const refs = record.artifacts.filter(item => item.kind === 'tool_output_part' && item.field === 'output.result.content');
    assert.ok(refs.length >= 1, 'the result must include a retrievable artifact reference');
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

    const pollReturned = await Promise.race([
      bridge.pollOnce().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 250))
    ]);
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
