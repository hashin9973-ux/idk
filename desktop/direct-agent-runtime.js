'use strict';

const { randomUUID } = require('node:crypto');
const { formatSlashCommand } = require('./agent-terminal');
const { DIRECT_AGENT_TOOL_NAMES } = require('./tool-bridge');
const fs = require('node:fs');
const path = require('node:path');
const DIRECT_AGENT_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'direct-agent-instructions.md'), 'utf8').trim();

const MAX_TOOL_ROUNDS = 16;
const MAX_STORED_MESSAGES = 160;
const MAX_TOOL_RESULT_CHARS = 48000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;



function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!['openai-compatible', 'koboldcpp'].includes(provider)) {
    throw new Error('Provider must be openai-compatible or koboldcpp.');
  }
  return provider;
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new Error('Enter an API base URL (up to 2,048 characters).');
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error('The API base URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) {
    throw new Error('The API URL must use HTTP or HTTPS and must not contain credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
}

function endpointFor(base, suffix) {
  const normalized = normalizeEndpoint(base);
  if (normalized.endsWith('/chat/completions')) return normalized;
  return normalized + '/' + suffix.replace(/^\/+/, '');
}

function normalizeDirectAgentConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Direct API connection settings are required.');
  }
  const provider = normalizeProvider(value.provider);
  const endpoint = normalizeEndpoint(value.endpoint);
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model || model.length > 256) throw new Error('Enter a model name or model ID (up to 256 characters).');
  const apiKey = value.apiKey === undefined || value.apiKey === null ? '' : String(value.apiKey);
  if (apiKey.length > 4096) throw new Error('The API key is longer than 4,096 characters.');
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt.trim() : '';
  if (systemPrompt.length > 12000) throw new Error('The custom agent instructions are longer than 12,000 characters.');
  const numberSetting = (key, fallback, min, max, label) => {
    const number = value[key] === undefined ? fallback : Number(value[key]);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(label + ' must be from ' + min + ' to ' + max + '.');
    return number;
  };
  const temperature = numberSetting('temperature', 0.2, 0, 2, 'Temperature');
  const topP = numberSetting('topP', 1, 0, 1, 'Top-p');
  const frequencyPenalty = numberSetting('frequencyPenalty', 0, -2, 2, 'Frequency penalty');
  const presencePenalty = numberSetting('presencePenalty', 0, -2, 2, 'Presence penalty');
  const maxTokens = value.maxTokens === undefined ? 8192 : Number(value.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) {
    throw new Error('Maximum response tokens must be an integer from 256 to 32,768.');
  }
  return { provider, endpoint, model, apiKey, systemPrompt, temperature, topP, frequencyPenalty, presencePenalty, maxTokens };
}

function safeError(value, secret = '') {
  let message = String(value && value.message || value || 'Unknown API error.');
  if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, 1000);
}

function markdownKey(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, character => character.toUpperCase());
}

function markdownFence(value) {
  const text = String(value);
  const runs = text.match(/`{3,}/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return fence + '\n' + text.replace(/\r\n/g, '\n') + '\n' + fence;
}

function formatMarkdownValue(value, depth = 0) {
  const indent = '  '.repeat(depth);
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (!value.trim()) return '—';
    if (value.includes('\n') || value.length > 500 || /^\s/.test(value)) return markdownFence(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    return value.map((item, index) => {
      if (item && typeof item === 'object') {
        const heading = item.name || item.title || item.path || item.id || ('Item ' + (index + 1));
        const rest = Object.entries(item).filter(([key]) => !['name','title','path','id'].includes(key));
        return indent + '- **' + String(heading).replace(/\n/g, ' ') + '**' +
          (rest.length ? '\n' + rest.map(([key, nested]) => indent + '  - **' + markdownKey(key) + ':** ' + formatMarkdownValue(nested, depth + 2)).join('\n') : '');
      }
      return indent + '- ' + formatMarkdownValue(item, depth + 1);
    }).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '—';
    return entries.map(([key, nested]) => {
      const rendered = formatMarkdownValue(nested, depth + 1);
      const block = rendered.includes('\n') || rendered.startsWith('```');
      return indent + '- **' + markdownKey(key) + ':**' + (block ? '\n' + rendered.split('\n').map(line => indent + '  ' + line).join('\n') : ' ' + rendered);
    }).join('\n');
  }
  return String(value);
}

function formatToolResultMarkdown(value) {
  const rendered = formatMarkdownValue(value);
  return rendered.length > MAX_TOOL_RESULT_CHARS
    ? rendered.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[Tool observation truncated. Request a narrower result or smaller page.]'
    : rendered;
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Tool arguments must be a non-empty JSON object.');
  let parsed;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new Error('The model returned invalid JSON for tool arguments: ' + safeError(error)); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must decode to a JSON object.');
  }
  return parsed;
}

function mergeToolCall(state, incoming, complete = false) {
  if (!incoming || typeof incoming !== 'object') return;
  const index = Number.isInteger(incoming.index) && incoming.index >= 0
    ? incoming.index : state.toolCalls.length;
  let target = state.toolCalls.find(item => item.index === index);
  if (!target) {
    target = { index, id: '', type: 'function', function: { name: '', arguments: '' } };
    state.toolCalls.push(target);
  }
  if (typeof incoming.id === 'string' && incoming.id) target.id = incoming.id;
  if (typeof incoming.type === 'string' && incoming.type) target.type = incoming.type;
  const fn = incoming.function && typeof incoming.function === 'object' ? incoming.function : {};
  if (typeof fn.name === 'string') target.function.name = complete ? fn.name : target.function.name + fn.name;
  if (typeof fn.arguments === 'string') target.function.arguments = complete ? fn.arguments : target.function.arguments + fn.arguments;
  else if (complete && fn.arguments && typeof fn.arguments === 'object') target.function.arguments = JSON.stringify(fn.arguments);
}

