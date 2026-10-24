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
