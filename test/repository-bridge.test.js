'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createOneDriveMailbox, BRIDGE_DIRECTORIES } = require('../desktop/onedrive-mailbox');
const repositoryBridgeModule = require('../desktop/repository-bridge');
const {
  PROTOCOL,
  RESULT_PROTOCOL,
  DEFAULT_BRANCH,
  DEFAULT_REQUEST_RECONCILIATION_INTERVAL_MS,
  validateConfig,
  validateRequest,
  sanitizeForRepository
} = repositoryBridgeModule;
const createRepositoryBridge = options => repositoryBridgeModule.createRepositoryBridge({
  ...options,
  allowLegacyGitHubMailboxForTests: true
});
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

async function waitForAsync(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous mailbox work.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const DEFAULT_TEST_SESSION_ID = 'session-' + 'c'.repeat(32);

test('result sanitization redacts the active session workspace rather than only the global root', () => {
  const sessionRoot = 'D:\\AgentWorkspaces\\agent-017';
  const report = sanitizeForRepository({
    ok: false,
    error: 'Access denied while opening D:\\AgentWorkspaces\\agent-017\\private\\file.txt'
  }, sessionRoot);
  assert.equal(JSON.stringify(report).includes(sessionRoot), false);
  assert.match(report.error, /<workspace>/);
});



function fakeGitHub({ privateRepo = true, initial = [], requestCommitShaOverride = null,
  falseConflictCreatePaths = [], transientCreateConflictPaths = [], unscopedRequestIds = [],
  contentsNotFoundPaths = [], blobNotFoundShas = [] } = {}) {
  const files = new Map();
  let nextSha = 1;
  const normalizedInitial = initial.map(([path, value]) => {
    if (!path.startsWith('bridge/requests/') || !value || typeof value !== 'object' ||
        value.tool === 'session_start' || value.session_id ||
        unscopedRequestIds.includes(value.request_id)) return [path, value];
    // Most tests focus on worker behavior, so use a standard test lease for
    // old fixtures. Explicit identity tests opt out and exercise rejection.
    return [path, { ...value, session_id: DEFAULT_TEST_SESSION_ID }];
  });
  for (const [path, value] of normalizedInitial) {
    files.set(path, { name: path.split('/').pop(), type: 'file', encoding: 'base64', content: encode(value), sha: 'sha-' + nextSha++ });
  }
  const queuedSessions = new Set();
  for (const [path, stored] of files) {
    if (!path.startsWith('bridge/requests/') || !path.endsWith('.json')) continue;
    let request;
    try { request = decode(stored); } catch { continue; }
    if (request.tool !== 'session_start' && typeof request.session_id === 'string' &&
        /^session-[a-f0-9]{32}$/.test(request.session_id)) queuedSessions.add(request.session_id);
  }
  for (const sessionId of queuedSessions) seedSession(sessionId);

  function seedSession(sessionId = DEFAULT_TEST_SESSION_ID, label = 'Test agent') {
    if (typeof sessionId !== 'string' || !/^session-[a-f0-9]{32}$/.test(sessionId)) throw new Error('Invalid test session ID');
    const sessionPath = 'bridge/sessions/' + sessionId + '.json';
    const existingSession = files.get(sessionPath);
    if (existingSession) return decode(existingSession);
    let agentId = null;
    for (const [filePath, stored] of files) {
      if (!/^bridge\/agents\/agent-[0-9]{3,}\.json$/.test(filePath)) continue;
      try {
        const value = decode(stored);
        if (value.current_session_id === sessionId) { agentId = value.agent_id; break; }
      } catch {}
    }
    if (!agentId) {
      let number = 1;
      do { agentId = 'agent-' + String(number++).padStart(3, '0'); }
      while (files.has('bridge/agents/' + agentId + '.json'));
    }
    const now = new Date().toISOString();
    const seatPath = 'bridge/agents/' + agentId + '.json';
    if (!files.has(seatPath)) {
      const seat = {
        protocol: 'chatgpt-local-agent-seat/v2', agent_id: agentId, current_session_id: sessionId,
        label, status: 'active', created_at: now, updated_at: now, last_activity_at: now,
        last_request_id: null, last_completed_at: null, recent_request_ids: [], active_request_ids: []
      };
      files.set(seatPath, { name: agentId + '.json', path: seatPath, type: 'file', encoding: 'base64', content: encode(seat), sha: 'sha-' + nextSha++ });
    }
    const session = {
      protocol: 'chatgpt-local-agent-session/v1', session_id: sessionId, agent_id: agentId,
      label, status: 'active', created_at: now, updated_at: now, last_activity_at: now,
      last_request_id: null, last_completed_at: null, recent_request_ids: [], active_request_ids: []
    };
    files.set(sessionPath, { name: sessionId + '.json', path: sessionPath, type: 'file', encoding: 'base64', content: encode(session), sha: 'sha-' + nextSha++ });
    return session;
  }
  const calls = [];
  let requestTreeFailuresRemaining = 0;
  const falseConflictPaths = new Set(falseConflictCreatePaths);
  const transientCreateConflictTargets = new Set(transientCreateConflictPaths);
  const contentsNotFoundTargets = new Set(contentsNotFoundPaths);
  const blobNotFoundTargets = new Set(blobNotFoundShas);
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
        return { status: 200, result: { sha: path.slice(restCommitPrefix.length), files: requestPaths.map(filename => ({ filename, status: 'added', sha: files.get(filename)?.sha || null })) } };
      }
      const blobPrefix = '/repos/test-owner/test-repo/git/blobs/';
      if (method === 'GET' && path.startsWith(blobPrefix)) {
        const blobSha = path.slice(blobPrefix.length);
        if (blobNotFoundTargets.has(blobSha)) throw new Error('Not Found (404): simulated missing immutable blob');
        const stored = [...files.values()].find(value => value && value.sha === blobSha);
        if (!stored) throw new Error('Not Found (404)');
        return { status: 200, result: { sha: blobSha, encoding: 'base64', content: stored.content } };
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
        if (contentsNotFoundTargets.has(rel)) throw new Error('Not Found (404): simulated stale Contents path');
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
    githubAuth, files, calls, seedSession,
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

test('production bridge refuses to fall back to the GitHub mailbox', () => {
  assert.throws(
    () => repositoryBridgeModule.createRepositoryBridge({
      getSettings: () => ({ repositoryBridge: {} }),
      persistSettings: () => {},
      getWorkspaceRoot: () => process.cwd(),
      executeTool: async () => ({ ok: true })
    }),
    /existing OneDrive-synchronized Bridge mailbox is required; GitHub is not a mailbox fallback/
  );
});

test('request validation bootstraps sessions once and requires the session ID for every other tool', () => {
  const base = {
    protocol: PROTOCOL,
    request_id: 'req-20261024-001',
    created_at: '2026-10-24T04:00:00Z',
    tool: 'project_status',
    args: {}
  };
  const sessionId = 'session-' + 'a'.repeat(32);
  const ordinary = { ...base, session_id: sessionId };
  assert.deepEqual(validateRequest(ordinary.request_id, ordinary), {
    request_id: ordinary.request_id, tool: 'project_status', args: {}, session_id: sessionId
  });
  assert.throws(() => validateRequest(base.request_id, base), /SESSION_ID_REQUIRED/);
  const bootstrap = { ...base, tool: 'session_start', args: {} };
  assert.deepEqual(validateRequest(bootstrap.request_id, bootstrap), {
    request_id: bootstrap.request_id, tool: 'session_start', args: {}
  });
  const suggestion = { path: process.cwd(), reason: 'The active application repository is the requested implementation target.' };
  const suggestedBootstrap = { ...base, tool: 'session_start', args: { workspace_suggestion: suggestion } };
  assert.deepEqual(validateRequest(suggestedBootstrap.request_id, suggestedBootstrap).args.workspace_suggestion, suggestion);
  assert.throws(() => validateRequest('bad-workspace-suggestion', {
    ...suggestedBootstrap, request_id: 'bad-workspace-suggestion',
    args: { workspace_suggestion: { ...suggestion, untrusted_extra: true } }
  }), /grounded path and reason/i);
  assert.throws(() => validateRequest('bad-workspace-path', {
    ...suggestedBootstrap, request_id: 'bad-workspace-path',
    args: { workspace_suggestion: { path: '', reason: 'No grounded path' } }
  }), /grounded path and reason/i);
  assert.throws(() => validateRequest('different-id', ordinary), /does not match/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, protocol: 'wrong' }), /protocol/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, args: { arbitraryShell: 'whoami' } }), /unsupported argument/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, tool: 'github_api', args: { method: 'PUT' } }), /unsupported local tool/i);
  assert.throws(() => validateRequest('../bad-id', { ...ordinary, request_id: '../bad-id' }), /invalid ID/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, session_id: 'not-a-session' }), /session_id has an invalid format/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, agent_id: 'agent-001' }), /legacy agent_id\/agent_token/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, agent_token: 'a'.repeat(64) }), /legacy agent_id\/agent_token/i);
  assert.throws(() => validateRequest(base.request_id, { ...bootstrap, session_id: sessionId }), /bootstrap request and must omit session_id/i);
  assert.throws(() => validateRequest(base.request_id, { ...ordinary, tool: 'agent_register' }), /unsupported local tool/i);
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

