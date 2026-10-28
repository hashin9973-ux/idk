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
    assert.match(escaped.error, /outside the selected workspace/);
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


test('auto-accept-all skips local approval dialogs, including sensitive-file approval, while preserving workspace path limits', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'access_token.txt'), 'local test secret', 'utf8');
    let approvalCalls = 0;
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvalCalls++; throw new Error('auto-accept must skip approval'); } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      getAutoAcceptAll: () => true,
      uploadWorkspaceFile: async (requestId, file) => ({ requestId, path: file.path, bytes: file.bytes.length })
    });
    const read = await bridge.runTool('read_file', { path: 'access_token.txt' }, 'req-auto-sensitive');
    assert.equal(read.ok, true, read.error || 'sensitive read was not auto-accepted');
    assert.equal(read.result.content, 'local test secret');
    const upload = await bridge.runTool('upload_workspace_file', { path: 'artifact.txt' }, 'req-auto-upload');
    assert.equal(upload.ok, true, upload.error || 'upload was not auto-accepted');
    assert.equal(upload.result.path, 'artifact.txt');
    const escaped = await bridge.runTool('write_file', { path: '../outside.txt', content: 'still blocked' }, 'req-auto-escape');
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /outside the selected workspace/);
    assert.equal(approvalCalls, 0);
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

