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
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 1024
  };
}

function definitions() {
  return getDirectAgentToolDefinitions();
}

test('SSE completion returns on [DONE] even when the API keeps its HTTP stream open', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"index":0,"delta":{"content":"Hello!"}}]}\n\n' +
        'data: [DONE]\n\n'
      ));
      // Deliberately leave the stream open to reproduce a proxy that holds the
      // response connection after sending the protocol terminator.
    },
    cancel() { cancelled = true; }
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const result = await Promise.race([
    readCompletion(response),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE parser waited for the HTTP connection to close.')), 250))
  ]);
  assert.equal(result.content, 'Hello!');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(cancelled, true);
});

test('SSE completion returns on finish_reason without waiting for [DONE] or connection close', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n'
      ));
    },
    cancel() { cancelled = true; }
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const result = await Promise.race([
    readCompletion(response),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE parser waited after finish_reason.')), 250))
  ]);
  assert.equal(result.content, 'Hi');
  assert.equal(result.finishReason, 'stop');
  assert.equal(cancelled, true);
});

test('ordinary chat turn completes after SSE [DONE] even if the server keeps the stream open', async () => {
  const session = { sessionId: 'session-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', messages: [], status: 'idle', error: '' };
  let cancelled = false;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"index":0,"delta":{"content":"Hey there!"}}]}\n\n' +
          'data: [DONE]\n\n'
        ));
      },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'text/event-stream' } }),
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async () => { throw new Error('No tool should run for a plain greeting.'); }
  });

  const result = await runtime.sendMessage('direct-agent-004', 'hey');
  assert.deepEqual(result, { accepted: true, completed: true });
  assert.equal(session.status, 'idle');
  assert.equal(session.messages.at(-1).content, 'Hey there!');
  assert.equal(cancelled, true);
  assert.equal(runtime.isRunning('direct-agent-004'), false);
});

test('direct API configuration validates and preserves sampling parameters', () => {
  const normalized = normalizeDirectAgentConfig({
    provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8000/v1', model: 'test-model',
    temperature: 0.8, topP: 0.9, frequencyPenalty: 0.4, presencePenalty: -0.2, maxTokens: 2048
  });
  assert.deepEqual({
    temperature: normalized.temperature, topP: normalized.topP,
    frequencyPenalty: normalized.frequencyPenalty, presencePenalty: normalized.presencePenalty,
    maxTokens: normalized.maxTokens
  }, { temperature: 0.8, topP: 0.9, frequencyPenalty: 0.4, presencePenalty: -0.2, maxTokens: 2048 });
  for (const invalid of [{ topP: 1.1 }, { frequencyPenalty: 2.1 }, { presencePenalty: -2.1 }, { temperature: 2.1 }, { maxTokens: 255 }]) {
    assert.throws(() => normalizeDirectAgentConfig({
      provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8000/v1', model: 'test-model', ...invalid
    }));
  }
});

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

test('direct agent catalog is generated from registered capabilities and never exceeds 30 tools', () => {
  const tools = getDirectAgentToolDefinitions();
  const names = tools.map(item => item.function.name);
  assert.ok(tools.length <= 30, 'published catalog exceeds the hard 30-tool limit');
  assert.equal(new Set(names).size, names.length, 'catalog contains duplicate tool names');
  assert.deepEqual(names, ['workspace', 'project', 'git', 'computer', 'tts', 'shell', 'run_tests', 'update_plan', 'batch']);
  for (const name of ['workspace', 'project', 'git', 'shell', 'run_tests', 'computer', 'batch']) {
    assert.ok(names.includes(name), 'missing grouped capability: ' + name);
  }
  for (const name of ['session_start', 'agent_status', 'send_agent_message', 'upload_workspace_file', 'github_api', 'read_file', 'write_file', 'git_status']) {
    assert.ok(!names.includes(name), 'individual/internal tool leaked into direct catalog: ' + name);
  }
  const batch = tools.find(item => item.function.name === 'batch');
  assert.deepEqual(batch.function.parameters.properties.steps.items.properties.tool.enum, names.filter(name => name !== 'batch'));
});