test('concurrent session bootstrap allocates distinct conversation IDs and reusable seats', async () => {
  const makeBootstrap = requestId => ({
    protocol: PROTOCOL, request_id: requestId, created_at: new Date().toISOString(),
    tool: 'session_start', args: {}
  });
  const first = makeBootstrap('session-start-first');
  const second = makeBootstrap('session-start-second');
  const fake = fakeGitHub({ initial: [
    ['bridge/requests/' + first.request_id + '.json', first],
    ['bridge/requests/' + second.request_id + '.json', second]
  ] });
  const fixture = settingsFixture();
  let localExecutions = 0;
  const assignedWorkspaces = [];
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    requestSessionAssignment: async () => ({ autoAssign: true, agent_id: null, workspace_root: null, message: '' }),
    onSessionAssigned: async assignment => { assignedWorkspaces.push(assignment); },
    executeTool: async (tool, args, id) => { localExecutions++; return { ok: true, tool, call_id: id }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + first.request_id + '.json') &&
      fake.files.has('bridge/results/' + second.request_id + '.json'));
    const resultA = decode(fake.files.get('bridge/results/' + first.request_id + '.json'));
    const resultB = decode(fake.files.get('bridge/results/' + second.request_id + '.json'));
    const sessionA = resultA.result.result;
    const sessionB = resultB.result.result;
    assert.notEqual(sessionA.session_id, sessionB.session_id);
    assert.match(sessionA.session_id, /^session-[a-f0-9]{32}$/);
    assert.match(sessionB.session_id, /^session-[a-f0-9]{32}$/);
    assert.deepEqual([sessionA.agent_id, sessionB.agent_id].sort(), ['agent-001', 'agent-002']);
    assert.equal(resultA.session_id, sessionA.session_id);
    assert.equal(resultB.session_id, sessionB.session_id);
    assert.equal(resultA.agent_id, sessionA.agent_id);
    assert.equal(resultB.agent_id, sessionB.agent_id);
    for (const session of [sessionA, sessionB]) {
      const seat = decode(fake.files.get('bridge/agents/' + session.agent_id + '.json'));
      const sessionRecord = decode(fake.files.get('bridge/sessions/' + session.session_id + '.json'));
      assert.equal(seat.protocol, 'chatgpt-local-agent-seat/v2');
      assert.equal(seat.current_session_id, session.session_id);
      assert.equal(seat.status, 'active');
      assert.equal(sessionRecord.protocol, 'chatgpt-local-agent-session/v1');
      assert.equal(sessionRecord.session_id, session.session_id);
      assert.equal('token_hash' in seat, false);
    }
    const claimA = decode(fake.files.get('bridge/claims/' + first.request_id + '.json'));
    const claimB = decode(fake.files.get('bridge/claims/' + second.request_id + '.json'));
    assert.equal(claimA.agent_id, sessionA.agent_id);
    assert.equal(claimB.agent_id, sessionB.agent_id);
    assert.deepEqual(assignedWorkspaces.map(item => ({ agent_id: item.agent_id, workspace_root: item.workspace_root })).sort((a, b) => a.agent_id.localeCompare(b.agent_id)), [
      { agent_id: 'agent-001', workspace_root: null },
      { agent_id: 'agent-002', workspace_root: null }
    ], 'auto-assignment leaves workspace resolution to the selected agent seat default');
    assert.equal(localExecutions, 0, 'mailbox session management never enters the workspace tool runner');
  } finally { await bridge.stop(); }
});

