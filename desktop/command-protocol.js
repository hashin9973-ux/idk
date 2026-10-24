'use strict';

const TOOL_NAMES = new Set([
  'get_capabilities','project_status','environment_info','list_dir','directory_tree','glob_file_search','read_file','file_info','search',
  'git_status','git_diff','git_log','git_show','git_branches','git_changed_files','discover_instructions',
  'init','write_file','apply_patch','create_directory','move_path','delete_path',
  'git_create_branch','git_switch_branch','git_commit','git_fetch','git_pull','git_push','git_clone','shell','run_tests','update_plan'
]);

const HELP = [
  'Local workspace commands:',
  '/status or /pwd — inspect the selected project and Git state',
  '/env — show non-secret machine and runtime information',
  '/init — create AGENTS.md without overwriting one',
  '/ls [path] or /tree [path] — list files; /find <glob> — find files',
  '/read <path> — read a UTF-8 text file; /info <path> — file metadata',
  '/search <text> — search project contents; /instructions [paths] — find AGENTS.md guidance',
  '/git — show Git status; /diff [path ...] — show changes; /log [path] — recent history',
  '/branches — list branches; /changed — list changed files including untracked files',
  '/mkdir <path> — create a directory; /mv <source> <destination> — move a file or directory',
  '/rm <path> — delete a file or an empty directory; /branch <name> — create a branch',
  '/switch <name> — switch branch; /commit <message> — commit staged changes or selected paths',
  '/fetch [remote] — fetch from a GitHub remote using the app-side credential (approval required)',
  '/pull [remote] [branch] — fast-forward the current branch from GitHub (approval required)',
  '/push [remote] [branch] — push the current commit to GitHub (approval required)',
  '/clone <owner/repository> <path> [branch] — clone into the selected workspace (approval required)',
  '/test [command] — run the detected tests or an explicit test command (approval required)',
  '/exec <PowerShell command> — run a local command (approval required)',
  '/github — show the app-side GitHub sign-in status (not a ChatGPT tool)',
  '/workspace — select the project folder',
  '/tools — re-send local-tool instructions if automatic conversation setup needs recovery',
  '/plan [task] — ask ChatGPT to plan using local tools; /review — inspect current changes',
  '/help — show this list',
  '',
  'When local workspace access is needed, emit exactly one fenced assistant_tool block containing a JSON object with version: 1, tool, args, and optional call_id.',
  'The desktop app validates the request, runs the tool on the selected local workspace, asks for native approval when required, and inserts the actual result into this same ChatGPT conversation.',
  'Wait for that result before requesting another local tool. Do not use GitHub commits as a tool transport, and do not request the app GitHub credential.'
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
  const need = (usage) => ({ error: 'Usage: ' + usage });
  switch (name) {
    case 'help': return { special: 'help', text: HELP };
    case 'workspace': return { special: 'workspace' };
    case 'tools': return { special: 'coding_mode' };
    case 'plan': return { special: 'plan_mode', task: rest };
    case 'review': return { special: 'review_mode' };
    case 'status': case 'pwd': return { tool: 'project_status', args: {} };
    case 'env': return { tool: 'environment_info', args: {} };
    case 'init': return { tool: 'init', args: {} };
    case 'ls': case 'list': return { tool: 'list_dir', args: { path: words.length ? words.join(' ') : '.' } };
    case 'tree': return { tool: 'directory_tree', args: { path: words[0] || '.', maxDepth: 4, maxEntries: 500 } };
    case 'find': case 'glob': return rest ? { tool: 'glob_file_search', args: { pattern: words.join(' ') } } : need('/find <glob>');
    case 'read': case 'cat': return rest ? { tool: 'read_file', args: { path: words.join(' ') } } : need('/read <relative-path>');
    case 'info': return rest ? { tool: 'file_info', args: { path: words.join(' ') } } : need('/info <path>');
    case 'search': case 'grep': return rest ? { tool: 'search', args: { query: words.join(' ') } } : need('/search <text>');
    case 'instructions': return { tool: 'discover_instructions', args: words.length ? { paths: words } : {} };
    case 'git': return { tool: 'git_status', args: {} };
    case 'diff': return { tool: 'git_diff', args: words.length ? { paths: words } : {} };
    case 'log': return { tool: 'git_log', args: words.length ? { path: words.join(' ') } : { maxCount: 20 } };
    case 'branches': return { tool: 'git_branches', args: {} };
    case 'changed': return { tool: 'git_changed_files', args: {} };
    case 'mkdir': return rest ? { tool: 'create_directory', args: { path: words.join(' '), recursive: true } } : need('/mkdir <path>');
    case 'mv': return words.length === 2 ? { tool: 'move_path', args: { source: words[0], destination: words[1] } } : need('/mv <source> <destination>');
    case 'rm': return rest ? { tool: 'delete_path', args: { path: words.join(' ') } } : need('/rm <path>');
    case 'branch': return words.length === 1 ? { tool: 'git_create_branch', args: { name: words[0] } } : need('/branch <name>');
    case 'switch': return words.length === 1 ? { tool: 'git_switch_branch', args: { name: words[0] } } : need('/switch <name>');
    case 'commit': return rest ? { tool: 'git_commit', args: { message: rest } } : need('/commit <message>');
    case 'fetch': return words.length <= 1 ? { tool: 'git_fetch', args: { remote: words[0] || 'origin' } } : need('/fetch [remote]');
    case 'pull': return words.length <= 2 ? { tool: 'git_pull', args: { ...(words[0] ? { remote: words[0] } : {}), ...(words[1] ? { branch: words[1] } : {}) } } : need('/pull [remote] [branch]');
    case 'push': return words.length <= 2 ? { tool: 'git_push', args: { ...(words[0] ? { remote: words[0] } : {}), ...(words[1] ? { branch: words[1] } : {}) } } : need('/push [remote] [branch]');
    case 'clone': return words.length >= 2 && words.length <= 3
      ? { tool: 'git_clone', args: { repository: words[0], path: words[1], ...(words[2] ? { branch: words[2] } : {}) } }
      : need('/clone <owner/repository> <path> [branch]');
    case 'test': case 'tests': return { tool: 'run_tests', args: rest ? { command: rest } : {} };
    case 'exec': return rest ? { tool: 'shell', args: { command: rest } } : need('/exec <PowerShell command>');
    case 'github': return { special: 'github_status' };
    default: return null;
  }
}

