const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../desktop/command-protocol');

test('Codex-style slash commands translate to local tool requests', () => {
  assert.deepEqual(commands.parseSlashCommand('/status'), { tool: 'project_status', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/pwd'), { tool: 'project_status', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/ls src'), { tool: 'list_dir', args: { path: 'src' } });
  assert.deepEqual(commands.parseSlashCommand('/ls "src folder"'), { tool: 'list_dir', args: { path: 'src folder' } });
  assert.deepEqual(commands.parseSlashCommand('/tree "src folder"'), { tool: 'list_dir', args: { path: 'src folder' } });
  assert.deepEqual(commands.parseSlashCommand('/cat "src/index file.js"'), { tool: 'read_file', args: { path: 'src/index file.js' } });
  assert.deepEqual(commands.parseSlashCommand('/tests'), { tool: 'run_tests', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/find src/**/*.js'), { tool: 'glob_file_search', args: { pattern: 'src/**/*.js' } });
  assert.deepEqual(commands.parseSlashCommand('/search useEffect'), { tool: 'search', args: { query: 'useEffect' } });
  assert.deepEqual(commands.parseSlashCommand('/grep "some phrase"'), { tool: 'search', args: { query: 'some phrase' } });
  assert.deepEqual(commands.parseSlashCommand('/git'), { tool: 'git_status', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/test'), { tool: 'run_tests', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/exec git status --short'), { tool: 'shell', args: { command: 'git status --short' } });
});

test('additional Codex-style aliases map to supported local tools', () => {
  assert.deepEqual(commands.parseSlashCommand('/tree src'), { tool: 'list_dir', args: { path: 'src' } });
  assert.deepEqual(commands.parseSlashCommand('/cat src/index.js'), { tool: 'read_file', args: { path: 'src/index.js' } });
  assert.deepEqual(commands.parseSlashCommand('/tests'), { tool: 'run_tests', args: {} });
  assert.equal(commands.parseSlashCommand('/plan implement feature').special, 'plan_mode');
  assert.equal(commands.parseSlashCommand('/review').special, 'review_mode');
});

test('workspace and coding mode are app-owned special commands', () => {
  assert.equal(commands.parseSlashCommand('/workspace').special, 'workspace');
  assert.equal(commands.parseSlashCommand('/codex').special, 'coding_mode');
  assert.equal(commands.parseSlashCommand('/plan make a small feature').special, 'plan_mode');
  assert.equal(commands.parseSlashCommand('/review').special, 'review_mode');
  assert.ok(commands.HELP.includes('/exec'));
});

test('assistant_tool blocks are validated and reject arbitrary tool names', () => {
  assert.deepEqual(commands.parseToolCall('{"version":1,"tool":"read_file","args":{"path":"src/index.js"},"call_id":"test-1"}'),
    { tool: 'read_file', args: { path: 'src/index.js' }, callId: 'test-1' });
  assert.throws(() => commands.parseToolCall('{"tool":"run_shell","args":{"command":"whoami"}}'), /Unknown local tool/);
  assert.throws(() => commands.parseToolCall('{"tool":"read_file","args":{},"unexpected":true}'), /Unsupported top-level/);
  assert.equal(commands.parseSlashCommand('/not-a-local-command'), null);
});