test('OneDrive mailbox bootstraps app-local sessions and routes ordinary requests by agent', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-bridge-onedrive-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const runtime = path.join(temp, 'OneDrive', 'Bridge');
  await fs.mkdir(runtime, { recursive: true });
  const settings = { repositoryBridge: { oneDrivePath: runtime, retentionDays: 30 } };
  const persistSettings = () => true;
  const mailbox = createOneDriveMailbox({ getSettings: () => settings });
  await mailbox.ensureReady();

  const bootstrapId = 'req-onedrive-session-bootstrap';
  await mailbox.writeJson('request/agent-000/' + bootstrapId + '.json', {
    protocol: PROTOCOL, request_id: bootstrapId, created_at: new Date().toISOString(),
    tool: 'session_start', args: { label: 'OneDrive integration test' }
  }, null, true);

  const bridge = createRepositoryBridge({
    mailbox,
    githubAuth: async () => { throw new Error('GitHub must not be used for OneDrive mailbox transport.'); },
    getSettings: () => settings,
    persistSettings,
    getWorkspaceRoot: () => temp,
    requestSessionAssignment: async () => ({ autoAssign: true, agent_id: null, workspace_root: temp, message: '' }),
    onSessionAssigned: async () => {},
    executeTool: async (tool, args) => {
      if (tool === 'get_capabilities') return { ok: true, result: { catalog_version: 1, tools: [], tool_calling: {} } };
      assert.equal(tool, 'environment_info');
      return { ok: true, result: { platform: 'win32', workspace: temp, checked: true } };
    },
    intervalMs: 5000,
    publishContextOnStart: true,
    requestReconciliationIntervalMs: 1
  });
  try {
    await bridge.start();
    await waitForAsync(async () => {
      const current = await mailbox.readJson('result/agent-000/' + bootstrapId + '.json');
      return Boolean(current && ['completed', 'failed', 'rejected', 'cancelled', 'partial'].includes(current.value.status));
    }, 5000);
    const bootstrapResult = (await mailbox.readJson('result/agent-000/' + bootstrapId + '.json')).value;
    assert.equal(bootstrapResult.status, 'completed',
      'bootstrap should complete locally; worker state: ' + JSON.stringify(bridge.getState()) +
      '; session registry keys: ' + JSON.stringify(Object.keys(settings.agentRegistryRecords || {})) +
      '; result: ' + JSON.stringify(bootstrapResult));
    const sessionId = bootstrapResult.result.result.session_id;
    const agentId = bootstrapResult.result.result.agent_id;
    assert.match(sessionId, /^session-[a-f0-9]{32}$/);
    assert.match(agentId, /^agent-[0-9]{3,}$/);
    assert.ok(settings.agentRegistryRecords['local/sessions/' + sessionId + '.json']);
    assert.ok(settings.agentRegistryRecords['local/agents/' + agentId + '.json']);
    assert.ok(await mailbox.readJson('claims/agent-000/' + bootstrapId + '.json'));

    const requestId = 'req-onedrive-agent-work';
    await mailbox.writeJson('request/' + agentId + '/' + requestId + '.json', {
      protocol: PROTOCOL, request_id: requestId, created_at: new Date().toISOString(),
      session_id: sessionId, tool: 'environment_info', args: {}
    }, null, true);
    await bridge.pollOnce();
    await waitForAsync(async () => (await mailbox.readJson('result/' + agentId + '/' + requestId + '.json'))?.value?.status === 'completed');
    const result = (await mailbox.readJson('result/' + agentId + '/' + requestId + '.json')).value;
    assert.equal(result.request_id, requestId);
    assert.equal(result.status, 'completed');
    assert.ok(await mailbox.readJson('claims/' + agentId + '/' + requestId + '.json'));
    assert.equal(result.result.result.platform, 'win32');
    const projectRequestId = 'req-onedrive-task-project';
    await mailbox.writeJson('request/' + agentId + '/' + projectRequestId + '.json', {
      protocol: PROTOCOL, request_id: projectRequestId, created_at: new Date().toISOString(),
      session_id: sessionId, tool: 'task_project_init', args: { name: 'OneDrive app-local coordination' }
    }, null, true);
    await bridge.pollOnce();
    await waitForAsync(async () => {
      const value = await mailbox.readJson('result/' + agentId + '/' + projectRequestId + '.json');
      return Boolean(value && ['completed', 'failed', 'rejected'].includes(value.value.status));
    });
    const projectResult = (await mailbox.readJson('result/' + agentId + '/' + projectRequestId + '.json')).value;
    assert.equal(projectResult.status, 'completed', JSON.stringify(projectResult));
    const projectId = projectResult.result.result.project_id;
    assert.ok(settings.agentRegistryRecords['local/projects/' + projectId + '.json']);

    const taskRequestId = 'req-onedrive-task-create';
    await mailbox.writeJson('request/' + agentId + '/' + taskRequestId + '.json', {
      protocol: PROTOCOL, request_id: taskRequestId, created_at: new Date().toISOString(),
      session_id: sessionId, tool: 'task_create', args: {
        project_id: projectId, title: 'Verify local persistence', objective: 'Create a task in the Windows app registry',
        acceptance_criteria: ['Task is stored in app settings'], scope_paths: ['src/bridge']
      }
    }, null, true);
    await bridge.pollOnce();
    await waitForAsync(async () => {
      const value = await mailbox.readJson('result/' + agentId + '/' + taskRequestId + '.json');
      return Boolean(value && ['completed', 'failed', 'rejected'].includes(value.value.status));
    });
    const taskResult = (await mailbox.readJson('result/' + agentId + '/' + taskRequestId + '.json')).value;
    assert.equal(taskResult.status, 'completed', JSON.stringify(taskResult));
    const taskId = taskResult.result.result.task_id;
    assert.ok(settings.agentRegistryRecords['local/tasks/' + taskId + '.json']);
    assert.equal((await fs.readdir(runtime)).some(name => ['tasks', 'projects', 'sessions', 'agents'].includes(name)), false);
    const status = await mailbox.readContent('STATUS.md');
    const statusText = status.content.toString('utf8');
    assert.match(statusText, /^# Windows Bridge Status/m);
    assert.match(statusText, /Agent inventory/);
    assert.match(statusText, new RegExp(agentId));
    assert.doesNotMatch(statusText, new RegExp(sessionId));
    assert.match(statusText, /Registered tools/);

    const rootEntries = (await fs.readdir(runtime)).sort();
    const allowed = [...BRIDGE_DIRECTORIES, 'AGENT.md', 'TOOLS.md', 'STATUS.md'].sort();
    assert.deepEqual(rootEntries, allowed);
    assert.equal(rootEntries.some(name => ['runtime', 'bridge', 'context', 'state', 'agents', 'sessions', 'tasks', 'projects', 'vision', 'artifacts', 'docs'].includes(name)), false);
    assert.deepEqual((await mailbox.listFolder('request')).map(item => item.name).sort(), ['agent-000', agentId].sort());
    assert.equal((await mailbox.listFolder('claims')).every(item => item.type === 'dir'), true);
    assert.equal((await mailbox.listFolder('result')).every(item => item.type === 'dir'), true);
  } finally {
    await bridge.stop();
  }
});

