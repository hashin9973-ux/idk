'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDirectAgentRuntime,
  normalizeDirectAgentConfig,
  endpointFor,
  readCompletion,
  parseSlashToolCommand,
  formatSlashToolCatalog,
  toApiMessages
} = require('../desktop/direct-agent-runtime');
const { getDirectAgentToolDefinitions } = require('../desktop/tool-bridge');

function sseResponse(events) {
  const payload = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    }
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function config() {
  return {
    provider: 'openai-compatible',
    endpoint: 'http://127.0.0.1:8000/v1',
    model: 'test-model',
    apiKey: '',
    systemPrompt: '',
    temperature: 0.2,
    maxTokens: 1024
  };
}

function definitions() {
  return [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          start_line: { type: 'integer', description: 'Optional first line.' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  }, {
    type: 'function',
    function: {
      name: 'environment_info',
      description: 'Inspect the local Windows environment.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  }];
}

test('direct API configuration validates provider, endpoint and model', () => {
  const normalized = normalizeDirectAgentConfig({
    provider: 'koboldcpp',
    endpoint: 'http://127.0.0.1:5001/v1/',
    model: 'koboldcpp/model'
  });
  assert.equal(normalized.endpoint, 'http://127.0.0.1:5001/v1');
  assert.equal(endpointFor(normalized.endpoint, 'chat/completions'), 'http://127.0.0.1:5001/v1/chat/completions');
  assert.equal(normalized.apiKey, '');
  assert.throws(() => normalizeDirectAgentConfig({
    provider: 'openai-compatible', endpoint: 'file:///tmp/api', model: 'model'
  }), /HTTP or HTTPS/);
  assert.throws(() => normalizeDirectAgentConfig({
    provider: 'openai-compatible', endpoint: 'https://user:pass@example.com/v1', model: 'model'
  }), /must not contain credentials/);
});

test('direct agent catalog includes local tools but excludes mailbox controls', () => {
  const tools = getDirectAgentToolDefinitions();
  const names = tools.map(item => item.function.name);
  for (const name of ['read_file', 'write_file', 'apply_patch', 'shell', 'run_tests', 'computer', 'git_status', 'batch']) {
    assert.ok(names.includes(name), 'missing local tool: ' + name);
  }
  for (const name of ['session_start', 'agent_status', 'send_agent_message', 'upload_workspace_file', 'github_api']) {
    assert.ok(!names.includes(name), 'mailbox tool leaked into direct API catalog: ' + name);
  }
  const batch = tools.find(item => item.function.name === 'batch');
  assert.ok(!batch.function.parameters.properties.steps.items.properties.tool.enum.includes('batch'));
});

test('slash catalog includes command names, descriptions and argument requirements', () => {
  const catalog = formatSlashToolCatalog(definitions());
  assert.match(catalog, /\/read_file — Read a workspace file/);
  assert.match(catalog, /path \(string; required; Workspace-relative file path\.\)/);
  assert.match(catalog, /start_line \(integer; optional/);
  assert.match(catalog, /\/environment_info — Inspect the local Windows environment/);
});

test('SSE parser streams assistant text and detects disabled native tool-call output', async () => {
  const response = sseResponse([
    { choices: [{ index: 0, delta: { content: 'Checking ' } }] },
    { choices: [{ index: 0, delta: { content: 'the workspace.', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]);
  let streamed = '';
  const result = await readCompletion(response, delta => { streamed += delta; });
  assert.equal(result.content, 'Checking the workspace.');
  assert.equal(streamed, 'Checking the workspace.');
  assert.equal(result.nativeToolCalls, true);
});

test('slash command parser supports JSON objects and concise named arguments', () => {
  assert.deepEqual(
    parseSlashToolCommand('/read_file {"path":"src/app.js"}', ['read_file']),
    { name: 'read_file', args: { path: 'src/app.js' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/read_file path="src/app.js" start_line=12', ['read_file']),
    { name: 'read_file', args: { path: 'src/app.js', start_line: 12 } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/read_file path=src/app.js', ['read_file']),
    { name: 'read_file', args: { path: 'src/app.js' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/environment_info', ['environment_info']),
    { name: 'environment_info', args: {} }
  );
  assert.deepEqual(
    parseSlashToolCommand('/batch steps=[{"tool":"read_file","args":{"path":"README.md"}},{"tool":"git_status","args":{}}]', ['batch']),
    { name: 'batch', args: { steps: [{ tool: 'read_file', args: { path: 'README.md' } }, { tool: 'git_status', args: {} }] } }
  );
  assert.equal(parseSlashToolCommand('Please inspect the project.'), null);
  assert.throws(() => parseSlashToolCommand('/not_a_tool {}', ['read_file']), /Unknown local tool/);
  assert.throws(() => parseSlashToolCommand('/read_file {"path":', ['read_file']), /JSON object or key=value/);
  assert.throws(() => parseSlashToolCommand('/read_file path=one path=two', ['read_file']), /repeated/);
  assert.throws(() => parseSlashToolCommand('/read_file []', ['read_file']), /Use named arguments/);
});

test('explicit user slash command executes locally and does not send native API tool schemas', async () => {
  const session = { sessionId: 'session-abcdef0123456789abcdef0123456789', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'The README was inspected.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { protocol: 'local-tool-result/v1', status: 'success', result: { content: 'actual README contents' } };
    }
  });
  const result = await runtime.sendMessage('direct-agent-002', '/read_file path="README.md"');
  assert.equal(result.completed, true);
  assert.deepEqual(executed, [{ name: 'read_file', args: { path: 'README.md' } }]);
  assert.equal(requests.length, 1);
  assert.ok(!Object.hasOwn(requests[0], 'tools'));
  assert.ok(!Object.hasOwn(requests[0], 'tool_choice'));
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content === '/read_file path="README.md"'));
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content.includes('actual README contents')));
  assert.ok(requests[0].messages.every(message => !Object.hasOwn(message, 'tool_calls')));
  assert.equal(session.messages.at(-1).content, 'The README was inspected.');
});

test('model invokes tools with assistant slash commands and receives local results on the next turn', async () => {
  const session = { sessionId: 'session-0123456789abcdef0123456789abcdef', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  const events = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) {
        return sseResponse([
          { choices: [{ index: 0, delta: { content: '/read_file path="README.md"' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I inspected README.md and found the project guidance.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args, requestId, sessionId) => {
      executed.push({ name, args, requestId, sessionId });
      return { protocol: 'local-tool-result/v2', status: 'success', result: { content: 'actual README contents' } };
    },
    onEvent: event => events.push(event)
  });

  const result = await runtime.sendMessage('direct-agent-001', 'Inspect the repository instructions.');
  assert.deepEqual(result, { accepted: true, completed: true });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'read_file');
  assert.deepEqual(executed[0].args, { path: 'README.md' });
  assert.equal(executed[0].sessionId, session.sessionId);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(!Object.hasOwn(request, 'tools'));
    assert.ok(!Object.hasOwn(request, 'tool_choice'));
    assert.ok(request.messages.every(message => !Object.hasOwn(message, 'tool_calls')));
  }
  assert.match(requests[0].messages[0].content, /AVAILABLE LOCAL SLASH COMMANDS/);
  assert.match(requests[0].messages[0].content, /\/read_file — Read a workspace file/);
  assert.ok(requests[1].messages.some(message => message.role === 'assistant' && message.content === '/read_file {"path":"README.md"}'));
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('[Untrusted local tool result for /read_file; status=success]')));
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('actual README contents')));
  assert.equal(session.messages.at(-1).content, 'I inspected README.md and found the project guidance.');
  assert.ok(events.some(event => event.type === 'tool_started' && event.source === 'model-slash'));
  assert.ok(events.some(event => event.type === 'tool_completed' && event.source === 'model-slash'));
});

test('native function-call output is rejected and the model is guided to the slash protocol', async () => {
  const session = { sessionId: 'session-fedcba9876543210fedcba9876543210', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) {
        return sseResponse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'provider_call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ]);
      }
      if (callNumber === 2) {
        return sseResponse([
          { choices: [{ index: 0, delta: { content: '/environment_info' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]);
      }
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'The environment was inspected.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { status: 'success', result: { platform: 'Windows' } };
    }
  });

  const result = await runtime.sendMessage('direct-agent-003', 'Inspect the environment.');
  assert.deepEqual(result, { accepted: true, completed: true });
  assert.deepEqual(executed, [{ name: 'environment_info', args: {} }]);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('Native API function calls are disabled')));
  assert.ok(requests[2].messages.some(message => message.role === 'assistant' && message.content === '/environment_info'));
  assert.ok(requests.every(request => !Object.hasOwn(request, 'tools') && !Object.hasOwn(request, 'tool_choice')));
  assert.ok(session.messages.some(message => message.kind === 'runtime_feedback'));
});

test('legacy native tool-call history is converted to slash messages and untrusted observations', () => {
  const apiMessages = toApiMessages([
    { role: 'user', content: 'Read a file.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
    },
    { role: 'tool', tool_call_id: 'old_call', name: 'read_file', content: '{"status":"success","result":"file text"}' },
    { role: 'assistant', content: 'Done.' }
  ]);
  assert.deepEqual(apiMessages, [
    { role: 'user', content: 'Read a file.' },
    { role: 'assistant', content: '/read_file {"path":"README.md"}' },
    { role: 'user', content: '[Untrusted local tool result from /read_file]\n{"status":"success","result":"file text"}' },
    { role: 'assistant', content: 'Done.' }
  ]);
  assert.ok(apiMessages.every(message => !Object.hasOwn(message, 'tool_calls')));
  assert.ok(apiMessages.every(message => !Object.hasOwn(message, 'tool_call_id')));
});