test('batch runs multiple tools in one bridge request and can pass a prior result into a later call', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'source.txt'), 'hello from batch\n', 'utf8');
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('batch', { steps: [
      { id: 'read', tool: 'read_file', args: { path: 'source.txt' } },
      { id: 'copy', tool: 'write_file', args: { path: 'copy.txt', content: { '$ref': 'read.result.content' } } },
      { id: 'verify', tool: 'read_file', args: { path: 'copy.txt' } }
    ] }, 'req-batch-reference');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.completed_steps, 3);
    assert.equal(result.result.steps[1].ok, true);
    assert.equal(result.result.steps[2].result.content, 'hello from batch\n');
    assert.equal(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8'), 'hello from batch\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('batch runs independent steps concurrently and preserves request-order results', async () => {
  const root = fixture();
  try {
    let active = 0;
    let maximumActive = 0;
    const concurrentTools = {
      ...localTools,
      async executeTool(workspaceRoot, tool, args) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 60));
        active--;
        return { tool, completed: true };
      }
    };
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools: concurrentTools,
      githubAuth: {}
    });
    const steps = Array.from({ length: 6 }, (_, index) => ({
      id: 'parallel' + index,
      tool: 'project_status',
      args: {}
    }));
    const result = await bridge.runTool('batch', { steps, maxConcurrency: 3 }, 'req-batch-concurrency');
    assert.equal(result.ok, true, result.error || 'concurrent batch failed');
    assert.equal(result.result.completed_steps, 6);
    assert.equal(result.result.max_concurrency, 3);
    assert.deepEqual(result.result.steps.map(step => step.id), steps.map(step => step.id));
    assert.ok(maximumActive > 1, 'independent operations should overlap');
    assert.ok(maximumActive <= 3, 'parallel work should respect the configured concurrency cap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch accepts 100 steps and runs 100 independent operations concurrently', async () => {
  const root = fixture();
  try {
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { throw new Error('read-only project status should not prompt'); } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    let active = 0;
    let maximumActive = 0;
    const concurrentTools = {
      ...localTools,
      async executeTool(workspaceRoot, tool, args) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return { tool, completed: true };
      }
    };
    const concurrentBridge = createToolBridge({
      dialog: { showMessageBox: async () => { throw new Error('read-only project status should not prompt'); } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools: concurrentTools,
      githubAuth: {}
    });
    const steps = Array.from({ length: 100 }, (_, i) => ({ id: 'status' + i, tool: 'project_status', args: {} }));
    const result = await concurrentBridge.runTool('batch', { steps, maxConcurrency: 100 }, 'req-batch-100-step');
    assert.equal(result.ok, true, result.error || 'larger batch failed');
    assert.equal(result.result.completed_steps, 100);
    assert.equal(result.result.requested_steps, 100);
    assert.equal(result.result.steps.length, 100);
    assert.equal(result.result.max_concurrency, 100);
    assert.equal(maximumActive, 100, '100 independent operations should be active concurrently when requested');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch applies native approval per protected step and stops after a declined operation', async () => {
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
    const result = await bridge.runTool('batch', { steps: [
      { id: 'inspect', tool: 'project_status', args: {} },
      { id: 'write', tool: 'shell', args: { command: "Set-Content -LiteralPath 'must-not-exist.txt' -Value 'no'" } },
      { id: 'later', tool: 'project_status', args: {} }
    ], maxConcurrency: 1 }, 'req-batch-approval');
    assert.equal(result.ok, false);
    assert.equal(approvalCalls, 1);
    assert.equal(result.result.stopped_at, 'write');
    assert.equal(result.result.steps.length, 3);
    assert.equal(result.result.steps[1].cancelled, true);
    assert.equal(result.result.steps[2].skipped, true);
    assert.equal(result.result.completed_steps, 2);
    assert.equal(result.result.skipped_steps, 1);
    assert.equal(fs.existsSync(path.join(root, 'must-not-exist.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool capabilities expose parameter schemas and the batch reference syntax', async () => {
  const root = fixture();
  try {
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('get_capabilities', {}, 'req-schema-catalog');
    assert.equal(result.ok, true);
    const tools = result.result.tools;
    const batch = tools.find(item => item.name === 'batch');
    const write = tools.find(item => item.name === 'write_file');
    const read = tools.find(item => item.name === 'read_file');
    const search = tools.find(item => item.name === 'search');
    const shell = tools.find(item => item.name === 'shell');
    assert.equal(result.status, 'success');
    assert.equal(result.result.tool_calling.catalog_version, 2);
    assert.equal(batch.parameters.properties.steps.type, 'array');
    assert.equal(batch.parameters.properties.steps.maxItems, 100);
    assert.equal(batch.parameters.properties.maxConcurrency.default, 32);
    assert.equal(batch.parameters.properties.maxConcurrency.maximum, 100);
    assert.ok(batch.parameters.properties.steps.items.properties.tool.enum.includes('read_file'));
    assert.equal(batch.parameters.properties.steps.items.properties.tool.enum.includes('batch'), false);
    assert.deepEqual(write.parameters.required, ['path', 'content']);
    assert.match(read.parameters.properties.path.description, /relative to the selected workspace/i);
    assert.match(read.parameters.properties.startLine.description, /1-based/i);
    assert.equal(search.parameters.properties.maxResults.default, 100);
    assert.equal(shell.parameters.properties.timeoutMs.maximum, 120000);
    assert.match(write.returns, /before\/after SHA-256/i);
    assert.match(batch.description, /one mailbox request/i);
    assert.equal(result.result.tool_calling.reference_syntax, '{\"$ref\":\"priorStepId.result.content\"}');
    assert.equal(tools.some(item => item.name === 'github_api'), false);
    assert.equal(tools.some(item => item.name === 'github_status'), false);
    for (const tool of tools) {
      assert.ok(typeof tool.returns === 'string' && tool.returns.length > 10, tool.name + ' result contract');
      assert.equal(tool.parameters.additionalProperties, false, tool.name);
      for (const [name, schema] of Object.entries(tool.parameters.properties)) {
        assert.ok(typeof schema.description === 'string' && schema.description.length > 10, tool.name + '.' + name);
        assert.doesNotMatch(schema.description, /parameter for/i, tool.name + '.' + name);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('batch keeps failure output and exit codes inline for the next agent decision', async () => {
  const root = fixture();
  try {
    const fakeTools = {
      ...localTools,
      async executeTool(workspaceRoot, tool, args) {
        if (tool === 'shell') return { command: args.command, exitCode: 7, timedOut: false, stdout: 'useful stdout', stderr: 'compiler error details' };
        return localTools.executeTool(workspaceRoot, tool, args);
      }
    };
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools: fakeTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('batch', { steps: [
      { id: 'compile', tool: 'shell', args: { command: 'Write-Output compile' } },
      { id: 'should-not-run', tool: 'project_status', args: {} }
    ], maxConcurrency: 1 }, 'req-batch-failure-result');
    assert.equal(result.ok, false);
    const step = result.result.steps[0];
    assert.equal(step.status, 'failed');
    assert.equal(step.exit_code, 7);
    assert.match(step.result.stdout, /useful stdout/);
    assert.match(step.result.stderr, /compiler error details/);
    assert.equal(result.result.stopped_at, 'compile');
    assert.equal(result.result.steps.length, 2);
    assert.equal(result.result.steps[1].status, 'skipped');
    assert.equal(result.result.steps[1].skipped, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent context packs Windows environment, project commands, instruction metadata, and tool schemas into one result', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'context-fixture',
      scripts: { test: 'node --test', lint: 'eslint .' }
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture instructions\\nUse focused edits.\\n', 'utf8');
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {}
    });
    const result = await bridge.runTool('get_agent_context', {}, 'req-agent-context');
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.result.protocol, 'chatgpt-local-agent-context/v1');
    assert.equal(result.result.project_commands.name, 'context-fixture');
    assert.equal(result.result.project_commands.scripts.test, 'node --test');
    assert.ok(Array.isArray(result.result.directory_overview.paths));
    assert.equal(result.result.directory_overview.format, 'paths');
    assert.equal(result.result.execution_policy.auto_accept_all, false);
    assert.ok(result.result.tool_catalog.tools.some(item => item.name === 'batch'));
    assert.ok(result.result.tool_catalog.tools.some(item => item.name === 'get_agent_context'));
    assert.ok(result.result.retrieval_rules.some(rule => /does not expose these local tools as native functions/i.test(rule)));
    assert.ok(result.result.retrieval_rules.some(rule => rule.includes('create bridge/requests') && rule.includes('read bridge/results')));
    assert.ok(result.result.retrieval_rules.some(rule => /before asking for machine facts/i.test(rule)));
    assert.ok(result.result.development_workflow.rules.some(rule => /Start with get_agent_context/i.test(rule)));
    assert.ok(result.result.development_workflow.rules.some(rule => /Never replay an uncertain side-effecting request/i.test(rule)));
    assert.ok(result.result.development_workflow.rules.some(rule => /measurable acceptance criteria/i.test(rule)));
    assert.ok(result.result.development_workflow.rules.some(rule => /integrated vertical slices/i.test(rule)));
    assert.ok(result.result.development_workflow.rules.some(rule => /end-to-end UI smoke test/i.test(rule)));
    assert.ok(Array.isArray(result.result.instruction_files));
    assert.ok(result.result.instruction_files.some(item => item.path === 'AGENTS.md' && /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.equal(result.result.instruction_files.some(item => Object.hasOwn(item, 'content')), false);
    assert.ok(result.result.suggested_commands.some(item => item.command === 'npm test'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computer uses familiar actions in one tool and gates visual side effects', async () => {
  const root = fixture();
  try {
    let approvalCalls = 0;
    const calls = [];
    const fakeComputer = {
      async status() { calls.push('status'); return { status: 'inactive', runtime_fresh: false }; },
      async connectColab() { calls.push('connect'); return { status: 'waiting_for_runtime', opened: true }; },
      async activate() { calls.push('enable'); return { status: 'starting', enabled: true, model_loaded: false }; },
      async deactivate() { calls.push('disable'); return { status: 'inactive', enabled: false, runtime_kept_alive: true }; },
      async analyzeScreenshot(args, id) { calls.push('screenshot'); return { status: 'report_available', request_id: 'computer-aaaaaaaaaaaaaaaaaaaaaaaa', report: 'A window is visible.' }; },
      async wait(args) { calls.push('wait'); return { status: 'report_available', request_id: args.request_id, report: 'A window is visible.' }; }
    };
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvalCalls++; return { response: 0 }; } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      visionService: fakeComputer
    });
    const status = await bridge.runTool('computer', { action: 'status' }, 'req-computer-status');
    assert.equal(status.ok, true);
    assert.equal(approvalCalls, 0);
    const enabled = await bridge.runTool('computer', { action: 'enable' }, 'req-computer-enable');
    assert.equal(enabled.ok, true);
    assert.equal(approvalCalls, 1);
    const shot = await bridge.runTool('computer', { action: 'screenshot', source: 'desktop' }, 'req-computer-shot');
    assert.equal(shot.ok, true);
    assert.equal(approvalCalls, 2);
    assert.equal(shot.result.request_id, 'computer-aaaaaaaaaaaaaaaaaaaaaaaa');
    const disabled = await bridge.runTool('computer', { action: 'disable' }, 'req-computer-disable');
    assert.equal(disabled.ok, true);
    assert.equal(approvalCalls, 2);
    const catalog = await bridge.runTool('get_capabilities', {}, 'req-computer-catalog');
    const names = catalog.result.tools.map(item => item.name);
    assert.ok(names.includes('computer'));
    const computer = catalog.result.tools.find(item => item.name === 'computer');
    assert.deepEqual(computer.parameters.properties.mode.enum, ['normal', 'fast']);
    assert.match(computer.description, /fast interaction mode/i);
    assert.match(computer.parameters.properties.action.description, /immediately/i);
    assert.match(computer.parameters.properties.observe.description, /mode=fast.*skips/i);
    assert.equal(names.some(name => /^vision_/.test(name)), false);
    assert.deepEqual(calls, ['status', 'enable', 'screenshot', 'disable']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('tts is a first-class local tool and routes Piper synthesis through the vision service', async () => {
  const root = fixture();
  try {
    let localToolCalls = 0;
    let approvalCalls = 0;
    const speechCalls = [];
    const local = {
      ...localTools,
      async executeTool(...args) { localToolCalls++; return localTools.executeTool(...args); }
    };
    const fakeVision = {
      async synthesizeSpeech(args, id) {
        speechCalls.push({ text: args.text, play: args.play, id });
        return { status: 'tts_completed', voice: 'en_US-libritts-high', speaker_id: 0, played: args.play !== false, local_file: 'C:\\temp\\speech.wav' };
      }
    };
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => { approvalCalls++; return { response: 0 }; } },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools: local,
      githubAuth: {},
      visionService: fakeVision,
      getAutoAcceptAll: () => false
    });
    const saved = await bridge.runTool('tts', { text: 'Hello from Piper.', play: false }, 'tts-save-test');
    assert.equal(saved.ok, true);
    assert.equal(saved.result.status, 'tts_completed');
    assert.equal(saved.result.played, false);
    assert.equal(approvalCalls, 0, 'saving generated audio without playback does not play sound');
    const played = await bridge.runTool('tts', { text: 'A short spoken test.' }, 'tts-play-test');
    assert.equal(played.ok, true);
    assert.equal(played.result.status, 'tts_completed');
    assert.equal(played.result.played, true);
    assert.equal(approvalCalls, 1, 'local audio playback asks for approval unless auto-accept is enabled');
    assert.equal(speechCalls.length, 2);
    assert.equal(speechCalls[0].text, 'Hello from Piper.');
    assert.equal(speechCalls[0].play, false);
    assert.equal(speechCalls[1].play, undefined);
    assert.equal(localToolCalls, 0, 'TTS must not be passed to the generic local tool runner');
    const catalog = await bridge.runTool('get_capabilities', {}, 'tts-catalog');
    const tool = catalog.result.tools.find(item => item.name === 'tts');
    assert.ok(tool);
    assert.equal(tool.parameters.properties.play.default, true);
    assert.equal(tool.parameters.properties.text.maxLength, 2000);
    assert.deepEqual(tool.parameters.required, ['text']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tts reports an asynchronous chunked playback start as successful initiation', async () => {
  const root = fixture();
  try {
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      getAutoAcceptAll: () => true,
      visionService: {
        async synthesizeSpeech(args) {
          assert.equal(args.play, undefined);
          return {
            status: 'tts_started',
            request_id: 'tts-' + 'a'.repeat(24),
            speech_job_id: 'tts-' + 'a'.repeat(24),
            played: true,
            playback_status: 'playing',
            chunks_total: 15,
            chunks_started: 1,
            chunks_completed: 0
          };
        }
      }
    });
    const result = await bridge.runTool('tts', { text: 'A punctuation-bounded speech sequence.' }, 'tts-async-start');
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'tts_started');
    assert.equal(result.result.playback_status, 'playing');
    assert.equal(result.result.chunks_total, 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tts reports playback failure distinctly from successful WAV synthesis', async () => {
  const root = fixture();
  try {
    const bridge = createToolBridge({
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      getMainWindow: () => null,
      getWorkspaceRoot: () => root,
      localTools,
      githubAuth: {},
      uploadWorkspaceFile: async () => ({}),
      getAutoAcceptAll: () => true,
      visionService: {
        async synthesizeSpeech() {
          return {
            status: 'tts_completed', voice: 'en_US-libritts-high', speaker_id: 0,
            played: false, playback_error: 'Windows audio device is unavailable.',
            local_file: 'C:\\temp\\speech.wav'
          };
        }
      }
    });
    const result = await bridge.runTool('tts', { text: 'Play a short test.' }, 'tts-playback-fail');
    assert.equal(result.ok, false);
    assert.match(result.error, /audio device is unavailable/i);
    assert.equal(result.result.status, 'tts_completed', 'WAV synthesis succeeded despite local playback failure');
    assert.equal(result.result.played, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