test('session_start forwards a grounded workspace suggestion and honors an explicit automatic-assignment workspace', async () => {
  const suggestion = { path: process.cwd(), reason: 'The current task targets this checked-out repository.' };
  const request = {
    protocol: PROTOCOL, request_id: 'session-start-workspace-suggestion',
    created_at: new Date().toISOString(), tool: 'session_start',
    args: { workspace_suggestion: suggestion }
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + request.request_id + '.json', request]] });
  const fixture = settingsFixture();
  let assignmentOptions = null;
  let assigned = null;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    requestSessionAssignment: async options => {
      assignmentOptions = options;
      return { autoAssign: true, agent_id: null, workspace_root: process.cwd(), message: '' };
    },
    onSessionAssigned: async value => { assigned = value; },
    executeTool: async () => { throw new Error('session_start must not invoke workspace tools'); },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.deepEqual(assignmentOptions.workspaceSuggestion, suggestion);
    assert.equal(assigned.workspace_root, process.cwd());
    assert.equal(result.result.result.workspace_root, '<workspace>', 'the mailbox result redacts the selected local workspace path');
    assert.equal(result.result.result.assignment_mode, 'automatic-confirmed');
  } finally { await bridge.stop(); }
});

test('a dismissed or unanswered session assignment fails without creating or returning a session ID', async () => {
  const request = {
    protocol: PROTOCOL, request_id: 'session-start-no-assignment',
    created_at: new Date().toISOString(), tool: 'session_start', args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + request.request_id + '.json', request]] });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    // Omit requestSessionAssignment to prove the default is fail-closed.
    executeTool: async () => { throw new Error('session_start must not execute a workspace tool'); },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.result.ok, false);
    assert.match(result.result.error, /SESSION_ASSIGNMENT_CANCELLED/);
    assert.match(result.result.error, /no session_id was created/i);
    assert.equal(result.result.result, undefined);
    assert.equal([...fake.files.keys()].some(file => file.startsWith('bridge/sessions/')), false);
  } finally { await bridge.stop(); }
});