function parseToolCall(raw) {
  if (typeof raw !== 'string' || raw.length > 24000) throw new Error('assistant_tool payload must be text under 24,000 characters.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('assistant_tool payload is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('assistant_tool payload must be a JSON object.');
  const allowed = new Set(['version', 'tool', 'args', 'call_id']);
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (extra.length) throw new Error('Unsupported top-level field(s): ' + extra.join(', '));
  if (value.version !== 1) throw new Error('Unsupported assistant_tool protocol version.');
  if (typeof value.tool !== 'string' || !TOOL_NAMES.has(value.tool)) {
    throw new Error('Unknown local tool: ' + String(value.tool || '(missing)'));
  }
  if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) {
    throw new Error('args must be a JSON object.');
  }
  let callId = null;
  if (value.call_id !== undefined) {
    if (typeof value.call_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.call_id)) {
      throw new Error('call_id must be a short ID containing only letters, numbers, dot, underscore or hyphen.');
    }
    callId = value.call_id;
  }
  return { tool: value.tool, args: value.args || {}, callId };
}

function isKnownSlashCommand(text) {
  const parsed = parseSlashCommand(text);
  return Boolean(parsed);
}

module.exports = { HELP, TOOL_NAMES, splitArgs, parseSlashCommand, parseToolCall, isKnownSlashCommand };
