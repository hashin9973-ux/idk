const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tools = require('../desktop/tool-runner');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-tools-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const value = 7;\n', 'utf8');
  return root;
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

test('workspace path policy rejects traversal and absolute paths', () => {
  const root = fixture();
  try {
    assert.throws(() => tools.safePath(root, '../outside.txt', false), /parent traversal/);
    assert.throws(() => tools.safePath(root, path.join(root, 'src', 'index.js'), false), /absolute paths/);
  } finally { cleanup(root); }
});

test('list_dir, read_file and search return actual workspace contents', async () => {
  const root = fixture();
  try {
    const listing = await tools.executeTool(root, 'list_dir', { path: 'src' });
    assert.equal(listing.entries[0].name, 'index.js');
    const file = await tools.executeTool(root, 'read_file', { path: 'src/index.js' });
    assert.match(file.content, /value = 7/);
    assert.equal(file.sha256.length, 64);
    const matches = await tools.executeTool(root, 'search', { query: 'value = 7' });
    assert.equal(matches.count, 1);
    assert.equal(matches.matches[0].path, 'src/index.js');
  } finally { cleanup(root); }
});

test('glob search handles recursive JavaScript patterns', async () => {
  const root = fixture();
  try {
    const result = await tools.executeTool(root, 'glob_file_search', { pattern: '**/*.js' });
    assert.ok(result.files.includes('src/index.js'));
  } finally { cleanup(root); }
});

test('write_file atomically creates and then replaces a file', async () => {
  const root = fixture();
  try {
    const first = await tools.executeTool(root, 'write_file', { path: 'src/note.txt', content: 'first\n' });
    assert.equal(first.beforeSha256, null);
    const second = await tools.executeTool(root, 'write_file', { path: 'src/note.txt', content: 'second\n' });
    assert.equal(typeof second.beforeSha256, 'string');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'note.txt'), 'utf8'), 'second\n');
  } finally { cleanup(root); }
});

test('secret-like files require explicit approval before reading', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=not-a-real-secret\n');
    fs.writeFileSync(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=fake-token\n', 'utf8');
    assert.equal(tools.getToolPolicy('read_file', { path: '.env' }).requiresApproval, true);
    await assert.rejects(tools.executeTool(root, 'read_file', { path: '.env' }), /explicit approval/);
    const approved = await tools.executeTool(root, 'read_file', { path: '.env', approved: true });
    assert.match(approved.content, /TOKEN=/);
    assert.equal(tools.getToolPolicy('read_file', { path: '.npmrc' }).requiresApproval, true);
    await assert.rejects(tools.executeTool(root, 'read_file', { path: '.npmrc' }), /explicit approval/);
  } finally { cleanup(root); }
});

test('apply_patch adds, updates and deletes files with real filesystem effects', async () => {
  const root = fixture();
  try {
    const add = '*** Begin Patch\n*** Add File: src/new.txt\n+line one\n+line two\n*** End Patch';
    const added = await tools.executeTool(root, 'apply_patch', { patch: add });
    assert.deepEqual(added.changed, ['src/new.txt']);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'line one\nline two\n');

    const update = '*** Begin Patch\n*** Update File: src/new.txt\n@@ line one\n-line one\n+updated\n*** End Patch';
    await tools.executeTool(root, 'apply_patch', { patch: update });
    assert.equal(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'updated\nline two\n');

    const remove = '*** Begin Patch\n*** Delete File: src/new.txt\n*** End Patch';
    await tools.executeTool(root, 'apply_patch', { patch: remove });
    assert.equal(fs.existsSync(path.join(root, 'src', 'new.txt')), false);
  } finally { cleanup(root); }
});

test('search skips secret-like files but still searches hidden project metadata', async () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: build\n', 'utf8');
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=hidden-value\n', 'utf8');
    fs.writeFileSync(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=fake-token\n', 'utf8');
    const search = await tools.executeTool(root, 'search', { query: 'hidden-value' });
    assert.equal(search.count, 0);
    const glob = await tools.executeTool(root, 'glob_file_search', { pattern: '.github/**/*.yml' });
    assert.ok(glob.files.includes('.github/workflows/ci.yml'));
  } finally { cleanup(root); }
});