test('session identity appears in claim/result and recent activity stays separate from busy state', async () => {
  const agentId = 'agent-001';
  const sessionId = 'session-' + 'b'.repeat(32);
  const now = new Date().toISOString();
  const seat = {
    protocol: 'chatgpt-local-agent-seat/v2', agent_id: agentId, current_session_id: sessionId,
    label: 'Agent 1', status: 'active', created_at: now, updated_at: now, last_activity_at: now,
    last_request_id: null, last_completed_at: null, recent_request_ids: [], active_request_ids: []
  };
  const session = {
    protocol: 'chatgpt-local-agent-session/v1', session_id: sessionId, agent_id: agentId,
    label: 'Agent 1', status: 'active', created_at: now, updated_at: now, last_activity_at: now,
    last_request_id: null, last_completed_at: null, recent_request_ids: [], active_request_ids: []
  };
  const request = {
    protocol: PROTOCOL, request_id: 'session-agent001-project-status-test', session_id: sessionId,
    created_at: now, tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [
    ['bridge/agents/' + agentId + '.json', seat],
    ['bridge/sessions/' + sessionId + '.json', session],
    ['bridge/requests/' + request.request_id + '.json', request]
  ] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => { executions++; return { ok: true, tool, call_id: id, result: { ready: true } }; },
    intervalMs: 5000
  });
  try {
    await bridge.start();
    await waitFor(() => {
      if (!fake.files.has('bridge/results/' + request.request_id + '.json')) return false;
      const updated = fake.files.get('bridge/agents/' + agentId + '.json');
      const current = updated && decode(updated);
      return current && current.status === 'active' && current.active_request_ids.length === 0 &&
        current.recent_request_ids.includes(request.request_id);
    });
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    const updatedSeat = decode(fake.files.get('bridge/agents/' + agentId + '.json'));
    const updatedSession = decode(fake.files.get('bridge/sessions/' + sessionId + '.json'));
    assert.equal(executions, 1);
    assert.equal(result.agent_id, agentId);
    assert.equal(result.session_id, sessionId);
    assert.equal(claim.agent_id, agentId);
    assert.equal(claim.session_id, sessionId);
    assert.equal(updatedSeat.current_session_id, sessionId);
    assert.equal(updatedSeat.last_request_id, request.request_id);
    assert.deepEqual(updatedSeat.active_request_ids, []);
    assert.ok(updatedSeat.recent_request_ids.includes(request.request_id));
    assert.equal(updatedSession.last_request_id, request.request_id);
    assert.deepEqual(updatedSession.active_request_ids, []);
    const state = bridge.getState();
    const status = state.agentStatus.find(item => item.agent_id === agentId);
    assert.equal(status.status, 'active');
    assert.equal(status.busy, false);
    const mailbox = state.agentMailboxes.find(item => item.agent_id === agentId);
    assert.ok(mailbox, 'agent seat appears in the mailbox monitor');
    const task = mailbox.requests.find(item => item.request_id === request.request_id);
    assert.ok(task, 'executed request appears in its agent console');
    assert.equal(task.tool, 'project_status');
    assert.equal(task.status, 'completed');
    assert.equal(task.progress, 100);
    assert.ok(task.request_json.includes('"session_id": "' + sessionId + '"'));
    assert.doesNotMatch(task.request_json, /agent_token|token_hash/);
    assert.ok(task.claim_json.includes(request.request_id));
    assert.ok(task.claim_json.includes(sessionId));
    assert.ok(task.result_json.includes('"status": "completed"'));
    assert.ok(task.result_json.includes(sessionId));
    assert.doesNotMatch(state.lastError, /Agent status update failed/i);
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
    assert.ok(createCommits.length >= 4, 'agent record, claim, result and state are committed');
    assert.equal(fake.files.has('bridge/agents/.gitkeep'), false,
      'worker startup does not create placeholder records before polling; the agent directory is created by real agent records when needed');
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


test('worker reads a tree-discovered request by immutable Git blob SHA when Contents returns 404', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-request-blob-fallback',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const requestPath = 'bridge/requests/' + request.request_id + '.json';
  const fake = fakeGitHub({
    initial: [[requestPath, request]],
    contentsNotFoundPaths: [requestPath]
  });
  // GitHub tree entries expose the 40-character immutable blob SHA even when
  // a branch-scoped Contents read is temporarily stale or reports 404.
  const discoveredBlobSha = 'b'.repeat(40);
  fake.files.get(requestPath).sha = discoveredBlobSha;
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
      return { ok: true, tool, call_id: id, result: { discovered: true } };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    assert.equal(executions, 1, 'a request visible in the tree must not be silently dropped after a Contents 404');
    assert.ok(fake.calls.some(call =>
      call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/git/blobs/' + discoveredBlobSha
    ), 'the worker should fetch the immutable blob identified by the request tree');
    assert.equal(fake.calls.some(call =>
      call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/contents/' + requestPath
    ), false, 'the successful immutable blob path should not depend on the stale Contents endpoint');
    const result = decode(fake.files.get('bridge/results/' + request.request_id + '.json'));
    assert.equal(result.status, 'completed');
    assert.equal(result.request_id, request.request_id);
    const claim = decode(fake.files.get('bridge/claims/' + request.request_id + '.json'));
    assert.equal(claim.status, 'completed');
    const mailbox = bridge.getState().agentMailboxes.find(item => item.agent_id === 'agent-001');
    assert.ok(mailbox, 'the request should be attributed to its session and appear in the agent widget');
    const rendered = mailbox.requests.find(item => item.request_id === request.request_id);
    assert.ok(rendered, 'the request should appear in the agent widget');
    assert.equal(rendered.status, 'completed');
    assert.ok(rendered.request_json.includes(request.request_id), 'the widget should contain the actual request JSON');
    assert.ok(rendered.claim_json.includes(request.request_id), 'the widget should contain its matching claim');
    assert.ok(rendered.result_json.includes(request.request_id), 'the widget should contain its matching result');
  } finally {
    await bridge.stop();
  }
});

test('worker surfaces a discovered request read failure instead of silently dropping it', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-request-read-failure-visible',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const requestPath = 'bridge/requests/' + request.request_id + '.json';
  const unavailableBlobSha = 'c'.repeat(40);
  const fake = fakeGitHub({
    initial: [[requestPath, request]],
    contentsNotFoundPaths: [requestPath],
    blobNotFoundShas: [unavailableBlobSha]
  });
  fake.files.get(requestPath).sha = unavailableBlobSha;
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth,
    ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => {
      executions++;
      return { ok: true };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await waitFor(() => bridge.getState().lastError.includes('REQUEST_FILE_UNAVAILABLE'));
    assert.equal(executions, 0);
    assert.equal(fake.files.has('bridge/claims/' + request.request_id + '.json'), false);
    assert.equal(fake.files.has('bridge/results/' + request.request_id + '.json'), false);
    const rendered = bridge.getState().agentMailboxes
      .flatMap(item => item.requests || [])
      .find(item => item.request_id === request.request_id);
    assert.ok(rendered, 'the undispatched request still needs a visible diagnostic row');
    assert.equal(rendered.status, 'failed');
    assert.match(rendered.error, /REQUEST_FILE_UNAVAILABLE/);
  } finally {
    await bridge.stop();
  }
});

