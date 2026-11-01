'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDirectAgentRuntime,
  normalizeDirectAgentConfig,
  endpointFor,
  readCompletion
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

test('direct API configuration validates provider, endpoint and model', () => {
  const config = normalizeDirectAgentConfig({
    provider: 'koboldcpp',
    endpoint: 'http://127.0.0.1:5001/v1/',
    model: 'koboldcpp/model'
  });
  assert.equal(config.endpoint, 'http://127.0.0.1:5001/v1');
  assert.equal(endpointFor(config.endpoint, 'chat/completions'), 'http://127.0.0.1:5001/v1/chat/completions');
  assert.equal(config.apiKey, '');
  assert.throws(() => normalizeDirectAgentConfig({
    provider: 'openai-compatible', endpoint: 'file:///tmp/api', model: 'model'
  }), /HTTP or HTTPS/);
  assert.throws(() => normalizeDirectAgentConfig({
    provider: 'openai-compatible', endpoint: 'https://user:pass@example.com/v1', model: 'model'
  }), /must not contain credentials/);
});

test('direct agent catalog includes local coding tools but excludes mailbox controls', () => {
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

test('SSE parser accumulates streamed text and partial tool-call arguments', async () => {
  const response = sseResponse([
    { choices: [{ index: 0, delta: { content: 'Hello ' } }] },
    { choices: [{ index: 0, delta: { content: 'world', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'environment_info', arguments: '{"verbose":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }, finish_reason: 'tool_calls' }] }
  ]);
  let streamed = '';
  const result = await readCompletion(response, delta => { streamed += delta; });
  assert.equal(result.content, 'Hello world');
  assert.equal(streamed, 'Hello world');
  assert.equal(result.toolCalls.get(0).id, 'call_1');
  assert.equal(result.toolCalls.get(0).function.name, 'environment_info');
  assert.equal(result.toolCalls.get(0).function.arguments, '{"verbose":true}');
  assert.equal(result.finishReason, 'tool_calls');
});

test('direct chat executes tools locally and feeds tool results into the next API request', async () => {
  const session = { sessionId: 'session-0123456789abcdef0123456789abcdef', messages: [], status: 'idle', error: '' };
  const saved = [];
  const requests = [];
  const executed = [];
  let callNumber = 0;
  const runtime = createDirectAgentRuntime({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      callNumber++;
      if (callNumber === 1) return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_local', type: 'function', function: { name: 'environment_info', arguments: '{}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]);
      return sseResponse([
        { choices: [{ index: 0, delta: { content: 'The local tool ran successfully.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    },
    getConfig: async () => ({
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8000/v1',
      model: 'test-model',
      apiKey: 'not-a-real-secret',
      systemPrompt: '',
      temperature: 0.2,
      maxTokens: 1024
    }),
    getSession: async () => session,
    saveSession: async (_agentId, value) => { saved.push(structuredClone(value)); },
    getToolDefinitions: async () => [{ type: 'function', function: { name: 'environment_info', description: 'Inspect the workspace', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    executeTool: async (name, args, callId, sessionId) => {
      executed.push({ name, args, callId, sessionId });
      return { protocol: 'chatgpt-local-tool-result-v2', status: 'success', result: { platform: 'win32' } };
    },
    onEvent: () => {}
  });

  const result = await runtime.sendMessage('direct-agent-001', 'Inspect the environment.');
  assert.deepEqual(result, { accepted: true, completed: true });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'environment_info');
  assert.equal(executed[0].sessionId, session.sessionId);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_local'));
  assert.ok(requests.every(request => request.messages.every(message => !Object.hasOwn(message, 'createdAt'))));
  assert.equal(session.status, 'idle');
  assert.equal(session.messages.at(-1).content, 'The local tool ran successfully.');
  assert.ok(saved.length >= 3);
  assert.equal(runtime.isRunning('direct-agent-001'), false);
});