test('slash catalog documents only the grouped published tools and named arguments', () => {
  const catalog = formatSlashToolCatalog(definitions());
  assert.match(catalog, /\/workspace — Workspace operations/);
  assert.match(catalog, /\/project — Project intelligence operations/);
  assert.match(catalog, /\/git — Git operations/);
  assert.match(catalog, /action \(string \(one of:/);
  assert.doesNotMatch(catalog, /\/read_file —/);
  assert.doesNotMatch(catalog, /JSON literals/);
});

test('Chat Completions request includes configured standard sampling parameters', async () => {
  const session = { sessionId: 'session-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', messages: [], status: 'idle', error: '' };
  let requestBody;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'Ready.' }, finish_reason: 'stop' }] }]);
    },
    getConfig: async () => ({ ...config(), temperature: 0.7, topP: 0.85, frequencyPenalty: 0.3, presencePenalty: 0.2 }),
    getSession: async () => session, saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async () => { throw new Error('No tool expected.'); }
  });
  const result = await runtime.sendMessage('direct-agent-004', 'hello');
  assert.equal(result.completed, true);
  assert.equal(requestBody.temperature, 0.7);
  assert.equal(requestBody.top_p, 0.85);
  assert.equal(requestBody.frequency_penalty, 0.3);
  assert.equal(requestBody.presence_penalty, 0.2);
  assert.equal(requestBody.max_tokens, 1024);
});