function consumeCompletionChunk(chunk, state, onDelta) {
  const choices = Array.isArray(chunk && chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    const delta = choice && choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      state.content += delta.content;
      if (typeof onDelta === 'function') onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) mergeToolCall(state, call, false);
    }
    if (choice && choice.finish_reason) state.finishReason = choice.finish_reason;
    if (choice && choice.message) {
      const message = choice.message;
      if (typeof message.content === 'string') {
        state.content += message.content;
        if (typeof onDelta === 'function') onDelta(message.content);
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) mergeToolCall(state, call, true);
      }
    }
  }
  state.nativeToolCalls = state.toolCalls.length > 0;
}

async function readCompletion(response, onDelta) {
  const state = { content: '', nativeToolCalls: false, toolCalls: [], finishReason: '' };
  const contentType = String(response.headers && response.headers.get && response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream') && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData = [];
    let streamFinished = false;

    const dispatch = () => {
      if (!eventData.length) return false;
      const raw = eventData.join('\n').trim();
      eventData = [];
      if (!raw) return false;
      if (raw === '[DONE]') return true;
      let chunk;
      try { chunk = JSON.parse(raw); }
      catch { throw new Error('The API returned a malformed server-sent event.'); }
      consumeCompletionChunk(chunk, state, onDelta);
      // Chat Completions emits finish_reason in the final choice chunk. Do not
      // require the HTTP connection to close after the protocol is complete.
      return Boolean(state.finishReason);
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line) {
            if (dispatch()) {
              streamFinished = true;
              break;
            }
            continue;
          }
          if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
        }
        if (streamFinished) break;
      }

      if (!streamFinished) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const line = buffer.replace(/\r$/, '');
          if (line.startsWith('data:')) {
            eventData.push(line.slice(5).trimStart());
          }
        }
        streamFinished = dispatch();
      }
    } finally {
      if (streamFinished) {
        try { await reader.cancel(); } catch {}
      }
      try { reader.releaseLock(); } catch {}
    }
    return state;
  }

  const body = await response.json();
  consumeCompletionChunk(body, state, onDelta);
  if (!state.finishReason) {
    const choice = body && body.choices && body.choices[0];
    state.finishReason = choice && choice.finish_reason || '';
  }
  return state;
}
function trimHistory(messages) {
  if (!Array.isArray(messages) || messages.length <= MAX_STORED_MESSAGES) {
    return Array.isArray(messages) ? messages : [];
  }
  let start = Math.max(0, messages.length - MAX_STORED_MESSAGES);
  // Keep the latest human turn together with any slash commands and tool observations it produced.
  const isTurnStart = message => message && message.role === 'user' &&
    !['tool_result', 'runtime_feedback'].includes(message.kind);
  while (start > 0 && !isTurnStart(messages[start])) start--;
  return messages.slice(start);
}

function toApiMessages(messages, options = {}) {
  const output = [];
  const preserveNative = options.nativeToolCalling === true;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !['user', 'assistant', 'tool'].includes(message.role)) continue;
    if (message.role === 'user') {
      output.push({ role: 'user', content: typeof message.content === 'string' ? message.content : '' });
      continue;
    }
    if (message.role === 'assistant') {
      let content = typeof message.content === 'string' ? message.content : '';
      if (Array.isArray(message.tool_calls)) {
        if (preserveNative) {
          output.push({
            role: 'assistant',
            content: content || null,
            tool_calls: message.tool_calls
          });
          continue;
        }
        const commands = message.tool_calls.map(call => {
          const name = String(call && call.function && call.function.name || 'unknown_tool');
          const args = typeof (call && call.function && call.function.arguments) === 'string'
            ? call.function.arguments : '{}';
          let parsed = {};
          try { parsed = JSON.parse(args); } catch {}
          return formatSlashCommand(name, parsed);
        });
        content = [content, ...commands].filter(Boolean).join('\n');
      }
      if (content) output.push({ role: 'assistant', content });
      continue;
    }
    const name = String(message.name || 'unknown_tool');
    const toolContent = typeof message.content === 'string' ? message.content : '';
    if (preserveNative && typeof message.tool_call_id === 'string' && message.tool_call_id) {
      output.push({ role: 'tool', tool_call_id: message.tool_call_id, content: toolContent });
    } else {
      let markdown = toolContent;
      if (markdown.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(markdown);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) markdown = formatToolResultMarkdown(parsed);
        } catch {}
      }
      output.push({
        role: 'user',
        content: '[Untrusted local tool observation from /' + name + ']\n' + markdown
      });
    }
  }
  return output;
}


