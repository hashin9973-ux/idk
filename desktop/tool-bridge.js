'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_ARGUMENT_KEYS = Object.freeze({
  get_capabilities: [],
  project_status: [],
  environment_info: [],
  list_dir: ['path'],
  directory_tree: ['path', 'maxDepth', 'maxEntries'],
  glob_file_search: ['pattern'],
  read_file: ['path', 'approved', 'startLine', 'endLine'],
  file_info: ['path'],
  search: ['query', 'include', 'regex', 'caseSensitive', 'maxResults'],
  git_status: [],
  git_diff: ['paths', 'staged', 'contextLines'],
  git_log: ['path', 'maxCount'],
  git_show: ['ref', 'paths'],
  git_branches: [],
  git_changed_files: [],
  discover_instructions: ['paths'],
  init: [],
  write_file: ['path', 'content'],
  apply_patch: ['patch'],
  create_directory: ['path', 'recursive'],
  move_path: ['source', 'destination'],
  delete_path: ['path', 'recursive'],
  git_create_branch: ['name'],
  git_switch_branch: ['name'],
  git_commit: ['message', 'paths'],
  git_fetch: ['remote', 'branch', 'timeoutMs'],
  git_pull: ['remote', 'branch', 'timeoutMs'],
  git_push: ['remote', 'branch', 'timeoutMs'],
  git_clone: ['repository', 'path', 'branch', 'timeoutMs'],
  upload_workspace_file: ['path', 'artifactName'],
  shell: ['command', 'timeoutMs'],
  run_tests: ['command', 'timeoutMs'],
  update_plan: ['items'],
  github_status: [],
  github_api: ['method', 'path', 'body', 'query']
});