test('SSE parser reconstructs streamed native tool names and arguments', async () => {
  const response = sseResponse([
    { choices: [{ index: 0, delta: { content: 'Checking ' } }] },
    { choices: [{ index: 0, delta: { content: 'the workspace.', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'work', arguments: '{"action":"read",' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'space', arguments: '"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }
  ]);
  let streamed = '';
  const result = await readCompletion(response, delta => { streamed += delta; });
  assert.equal(result.content, 'Checking the workspace.');
  assert.equal(streamed, 'Checking the workspace.');
  assert.equal(result.nativeToolCalls, true);
  assert.deepEqual(result.toolCalls, [{
    index: 0, id: 'call_1', type: 'function',
    function: { name: 'workspace', arguments: '{"action":"read","path":"README.md"}' }
  }]);
  assert.equal(result.finishReason, 'tool_calls');
});

test('slash command parser uses readable named arguments and list values, not JSON objects', () => {
  assert.throws(() => parseSlashToolCommand('/read_file {"path":"src/app.js"}', ['read_file']), /JSON argument objects/);
  const available = definitions().map(item => item.function.name);
  assert.deepEqual(
    parseSlashToolCommand('/read_file path="src/app.js" startLine=12', available),
    { name: 'workspace', args: { path: 'src/app.js', startLine: 12, action: 'read' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/workspace action=read path=src/app.js', available),
    { name: 'workspace', args: { action: 'read', path: 'src/app.js' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/environment_info', available),
    { name: 'workspace', args: { action: 'environment' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/project_search query="main entry" kind=symbol maxResults=8', available),
    { name: 'project', args: { query: 'main entry', kind: 'symbol', maxResults: 8, action: 'search' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/project action=index_status', available),
    { name: 'project', args: { action: 'index_status' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/find path="src" pattern="**/*.js"', available),
    { name: 'workspace', args: { path: 'src', pattern: '**/*.js', action: 'glob' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/plan items=[Inspect, Test]', available),
    { name: 'update_plan', args: { items: ['Inspect', 'Test'] } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/run command="npm test"', available),
    { name: 'shell', args: { command: 'npm test' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/test command="npm test"', available),
    { name: 'run_tests', args: { command: 'npm test' } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/update_plan items=[Inspect files, Implement fix, Run tests]', ['update_plan']),
    { name: 'update_plan', args: { items: ['Inspect files', 'Implement fix', 'Run tests'] } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/batch steps="read_file path=README.md; git_status"', ['batch']),
    { name: 'batch', args: { steps: [{ tool: 'workspace', args: { path: 'README.md', action: 'read' } }, { tool: 'git', args: { action: 'status' } }] } }
  );
  assert.deepEqual(
    parseSlashToolCommand("/batch steps=\"shell command='Write-Output one; two'; git_status\"", available),
    { name: 'batch', args: { steps: [{ tool: 'shell', args: { command: 'Write-Output one; two' } }, { tool: 'git', args: { action: 'status' } }] } }
  );
  assert.deepEqual(
    parseSlashToolCommand('/computer action=sequence steps="click x=400 y=300; type text=Hello; press key=ENTER"', ['computer']),
    { name: 'computer', args: { action: 'sequence', steps: [{ action: 'click', x: 400, y: 300 }, { action: 'type', text: 'Hello' }, { action: 'press', key: 'ENTER' }] } }
  );
  assert.deepEqual(
    parseSlashToolCommand("/computer action=sequence steps=\"type text='a; b'; press key=ENTER\"", available),
    { name: 'computer', args: { action: 'sequence', steps: [{ action: 'type', text: 'a; b' }, { action: 'press', key: 'ENTER' }] } }
  );
  assert.equal(parseSlashToolCommand('Please inspect the project.'), null);
  assert.deepEqual(parseSlashToolCommand('/project', available), { name: 'project', args: { action: 'status' } });
  assert.throws(() => parseSlashToolCommand('/not_a_tool {}', ['read_file']), /Unknown local tool/);
  assert.throws(() => parseSlashToolCommand('/read_file {"path":', ['read_file']), /JSON argument objects/);
  assert.throws(() => parseSlashToolCommand('/read_file path=one path=two', ['read_file']), /repeated/);
  assert.throws(() => parseSlashToolCommand('/read_file []', ['read_file']), /Use named arguments/);
});

test('explicit user slash shortcut routes through grouped local capability and preserves the actual result', async () => {
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
  assert.deepEqual(executed, [{ name: 'workspace', args: { path: 'README.md', action: 'read' } }]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.length <= 30);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'workspace'));
  assert.equal(requests[0].tool_choice, 'auto');
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content === '/read_file path="README.md"'));
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content.includes('actual README contents')));
  assert.ok(requests[0].messages.every(message => !Object.hasOwn(message, 'tool_calls')));
  assert.equal(session.messages.at(-1).content, 'The README was inspected.');
});

test('model slash fallback executes the grouped command and receives the real result before answering', async () => {
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
  assert.equal(executed[0].name, 'workspace');
  assert.deepEqual(executed[0].args, { path: 'README.md', action: 'read' });
  assert.equal(executed[0].sessionId, session.sessionId);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(request.tools.length <= 30);
    assert.equal(request.tool_choice, 'auto');
    assert.ok(request.messages.every(message => !Object.hasOwn(message, 'tool_calls')));
  }
  assert.match(requests[0].messages[0].content, /AVAILABLE LOCAL SLASH COMMANDS/);
  assert.match(requests[0].messages[0].content, /\/workspace — Workspace operations/);
  assert.ok(requests[1].messages.some(message => message.role === 'assistant' && message.content === '/workspace action=read path=README.md'));
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('[Untrusted local tool result for /workspace; status=success]')));
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('actual README contents')));
  assert.equal(session.messages.at(-1).content, 'I inspected README.md and found the project guidance.');
  assert.ok(events.some(event => event.type === 'tool_started' && event.source === 'model-slash'));
  assert.ok(events.some(event => event.type === 'tool_completed' && event.source === 'model-slash'));
});

test('native function calls are parsed, validated, executed and fed back for the next model turn', async () => {
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
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'provider_call', type: 'function', function: { name: 'workspace', arguments: '{"action":"read",' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }
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
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { status: 'success', result: { content: 'actual README contents' } };
    }
  });

  const result = await runtime.sendMessage('direct-agent-003', 'Inspect the repository instructions.');
  assert.deepEqual(result, { accepted: true, completed: true });
  assert.deepEqual(executed, [{ name: 'workspace', args: { action: 'read', path: 'README.md' } }]);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.length <= 30);
  assert.equal(requests[0].tool_choice, 'auto');
  assert.ok(requests[1].tools.length <= 30);
  assert.ok(requests[1].messages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls)));
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'provider_call' && message.content.includes('actual README contents')));
  assert.equal(session.messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(session.messages.at(-1).content, 'I inspected README.md and found the project guidance.');
});

test('providers that reject native tools fall back to the slash-command protocol', async () => {
  const session = { sessionId: 'session-aaaaaaaa11111111aaaaaaaa11111111', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return new Response(JSON.stringify({ error: { message: 'This model does not support tools.' } }), {
        status: 400, headers: { 'content-type': 'application/json' }
      });
      if (callNumber === 2) return sseResponse([
        { choices: [{ index: 0, delta: { content: '/workspace action=read path=README.md' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I inspected README.md.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => ({ ...config(), provider: 'koboldcpp' }),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { status: 'success', result: { content: 'actual file contents' } };
    }
  });
  const result = await runtime.sendMessage('direct-agent-003', 'Read README.md.');
  assert.equal(result.completed, true);
  assert.deepEqual(executed, [{ name: 'workspace', args: { action: 'read', path: 'README.md' } }]);
  assert.equal(requests.length, 3);
  assert.ok(requests[0].tools.length <= 30);
  assert.ok(!Object.hasOwn(requests[1], 'tools'));
  assert.ok(!Object.hasOwn(requests[2], 'tools'));
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('Native tool calling unavailable')));
  assert.ok(requests[2].messages.some(message => message.role === 'assistant' && message.content === '/workspace action=read path=README.md'));
  assert.equal(session.toolProtocol, 'slash');
});

test('models that explicitly report native tool limitations are switched to slash fallback', async () => {
  const session = { sessionId: 'session-eeeeeeee55555555eeeeeeee55555555', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { content: "I cannot use the available tools with this model." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
      if (callNumber === 2) return sseResponse([
        { choices: [{ index: 0, delta: { content: '/workspace action=read path=README.md' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I read README.md.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(), getSession: async () => session, saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { status: 'success', result: { content: 'verified README contents' } };
    }
  });
  const result = await runtime.sendMessage('direct-agent-008', 'Read README.md.');
  assert.equal(result.completed, true);
  assert.deepEqual(executed, [{ name: 'workspace', args: { action: 'read', path: 'README.md' } }]);
  assert.ok(!Object.hasOwn(requests[1], 'tools'));
  assert.ok(requests[1].messages.some(message => message.content.includes('Native tool calling unavailable')));
  assert.equal(session.toolProtocol, 'slash');
});

test('invalid native tool names, schemas and malformed arguments never execute', async () => {
  const session = { sessionId: 'session-ffffffff66666666ffffffff66666666', messages: [], status: 'idle', error: '' };
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async () => {
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: 'invalid_action', type: 'function', function: { name: 'workspace', arguments: '{"action":"run_anything","command":"whoami"}' } },
          { index: 1, id: 'invalid_json', type: 'function', function: { name: 'workspace', arguments: '{"action":"read",}' } },
          { index: 2, id: 'unknown_tool', type: 'function', function: { name: 'powershell_unrestricted', arguments: '{"command":"whoami"}' } }
        ] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I cannot truthfully report any operation as completed.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(), getSession: async () => session, saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => { executed.push({ name, args }); return { status: 'success' }; }
  });
  const result = await runtime.sendMessage('direct-agent-009', 'Do an unsupported command.');
  assert.equal(result.completed, true);
  assert.equal(executed.length, 0);
  assert.equal(session.messages.filter(message => message.role === 'tool').length, 3);
  assert.ok(session.messages.some(message => message.role === 'tool' && message.content.includes('must be one of:')));
  assert.ok(session.messages.some(message => message.role === 'tool' && message.content.includes('invalid JSON')));
  assert.ok(session.messages.some(message => message.role === 'tool' && message.content.includes('not registered')));
});

test('ordinary execution claims do not execute anything and trigger the explicit fallback', async () => {
  const session = { sessionId: 'session-bbbbbbbb22222222bbbbbbbb22222222', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I ran npm test and all tests passed.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
      if (callNumber === 2) return sseResponse([
        { choices: [{ index: 0, delta: { content: '/test command="npm test"' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I tested the project.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { status: 'success', result: { exitCode: 0, stdout: 'Tests passed.' } };
    }
  });
  const result = await runtime.sendMessage('direct-agent-005', 'Run the test suite.');
  assert.equal(result.completed, true);
  assert.deepEqual(executed, [{ name: 'run_tests', args: { command: 'npm test' } }]);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('Unverified execution claim')));
  assert.ok(!Object.hasOwn(requests[1], 'tools'));
  assert.equal(session.toolProtocol, 'slash');
});

test('multiple native calls execute in parallel and later rounds receive their results', async () => {
  const session = { sessionId: 'session-dddddddd44444444dddddddd44444444', messages: [], status: 'idle', error: '' };
  const requests = [];
  const executed = [];
  let active = 0;
  let maxActive = 0;
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: 'read_1', type: 'function', function: { name: 'workspace', arguments: '{"action":"read","path":"README.md"}' } },
          { index: 1, id: 'project_1', type: 'function', function: { name: 'project', arguments: '{"action":"overview"}' } }
        ] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      if (callNumber === 2) return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: 'git_1', type: 'function', function: { name: 'git', arguments: '{"action":"status"}' } }
        ] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I inspected the workspace.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(),
    getSession: async () => session,
    saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async (name, args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      executed.push({ name, args });
      return { status: 'success', result: { inspected: name } };
    }
  });
  const result = await runtime.sendMessage('direct-agent-007', 'Inspect project files and Git status.');
  assert.equal(result.completed, true);
  assert.equal(executed.length, 3);
  assert.ok(maxActive > 1, 'independent native calls in one round should execute concurrently');
  assert.ok(requests[0].tools.length <= 30);
  assert.ok(requests[1].messages.filter(message => message.role === 'tool').length >= 2);
  assert.ok(requests[2].messages.some(message => message.role === 'tool' && message.tool_call_id === 'git_1'));
  assert.equal(session.messages.filter(message => message.role === 'tool').length, 3);
});

test('repeated native side effects with identical arguments are blocked inside one turn', async () => {
  const session = { sessionId: 'session-cccccccc33333333cccccccc33333333', messages: [], status: 'idle', error: '' };
  const requests = [];
  let executed = 0;
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: 'write_1', type: 'function', function: { name: 'workspace', arguments: '{"action":"write","path":"same.txt","content":"hello"}' } },
          { index: 1, id: 'write_2', type: 'function', function: { name: 'workspace', arguments: '{"action":"write","path":"same.txt","content":"hello"}' } }
        ] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'I wrote the file once.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => config(), getSession: async () => session, saveSession: async () => {},
    getToolDefinitions: async () => definitions(),
    executeTool: async () => { executed++; return { status: 'success', result: { path: 'same.txt' } }; }
  });
  const result = await runtime.sendMessage('direct-agent-006', 'Write a file once.');
  assert.equal(result.completed, true);
  assert.equal(executed, 1);
  assert.equal(requests.length, 2);
  assert.ok(session.messages.some(message => message.role === 'tool' && message.content.includes('Repeated identical side effect blocked')));
});