function parseSlashListItem(token) {
  const value = String(token).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error('A quoted command value contains invalid escaping.'); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/\\(['\\])/g, '$1');
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(null|none)$/i.test(value)) return null;
  return value;
}

function parseSlashArgumentValue(raw, start) {
  const first = raw[start];
  if (first === '"' || first === "'") {
    let index = start + 1;
    let escaped = false;
    for (; index < raw.length; index++) {
      const char = raw[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === first) break;
    }
    if (index >= raw.length) throw new Error('A quoted command value is missing its closing quote.');
    return { value: parseSlashListItem(raw.slice(start, index + 1)), next: index + 1 };
  }
  if (first === '[') {
    let index = start + 1, quote = '', escaped = false;
    for (; index < raw.length; index++) {
      const char = raw[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ']') break;
    }
    if (index >= raw.length || quote) throw new Error('A list value is missing its closing bracket or quote.');
    const body = raw.slice(start + 1, index);
    const values = [];
    let token = ''; quote = ''; escaped = false;
    for (const char of body) {
      if (quote) {
        token += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") { quote = char; token += char; }
      else if (char === ',') { if (token.trim()) values.push(parseSlashListItem(token)); token = ''; }
      else token += char;
    }
    if (token.trim()) values.push(parseSlashListItem(token));
    return { value: values, next: index + 1 };
  }
  let index = start;
  while (index < raw.length && !/\s/.test(raw[index])) index++;
  if (index === start) throw new Error('Every command argument needs a value after "=".');
  return { value: parseSlashListItem(raw.slice(start, index)), next: index };
}

function parseSlashArguments(raw, toolName) {
  const input = String(raw || '').trim();
  if (!input) return {};
  if (input.startsWith('{')) {
    throw new Error('Use named arguments for /' + toolName + '; JSON argument objects are not part of the command format.');
  }
  const args = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index++;
    if (index >= input.length) break;
    const match = input.slice(index).match(/^([a-z][a-z0-9_]*)=/i);
    if (!match) throw new Error('Use named arguments for /' + toolName + ', for example: /' + toolName + ' path="src/app.js".');
    const key = match[1];
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe argument key is not allowed.');
    if (Object.prototype.hasOwnProperty.call(args, key)) throw new Error('Argument "' + key + '" is repeated in /' + toolName + '.');
    index += match[0].length;
    const parsed = parseSlashArgumentValue(input, index);
    if (key === 'steps' && typeof parsed.value === 'string' && toolName === 'computer') {
      args[key] = parsed.value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const match = part.match(/^([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
        if (!match) throw new Error('Each computer step needs an action name and named arguments.');
        return { action: match[1], ...parseSlashArguments(match[2] || '', 'computer-step') };
      });
    } else if (key === 'steps' && typeof parsed.value === 'string' && toolName === 'batch') {
      args[key] = parsed.value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const command = parseSlashToolCommand(part.startsWith('/') ? part : '/' + part,
          DIRECT_AGENT_TOOL_NAMES.filter(name => name !== 'batch'));
        if (!command) throw new Error('Each batch step must be a local tool command.');
        return { tool: command.name, args: command.args };
      });
    } else args[key] = parsed.value;
    index = parsed.next;
    if (index < input.length && !/\s/.test(input[index])) throw new Error('Separate command arguments with spaces.');
  }
  return args;
}

function parseSlashToolCommand(input, availableTools = DIRECT_AGENT_TOOL_NAMES) {
  if (typeof input !== 'string' || !input.trim().startsWith('/')) return null;
  const trimmed = input.trim();
  const match = trimmed.match(/^\/([a-z][a-z0-9_]*)(?:\s+([\s\S]*))?$/i);
  if (!match) throw new Error('Slash commands use /tool_name followed by named arguments. Type / to browse available tools.');
  const legacy = {
    project: ['project', 'status', true], status: ['project', 'status'],
    project_status: ['project', 'status'], project_index_status: ['project', 'index_status'],
    project_index_refresh: ['project', 'index_refresh'], project_search: ['project', 'search'],
    project_overview: ['project', 'overview'], project_impact: ['project', 'impact'],
    game_project_intelligence: ['project', 'game'],
    ls: ['workspace', 'list'], list_dir: ['workspace', 'list'],
    tree: ['workspace', 'tree'], directory_tree: ['workspace', 'tree'],
    glob_file_search: ['workspace', 'glob'], read: ['workspace', 'read'], read_file: ['workspace', 'read'],
    file_info: ['workspace', 'info'], search: ['workspace', 'search'],
    discover_instructions: ['workspace', 'instructions'], init: ['workspace', 'init'],
    write: ['workspace', 'write'], write_file: ['workspace', 'write'],
    patch: ['workspace', 'patch'], apply_patch: ['workspace', 'patch'],
    create_directory: ['workspace', 'mkdir'], move_path: ['workspace', 'move'], delete_path: ['workspace', 'delete'],
    environment_info: ['workspace', 'environment'],
    git_status: ['git', 'status'], git_diff: ['git', 'diff'], git_log: ['git', 'log'],
    git_show: ['git', 'show'], git_branches: ['git', 'branches'], git_changed_files: ['git', 'changed'],
    git_worktree: ['git', 'worktree'], git_create_branch: ['git', 'create_branch'],
    git_switch_branch: ['git', 'switch_branch'], git_commit: ['git', 'commit'],
    git_fetch: ['git', 'fetch'], git_pull: ['git', 'pull'], git_push: ['git', 'push'], git_clone: ['git', 'clone'],
    run: ['shell', null], test: ['run_tests', null]
  };
  const alias = legacy[match[1]];
  const name = alias ? alias[0] : match[1];
  if (!Array.isArray(availableTools) || !availableTools.includes(name)) {
    throw new Error('Unknown local tool /' + name + '. Type / to browse available tools.');
  }
  const args = parseSlashArguments(match[2] || '', name);
  if (alias) {
    if (alias[1]) {
      if (args.action !== undefined && alias[2] !== true && args.action !== alias[1]) throw new Error('This shortcut has a fixed action: ' + alias[1] + '.');
      if (args.action === undefined) args.action = alias[1];
    }
  }
  return { name, args };
}

