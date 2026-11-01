'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderToolCatalogMarkdown } = require('../desktop/tool-catalog-markdown');

test('tool guide contains the exact live schemas, descriptions, permissions and result contracts', () => {
  const markdown = renderToolCatalogMarkdown({
    catalog_version: 5,
    tool_calling: { mode: 'onedrive-mailbox-batch', rule: 'Up to 100 operations.', reference_syntax: '{"$ref":"priorStepId.result.content"}' },
    tools: [
      { name: 'exec_command', mode: 'approval', description: 'Run an installed language tool.', permission_note: 'Requires local approval.', returns: 'exitCode, stdout, stderr.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'], additionalProperties: false } },
      { name: 'read_file', mode: 'read', description: 'Read source code.', permission_note: 'No approval required.', returns: 'File content and pagination.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
      { name: 'computer', mode: 'action-dependent-approval', description: 'Operate the Windows desktop.', permission_note: 'Action-dependent native approval.', returns: 'Action result.', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false } },
      { name: 'task_create', mode: 'repository-bridge-control', description: 'Create a project task.', permission_note: 'App-managed coordination.', returns: 'Task record.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } },
      { name: 'git_status', mode: 'read', description: 'Read Git status.', parameters: { type: 'object', properties: {}, required: [] } }
    ]
  });
  assert.match(markdown, /Catalog version: 5/);
  assert.match(markdown, /Registered tools: 5/);
  assert.match(markdown, /exec_command/);
  assert.match(markdown, /"command": \{/);
  assert.match(markdown, /"required": \[/);
  assert.match(markdown, /Permission requirements: Requires local approval/);
  assert.match(markdown, /Result contract: exitCode, stdout, stderr/);
  assert.match(markdown, /General coding workflow/);
  assert.match(markdown, /installed on the Windows machine/);
  assert.match(markdown, /Agent collaboration/);
  assert.match(markdown, /Desktop, vision and audio/);
  assert.match(markdown, /Slash-style shortcuts/);
  assert.ok(markdown.includes('| /status | Read STATUS.md. |'));
  assert.ok(markdown.includes('| /agents | Invoke agent_status. |'));
  assert.match(markdown, /not additional registered tools or a separate command protocol/);
  assert.match(markdown, /Batch and reference contract/);
  assert.match(markdown, /Up to 100 operations/);
  assert.doesNotMatch(markdown, /capabilities\.json|undefined/);
});