test('Markdown tool observations redact secrets and preserve code/output structure', () => {
  const { formatToolResultMarkdown } = require('../desktop/markdown-tool-output');
  const rendered = formatToolResultMarkdown('workspace', { protocol: 'private-protocol', status: 'success', result: {
    projectRoot: 'C:/work/demo',
    detectedTechnologies: ['Node.js', 'TypeScript'],
    buildCommands: [{ name: 'build', command: 'npm run build' }],
    apiKey: 'secret-value',
    warnings: []
  } });
  assert.match(rendered, /\\*\\*Project Root:\\*\\* C:\\/work\\/demo/);
  assert.match(rendered, /- Node.js/);
  assert.match(rendered, /npm run build/);
  assert.match(rendered, /\\[redacted\\]/);
  assert.doesNotMatch(rendered, /"projectRoot"|private-protocol|secret-value/);
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
    { role: 'assistant', content: '/workspace action=read path=README.md' },
    { role: 'user', content: '[Untrusted local tool observation from /read_file]\n### Tool result: `/read_file`\n- **Status:** success\n\n#### Result\n- **Result:** file text' },
    { role: 'assistant', content: 'Done.' }
  ]);
  assert.ok(apiMessages.every(message => !Object.hasOwn(message, 'tool_calls')));
  assert.ok(apiMessages.every(message => !Object.hasOwn(message, 'tool_call_id')));
  assert.deepEqual(toApiMessages([
    { role: 'user', content: '/read_file {"path":"README.md"}' }
  ]), [
    { role: 'user', content: '/workspace action=read path=README.md' }
  ]);
  const nativeMessages = toApiMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'native_1', type: 'function', function: { name: 'workspace', arguments: '{"action":"read","path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'native_1', name: 'workspace', content: 'actual result' }
  ], { nativeToolCalling: true });
  assert.deepEqual(nativeMessages, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'native_1', type: 'function', function: { name: 'workspace', arguments: '{"action":"read","path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'native_1', content: 'actual result' }
  ]);
});