test('stale in-flight mailbox poll is detached and recovered without an old poll clearing the new one', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-stalled-poll-recovery',
    created_at: new Date().toISOString(),
    tool: 'project_status',
    args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + request.request_id + '.json', request]] });
  const fixture = settingsFixture();
  let executions = 0;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth,
    ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id) => {
      executions++;
      return { ok: true, tool, call_id: id };
    },
    intervalMs: 5000,
    requestReconciliationIntervalMs: 1,
    stalledOperationRecoveryMs: 15
  });

  let releaseBlockedRead;
  const blockedRead = new Promise(resolve => { releaseBlockedRead = resolve; });
  const requestsTreePath = '/repos/test-owner/test-repo/git/trees/' + fake.treeRef('bridge/requests');
  const originalRequestApi = fake.githubAuth.requestApi;
  let blockNextTreeRead = false;
  let blockedReadStarted = false;
  fake.githubAuth.requestApi = async input => {
    if (blockNextTreeRead && !blockedReadStarted &&
        input.method === 'GET' && input.path === requestsTreePath) {
      blockedReadStarted = true;
      await blockedRead;
    }
    return originalRequestApi(input);
  };

  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/' + request.request_id + '.json'));
    await waitFor(() => !bridge.getState().requestPolling.pollInFlight);
    await new Promise(resolve => setTimeout(resolve, 5));

    blockNextTreeRead = true;
    const abandonedPoll = bridge.pollOnce();
    await waitFor(() => blockedReadStarted && bridge.getState().requestPolling.pollInFlight);
    const staleStartedAt = bridge.getState().requestPolling.pollStartedAt;
    await new Promise(resolve => setTimeout(resolve, 25));

    const recovery = bridge.recoverStalledPolling();
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.stalePoll, true);
    await waitFor(() => !bridge.getState().requestPolling.pollInFlight &&
      bridge.getState().lastPollAt !== null &&
      Date.parse(bridge.getState().lastPollAt) >= Date.parse(staleStartedAt));

    releaseBlockedRead();
    await abandonedPoll;
    assert.equal(bridge.getState().requestPolling.pollInFlight, false,
      'late completion from the detached poll must not change the recovered poll state');
    assert.equal(executions, 1, 'poll recovery must not execute a request twice');
  } finally {
    releaseBlockedRead();
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
  // Match the real mailbox layout: request polling happens within an existing
  // requests directory instead of relying on startup to create a placeholder.
  const fake = fakeGitHub({ initial: [['bridge/requests/.gitkeep', { purpose: 'test mailbox directory' }]] });
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
      session_id: DEFAULT_TEST_SESSION_ID,
      created_at: new Date().toISOString(),
      tool: 'project_status',
      args: {}
    };
    const requestPath = 'bridge/requests/' + request.request_id + '.json';
    fake.seedSession(request.session_id);
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
    session_id: DEFAULT_TEST_SESSION_ID,
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
    const discoveredBlobSha = 'd'.repeat(40);
    fake.seedSession(initial.session_id);
    fake.files.set(requestPath, {
      name: initial.request_id + '.json',
      path: requestPath,
      type: 'file',
      encoding: 'base64',
      content: encode(initial),
      sha: discoveredBlobSha
    });

    await waitFor(() => fake.files.has('bridge/results/' + initial.request_id + '.json'), 3500);
    assert.equal(executions, 1, 'the request from the recent commit should execute exactly once');
    assert.equal(bridge.getState().requestPolling.requestTreeScanCount, initialTreeScanCount,
      'fast pickup must not require another full request-folder tree read');
    assert.ok(fake.calls.some(call => call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/commits/' + String(1).padStart(40, '0')),
    'the fast path should inspect the changed commit file list');
    assert.ok(fake.calls.some(call => call.method === 'GET' &&
      call.path === '/repos/test-owner/test-repo/git/blobs/' + discoveredBlobSha),
    'the commit fast path must forward the immutable request blob SHA into dispatch');
    assert.equal(decode(fake.files.get('bridge/results/' + initial.request_id + '.json')).status, 'completed');
  } finally {
    await bridge.stop();
  }
});


