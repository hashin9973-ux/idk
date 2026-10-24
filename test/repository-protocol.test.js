const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../desktop/repository-protocol');

test('repository bridge accepts valid repository and branch names', () => {
  assert.equal(protocol.validateRepositoryName('owner/my-project'), 'owner/my-project');
  assert.equal(protocol.validateBranchName('main'), 'main');
  assert.equal(protocol.validateBranchName('chatgpt-bridge/dev'), 'chatgpt-bridge/dev');
});

test('repository and branch validation rejects path injection', () => {
  for (const value of ['', 'owner', 'owner/repo/other', '../repo', 'owner/..', 'owner/repo\\evil']) {
    assert.throws(() => protocol.validateRepositoryName(value));
  }
  for (const value of ['../main', '/main', 'main/', 'main//other', 'main?query', 'main name', 'main\\evil', 'foo..bar']) {
    assert.throws(() => protocol.validateBranchName(value));
  }
});

test('request builder emits the versioned repository protocol', () => {
  const request = protocol.buildRepositoryRequest({
    callId: 'inspect-001',
    tool: 'read_file',
    args: { path: 'src/index.js' },
    description: 'Read the main module'
  });
  assert.equal(request.protocol, protocol.REQUEST_PROTOCOL);
  assert.equal(request.call_id, 'inspect-001');
  assert.equal(request.tool, 'read_file');
  assert.deepEqual(request.args, { path: 'src/index.js' });
  assert.equal(typeof request.created_at, 'string');
});

test('request parser binds the request ID to the filename', () => {
  const raw = JSON.stringify({
    protocol: protocol.REQUEST_PROTOCOL,
    call_id: 'inspect-001',
    tool: 'read_file',
    args: { path: 'src/index.js' }
  });
  assert.deepEqual(protocol.parseRepositoryToolRequest(raw, 'inspect-001'), {
    protocol: protocol.REQUEST_PROTOCOL,
    callId: 'inspect-001',
    tool: 'read_file',
    args: { path: 'src/index.js' },
    created_at: null,
    description: ''
  });
  assert.throws(() => protocol.parseRepositoryToolRequest(raw, 'another-id'), /does not match/);
});

test('request parser rejects unknown tools, extra fields, and invalid payloads', () => {
  const base = { protocol: protocol.REQUEST_PROTOCOL, call_id: 'call-1', tool: 'project_status', args: {} };
  assert.throws(() => protocol.parseRepositoryToolRequest(JSON.stringify({ ...base, tool: 'github_api' }), 'call-1'), /Unknown local development tool/);
  assert.throws(() => protocol.parseRepositoryToolRequest(JSON.stringify({ ...base, admin: true }), 'call-1'), /Unsupported request fields/);
  assert.throws(() => protocol.parseRepositoryToolRequest('{bad json', 'call-1'), /valid JSON/);
  assert.throws(() => protocol.parseRepositoryToolRequest(JSON.stringify({ ...base, call_id: '../x' }), 'call-1'), /match the request filename/);
  assert.throws(() => protocol.parseRepositoryToolRequest('x'.repeat(1024 * 1024 + 1), 'call-1'), /under 1 MiB/);
});
