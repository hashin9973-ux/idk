const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../desktop/command-protocol');

test('Codex-style slash commands translate to local tool requests', () => {
  assert.deepEqual(commands.parseSlashCommand('/status'), { tool: 'project_status', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/pwd'), { tool: 'project_status', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/ls src'), { tool: 'list_dir', args: { path: 'src' } });
  assert.deepEqual(commands.parseSlashCommand('/ls "src folder"'), { tool: 'list_dir', args: { path: 'src folder' } });
  assert.deepEqual(commands.parseSlashCommand('/tree "src folder"'), { tool: 'directory_tree', args: { path: 'src folder', maxDepth: 4, maxEntries: 500 } });
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
  assert.deepEqual(commands.parseSlashCommand('/tree src'), { tool: 'directory_tree', args: { path: 'src', maxDepth: 4, maxEntries: 500 } });
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


test('expanded local tools are recognized by the fenced tool protocol', () => {
  const tools = [
    'environment_info', 'directory_tree', 'file_info', 'git_log', 'git_show',
    'git_branches', 'git_changed_files', 'discover_instructions', 'create_directory',
    'move_path', 'delete_path', 'git_create_branch', 'git_switch_branch', 'git_commit',
    'github_status', 'github_api'
  ];
  for (const tool of tools) {
    const parsed = commands.parseToolCall(JSON.stringify({ version: 1, tool, args: {} }));
    assert.equal(parsed.tool, tool);
  }
});

test('new slash commands map to the expected filesystem and Git tools', () => {
  assert.deepEqual(commands.parseSlashCommand('/env'), { tool: 'environment_info', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/tree src'), { tool: 'directory_tree', args: { path: 'src', maxDepth: 4, maxEntries: 500 } });
  assert.deepEqual(commands.parseSlashCommand('/info src/index.js'), { tool: 'file_info', args: { path: 'src/index.js' } });
  assert.deepEqual(commands.parseSlashCommand('/log src/index.js'), { tool: 'git_log', args: { path: 'src/index.js' } });
  assert.deepEqual(commands.parseSlashCommand('/branches'), { tool: 'git_branches', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/changed'), { tool: 'git_changed_files', args: {} });
  assert.deepEqual(commands.parseSlashCommand('/mkdir src/new-dir'), { tool: 'create_directory', args: { path: 'src/new-dir', recursive: true } });
  assert.deepEqual(commands.parseSlashCommand('/mv src/a.txt src/b.txt'), { tool: 'move_path', args: { source: 'src/a.txt', destination: 'src/b.txt' } });
  assert.deepEqual(commands.parseSlashCommand('/rm src/a.txt'), { tool: 'delete_path', args: { path: 'src/a.txt' } });
  assert.deepEqual(commands.parseSlashCommand('/branch feature/example'), { tool: 'git_create_branch', args: { name: 'feature/example' } });
  assert.deepEqual(commands.parseSlashCommand('/switch main'), { tool: 'git_switch_branch', args: { name: 'main' } });
  assert.deepEqual(commands.parseSlashCommand('/github'), { tool: 'github_status', args: {} });
});
