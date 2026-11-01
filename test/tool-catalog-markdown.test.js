'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderToolCatalogMarkdown } = require('../desktop/tool-catalog-markdown');

test('tool guide is generated from the live capability catalog and groups specialized tools', () => {
  const markdown = renderToolCatalogMarkdown({
    catalog_version: 5,
    tools: [
      { name: 'exec_command', mode: 'approval', description: 'Run an installed language tool.', parameters: { properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'] } },
      { name: 'read_file', mode: 'read', description: 'Read source code.', parameters: { properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'computer', mode: 'action-dependent-approval', description: 'Operate the Windows desktop.', parameters: { properties: { action: { type: 'string' } }, required: ['action'] } },
      { name: 'task_create', mode: 'repository-bridge-control', description: 'Create a project task.', parameters: { properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'git_status', mode: 'read', description: 'Read Git status.', parameters: { properties: {}, required: [] } }
    ]
  });
  assert.match(markdown, /Catalog version: 5/);
  assert.match(markdown, /exec_command/);
  assert.match(markdown, /command\*/);
  assert.match(markdown, /Any programming language/);
  assert.match(markdown, /installed on Windows/);
  assert.match(markdown, /Typical coding loop/);
  assert.match(markdown, /Agent collaboration/);
  assert.match(markdown, /Desktop, vision and audio/);
  assert.match(markdown, /Schemas and transport/);
  assert.match(markdown, /capabilities\.json/);
  assert.doesNotMatch(markdown, /undefined/);
});