test('workspace file mutations are automatic while commands and tests remain approval-gated', () => {
  for (const name of ['write_file', 'apply_patch', 'create_directory', 'move_path', 'delete_path']) {
    const policy = tools.getToolPolicy(name);
    assert.equal(policy.requiresApproval, false, name);
    assert.equal(policy.automatic, true, name);
  }
  for (const name of ['run_tests', 'shell', 'git_commit', 'git_push', 'git_clone', 'init']) {
    assert.equal(tools.getToolPolicy(name).requiresApproval, true, name);
  }
  assert.equal(tools.getToolPolicy('project_status').requiresApproval, false);
  assert.equal(tools.getToolPolicy('read_file', { path: '.env' }).requiresApproval, true);
});

test('secret-like write and patch targets require approval', () => {
  assert.equal(tools.getToolPolicy('write_file', { path: '.env' }).requiresApproval, true);
  assert.equal(tools.getToolPolicy('delete_path', { path: 'keys/id_rsa' }).requiresApproval, true);
  assert.equal(tools.getToolPolicy('write_file', { path: 'secrets/config.json' }).requiresApproval, true);
  assert.equal(tools.getToolPolicy('move_path', { source: 'src/auth/config.json', destination: 'archive/config.json' }).requiresApproval, true);
  assert.equal(tools.getToolPolicy('move_path', { source: 'config.json', destination: '.npmrc' }).requiresApproval, true);
  assert.equal(tools.getToolPolicy('apply_patch', {
    patch: '*** Begin Patch Patch\n*** Update File: .env\n@@ TOKEN\n-TOKEN=old\n+TOKEN=new\n*** End Patch'
  }).requiresApproval, true);
});

test('init does not overwrite existing AGENTS.md', async () => {
  const root = fixture();
  try {
    const file = path.join(root, 'AGENTS.md');
    fs.writeFileSync(file, 'keep me\n', 'utf8');
    const result = await tools.executeTool(root, 'init', {});
    assert.equal(result.initialized, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep me\n');
  } finally { cleanup(root); }
});


test('ranged file reads, file metadata, and directory trees return bounded workspace data', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'src', 'lines.txt'), 'one\ntwo\nthree\n', 'utf8');
    const ranged = await tools.executeTool(root, 'read_file', { path: 'src/lines.txt', startLine: 2, endLine: 2 });
    assert.equal(ranged.content, 'two');
    assert.equal(ranged.startLine, 2);
    assert.equal(ranged.totalLines, 4);
    const info = await tools.executeTool(root, 'file_info', { path: 'src/lines.txt' });
    assert.equal(info.type, 'file');
    assert.equal(info.sha256.length, 64);
    const tree = await tools.executeTool(root, 'directory_tree', { path: 'src', maxDepth: 2, maxEntries: 20 });
    assert.ok(tree.entries.some(entry => entry.path === 'src/index.js'));
    assert.ok(tree.entries.some(entry => entry.path === 'src/lines.txt'));
  } finally { cleanup(root); }
});

test('create_directory, move_path and delete_path have real effects inside the workspace', async () => {
  const root = fixture();
  try {
    await tools.executeTool(root, 'create_directory', { path: 'tmp/nested', recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'nested', 'move-me.txt'), 'hello', 'utf8');
    const moved = await tools.executeTool(root, 'move_path', { source: 'tmp/nested/move-me.txt', destination: 'tmp/nested/moved.txt' });
    assert.equal(moved.moved, true);
    assert.equal(fs.readFileSync(path.join(root, 'tmp', 'nested', 'moved.txt'), 'utf8'), 'hello');
    await tools.executeTool(root, 'delete_path', { path: 'tmp/nested/moved.txt' });
    assert.equal(fs.existsSync(path.join(root, 'tmp', 'nested', 'moved.txt')), false);
    await assert.rejects(tools.executeTool(root, 'move_path', { source: '../outside', destination: 'tmp/outside' }), /parent traversal/);
  } finally { cleanup(root); }
});

