'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRequestCommands, formatResultOutput } = require('../desktop/agent-terminal');

test('tool-call JSON is rendered as shell-style command lines without JSON filenames', () => {
  const request = JSON.stringify({ protocol: 'chatgpt-local-repo-bridge/v1', request_id: 'request-1',
    tool: 'read_file', args: { path: 'src/main.cpp', startLine: 10, includeImages: false } });
  assert.equal(formatRequestCommands(request, 'unknown'),
    "$ read_file --path 'src/main.cpp' --start-line '10' --no-include-images");
});

test('shell commands retain their ordinary command-line form', () => {
  const request = JSON.stringify({ tool: 'shell', args: { command: 'npm test\nnode --check app.js' } });
  assert.equal(formatRequestCommands(request, 'shell'), '$ npm test\n$ node --check app.js');
});

test('batch requests render each step as a separate terminal command', () => {
  const request = JSON.stringify({ tool: 'batch', args: { steps: [
    { id: 'inspect', tool: 'list_directory', args: { path: 'src' } },
    { id: 'tests', tool: 'run_tests', args: { command: 'npm test' } }
  ] } });
  assert.equal(formatRequestCommands(request, 'batch'),
    "# inspect\n$ list_directory --path 'src'\n# tests\n$ run_tests --command 'npm test'");
});

test('potential credentials are redacted from the display-only command', () => {
  const request = JSON.stringify({ tool: 'connect', args: { endpoint: 'https://example.invalid', api_key: 'never-display-this' } });
  const rendered = formatRequestCommands(request, 'connect');
  assert.match(rendered, /\[redacted\]/);
  assert.doesNotMatch(rendered, /never-display-this/);
});

test('terminal argument display renders lists and nested objects without JSON', () => {
  const request = JSON.stringify({ tool: 'project_search', args: { query: 'main entry', paths: ['src', 'test'], filters: { kind: 'symbol', maxResults: 5 } } });
  const rendered = formatRequestCommands(request, 'unknown');
  assert.match(rendered, /--paths \\[.*src.*test.*\\]/);
  assert.match(rendered, /--filters \\[kind='symbol'; maxResults=5\\]/);
  assert.doesNotMatch(rendered, /"paths":/);
});

test('result JSON is translated to ordinary output lines', () => {
  const result = JSON.stringify({ status: 'completed', result: { output: { stdout: '2 tests passed\nOK', stderr: '' } } });
  assert.equal(formatResultOutput(result, 'queued', ''), '# completed\n2 tests passed\nOK');
});

test('nested sensitive values are redacted in the display-only command', () => {
  const request = JSON.stringify({ tool: 'configure', args: { options: { access_token: 'private', visible: 'yes' } } });
  const rendered = formatRequestCommands(request, 'configure');
  assert.match(rendered, /\[redacted\]/);
  assert.doesNotMatch(rendered, /private/);
  assert.match(rendered, /visible/);
});


test('direct tool calls render in slash-command form with nested secrets redacted', () => {
  const rendered = require('../desktop/agent-terminal').formatSlashCommand('read_file', {
    path: 'src/main.js',
    options: { api_key: 'never-display-this', include: ['a', 'b'] }
  });
  assert.equal(rendered, '/read_file path=src/main.js options=[structured value]');
  assert.equal(require('../desktop/agent-terminal').formatSlashCommand('environment_info', {}), '/environment_info');
  assert.doesNotMatch(rendered, /never-display-this/);
});
