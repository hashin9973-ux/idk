'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const localTools = require('../desktop/tool-runner');
const { createToolBridge } = require('../desktop/tool-bridge');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-tool-bridge-'));
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'output-to-upload\\n', 'utf8');
  return root;
}

test('workspace artifact upload waits for local approval before reading and publishing the file', async () => {
  const root = fixture();
  try {
    let approvalCalls = 0;
    let uploadCalls = 0;
    let uploaded = null;
    const dialog = {
      async showMessageBox(options) {
        approvalCalls++;
        assert.match(options.title, /Approve local coding tool/);
        assert.match(options.detail, /artifact\.txt/);
        assert.match(options.detail, /shared GitHub mailbox branch/);
        return { response: 0 };
      }
    };
    const bridge = createToolBridge({
      dialog,
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      uploadWorkspaceFile: async (requestId, file) => {
        uploadCalls++;
        uploaded = { requestId, file };
        return { path: 'bridge/artifacts/' + requestId + '/' + file.artifactName, bytes: file.bytes.length };
      }
    });

    const result = await bridge.runTool('upload_workspace_file', { path: 'artifact.txt' }, 'req-upload-test');
    assert.equal(approvalCalls, 1);
    assert.equal(uploadCalls, 1);
    assert.equal(uploaded.requestId, 'req-upload-test');
    assert.equal(uploaded.file.path, 'artifact.txt');
    assert.equal(uploaded.file.artifactName, 'artifact.txt');
    assert.equal(Buffer.isBuffer(uploaded.file.bytes), true);
    assert.equal(uploaded.file.bytes.toString('utf8'), 'output-to-upload\\n');
    assert.equal(result.ok, true);
    assert.equal(result.result.path, 'bridge/artifacts/req-upload-test/artifact.txt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace-relative file writes execute without a dialog and reject paths outside the selected workspace', async () => {
  const root = fixture();
  try {
    let approvalCalls = 0;
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvalCalls++; throw new Error('unexpected approval dialog'); } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });

    const written = await bridge.runTool('write_file', { path: 'new.txt', content: 'safe sandbox write\\n' }, 'req-auto-write');
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'safe sandbox write\\n');
    assert.equal(approvalCalls, 0);

    const escaped = await bridge.runTool('write_file', { path: '../outside.txt', content: 'must not write' }, 'req-escape-write');
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /parent traversal/);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.txt')), false);
    assert.equal(approvalCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shell commands remain approval-gated and are not executed when declined', async () => {
  const root = fixture();
  try {
    let approvalCalls = 0;
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvalCalls++; return { response: 1 }; } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('shell', {
      command: "Set-Content -LiteralPath 'should-not-exist.txt' -Value 'not run'"
    }, 'req-shell-declined');
    assert.equal(approvalCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(path.join(root, 'should-not-exist.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('declining the local artifact-upload approval performs no file publication', async () => {
  const root = fixture();
  try {
    let uploadCalls = 0;
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      uploadWorkspaceFile: async () => { uploadCalls++; return { path: 'should-not-exist' }; }
    });
    const result = await bridge.runTool('upload_workspace_file', { path: 'artifact.txt' }, 'req-upload-declined');
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(uploadCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool capabilities advertise the separate upload and context-refresh controls', async () => {
  const root = fixture();
  try {
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('get_capabilities', {}, 'req-capabilities');
    assert.equal(result.ok, true);
    const names = result.result.tools.map(tool => tool.name);
    assert.ok(names.includes('upload_workspace_file'));
    assert.ok(names.includes('refresh_environment_context'));
    assert.equal(result.result.tools.find(tool => tool.name === 'upload_workspace_file').mode, 'approval-required');
    assert.equal(result.result.tools.find(tool => tool.name === 'refresh_environment_context').mode, 'repository-bridge-control');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('tool bridge preserves large local text so the repository layer can externalize the complete output', async () => {
  const root = fixture();
  try {
    const longText = 'full-output\\n' + 'Z'.repeat(220000);
    const largeOutputTools = {
      ...localTools,
      async executeTool(workspaceRoot, tool, args) {
        if (tool === 'read_file') return { path: args.path, content: longText };
        return localTools.executeTool(workspaceRoot, tool, args);
      }
    };
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools: largeOutputTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('read_file', { path: 'large.txt' }, 'req-large-read');
    assert.equal(result.ok, true);
    assert.equal(result.result.content, longText);
    assert.equal(result.truncatedForMailbox, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('workspace artifact uploads reject files above 8 MiB without publishing them', async () => {
  const root = fixture();
  const oversizedPath = path.join(root, 'too-big.bin');
  try {
    fs.writeFileSync(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    let approvals = 0;
    let uploads = 0;
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvals++; return { response: 0 }; } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      uploadWorkspaceFile: async () => { uploads++; return { path: 'should-not-exist' }; }
    });
    const result = await bridge.runTool('upload_workspace_file', { path: 'too-big.bin' }, 'req-too-big');
    assert.equal(approvals, 1);
    assert.equal(uploads, 0);
    assert.equal(result.ok, false);
    assert.match(result.error, /8 MiB upload limit/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('native approval details escape remote newlines and bidirectional control characters', async () => {
  const root = fixture();
  try {
    let capturedOptions = null;
    const bridge = createToolBridge({
      dialog: {
        async showMessageBox(options) {
          capturedOptions = options;
          return { response: 1 };
        }
      },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const command = ['Write-Output safe', 'Tool: delete_path', 'Approve once'].join('\n') + '\u202E' + 'X'.repeat(5000);
    const result = await bridge.runTool('shell', { command }, 'req-dialog-injection');
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.ok(capturedOptions);
    assert.ok(capturedOptions.detail.includes('Write-Output safe\\nTool: delete_path\\nApprove once'));
    assert.ok(capturedOptions.detail.includes('[BIDI U+202E]'));
    assert.ok(capturedOptions.detail.includes('[DISPLAY TRUNCATED]'));
    assert.equal(capturedOptions.detail.includes(command), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