test('workspace file mutations are automatic but Git operations require approval', () => {
  for (const name of ['create_directory','move_path','delete_path','write_file','apply_patch']) {
    assert.equal(tools.getToolPolicy(name).requiresApproval, false, name);
  }
  for (const name of [
    'git_create_branch','git_switch_branch','git_commit','git_fetch','git_pull','git_push','git_clone',
    'shell','run_tests'
  ]) {
    assert.equal(tools.getToolPolicy(name).requiresApproval, true, name);
  }
  for (const name of ['environment_info','directory_tree','file_info','git_log','git_show','git_branches','git_changed_files','discover_instructions']) {
    assert.equal(tools.getToolPolicy(name).requiresApproval, false, name);
  }
});

test('Git history, branch listing and changed-file tools use the selected repository', async t => {
  const root = fixture();
  try {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      t.skip('Git is not installed in this test environment.');
      return;
    }
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tool Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'tool-test@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '--', 'src/index.js'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial test commit'], { cwd: root, stdio: 'ignore' });
    const log = await tools.executeTool(root, 'git_log', { maxCount: 5 });
    assert.equal(log.commits.length, 1);
    assert.equal(log.commits[0].subject, 'initial test commit');
    const branches = await tools.executeTool(root, 'git_branches', {});
    assert.equal(branches.length, 1);
    assert.equal(branches[0].current, true);
    const show = await tools.executeTool(root, 'git_show', { ref: 'HEAD' });
    assert.match(show.stdout, /initial test commit/);
    fs.writeFileSync(path.join(root, 'src', 'untracked.txt'), 'new file', 'utf8');
    const changed = await tools.executeTool(root, 'git_changed_files', {});
    assert.equal(changed.count, 1);
    assert.equal(changed.files[0].path, 'src/untracked.txt');
    assert.equal(changed.files[0].raw, '?? src/untracked.txt');
    await tools.executeTool(root, 'git_create_branch', { name: 'feature/tool-test' });
    const next = await tools.executeTool(root, 'git_branches', {});
    assert.ok(next.some(branch => branch.name === 'feature/tool-test'));
  } finally { cleanup(root); }
});

test('run_tests honors an explicit project-native PowerShell command and timeout', async t => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell execution is only available on Windows.');
    return;
  }
  const root = fixture();
  try {
    const result = await tools.executeTool(root, 'run_tests', {
      command: "Write-Output 'explicit test command'; exit 0",
      timeoutMs: 5000
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timeoutMs, 5000);
    assert.equal(result.stdout_truncated, false);
    assert.equal(result.stderr_truncated, false);
    assert.match(result.stdout, /explicit test command/);
  } finally { cleanup(root); }
});

test('PowerShell waits for final stdout before returning success', async t => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell execution is only available on Windows.');
    return;
  }
  const root = fixture();
  const startedAt = Date.now();
  try {
    const result = await tools.executeTool(root, 'shell', {
      command: "Start-Sleep -Milliseconds 350; Write-Output 'final terminal output'; exit 0",
      timeoutMs: 5000
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 300, 'execution must wait for the foreground command to finish');
    assert.ok(Date.now() - startedAt >= 300);
    assert.match(result.stdout, /final terminal output/);
  } finally { cleanup(root); }
});

test('PowerShell timeout always returns a terminal result and partial output', async t => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell execution is only available on Windows.');
    return;
  }
  const root = fixture();
  try {
    const startedAt = Date.now();
    const result = await tools.executeTool(root, 'shell', {
      command: "Write-Output 'output before timeout'; Start-Sleep -Seconds 60; Write-Output 'unreachable output'",
      timeoutMs: 1500
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timeoutMs, 1500);
    assert.ok(Date.now() - startedAt < 10000, 'timeout must resolve even if a child keeps pipes open');
    assert.match(result.timeoutMessage, /process tree/);
    assert.match(result.stdout, /output before timeout/);
    assert.doesNotMatch(result.stdout, /unreachable output/);
  } finally { cleanup(root); }
});

test('PowerShell reports when stdout is truncated at the output limit', async t => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell execution is only available on Windows.');
    return;
  }
  const root = fixture();
  try {
    const result = await tools.executeTool(root, 'shell', {
      command: "[Console]::Out.Write('x' * 200000)",
      timeoutMs: 5000
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stderr_truncated, false);
    assert.match(result.stdout, /stdout truncated/);
  } finally { cleanup(root); }
});