function slashSchemaType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return (schema.type || 'value') + ' (one of: ' + schema.enum.map(value => String(value)).join(', ') + ')';
  if (schema.type === 'array') return 'array' + (schema.items && schema.items.type ? '<' + schema.items.type + '>' : '');
  if (schema.type === 'object') return 'object';
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(slashSchemaType).join('|');
  return schema.type || 'any';
}

function slashSchemaLines(name, schema, required = false, depth = 0) {
  const indent = '  '.repeat(depth + 1);
  const details = [slashSchemaType(schema), required ? 'required' : 'optional'];
  if (schema && schema.default !== undefined) details.push('default ' + String(schema.default));
  if (schema && typeof schema.description === 'string' && schema.description.trim()) {
    details.push(schema.description.trim().replace(/\s+/g, ' ').slice(0, 180));
  }
  const lines = [indent + name + ' (' + details.join('; ') + ')'];
  let nestedProperties = null;
  let nestedRequired = [];
  if (schema && schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    nestedProperties = schema.properties;
    nestedRequired = Array.isArray(schema.required) ? schema.required : [];
  } else if (schema && schema.type === 'array' && schema.items && schema.items.type === 'object' &&
      schema.items.properties && typeof schema.items.properties === 'object') {
    nestedProperties = schema.items.properties;
    nestedRequired = Array.isArray(schema.items.required) ? schema.items.required : [];
    lines.push(indent + '  items: object');
  }
  if (nestedProperties) {
    for (const [childName, childSchema] of Object.entries(nestedProperties)) {
      lines.push(...slashSchemaLines(childName, childSchema, nestedRequired.includes(childName), depth + 1));
    }
  }
  return lines;
}

function formatSlashToolCatalog(tools) {
  const entries = (Array.isArray(tools) ? tools : []).filter(item =>
    item && item.type === 'function' && item.function &&
    typeof item.function.name === 'string' && DIRECT_AGENT_TOOL_NAMES.includes(item.function.name)
  ).map(item => {
    const fn = item.function;
    const parameters = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {};
    const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
    const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
    const args = Object.entries(properties).flatMap(([name, schema]) =>
      slashSchemaLines(name, schema, required.has(name), 0)
    );
    const description = String(fn.description || 'Local Windows workspace tool').replace(/\s+/g, ' ').trim();
    return '/' + fn.name + ' — ' + description + '\n' +
      (args.length ? '  Arguments:\n' + args.join('\n') : '  Arguments: none');
  });
  return [
    'AVAILABLE LOCAL SLASH COMMANDS',
    'Use the exact command names below. Values containing spaces must be double-quoted; use [one, two, three] for simple lists.',
    'Command syntax: /tool_name argument=value other="text with spaces". A command with no arguments is simply /tool_name. For independent work use /batch steps="read_file path=README.md; git_status". Do not send JSON objects or arrays.',
    'Shortcuts: /project and /status → /project action=status; /ls, /tree, /read, /write, /patch → /workspace action=list|tree|read|write|patch; /run → /shell; /test → /run_tests. Use /git action=status|diff|log|show|branches|changed|worktree|create_branch|switch_branch|commit|fetch|pull|push|clone.',
    ...entries
  ].join('\n');
}
function stableToolFingerprint(tool, args) {
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  return String(tool) + ':' + stable(args);
}

function validateSchemaValue(value, schema, label) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.anyOf)) {
    const accepted = schema.anyOf.some(candidate => {
      try { validateSchemaValue(value, candidate, label); return true; } catch { return false; }
    });
    if (!accepted) throw new Error(label + ' does not match any allowed value shape.');
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value)) {
    throw new Error(label + ' must be one of: ' + schema.enum.join(', ') + '.');
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(label + ' must be a string.');
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw new Error(label + ' is too short.');
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw new Error(label + ' is too long.');
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) throw new Error(label + ' has an invalid format.');
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(label + ' must be an integer.');
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + ' must be a finite number.');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean.');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw new Error(label + ' has too few items.');
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw new Error(label + ' has too many items.');
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, label + '[' + index + ']'));
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, required)) throw new Error(label + '.' + required + ' is required.');
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
      if (extra.length) throw new Error(label + ' has unsupported field(s): ' + extra.join(', ') + '.');
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateSchemaValue(item, properties[key], label + '.' + key);
    }
  }
  if ((schema.type === 'integer' || schema.type === 'number') && typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(label + ' is below its minimum.');
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(label + ' exceeds its maximum.');
  }
}

function validateNativeToolArguments(name, args, tools) {
  const definition = tools.find(item => item && item.type === 'function' && item.function && item.function.name === name);
  if (!definition) throw new Error('The model requested a tool that is not registered: ' + name + '.');
  const schema = definition.function.parameters || {};
  validateSchemaValue(args, schema, 'arguments for ' + name);
  return args;
}