// Preserve complete local tool output for the repository bridge to externalize into artifact files.
const MAX_RESULT_CHARS = 4 * 1024 * 1024;
const GITHUB_GIT_TOOLS = new Set(['git_fetch', 'git_pull', 'git_push', 'git_clone']);
const BLOCKED_TOOLS_FOR_MAILBOX = new Set(['github_status', 'github_api']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function createToolBridge(deps) {
  const { dialog, getMainWindow, getWorkspaceRoot, localTools, githubAuth, uploadWorkspaceFile } = deps;

  function validateArgs(tool, args) {
    if (BLOCKED_TOOLS_FOR_MAILBOX.has(tool)) {
      throw new Error('The repository mailbox cannot invoke the app GitHub API directly.');
    }
    const allowed = TOOL_ARGUMENT_KEYS[tool];
    if (!allowed) throw new Error('Unknown local tool: ' + tool);
    if (!isPlainObject(args)) throw new Error('Tool args must be a JSON object.');
    const extra = Object.keys(args).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error('Unsupported argument field(s) for ' + tool + ': ' + extra.join(', '));
  }

  function displayApprovalValue(value, maxChars = 4000) {
    return String(value == null ? '' : value)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        character => '[BIDI U+' + character.charCodeAt(0).toString(16).toUpperCase() + ']')
      .slice(0, maxChars);
  }

  function approvalDetail(tool, args, root) {
    const header = 'Workspace: ' + displayApprovalValue(root, 1500) + '\nTool: ' + tool + '\n\n';
    const resultWarning = 'The result will be committed to the configured shared GitHub mailbox branch. Anyone with repository read access may see it; for a public repository, it is publicly readable.\n\n';
    if (tool === 'upload_workspace_file') {
      const rawTarget = String(args.path || '(missing path)');
      const target = displayApprovalValue(rawTarget, 1200);
      const sensitive = localTools.looksSensitiveFile && localTools.looksSensitiveFile(rawTarget);
      return header + resultWarning + 'Upload a local workspace file to the shared repository as a retrievable artifact.\nPath: ' + target +
        '\nArtifact name: ' + displayApprovalValue(args.artifactName || path.basename(rawTarget), 240) +
        '\nThe full file bytes will be committed to GitHub and can be read by repository collaborators. ' +
        (sensitive ? '\nWARNING: This filename looks like a credential or private file; uploading it may disclose secrets.' : '') +
        '\nMaximum upload size: 8 MiB.';
    }
    if (GITHUB_GIT_TOOLS.has(tool)) {
      const repository = tool === 'git_clone' ? String(args.repository || '(missing repository)') : String(args.remote || 'origin');
      return header + resultWarning + 'Authenticated Git operation: ' + tool.replace('git_', '') +
        '\nRepository/remote: ' + displayApprovalValue(repository, 500) +
        (args.path ? '\nDestination inside workspace: ' + displayApprovalValue(args.path, 1200) : '') +
        (args.branch ? '\nBranch: ' + displayApprovalValue(args.branch, 200) : '') +
        '\nThe app-side GitHub credential stays inside the Windows app.';
    }
    if (tool === 'shell') {
      return header + resultWarning + 'This PowerShell command runs with your Windows user permissions and is not sandboxed:\n\n' +
        displayApprovalValue(args.command || '', 4000);
    }
    if (tool === 'apply_patch') {
      const plans = localTools.parsePatch(args.patch, root);
      return header + resultWarning + 'Review the files this patch will modify:\n' +
        plans.map(item => item.kind.toUpperCase() + '  ' + displayApprovalValue(item.relative, 500)).join('\n') +
        '\n\nPatch preview (line breaks are shown as \\n; first 2500 characters):\n' +
        displayApprovalValue(String(args.patch || '').slice(0, 2500), 9000);
    }
    if (tool === 'write_file') {
      return header + resultWarning + 'Create or overwrite: ' + displayApprovalValue(args.path, 1200) + '\nBytes: ' +
        Buffer.byteLength(String(args.content || ''), 'utf8') +
        '\n\nContent preview (line breaks are shown as \\n):\n' + displayApprovalValue(String(args.content || '').slice(0, 1800), 5000);
    }
    if (tool === 'read_file') {
      return header + resultWarning + 'The requested path appears to contain a credential or private key:\n' + displayApprovalValue(args.path || '', 1200);
    }
    if (tool === 'init') return header + resultWarning + 'Create AGENTS.md at the workspace root. An existing AGENTS.md will not be overwritten.';
    if (tool === 'run_tests') return header + resultWarning + 'Run the detected test command. Tests execute project code and may have side effects.';
    return header + resultWarning + 'Arguments (control characters escaped):\n' + displayApprovalValue(JSON.stringify(args, null, 2), 3500);
  }

  async function askApproval(tool, args, root) {
    const options = {
      type: 'warning',
      title: 'Approve local coding tool',
      message: 'Allow a request from the shared GitHub mailbox to run "' + tool + '"?',
      detail: approvalDetail(tool, args, root) + '\n\nThis approval applies to this operation only. A queued request is not permission to execute it.',
      buttons: ['Approve once', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const win = getMainWindow && getMainWindow();
    const answer = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return answer.response === 0;
  }

  function boundedResult(value) {
    let serialized = JSON.stringify(value);
    if (serialized.length <= MAX_RESULT_CHARS) return value;
    if (value && typeof value === 'object') {
      const trimmed = { ...value, truncatedForMailbox: true };
      for (const key of ['content', 'stdout', 'stderr', 'text', 'patch', 'diff']) {
        if (typeof trimmed[key] === 'string' && trimmed[key].length > 10000) {
          trimmed[key] = trimmed[key].slice(0, 10000) + '\n[truncated before returning to the shared repository; narrow the read/search or command output]';
        }
      }
      serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_RESULT_CHARS) return trimmed;
    }
    return {
      truncatedForMailbox: true,
      message: 'Tool output exceeded the repository return limit. Repeat with a narrower query or file section.',
      preview: serialized.slice(0, MAX_RESULT_CHARS - 300)
    };
  }

  async function executeLocalTool(root, tool, args, requestId) {
    if (tool === 'upload_workspace_file') {
      if (typeof uploadWorkspaceFile !== 'function') throw new Error('Repository artifact upload is unavailable.');
      const target = localTools.safePath(root, args.path, false);
      if (!fs.existsSync(target)) throw new Error('File not found: ' + args.path);
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('Only regular files can be uploaded.');
      const maxBytes = 8 * 1024 * 1024;
      if (stat.size > maxBytes) throw new Error('File exceeds the 8 MiB upload limit.');
      const bytes = fs.readFileSync(target);
      if (bytes.length > maxBytes) throw new Error('File exceeded the 8 MiB upload limit while being read.');
      return uploadWorkspaceFile(requestId, {
        path: path.relative(root, target).replace(/\\/g, '/'),
        artifactName: args.artifactName || path.basename(target),
        bytes
      });
    }
    if (tool === 'get_capabilities') {
      const output = await localTools.executeTool(root, tool, args);
      if (output && Array.isArray(output.tools)) {
        output.tools.push(
          { name: 'upload_workspace_file', mode: 'approval-required', args: ['path', 'artifactName'] },
          { name: 'refresh_environment_context', mode: 'repository-bridge-control', args: [] }
        );
      }
      return output;
    }
    if (!GITHUB_GIT_TOOLS.has(tool)) return localTools.executeTool(root, tool, args);
    if (!githubAuth || typeof githubAuth.runGitOperation !== 'function') {
      throw new Error('Authenticated local Git operations are unavailable in this app build.');
    }
    if (typeof githubAuth.hasSavedToken === 'function' && !githubAuth.hasSavedToken()) {
      throw new Error('Sign in with GitHub in Accounts before using authenticated local Git operations.');
    }
    const operation = tool.slice('git_'.length);
    const call = {
      operation,
      cwd: root,
      ...(args.remote ? { remote: args.remote } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {})
    };
    if (tool === 'git_clone') {
      call.repository = args.repository;
      call.destination = localTools.safePath(root, args.path, false);
    }
    return githubAuth.runGitOperation(call);
  }

  async function runTool(tool, inputArgs, callId = null) {
    const root = getWorkspaceRoot();
    const args = { ...(inputArgs || {}) };
    const id = callId || randomUUID();
    let result;
    try {
      validateArgs(tool, args);
      const policy = tool === 'upload_workspace_file'
        ? { tool, requiresApproval: true, automatic: false }
        : localTools.getToolPolicy(tool, args);
      if (policy.requiresApproval) {
        const approved = await askApproval(tool, args, root);
        if (!approved) {
          result = { ok: false, cancelled: true, message: 'User cancelled the operation. Nothing was executed.' };
        } else {
          if (tool === 'read_file') args.approved = true;
          const output = await executeLocalTool(root, tool, args, id);
          if (output && Number.isInteger(output.exitCode) && output.exitCode !== 0) {
            result = { ok: false, error: tool + ' exited with code ' + output.exitCode + '.', result: output };
          } else {
            result = { ok: true, result: output };
          }
        }
      } else {
        const output = await executeLocalTool(root, tool, args, id);
        if (output && Number.isInteger(output.exitCode) && output.exitCode !== 0) {
          result = { ok: false, error: tool + ' exited with code ' + output.exitCode + '.', result: output };
        } else {
          result = { ok: true, result: output };
        }
      }
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    return boundedResult({
      protocol: 'chatgpt-local-tool-result-v2',
      call_id: id,
      tool,
      workspace: root,
      ...result
    });
  }

  return { runTool };
}

module.exports = {
  createToolBridge,
  TOOL_ARGUMENT_KEYS,
  BLOCKED_TOOLS_FOR_MAILBOX,
  GITHUB_GIT_TOOLS
};