test('worker drains queued mailbox requests without a folder re-read for every completion', async () => {
  const requests = Array.from({ length: 80 }, (_, index) => ({
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
    assert.equal(executions, 80);
    assert.equal(maximumActive, 64, 'the worker should fill its configured 64-request limit, then refill from its local queue');
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
  ], unscopedRequestIds: [first.request_id] });
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
  const longText = 'Header line\n' + 'A'.repeat(1500000) + '\n' + 'λ🙂'.repeat(8000);
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

test('message retention deletes only expired messages with valid read receipts', async () => {
  const now = Date.now();
  const oldTimestamp = String(now - 60 * 24 * 60 * 60 * 1000).padStart(13, '0');
  const recentTimestamp = String(now).padStart(13, '0');
  const sessionId = 'session-' + 'b'.repeat(32);
  const oldReadId = 'msg-' + oldTimestamp + '-' + 'a'.repeat(32);
  const oldUnreadId = 'msg-' + oldTimestamp + '-' + 'c'.repeat(32);
  const recentReadId = 'msg-' + recentTimestamp + '-' + 'd'.repeat(32);
  const nowIso = new Date().toISOString();
  const session = {
    protocol: 'chatgpt-local-agent-session/v1', session_id: sessionId, agent_id: 'agent-001',
    label: 'Retention test session', status: 'active', created_at: nowIso, updated_at: nowIso,
    last_activity_at: nowIso, active_request_ids: [], recent_request_ids: []
  };
  const seat = {
    protocol: 'chatgpt-local-agent-seat/v2', agent_id: 'agent-001', current_session_id: sessionId,
    label: 'Retention test session', status: 'active', created_at: nowIso, updated_at: nowIso,
    last_activity_at: nowIso, active_request_ids: [], recent_request_ids: []
  };
  const message = (messageId, createdAt) => ({
    protocol: 'chatgpt-local-agent-message/v1', message_id: messageId, thread_id: messageId,
    sender_session_id: 'session-' + 'e'.repeat(32), sender_agent_id: 'agent-002',
    recipient_session_id: sessionId, recipient_agent_id: 'agent-001', subject: 'retention test',
    message: 'test message', created_at: createdAt, in_reply_to: null, read_at: null
  });
  const receipt = messageId => ({
    protocol: 'chatgpt-local-agent-message-receipt/v1', message_id: messageId,
    recipient_session_id: sessionId, created_at: nowIso, read_at: nowIso
  });
  const oldDate = new Date(Number(oldTimestamp)).toISOString();
  const recentDate = new Date(Number(recentTimestamp)).toISOString();
  const fake = fakeGitHub({ initial: [
    ['bridge/sessions/' + sessionId + '.json', session],
    ['bridge/agents/agent-001.json', seat],
    ['messages/agent-001/' + oldReadId + '.json', message(oldReadId, oldDate)],
    ['messages/agent-001/' + oldReadId + '.read.json', receipt(oldReadId)],
    ['messages/agent-001/' + oldUnreadId + '.json', message(oldUnreadId, oldDate)],
    ['messages/agent-001/' + recentReadId + '.json', message(recentReadId, recentDate)],
    ['messages/agent-001/' + recentReadId + '.read.json', receipt(recentReadId)]
  ] });
  const fixture = settingsFixture();
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture, getWorkspaceRoot: () => process.cwd(),
    executeTool: async () => ({ ok: true, result: {} }), intervalMs: 5000, cleanupIntervalMs: 1000
  });
  try {
    await bridge.start();
    await waitFor(() => !fake.files.has('messages/agent-001/' + oldReadId + '.json'), 5000);
    assert.equal(fake.files.has('messages/agent-001/' + oldReadId + '.json'), false);
    assert.equal(fake.files.has('messages/agent-001/' + oldReadId + '.read.json'), false);
    assert.equal(fake.files.has('messages/agent-001/' + oldUnreadId + '.json'), true, 'old unread messages must be retained');
    assert.equal(fake.files.has('messages/agent-001/' + recentReadId + '.json'), true, 'recent read messages must be retained');
    assert.equal(fake.files.has('messages/agent-001/' + recentReadId + '.read.json'), true);
  } finally { await bridge.stop(); }
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
        return { ok: true, result: { protocol: 'chatgpt-local-tools-v2', tools: [], tool_calling: { mode: 'onedrive-mailbox-batch', catalog_version: 1 } } };
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
      session_id: DEFAULT_TEST_SESSION_ID,
      created_at: new Date().toISOString(),
      tool: 'project_status',
      args: {}
    };
    const requestPath = 'bridge/requests/' + requestId + '.json';
    fake.seedSession(request.session_id);
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

test('environment refresh publishes only the canonical AGENT.md and complete TOOLS.md guides', async () => {
  const request = {
    protocol: PROTOCOL,
    request_id: 'req-refresh-context',
    created_at: new Date().toISOString(),
    tool: 'session_start',
    args: { label: 'Context publication test' }
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/req-refresh-context.json', request]] });
  const fixture = settingsFixture();
  const calls = [];
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    requestSessionAssignment: async () => ({ autoAssign: true, agent_id: null, workspace_root: process.cwd(), message: '' }),
    onSessionAssigned: async () => {},
    executeTool: async (tool, args = {}) => {
      calls.push({ tool, args });
      if (tool === 'get_capabilities') return { ok: true, result: {
        catalog_version: 7,
        tools: [{
          name: 'read_file', mode: 'read', description: 'Read UTF-8 text from the Windows workspace.',
          permission_note: 'Read-only; no approval required.', returns: 'Content and pagination metadata.',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } },
            required: ['path'], additionalProperties: false }
        }],
        tool_calling: { mode: 'onedrive-mailbox-batch', rule: 'Up to 100 operations.', reference_syntax: '{"$ref":"priorStepId.result.content"}' }
      } };
      return { ok: true, result: { tool } };
    },
    intervalMs: 5000,
    publishContextOnStart: true,
    contextRefreshIntervalMs: 5 * 60 * 1000
  });
  try {
    await bridge.start();
    await waitFor(() => fake.files.has('bridge/results/req-refresh-context.json'));
    const agent = Buffer.from(fake.files.get('AGENT.md').content, 'base64').toString('utf8');
    const tools = Buffer.from(fake.files.get('TOOLS.md').content, 'base64').toString('utf8');
    assert.match(agent, /Windows Bridge operating guide/);
    assert.match(agent, /OneDrive is file storage and message transport only/);
    assert.match(agent, /request\/agent-000/);
    assert.match(agent, /claims\/<agent-id>/);
    assert.match(agent, /app persistent local settings store/);
    assert.match(agent, /project, and task coordination records/);
    assert.match(agent, /10,000 sessions/);
    assert.match(agent, /SCREEN.md/);
    assert.match(agent, /Slash-style shortcuts/);
    assert.match(agent, /\/status/);
    assert.match(agent, /\/agents/);
    assert.doesNotMatch(agent, /Bridge\/runtime|bridge\/context|capabilities\.json/);
    assert.match(tools, /Windows Bridge tool reference/);
    assert.match(tools, /Catalog version: 7/);
    assert.match(tools, /read_file/);
    assert.match(tools, /Read UTF-8 text from the Windows workspace/);
    assert.match(tools, /Permission requirements: Read-only; no approval required/);
    assert.match(tools, /"path": \{/);
    assert.match(tools, /Argument schema/);
    assert.match(tools, /Up to 100 operations/);
    assert.equal(fake.files.has('bridge/context/latest.json'), false);
    assert.equal(fake.files.has('bridge/context/TOOLS.md'), false);
    assert.equal(calls.filter(call => call.tool === 'get_capabilities').length >= 1, true);
    assert.equal(decode(fake.files.get('bridge/results/req-refresh-context.json')).status, 'completed');
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


test('revoking an in-flight agent session aborts its local tool and publishes a cancelled result', async () => {
  const requestId = 'req-revoke-inflight';
  const request = {
    protocol: PROTOCOL, request_id: requestId, session_id: DEFAULT_TEST_SESSION_ID,
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + requestId + '.json', request]] });
  const fixture = settingsFixture();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let capturedSignal = null;
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id, sessionId, signal) => {
      assert.equal(tool, 'project_status');
      assert.equal(sessionId, DEFAULT_TEST_SESSION_ID);
      capturedSignal = signal;
      markStarted();
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      return { ok: true, result: { shouldNotPublish: true } };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await waitFor(() => Boolean(capturedSignal), 2000);
    assert.ok(capturedSignal && !capturedSignal.aborted);

    const revoked = await bridge.revokeAgentSession(DEFAULT_TEST_SESSION_ID);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.agent_id, 'agent-001');
    assert.equal(revoked.cancellation.length, 1);
    assert.equal(revoked.cancellation[0].abort_signalled, true);
    assert.equal(capturedSignal.aborted, true);

    await waitFor(() => fake.files.has('bridge/results/' + requestId + '.json'));
    const result = decode(fake.files.get('bridge/results/' + requestId + '.json'));
    assert.equal(result.status, 'cancelled');
    assert.match(result.error || result.result && result.result.error || '', /SESSION_REVOKED/);
    assert.equal(result.session_id, DEFAULT_TEST_SESSION_ID);
    const claim = decode(fake.files.get('bridge/claims/' + requestId + '.json'));
    assert.equal(claim.status, 'completed');
    assert.equal(claim.result.status, 'cancelled');

    const session = decode(fake.files.get('bridge/sessions/' + DEFAULT_TEST_SESSION_ID + '.json'));
    const seat = decode(fake.files.get('bridge/agents/agent-001.json'));
    assert.equal(session.status, 'revoked');
    assert.equal(seat.current_session_id, null);
    const visibleAgent = bridge.getState().agentMailboxes.find(item => item.agent_id === 'agent-001');
    assert.equal(visibleAgent.session_id, null, 'late completion must not restore the revoked session in the dashboard');
  } finally {
    await bridge.stop();
  }
});


