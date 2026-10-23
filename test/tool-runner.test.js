const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    assert.equal(tools.getToolPolicy('read_file', { path: '.env' }).requiresApproval, true);
    await assert.rejects(tools.executeTool(root, 'read_file', { path: '.env' }), /explicit approval/);
    const approved = await tools.executeTool(root, 'read_file', { path: '.env', approved: true });
    assert.match(approved.content, /TOKEN=/);
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

test('writes, patches, tests and PowerShell require approval policy', () => {
  assert.equal(tools.getToolPolicy('write_file').requiresApproval, true);
  assert.equal(tools.getToolPolicy('apply_patch').requiresApproval, true);
  assert.equal(tools.getToolPolicy('run_tests').requiresApproval, true);
  assert.equal(tools.getToolPolicy('shell').requiresApproval, true);
  assert.equal(tools.getToolPolicy('project_status').requiresApproval, false);
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
