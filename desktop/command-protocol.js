'use strict';

const TOOL_NAMES = new Set([
  'get_capabilities','project_status','list_dir','glob_file_search','read_file','search',
  'git_status','git_diff','init','write_file','apply_patch','shell','run_tests','update_plan'
]);

const HELP = [
  'Local workspace commands:',
  '/status — inspect the selected project and Git state',
  '/init — create AGENTS.md without overwriting one',
  '/ls [path] — list workspace files',
  '/find <glob> — find files, e.g. /find src/**/*.js',
  '/read <path> — read a UTF-8 text file',
  '/search <text> — search project contents',
  '/git — show Git status',
  '/diff [path ...] — show tracked changes',
  '/test — run the detected test command (approval required)',
  '/exec <PowerShell command> — run a local command (approval required)',
  '/workspace — select the project folder',
  '/codex — tell ChatGPT to use this app as its local coding-tool backend',
  '/help — show this list',
  '',
  'ChatGPT tool call format: a fenced assistant_tool block containing {"tool":"read_file","args":{"path":"src/index.js"}}.',
  'File edits, patches, tests and shell commands require your approval.'
].join('\n');

function splitArgs(text) {
  const result = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    result.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') :
      match[2] !== undefined ? match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') : match[3]);
  }
  return result;
}

function parseSlashCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const rest = (match[2] || '').trim();
  const words = splitArgs(rest);
  switch (name) {
    case 'help': return { special: 'help', text: HELP };
    case 'workspace': return { special: 'workspace' };
    case 'codex': return { special: 'coding_mode' };
    case 'status': return { tool: 'project_status', args: {} };
    case 'init': return { tool: 'init', args: {} };
    case 'ls':
    case 'list': return { tool: 'list_dir', args: { path: rest || '.' } };
    case 'find':
    case 'glob': return rest ? { tool: 'glob_file_search', args: { pattern: rest } } : { error: 'Usage: /find <glob>, for example /find src/**/*.js' };
    case 'read': return rest ? { tool: 'read_file', args: { path: rest } } : { error: 'Usage: /read <relative-path>' };
    case 'search': return rest ? { tool: 'search', args: { query: rest } } : { error: 'Usage: /search <text>' };
    case 'git': return { tool: 'git_status', args: {} };
    case 'diff': return { tool: 'git_diff', args: words.length ? { paths: words } : {} };
    case 'test': return { tool: 'run_tests', args: {} };
    case 'exec': return rest ? { tool: 'shell', args: { command: rest } } : { error: 'Usage: /exec <PowerShell command>' };
    case 'write':
      if (!rest) return { error: 'Usage: /write <relative-path> then a newline, then file contents. For larger edits, use an assistant_tool apply_patch call.' };
      return { error: 'For file creation use a ChatGPT assistant_tool call with tool=write_file and args.path/content; direct /write is intentionally disabled to prevent accidental overwrites.' };
    default: return null;
  }
}

function parseToolCall(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) throw new Error('Tool request is missing or exceeds the 2 MiB limit.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('assistant_tool block must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('assistant_tool request must be a JSON object.');
  const extras = Object.keys(value).filter(k => !['tool','args','call_id','version'].includes(k));
  if (extras.length) throw new Error('Unsupported top-level tool field: ' + extras.join(', '));
  if (value.version !== undefined && value.version !== 1) throw new Error('Unsupported assistant_tool protocol version.');
  if (typeof value.tool !== 'string' || !TOOL_NAMES.has(value.tool)) throw new Error('Unknown local tool request.');
  if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) throw new Error('args must be a JSON object.');
  if (value.call_id !== undefined && (typeof value.call_id !== 'string' || value.call_id.length > 100)) throw new Error('call_id must be a short string.');
  return { tool: value.tool, args: value.args || {}, callId: value.call_id || null };
}

function isKnownSlashCommand(text) {
  const parsed = parseSlashCommand(text);
  return Boolean(parsed);
}

module.exports = { HELP, TOOL_NAMES, splitArgs, parseSlashCommand, parseToolCall, isKnownSlashCommand };