function nativeToolUnsupported(errorText) {
  return /(unsupported|not supported|unknown|unrecognized|disabled|does not support|doesn't support).{0,100}(tools?|tool_choice|function.?call)|(tools?|tool_choice|function.?call).{0,100}(unsupported|not supported|unknown|unrecognized|disabled|not allowed)/i.test(String(errorText || ''));
}

function reportsToolInability(content) {
  const value = String(content || '');
  return /\b(?:I|we)\s+(?:cannot|can't|could not|do not|don't)\s+(?:use|call|invoke|access|run|execute)\s+(?:the\s+)?(?:(?:local|available)\s+)?tools?\b/i.test(value) ||
    /\b(?:native\s+)?(?:tool|function)\s+calling\s+(?:is not|isn't|isn't currently)\s+supported\b/i.test(value);
}

function claimedActionKind(content) {
  const value = String(content || '');
  const match = value.match(/\b(?:I|we)\s+(?:(?:have|has)\s+)?(?:successfully\s+)?(read|opened|inspected|checked|searched|listed|created|wrote|updated|edited|patched|deleted|removed|moved|renamed|ran|executed|tested|built|installed|committed|pushed|pulled|fetched|switched|cloned|captured|clicked|typed|pressed|saved)\b/i);
  if (match) return match[1].toLowerCase();
  if (/\b(?:tests?|build)\s+(?:have\s+)?(?:passed|succeeded|completed)\b/i.test(value)) return 'tested';
  return '';
}
function toolSupportsClaim(tool, args, kind) {
  const action = String(args && args.action || '');
  if (['read','opened','inspected','checked','searched','listed'].includes(kind)) {
    return tool === 'workspace' && ['read','list','tree','glob','info','search','instructions'].includes(action) ||
      tool === 'project' || tool === 'git' && ['status','diff','log','show','branches','changed'].includes(action) ||
      tool === 'computer' && ['status','screenshot','wait'].includes(action);
  }
  if (['created','wrote','updated','edited','patched','deleted','removed','moved','renamed','saved'].includes(kind)) {
    return tool === 'workspace' && ['write','patch','mkdir','move','delete','init'].includes(action) ||
      tool === 'git' && ['create_branch','switch_branch','commit','pull','push','clone'].includes(action);
  }
  if (['ran','executed','tested','built','installed'].includes(kind)) return tool === 'shell' || tool === 'run_tests';
  if (['committed','pushed','pulled','fetched','switched','cloned'].includes(kind)) return tool === 'git';
  if (['captured','clicked','typed','pressed'].includes(kind)) return tool === 'computer';
  return false;
}

function isSideEffectingInvocation(tool, args = {}) {
  const action = String(args.action || '');
  if (tool === 'shell' || tool === 'run_tests' || tool === 'tts') return true;
  if (tool === 'computer') return !['status','wait','screenshot'].includes(action);
  if (tool === 'workspace') return ['init','write','patch','mkdir','move','delete'].includes(action);
  if (tool === 'project') return action === 'index_refresh';
  if (tool === 'git') return !['status','diff','log','show','branches','changed'].includes(action);
  if (tool === 'batch') return Array.isArray(args.steps) && args.steps.some(step => isSideEffectingInvocation(step.tool, step.args || {}));
  return false;
}

function createDirectAgentRuntime({
  fetchImpl = globalThis.fetch,
  getConfig,
  getSession,
  saveSession,
  getToolDefinitions,
  executeTool,
  onEvent = () => {},
  clock = () => Date.now()
}) {
  if (typeof fetchImpl !== 'function' || typeof getConfig !== 'function' ||
      typeof getSession !== 'function' || typeof saveSession !== 'function' ||
      typeof getToolDefinitions !== 'function' || typeof executeTool !== 'function') {
    throw new TypeError('Direct-agent runtime dependencies are incomplete.');
  }

  const active = new Map();

  function emit(agentId, event) {
    try { onEvent({ agentId, ...event }); } catch {}
  }

  async function save(agentId, session, patch = {}) {
    session.updatedAt = new Date(clock()).toISOString();
    await saveSession(agentId, session);
    emit(agentId, { type: 'session', session: { ...session, ...patch } });
  }

  async function requestCompletion(config, messages, signal, onDelta, tools, toolProtocol) {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
    if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
    const body = {
      model: config.model,
      messages,
      stream: true,
      temperature: config.temperature,
      top_p: config.topP,
      frequency_penalty: config.frequencyPenalty,
      presence_penalty: config.presencePenalty,
      max_tokens: config.maxTokens
    };
    if (toolProtocol !== 'slash' && Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const response = await fetchImpl(endpointFor(config.endpoint, 'chat/completions'), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(body)
    });
    if (!response || typeof response.ok !== 'boolean') throw new Error('The API returned an invalid HTTP response.');
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch {}
      const error = new Error('API request failed with HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 700) : '.'));
      error.status = response.status;
      error.nativeToolsUnsupported = body.tools !== undefined && nativeToolUnsupported(detail);
      throw error;
    }
    return readCompletion(response, onDelta);
  }

  async function sendMessage(agentId, input) {
    if (typeof agentId !== 'string' || !/^direct-agent-[0-9]{3,}$/.test(agentId)) throw new Error('A valid direct-agent ID is required.');
    if (typeof input !== 'string' || !input.trim() || input.length > 20000) {
      throw new Error('Message must contain 1–20,000 characters.');
    }
    if (active.has(agentId)) throw new Error('This agent is already working. Wait for it to finish or stop the current run.');
    const controller = new AbortController();
    active.set(agentId, controller);
    const timeout = setTimeout(() => controller.abort(new Error('The API request exceeded the 10-minute timeout.')), REQUEST_TIMEOUT_MS);
    let session;
    let config;
    try {
      session = await getSession(agentId);
      if (!session || typeof session.sessionId !== 'string' || !Array.isArray(session.messages)) {
        throw new Error('The direct-agent session is unavailable. Recreate this widget to start a new session.');
      }
      config = await getConfig(agentId);
      if (!config || !config.model || !config.endpoint) throw new Error('The direct API connection is incomplete.');
      const target = [config.provider || 'openai-compatible', config.endpoint, config.model].join('|');
      if (session.toolProtocolTarget !== target) {
        session.toolProtocolTarget = target;
        session.toolProtocol = 'auto';
      }
      if (!['auto', 'native', 'slash'].includes(session.toolProtocol)) session.toolProtocol = 'auto';
      session.status = 'running';
      session.error = '';
      session.messages = trimHistory(session.messages);
      session.messages.push({ role: 'user', content: input.trim(), createdAt: new Date(clock()).toISOString() });
      await save(agentId, session, { status: 'running', toolProtocol: session.toolProtocol });
      emit(agentId, { type: 'status', status: 'running' });

      const tools = await getToolDefinitions();
      if (!Array.isArray(tools) || !tools.length) throw new Error('No direct-agent tools are available.');
      if (tools.length > 30) throw new Error('The direct-agent tool catalog exposes ' + tools.length + ' tools; the hard limit is 30.');
      const names = tools.map(item => item && item.function && item.function.name).filter(name => typeof name === 'string');
      if (names.length !== tools.length || new Set(names).size !== names.length ||
          names.some(name => !DIRECT_AGENT_TOOL_NAMES.includes(name))) {
        throw new Error('The direct-agent catalog contains missing, duplicate, or unregistered tool definitions.');
      }
      const availableSlashTools = names;
      const baseSystem = [
        DIRECT_AGENT_INSTRUCTIONS,
        config.systemPrompt || '',
        formatSlashToolCatalog(tools)
      ].filter(Boolean).join('\n\n');

      const failedSignatures = new Set();
      const attemptedSideEffects = new Set();
      const successfulInvocations = [];
      let toolRounds = 0;
      let executedCalls = 0;
      let unverifiedClaimRetries = 0;
      const protocolSystem = mode => mode === 'slash'
        ? 'TOOL EXECUTION MODE: Native API tool calling was rejected by this provider/model. Use the exact slash-command fallback. A command is executable only when the entire assistant response is one valid slash command. Ordinary text, explanations, or claims that an operation ran never execute anything.'
        : 'TOOL EXECUTION MODE: Native Chat Completions tools are advertised for this provider/model. Call the registered tools for real operations. If you choose the slash fallback, the entire assistant response must be one valid slash command. Ordinary text claiming an operation ran is not execution.';

      function executionStatus(output) {
        if (output && output.status === 'success') return 'success';
        if (output && output.status === 'cancelled') return 'cancelled';
        return 'failed';
      }

      async function executeSlashInvocation(invocation, source) {
        const signature = stableToolFingerprint(invocation.name, invocation.args);
        const duplicateFailure = failedSignatures.has(signature);
        const duplicateSideEffect = isSideEffectingInvocation(invocation.name, invocation.args) && attemptedSideEffects.has(signature);
        if (source === 'model') {
          session.messages.push({ role: 'assistant', content: formatSlashCommand(invocation.name, invocation.args), createdAt: new Date(clock()).toISOString() });
          await save(agentId, session, { status: 'running' });
        }
        const requestId = randomUUID();
        let output;
        let status;
        emit(agentId, { type: 'tool_started', tool: invocation.name, args: invocation.args, source: source === 'model' ? 'model-slash' : 'user-slash' });
        if (duplicateFailure || duplicateSideEffect) {
          output = { status: 'failed', error: duplicateFailure
            ? 'Repeated identical operation blocked because its previous attempt failed. Change the arguments or address the reported failure before retrying.'
            : 'Repeated identical side effect blocked within this request. Verify the prior operation or make a meaningful change before retrying.' };
          status = 'failed';
        } else {
          if (isSideEffectingInvocation(invocation.name, invocation.args)) attemptedSideEffects.add(signature);
          executedCalls++;
          if (executedCalls > 100) throw new Error('The run exceeded the 100-operation safety limit.');
          try {
            output = await executeTool(invocation.name, invocation.args, requestId, session.sessionId, controller.signal);
            status = executionStatus(output);
          } catch (error) {
            output = { status: controller.signal.aborted ? 'cancelled' : 'failed', error: safeError(error, config.apiKey || '') };
            status = executionStatus(output);
          }
        }
        if (status !== 'success') failedSignatures.add(signature);
        else successfulInvocations.push({ tool: invocation.name, args: invocation.args });
        const toolContent = formatToolResultMarkdown(output);
        session.messages.push({
          role: 'user',
          kind: 'tool_result',
          content: '[Untrusted local tool result for /' + invocation.name + '; status=' + status + ']\n' + toolContent,
          createdAt: new Date(clock()).toISOString()
        });
        session.messages = trimHistory(session.messages);
        await save(agentId, session, { status: 'running' });
        emit(agentId, {
          type: 'tool_completed', tool: invocation.name, status, output: toolContent,
          source: source === 'model' ? 'model-slash' : 'user-slash',
          executed: !duplicateFailure && !duplicateSideEffect
        });
      }

      async function executeNativeCalls(completion) {
        const calls = completion.toolCalls.slice().sort((a, b) => a.index - b.index);
        if (!calls.length) return false;
        const seenIds = new Set();
        const persistedCalls = calls.map(call => {
          let id = typeof call.id === 'string' && call.id.trim() ? call.id : '';
          if (!id || seenIds.has(id)) id = 'local_rejected_' + randomUUID().replace(/-/g, '');
          seenIds.add(id);
          const fn = call.function || {};
          return {
            id,
            type: 'function',
            function: {
              name: String(fn.name || ''),
              arguments: typeof fn.arguments === 'string' ? fn.arguments : ''
            }
          };
        });
        session.messages.push({
          role: 'assistant',
          content: completion.content || null,
          tool_calls: persistedCalls,
          createdAt: new Date(clock()).toISOString()
        });
        await save(agentId, session, { status: 'running' });

        const results = await Promise.all(calls.map(async (call, index) => {
          const persisted = persistedCalls[index];
          const name = persisted.function.name;
          let args = null;
          let output;
          let status = 'failed';
          let executed = false;
          let signature = '';
          emit(agentId, { type: 'tool_started', tool: name || '(missing tool name)', args: null, source: 'model-native', toolCallId: persisted.id });
          try {
            if (!call.id || persisted.id.startsWith('local_rejected_')) {
              throw new Error('The provider returned a native tool call without a unique call ID. Nothing was executed.');
            }
            if (persisted.function.arguments.trim() === '') throw new Error('The provider returned empty tool arguments. Nothing was executed.');
            args = parseToolArguments(persisted.function.arguments);
            validateNativeToolArguments(name, args, tools);
            signature = stableToolFingerprint(name, args);
            if (failedSignatures.has(signature)) {
              throw new Error('Repeated identical operation blocked because its previous attempt failed. Change the arguments or address the reported failure before retrying.');
            }
            if (isSideEffectingInvocation(name, args)) {
              if (attemptedSideEffects.has(signature)) throw new Error('Repeated identical side effect blocked within this request. Verify the prior operation or make a meaningful change before retrying.');
              attemptedSideEffects.add(signature);
            }
            executedCalls++;
            if (executedCalls > 100) throw new Error('The run exceeded the 100-operation safety limit.');
            output = await executeTool(name, args, randomUUID(), session.sessionId, controller.signal);
            status = executionStatus(output);
            executed = true;
          } catch (error) {
            status = controller.signal.aborted ? 'cancelled' : 'failed';
            output = { status, error: safeError(error, config.apiKey || '') };
          }
          if (status !== 'success' && signature) failedSignatures.add(signature);
          else successfulInvocations.push({ tool: name, args });
          const markdown = '[Untrusted local tool result for /' + (name || 'unknown') + '; status=' + status + ']\n' + formatToolResultMarkdown(output);
          emit(agentId, {
            type: 'tool_completed', tool: name || '(missing tool name)', status,
            output: markdown, source: 'model-native', toolCallId: persisted.id, executed
          });
          return {
            role: 'tool',
            name: name || undefined,
            tool_call_id: persisted.id,
            content: markdown,
            kind: 'tool_result',
            createdAt: new Date(clock()).toISOString()
          };
        }));
        session.messages.push(...results);
        session.messages = trimHistory(session.messages);
        await save(agentId, session, { status: 'running', toolProtocol: 'native' });
        return true;
      }

      const explicitSlashInvocation = parseSlashToolCommand(input.trim(), availableSlashTools);
      if (explicitSlashInvocation) await executeSlashInvocation(explicitSlashInvocation, 'user');

      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('The run was cancelled.');
        if (toolRounds > MAX_TOOL_ROUNDS) throw new Error('The model exceeded the ' + MAX_TOOL_ROUNDS + '-round tool-execution limit.');
        const mode = session.toolProtocol;
        let completion;
        try {
          completion = await requestCompletion(
            config,
            [{ role: 'system', content: baseSystem + '\n\n' + protocolSystem(mode) }, ...toApiMessages(session.messages, { nativeToolCalling: mode === 'native' })],
            controller.signal,
            delta => { emit(agentId, { type: 'delta', delta }); },
            tools,
            mode
          );
        } catch (error) {
          if (error && error.nativeToolsUnsupported && session.toolProtocol !== 'slash') {
            session.toolProtocol = 'slash';
            session.messages.push({
              role: 'user',
              kind: 'runtime_feedback',
              content: '[Native tool calling unavailable] The provider rejected the advertised tool schema. No operation was executed. Use the exact slash-command fallback from the catalog; only a complete valid slash command triggers local execution.',
              createdAt: new Date(clock()).toISOString()
            });
            await save(agentId, session, { status: 'running', toolProtocol: 'slash' });
            emit(agentId, { type: 'tool_protocol', mode: 'slash', reason: 'provider-rejected-native-tools' });
            continue;
          }
          throw error;
        }

        if (completion.toolCalls.length) {
          if (++toolRounds > MAX_TOOL_ROUNDS) throw new Error('The model exceeded the ' + MAX_TOOL_ROUNDS + '-round tool-execution limit.');
          session.toolProtocol = 'native';
          await executeNativeCalls(completion);
          continue;
        }

        const responseText = completion.content.trim();
        if (reportsToolInability(responseText) && session.toolProtocol !== 'slash') {
          session.toolProtocol = 'slash';
          session.messages.push({
            role: 'user',
            kind: 'runtime_feedback',
            content: '[Native tool calling unavailable] Your response indicates that this provider/model cannot invoke native tools. The application has switched to the deterministic slash-command protocol. Return one valid command from the live catalog; ordinary prose does not execute an operation.',
            createdAt: new Date(clock()).toISOString()
          });
          await save(agentId, session, { status: 'running', toolProtocol: 'slash' });
          emit(agentId, { type: 'tool_protocol', mode: 'slash', reason: 'model-reported-native-tool-inability' });
          continue;
        }
        if (responseText.startsWith('/')) {
          if (++toolRounds > MAX_TOOL_ROUNDS) throw new Error('The model exceeded the ' + MAX_TOOL_ROUNDS + '-round tool-execution limit.');
          let invocation;
          try {
            invocation = parseSlashToolCommand(responseText, availableSlashTools);
          } catch (error) {
            session.messages.push({ role: 'assistant', content: completion.content, createdAt: new Date(clock()).toISOString() });
            session.messages.push({
              role: 'user',
              kind: 'runtime_feedback',
              content: '[Slash-command error] ' + safeError(error) + ' Return one corrected command using the available slash-command catalog.',
              createdAt: new Date(clock()).toISOString()
            });
            await save(agentId, session, { status: 'running' });
            continue;
          }
          await executeSlashInvocation(invocation, 'model');
          continue;
        }

        if (completion.nativeToolCalls || completion.finishReason === 'tool_calls') {
          if (++toolRounds > MAX_TOOL_ROUNDS) throw new Error('The model exceeded the MAX tool-round limit.');
          session.toolProtocol = 'slash';
          session.messages.push({
            role: 'user',
            kind: 'runtime_feedback',
            content: '[Invalid native tool response] The provider returned a tool-call finish without a valid callable name, call ID, or complete arguments. Nothing was executed. Use one valid slash command instead.',
            createdAt: new Date(clock()).toISOString()
          });
          await save(agentId, session, { status: 'running', toolProtocol: 'slash' });
          continue;
        }

        if (!responseText) throw new Error('The model returned an empty response. Return a valid tool call/slash command, or provide a final answer.');
        const claimedKind = claimedActionKind(responseText);
        const claimVerified = claimedKind && successfulInvocations.some(item => toolSupportsClaim(item.tool, item.args, claimedKind));
        if (claimedKind && !claimVerified) {
          if (unverifiedClaimRetries++ > 0) {
            throw new Error('The model repeatedly claimed a local operation without a matching successful tool call. No success was recorded.');
          }
          if (session.toolProtocol !== 'slash') {
            session.toolProtocol = 'slash';
            emit(agentId, { type: 'tool_protocol', mode: 'slash', reason: 'unverified-execution-claim' });
          }
          session.messages.push({
            role: 'user',
            kind: 'runtime_feedback',
            content: '[Unverified execution claim] Your response claims that you ' + claimedKind + ' something, but this request contains no matching successful local tool call. Nothing should be reported as completed. Use a real native tool call when available or return one valid slash command; otherwise clearly state that you did not perform the operation.',
            createdAt: new Date(clock()).toISOString()
          });
          await save(agentId, session, { status: 'running', toolProtocol: session.toolProtocol });
          continue;
        }
        session.messages.push({ role: 'assistant', content: completion.content, createdAt: new Date(clock()).toISOString() });
        session.status = 'idle';
        session.error = '';
        session.messages = trimHistory(session.messages);
        await save(agentId, session, { status: 'idle', toolProtocol: session.toolProtocol });
        emit(agentId, { type: 'completed', status: 'idle' });
        return { accepted: true, completed: true };
      }
    } catch (error) {
      const message = safeError(error, config && config.apiKey || '');
      if (session) {
        session.status = controller.signal.aborted ? 'interrupted' : 'error';
        session.error = message;
        try { await save(agentId, session, { status: session.status, error: message }); } catch {}
      }
      emit(agentId, { type: 'error', status: controller.signal.aborted ? 'interrupted' : 'error', error: message });
      return { accepted: true, completed: false, error: message };
    } finally {
      clearTimeout(timeout);
      if (active.get(agentId) === controller) active.delete(agentId);
      emit(agentId, { type: 'status', status: session && session.status || 'idle' });
    }
  }

  function cancel(agentId) {
    const controller = active.get(agentId);
    if (!controller) return { cancelled: false };
    controller.abort(new Error('Stopped by the user.'));
    return { cancelled: true };
  }

  function isRunning(agentId) { return active.has(agentId); }
  function stop() {
    for (const controller of active.values()) controller.abort(new Error('Application is shutting down.'));
    active.clear();
  }

  return { sendMessage, cancel, isRunning, stop };
}
module.exports = {
  createDirectAgentRuntime,
  normalizeProvider,
  normalizeEndpoint,
  normalizeDirectAgentConfig,
  endpointFor,
  parseToolArguments,
  validateNativeToolArguments,
  parseSlashToolCommand,
  formatSlashToolCatalog,
  formatToolResultMarkdown,
  toApiMessages,
  readCompletion,
  DIRECT_AGENT_TOOL_NAMES
};