test('optional mailbox wipe drains a revoked in-flight worker before deleting its terminal mailbox records', async () => {
  const requestId = 'req-revoke-and-wipe';
  const request = {
    protocol: PROTOCOL, request_id: requestId, session_id: DEFAULT_TEST_SESSION_ID,
    created_at: new Date().toISOString(), tool: 'project_status', args: {}
  };
  const fake = fakeGitHub({ initial: [['bridge/requests/' + requestId + '.json', request]] });
  const fixture = settingsFixture();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const bridge = createRepositoryBridge({
    githubAuth: fake.githubAuth, ...fixture,
    getWorkspaceRoot: () => process.cwd(),
    executeTool: async (tool, args, id, sessionId, signal) => {
      markStarted();
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      return { ok: true, result: { shouldNotPublish: true } };
    },
    intervalMs: 5000
  });

  try {
    await bridge.start();
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tool execution did not start.')), 2000))
    ]);
    const revoked = await bridge.revokeAgentSession(DEFAULT_TEST_SESSION_ID, { wipeMailbox: true });
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.cancellation_drain_timed_out, false);
    assert.equal(revoked.mailbox_cleanup.status, 'completed');
    assert.equal(revoked.mailbox_cleanup.deleted_request_records, 1);
    assert.equal(fake.files.has('bridge/requests/' + requestId + '.json'), false);
    assert.equal(fake.files.has('bridge/claims/' + requestId + '.json'), false);
    assert.equal(fake.files.has('bridge/results/' + requestId + '.json'), false);
    const session = decode(fake.files.get('bridge/sessions/' + DEFAULT_TEST_SESSION_ID + '.json'));
    assert.equal(session.status, 'revoked', 'session history remains after an optional mailbox wipe');
    assert.ok(fake.files.has('bridge/revoked-sessions/' + DEFAULT_TEST_SESSION_ID + '.json'));
  } finally {
    await bridge.stop();
  }
});

test('a conflicting immutable result is not mistaken for successful publication on OneDrive', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-bridge-result-conflict-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bridgeRoot = path.join(temp, 'OneDrive', 'Bridge');
  await fs.mkdir(bridgeRoot, { recursive: true });
  const settings = { repositoryBridge: { oneDrivePath: bridgeRoot, retentionDays: 30 } };
  const mailbox = createOneDriveMailbox({ getSettings: () => settings });
  await mailbox.ensureReady();

  const requestId = 'req-onedrive-result-conflict';
  const request = {
    protocol: PROTOCOL,
    request_id: requestId,
    created_at: new Date().toISOString(),
    tool: 'session_start',
    args: { label: 'Result conflict test' }
  };
  await mailbox.writeJson('request/agent-000/' + requestId + '.json', request, null, true);

  let conflictWritten = false;
  const resultPath = 'result/agent-000/' + requestId + '.json';
  const writeJson = mailbox.writeJson.bind(mailbox);
  mailbox.writeJson = async (relativePath, value, expectedSha, createOnly) => {
    if (!conflictWritten && relativePath === resultPath && createOnly === true) {
      // Insert the exact worker-generated result with one additional literal JSON
      // key before the worker's create-only publication reaches the adapter.
      const conflictingResult = JSON.parse(JSON.stringify(value));
      Object.defineProperty(conflictingResult, '__proto__', {
        value: { unexpected: true }, enumerable: true, configurable: true, writable: true
      });
      const inserted = await writeJson(relativePath, conflictingResult, expectedSha, true);
      assert.equal(inserted.ok, true, 'the conflicting result should be the first immutable file at this path');
      conflictWritten = true;
    }
    return writeJson(relativePath, value, expectedSha, createOnly);
  };
  const bridge = createRepositoryBridge({
    mailbox,
    ...{ settings, getSettings: () => settings, persistSettings: () => {} },
    getWorkspaceRoot: () => process.cwd(),
    requestSessionAssignment: async () => ({
      autoAssign: true, agent_id: null, workspace_root: process.cwd(), message: ''
    }),
    onSessionAssigned: async () => {},
    executeTool: async () => { throw new Error('session_start must not execute a workspace tool'); },
    intervalMs: 5000
  });

  try {
    const started = await bridge.start();
    assert.equal(started.transport, 'onedrive-synced-folder');
    await waitForAsync(async () => {
      const claim = await mailbox.readJson('claims/agent-000/' + requestId + '.json');
      return conflictWritten && Boolean(claim && claim.value.status === 'completed') &&
        bridge.getState().lastError.includes('contents do not match');
    });
    const claim = await mailbox.readJson('claims/agent-000/' + requestId + '.json');
    const storedResult = await mailbox.readJson('result/agent-000/' + requestId + '.json');
    assert.equal(claim.value.result.status, 'completed', 'the claim retains the worker-generated result for recovery');
    assert.ok(Number.isInteger(claim.value.result.timing_ms.mailbox_operations_before_result_publish));
    assert.ok(claim.value.result.timing_ms.mailbox_operations_before_result_publish > 0);
    assert.ok(Number.isInteger(claim.value.result.timing_ms.mailbox_operation_ms_before_result_publish));
    assert.equal(storedResult.value.status, 'completed', 'the pre-existing result is a copy of the worker result with one extra JSON key');
    assert.equal(Object.hasOwn(storedResult.value, '__proto__'), true, 'a literal __proto__ key must remain part of JSON equality');
    assert.match(bridge.getState().lastError, /contents do not match/i);
  } finally {
    await bridge.stop();
  }
});
