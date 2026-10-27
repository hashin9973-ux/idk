'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isFilesystemRoot } = require('./workspace-path');

const TOOL_ARGUMENT_KEYS = Object.freeze({
  get_capabilities: [],
  get_agent_context: [],
  project_status: [],
  environment_info: [],
  list_dir: ['path'],
  directory_tree: ['path', 'maxDepth', 'maxEntries', 'format'],
  glob_file_search: ['pattern', 'path'],
  read_file: ['path', 'approved', 'startLine', 'endLine', 'startCharacter'],
  file_info: ['path'],
  search: ['query', 'path', 'include', 'regex', 'caseSensitive', 'maxResults'],
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
  computer: ['action', 'source', 'path', 'prompt', 'waitMs', 'request_id', 'x', 'y', 'fromX', 'fromY', 'button', 'clicks', 'deltaX', 'deltaY', 'durationMs', 'key', 'keys', 'text', 'steps', 'observe', 'frameWidth', 'frameHeight'],
  shell: ['command', 'timeoutMs'],
  run_tests: ['command', 'timeoutMs'],
  update_plan: ['items'],
  batch: ['steps', 'stopOnError', 'maxConcurrency'],
  github_status: [],
  github_api: ['method', 'path', 'body', 'query']
});

// Preserve complete local tool output for inline results or batch-output artifact bundles.
const MAX_RESULT_CHARS = 4 * 1024 * 1024;
const MAX_BATCH_STEPS = 100;
const MAX_BATCH_CONCURRENCY = 100;
const DEFAULT_BATCH_CONCURRENCY = 32;
const GITHUB_GIT_TOOLS = new Set(['git_fetch', 'git_pull', 'git_push', 'git_clone']);
const BLOCKED_TOOLS_FOR_MAILBOX = new Set(['github_status', 'github_api']);

const TOOL_DESCRIPTIONS = Object.freeze({
  get_capabilities: 'List every callable local tool with exact arguments, constraints, permission mode, and result summary. This catalog is stable for the running app build.',
  get_agent_context: 'Return one compact snapshot of the selected Windows workspace, runtime, Git state, project commands, instruction-file locations, directory overview, and callable tool catalog. Full source and instruction contents stay on demand.',
  project_status: 'Summarize detected project technologies, whether the selected workspace is a Git repository, current branch/status, and top-level entries.',
  environment_info: 'Describe the local OS/runtime and available shell. Identity-sensitive fields are redacted before context is published to GitHub.',
  list_dir: 'List up to 500 immediate children of a workspace-relative directory, sorted by name.',
  directory_tree: 'Return a bounded workspace-relative tree. Use format=paths for a compact listing that minimizes transfer size; common generated/dependency directories and symlinks are skipped.',
  glob_file_search: 'Find files using a glob such as **/*.js. Optional path restricts the search to a subdirectory; skips common generated/dependency directories.',
  read_file: 'Read UTF-8 text in lossless pages of up to 12 KiB from files up to 32 MiB. totalLines is computed from the entire file; each result reports the returned range, reachedEof, hasMoreInFile, nextStartLine and nextStartCharacter. Continue from the returned pointer until hasMoreInFile=false; fileComplete=true only when the whole file fits in one response starting at line 1. Never count a partial page as the total. Secret-like paths require local approval.',
  file_info: 'Return type, byte size, timestamps, permissions, and a SHA-256 digest for regular files.',
  search: 'Search text files for a literal string by default or a regular expression when regex=true. Optional path restricts the search to a subdirectory. Secret-like files and binary/oversized files are skipped.',
  git_status: 'Return current branch and working-tree status without changing the repository.',
  git_diff: 'Return the current diff; optionally restrict to relative paths, staged changes, or 0–20 context lines.',
  git_log: 'Read recent Git commits, optionally limited to a workspace-relative file path.',
  git_show: 'Show a Git revision (default HEAD), optionally restricted to workspace-relative paths.',
  git_branches: 'List local branches and identify the current branch.',
  git_changed_files: 'List tracked and untracked changes from Git status.',
  discover_instructions: 'Find applicable AGENTS.md files at the workspace root and in ancestor directories for supplied relative paths. Returns instruction contents; read only relevant instruction files.',
  init: 'Create a starter AGENTS.md at the workspace root if none exists. Requires local approval.',
  write_file: 'Create or replace a UTF-8 text file inside the selected workspace. Parent directory must exist; secret-like paths require local approval.',
  apply_patch: 'Apply a focused patch using Begin Patch/Add File/Update File/Delete File sections. Requires matching current context; secret-like paths require local approval.',
  create_directory: 'Create a workspace-relative directory; recursive creation is on by default.',
  move_path: 'Move or rename a workspace-relative file or directory.',
  delete_path: 'Delete a workspace-relative file or directory; deletion is limited to the selected workspace.',
  git_create_branch: 'Create a local branch. Requires local approval.',
  git_switch_branch: 'Switch to an existing local branch. Requires local approval and may be blocked by a dirty working tree.',
  git_commit: 'Commit already-staged changes, or stage only the supplied paths and then commit. Requires local approval.',
  git_fetch: 'Fetch a remote using the app GitHub credential; defaults to origin. Requires local approval.',
  git_pull: 'Pull from a remote using the app GitHub credential; defaults to origin. Requires local approval.',
  git_push: 'Push to a remote using the app GitHub credential; defaults to origin. Requires local approval.',
  git_clone: 'Clone a repository into a relative destination inside the selected workspace. Requires local approval.',
  shell: 'Run PowerShell as the signed-in Windows user from the selected workspace. Waits for the foreground process to exit or the configured timeout, then returns exitCode, timedOut, stdout, stderr, and durationMs. At timeout it attempts to kill the whole process tree and still returns a timeout result. For long-running servers, start them deliberately in the background with logs redirected to files, poll a bounded readiness check, and do not confuse server startup with command completion. Requires local approval unless Auto-accept everything is enabled; PowerShell is not OS-sandboxed.',
  run_tests: 'Run the detected project-native test command, or the supplied PowerShell command, and wait for its exit or timeout. Returns the actual exit code, timeout flag, stdout, stderr, and duration. A timeout or non-zero exit is a failure; inspect output before making dependent changes.',
  update_plan: 'Maintain a short local task plan with up to 30 string or structured steps.',
  upload_workspace_file: 'Share an explicitly approved workspace file as a repository artifact. Always requires local approval and is limited to 8 MiB.',
  computer: 'Use one computer tool for visual context and local mouse/keyboard control. Connect automatically activates vision and begins model loading; status reports readiness. After screenshot, coordinates use its returned JPEG pixel frame, origin at top-left. click/move/drag/scroll and key/mouse actions send Windows inputs. sequence batches up to 50 inputs and can capture/analyze a fresh screenshot afterward. start_control enables a control session without per-action approval; stop_control releases held inputs. Held inputs auto-release after 10 seconds and control expires after 15 minutes idle.',
  refresh_environment_context: 'Refresh the shared background context snapshot. This is a mailbox control request, not a nested local batch step.',
  batch: 'Execute 1–100 local tool calls in one mailbox request. Independent operations run concurrently up to maxConcurrency (1–100; default 32). Use maxConcurrency=100 for large, lightweight, independent file operations. File/path conflicts and shell, tests, Git mutations, and other unknown-side-effect operations preserve request order. Explicit {"$ref":"stepId.result.content"} references wait for that earlier step. Each step gets its own status/output. Large aggregate outputs are bundled as mailbox artifacts; fetch all listed parts concurrently and review them together. Stop launching later steps after a failure by default.'
});
const REQUIRED_ARGUMENTS = Object.freeze({
  read_file: ['path'], file_info: ['path'], search: ['query'], write_file: ['path', 'content'],
  apply_patch: ['patch'], create_directory: ['path'], move_path: ['source', 'destination'],
  delete_path: ['path'], git_create_branch: ['name'], git_switch_branch: ['name'],
  git_commit: ['message'], git_clone: ['repository', 'path'], shell: ['command'],
  upload_workspace_file: ['path'], batch: ['steps'],
  computer: ['action']
});
const BASE_FIELD_SCHEMAS = Object.freeze({
  path: { type: 'string', description: 'Path relative to the selected workspace or an absolute Windows path inside it. Paths outside the selected workspace and symlink escapes are rejected.' },
  pattern: { type: 'string', description: 'Glob pattern relative to the workspace, for example **/*.js.', maxLength: 300, default: '**/*' },
  query: { type: 'string', description: 'Non-empty text to search for; interpreted literally unless regex=true.', minLength: 1, maxLength: 500 },
  action: { type: 'string', description: 'Computer action: status, connect, enable, disable, screenshot, wait, start_control, stop_control, click, move, drag, scroll, press, type, hotkey, mouse_down, mouse_up, key_down, key_up, or sequence.', enum: ['status', 'connect', 'enable', 'disable', 'screenshot', 'wait', 'start_control', 'stop_control', 'click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey', 'mouse_down', 'mouse_up', 'key_down', 'key_up', 'sequence'] },
  ref: { type: 'string', description: 'Simple Git revision such as HEAD, a branch name, or a commit hash. Complex revision expressions and option-like values are rejected.', maxLength: 120, default: 'HEAD' },
  message: { type: 'string', description: 'Commit message.', minLength: 1, maxLength: 500 },
  content: { type: 'string', description: 'Complete UTF-8 file contents. Maximum 1 MiB; replaces the target file when it exists.', maxLength: 1048576 },
  patch: { type: 'string', description: 'Focused patch beginning with *** Begin Patch and ending with *** End Patch. Maximum 2 MiB.', maxLength: 2097152 },
  name: { type: 'string', description: 'Local Git branch name; must pass git check-ref-format.', minLength: 1, maxLength: 100 },
  source: { type: 'string', description: 'Existing workspace-relative path to move.' },
  destination: { type: 'string', description: 'Workspace-relative destination path that must not already exist.' },
  remote: { type: 'string', description: 'Configured Git remote name. Defaults to origin.', default: 'origin' },
  branch: { type: 'string', description: 'Optional branch/ref for the remote operation; omitted to use the remote/default behavior.' },
  repository: { type: 'string', description: 'Repository URL or owner/name accepted by git clone.' },
  artifactName: { type: 'string', description: 'Optional output filename for the explicitly shared artifact. Path separators are replaced.', maxLength: 120 },
  source: { type: 'string', description: 'Screenshot source: desktop captures the current primary Windows display; workspace_file reads an image within the selected workspace.', enum: ['desktop', 'workspace_file'], default: 'desktop' },
  prompt: { type: 'string', description: 'Optional visual observation prompt. The vision model should describe visible evidence only.', maxLength: 2000 },
  waitMs: { type: 'integer', description: 'How long to wait for completion before returning a pending request ID (0–120,000 ms).', minimum: 0, maximum: 120000, default: 5000 },
  request_id: { type: 'string', description: 'Existing screenshot request ID returned by computer(action=screenshot) or computer(action=sequence, observe=true). Format: computer- followed by 24 lowercase hexadecimal characters.', pattern: '^computer-[a-f0-9]{24}
  command: { type: 'string', description: 'PowerShell command to execute from the workspace. Arbitrary commands run with the signed-in user permissions and require local approval.', minLength: 1, maxLength: 20000 },
  maxDepth: { type: 'integer', description: 'Maximum directory depth (1–12). Defaults to 4.', minimum: 1, maximum: 12, default: 4 },
  maxEntries: { type: 'integer', description: 'Maximum tree entries (1–2,000). Defaults to 500.', minimum: 1, maximum: 2000, default: 500 },
  format: { type: 'string', description: 'Use paths for a compact path-only listing, or entries for structured file records.', enum: ['entries', 'paths'], default: 'entries' },
  startLine: { type: 'integer', description: 'First 1-based line to return. For a complete read, continue at the prior result nextStartLine.', minimum: 1 },
  startCharacter: { type: 'integer', description: 'Unicode code-point offset within startLine; resume a long line at the prior result nextStartCharacter. Defaults to 0.', minimum: 0 }, 
  endLine: { type: 'integer', description: 'Last line to return, 1-based and inclusive. At most 5,000 lines can be read in one call.' , minimum: 1 },
  maxResults: { type: 'integer', description: 'Maximum matching lines to return (1–150). Defaults to 100.', minimum: 1, maximum: 150, default: 100 },
  contextLines: { type: 'integer', description: 'Number of diff context lines (0–20).', minimum: 0, maximum: 20, default: 3 },
  maxCount: { type: 'integer', description: 'Maximum Git log entries (1–100). Defaults to 20.', minimum: 1, maximum: 100, default: 20 },
  timeoutMs: { type: 'integer', description: 'Operation timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 },
  recursive: { type: 'boolean', description: 'Recursively create a directory and its parents. Defaults to true.', default: true },
  staged: { type: 'boolean', description: 'When true, show the staged diff instead of the unstaged diff.', default: false },
  regex: { type: 'boolean', description: 'Interpret query as a regular expression. Defaults to false.', default: false },
  caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to false.', default: false },
  stopOnError: { type: 'boolean', description: 'Stop launching queued batch steps after a failure; already-running independent steps may finish. Defaults to true.', default: true },
  maxConcurrency: { type: 'integer', description: 'Maximum independent steps to execute at once (1–100). Defaults to 32. Use 100 for large, lightweight, independent file operations; conflicting paths and shell, tests, and Git mutations are automatically ordered.', minimum: 1, maximum: 100, default: 32 },
  paths: { type: 'array', description: 'Optional list of workspace-relative paths. When set, limits the operation to those paths.', items: { type: 'string' }, maxItems: 100 },
  items: { type: 'array', description: 'Plan steps as strings or objects containing step and optional status.', maxItems: 30, items: { anyOf: [
    { type: 'string', maxLength: 1000 },
    { type: 'object', properties: { step: { type: 'string', maxLength: 1000 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['step'], additionalProperties: false }
  ] } },
  steps: { type: 'array', description: 'Ordered local tool calls (up to 100). Each step needs a unique id, a tool name, and args. References may only point to completed earlier steps.', minItems: 1, maxItems: 100 },
});
const TOOL_PARAMETER_OVERRIDES = Object.freeze({
  computer: {
    action: { enum: ['status', 'connect', 'enable', 'disable', 'screenshot', 'wait', 'start_control', 'stop_control', 'click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey', 'mouse_down', 'mouse_up', 'key_down', 'key_up', 'sequence'] },
    source: { enum: ['desktop', 'workspace_file'], default: 'desktop' },
    path: { description: 'Optional image path within the workspace; required when action=screenshot and source=workspace_file.' },
    waitMs: { default: 15000 },
    request_id: { description: 'Existing screenshot request ID returned by computer(action=screenshot) or computer(action=sequence, observe=true).', pattern: '^computer-[a-f0-9]{24}
  list_dir: { path: { description: 'Directory to list, relative to the selected workspace. Defaults to . (workspace root).', default: '.' } },
  directory_tree: {
    path: { description: 'Subdirectory to walk, relative to the selected workspace. Defaults to . (workspace root).', default: '.' },
    maxDepth: { default: 4 },
    maxEntries: { default: 500 }
  },
  glob_file_search: {
    pattern: { default: '**/*', description: 'Glob pattern relative to path, for example **/*.js or src/**/*.ts. Maximum 300 characters.' },
    path: { description: 'Optional starting directory relative to the workspace, or an absolute path inside it. Defaults to the workspace root.', default: '.' }
  },
  search: { path: { description: 'Optional directory to search, relative to the workspace or an absolute path inside it. Defaults to the workspace root.', default: '.' } },
  git_diff: { contextLines: { default: 3 } },
  create_directory: { recursive: { description: 'Create missing parent directories as needed. Defaults to true.', default: true } },
  delete_path: { recursive: { description: 'Set true to delete a non-empty directory tree. Defaults to false; without it, only files and empty directories can be deleted.', default: false } },
  git_log: { path: { description: 'Optional workspace-relative path to limit the history.' } },
  git_show: { ref: { default: 'HEAD' } },
  git_commit: { paths: { description: 'Optional paths to stage before committing. If omitted, only changes already staged are committed.', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
  discover_instructions: { paths: { description: 'Optional relative files/directories whose ancestor AGENTS.md files should be found. Maximum 50 paths.', items: { type: 'string' }, maxItems: 50 } },
  run_tests: { command: { description: 'Optional override PowerShell command. If omitted, detect and run the project-native test command. Requires local approval.', minLength: 1, maxLength: 20000 } },
  git_fetch: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_pull: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_push: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_clone: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  shell: { timeoutMs: { description: 'PowerShell timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  run_tests: { timeoutMs: { description: 'Test-command timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  batch: {
    steps: {
      description: '1–100 calls. Independent calls run concurrently (default limit 32; maximum 100); a {"$ref":"stepId.result.content"} value makes a step wait for that earlier step. File/path conflicts and shell/tests/Git mutations are ordered automatically. Each step follows the current local approval setting.',
      minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique step ID used by result references.', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$' },
          tool: { type: 'string', description: 'Callable local tool for this step.', enum: Object.keys(TOOL_ARGUMENT_KEYS).filter(name => name !== 'batch' && name !== 'refresh_environment_context' && !BLOCKED_TOOLS_FOR_MAILBOX.has(name)) },
          args: { type: 'object', description: 'Arguments matching the named tool schema. A value can be {"$ref":"earlierStep.result.someField"} to insert that prior result.', additionalProperties: true }
        },
        required: ['id', 'tool', 'args'],
        additionalProperties: false
      }
    }
  }
});
const TOOL_RESULT_SUMMARIES = Object.freeze({
  get_capabilities: 'Returns catalog_version, tool protocol, callable tools with schemas/permission notes/result summaries, and the batch/reference contract.',
  project_status: 'Returns isGitRepository, detectedTechnologies, topLevelEntries, and Git status when applicable.',
  environment_info: 'Returns platform, architecture, OS/runtime version, CPU and memory metadata. Identity-sensitive fields are redacted before repository publication.',
  list_dir: 'Returns the relative directory path, sorted entries (name/type/size), and a truncated flag.',
  directory_tree: 'Returns relative start path, applied maxDepth, entry count, truncation flag, and relative path/type/size entries.',
  glob_file_search: 'Returns the original glob pattern, match count, truncation flag, and relative file paths.',
  read_file: 'Returns exact full-file bytes, SHA-256 and totalLines, plus a lossless bounded page: returnedLineCount/returnedBytes, requested and returned line ranges, rangeComplete, hasMoreInRange, hasMoreInFile, reachedEof, fileComplete and nextStartLine/nextStartCharacter. Resume with the returned cursor until hasMoreInFile=false; only a single response starting at line 1 can have fileComplete=true. Each content page is at most 12 KiB.',
  search: 'Returns query, scanned-file count, match count, truncation flag, and matches with path/line/column/text.',
  write_file: 'Returns relative path, byte count, and before/after SHA-256 hashes.',
  apply_patch: 'Returns changed-file count, relative changed paths, and per-file actions.',
  git_status: 'Returns current branch/working-tree status, Git output, exit code, and stderr.',
  git_diff: 'Returns Git diff command, exitCode, stdout/stderr, and whether output was truncated.',
  shell: 'Returns PowerShell command, working directory, exitCode, timeout state, stdout/stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  run_tests: 'Returns test command result with exitCode, timeout state, stdout, stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  file_info: 'Returns relative path, file type, byte size, timestamps, permissions, and SHA-256 for regular files.',
  git_log: 'Returns Git command metadata and commits with SHA, short SHA, author, ISO date, and subject.',
  git_show: 'Returns Git command, exitCode, stdout/stderr, and output-truncation flag.',
  git_branches: 'Returns local branches with name, current-branch flag, short SHA, and upstream when configured.',
  git_changed_files: 'Returns change count, per-file index/worktree status and path, plus truncation and Git exit information.',
  discover_instructions: 'Returns applicable AGENTS.md paths and contents for the root and ancestor directories of supplied paths.',
  init: 'Returns initialized flag, AGENTS.md path, and either bytes written or reason it was left untouched.',
  create_directory: 'Returns created flag, relative path, and recursive mode.',
  move_path: 'Returns moved flag and relative source/destination paths.',
  delete_path: 'Returns deleted flag, relative path, and deleted entry type.',
  git_create_branch: 'Returns created flag and branch name.',
  git_switch_branch: 'Returns switched flag, branch name, and Git output/exit status.',
  git_commit: 'Returns committed flag and Git output/exit status, including the resulting commit hash in stdout when successful.',
  git_fetch: 'Returns exitCode, stdout/stderr and timeout status for the fetch operation.',
  git_pull: 'Returns exitCode, stdout/stderr and timeout status for the pull operation.',
  git_push: 'Returns exitCode, stdout/stderr and timeout status for the push operation.',
  git_clone: 'Returns exitCode, stdout/stderr and timeout status for the clone operation.',
  update_plan: 'Returns the current ordered plan with IDs, step text and pending/in_progress/completed status.',
  upload_workspace_file: 'Returns the repository artifact path/URL, media type, byte size, SHA-256, visibility and retrieval note.',
  computer: 'Returns model readiness, screenshot analysis with coordinate-frame metadata, local mouse/keyboard input outcomes, or a batched observe-act-observe result.',
  refresh_environment_context: 'Returns the compact context index, including current agent_context, project-native command hints and tool catalog.',
  batch: 'Returns ordered steps with IDs, tool names, success/failed/cancelled status, errors/cancellation details, exit codes, and actual results even for failed commands.',
  get_agent_context: 'Returns a compact environment/project snapshot, project scripts, suggested native commands, instruction file paths/hashes/sizes, bounded tree and complete tool catalog.'
});
function parameterSchema(tool) {
  const names = (TOOL_ARGUMENT_KEYS[tool] || []).filter(name => name !== 'approved');
  const overrides = TOOL_PARAMETER_OVERRIDES[tool] || {};
  const properties = {};
  for (const name of names) {
    const base = BASE_FIELD_SCHEMAS[name] || { type: 'string', description: 'Argument ' + name + ' for ' + tool + '.' };
    const override = overrides[name] || {};
    properties[name] = { ...base, ...override };
    if (tool === 'git_fetch' || tool === 'git_pull' || tool === 'git_push' || tool === 'git_clone') {
      if (name === 'timeoutMs' && !override.default) properties[name] = { ...properties[name], default: 60000 };
    }
  }
  if (tool === 'batch') {
    properties.steps = { ...BASE_FIELD_SCHEMAS.steps, ...overrides.steps };
  }
  return { type: 'object', properties, required: REQUIRED_ARGUMENTS[tool] || [], additionalProperties: false };
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function computerServiceCall(service, args, requestId) {
  switch (args.action) {
    case 'status': return service.status(args);
    case 'connect': return service.connectColab();
    case 'enable': return service.activate(args, requestId);
    case 'disable': return service.deactivate(args, requestId);
    case 'screenshot': return service.analyzeScreenshot(args, requestId);
    case 'wait': return service.wait(args);
    case 'start_control':
    case 'stop_control':
    case 'sequence':
    case 'click':
    case 'move':
    case 'drag':
    case 'scroll':
    case 'press':
    case 'type':
    case 'hotkey':
    case 'mouse_down':
    case 'mouse_up':
    case 'key_down':
    case 'key_up':
      return service.inputAction(args, requestId);
    default: throw new Error('Unsupported computer action.');
  }
}

function computerOutputFailed(action, output) {
  if (!output || output.status === 'error' || output.status === 'inference_failed') return true;
  if (action === 'screenshot') return !['report_available', 'inference_in_progress'].includes(output.status);
  if (action === 'sequence') return output.status === 'error';
  if (action === 'wait') return ['inactive', 'needs_authentication', 'gpu_unavailable', 'disconnected'].includes(output.status);
  return false;
}

function createToolBridge(deps) {
  const { dialog, getMainWindow, getWorkspaceRoot, localTools, githubAuth, uploadWorkspaceFile, getAutoAcceptAll, visionService } = deps;
  const COMPUTER_TOOLS = new Set(['computer']);

  function validateArgs(tool, args) {
    if (BLOCKED_TOOLS_FOR_MAILBOX.has(tool)) {
      throw new Error('The repository mailbox cannot invoke the app GitHub API directly.');
    }
    const allowed = TOOL_ARGUMENT_KEYS[tool];
    if (!allowed) throw new Error('Unknown local tool: ' + tool);
    if (!isPlainObject(args)) throw new Error('Tool args must be a JSON object.');
    const extra = Object.keys(args).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error('Unsupported argument field(s) for ' + tool + ': ' + extra.join(', '));
    if (tool === 'batch') validateBatchArgs(args);
  }

  function validateBatchArgs(args) {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > MAX_BATCH_STEPS) {
      throw new Error('batch.steps must contain between 1 and ' + MAX_BATCH_STEPS + ' tool steps.');
    }
    if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
      throw new Error('batch.stopOnError must be a boolean.');
    }
    if (args.maxConcurrency !== undefined && (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1 || args.maxConcurrency > MAX_BATCH_CONCURRENCY)) {
      throw new Error('batch.maxConcurrency must be an integer from 1 to ' + MAX_BATCH_CONCURRENCY + '.');
    }
    const ids = new Set();
    for (const [index, step] of args.steps.entries()) {
      if (!isPlainObject(step)) throw new Error('batch step ' + (index + 1) + ' must be an object.');
      if (Object.keys(step).some(key => !['id','tool','args'].includes(key))) throw new Error('batch step contains unsupported fields.');
      if (typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(step.id)) throw new Error('batch step IDs must be 1–20 simple characters.');
      if (ids.has(step.id)) throw new Error('duplicate batch step ID: ' + step.id);
      if (typeof step.tool !== 'string' || step.tool === 'batch' || step.tool === 'refresh_environment_context' || BLOCKED_TOOLS_FOR_MAILBOX.has(step.tool)) {
        throw new Error('batch step ' + step.id + ' uses an unsupported or non-nestable tool.');
      }
      if (!isPlainObject(step.args)) throw new Error('batch step ' + step.id + ' args must be an object.');
      if (Object.hasOwn(step.args, 'approved')) throw new Error('batch steps cannot bypass local approval with an approved argument.');
      validateArgs(step.tool, step.args);
      for (const referencedId of collectBatchRefIds(step.args)) {
        if (!ids.has(referencedId)) throw new Error('batch reference must point to an earlier step: ' + referencedId);
      }
      ids.add(step.id);
    }
  }

  function collectBatchRefIds(value, refs = new Set(), depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) { for (const item of value) collectBatchRefIds(item, refs, depth + 1); return refs; }
    if (!isPlainObject(value)) return refs;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      if (!parts[0] || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('unsafe batch reference path.');
      refs.add(parts[0]);
      return refs;
    }
    for (const item of Object.values(value)) collectBatchRefIds(item, refs, depth + 1);
    return refs;
  }

  function normalizeBatchPath(value) {
    return String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  }

  function batchFootprint(step) {
    const args = step.args || {};
    const reads = [];
    const writes = [];
    let barrier = false;
    const add = (set, value) => {
      const normalized = normalizeBatchPath(value);
      if (normalized) set.push(normalized);
    };
    switch (step.tool) {
      case 'read_file':
      case 'file_info':
      case 'upload_workspace_file':
        add(reads, args.path);
        break;
      case 'write_file':
      case 'create_directory':
      case 'delete_path':
        add(writes, args.path);
        break;
      case 'move_path':
        add(writes, args.source);
        add(writes, args.destination);
        break;
      case 'init':
        add(writes, 'AGENTS.md');
        break;
      case 'apply_patch': {
        const paths = typeof args.patch === 'string'
          ? [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/gm)].map(match => match[1].trim())
          : [];
        for (const item of paths) add(writes, item);
        if (!writes.length) barrier = true;
        break;
      }
      case 'project_status':
      case 'list_dir':
      case 'directory_tree':
      case 'glob_file_search':
      case 'search':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
      case 'git_show':
      case 'git_branches':
      case 'git_changed_files':
      case 'discover_instructions':
      case 'get_agent_context':
        reads.push('*');
        break;
      case 'computer':
      case 'shell':
      case 'run_tests':
      case 'git_fetch':
      case 'git_pull':
      case 'git_push':
      case 'git_clone':
      case 'git_create_branch':
      case 'git_switch_branch':
      case 'git_commit':
      case 'refresh_environment_context':
        barrier = true;
        break;
      default:
        break;
    }
    return { reads, writes, barrier };
  }

  function batchFootprintsConflict(left, right) {
    if (left.barrier || right.barrier) return true;
    const overlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    return left.writes.some(a => right.reads.some(b => overlaps(a, b)) || right.writes.some(b => overlaps(a, b))) ||
      right.writes.some(a => left.reads.some(b => overlaps(a, b)));
  }

  function inferBatchDependencies(steps, index) {
    const current = steps[index];
    const dependencies = new Set(collectBatchRefIds(current.args));
    const currentFootprint = batchFootprint(current);
    for (let priorIndex = 0; priorIndex < index; priorIndex++) {
      const prior = steps[priorIndex];
      if (batchFootprintsConflict(batchFootprint(prior), currentFootprint)) dependencies.add(prior.id);
    }
    return [...dependencies];
  }

  function resolveBatchRefs(value, completed, depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) return value.map(item => resolveBatchRefs(item, completed, depth + 1));
    if (!isPlainObject(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      const stepId = parts.shift();
      if (!stepId || !completed.has(stepId)) throw new Error('batch reference must point to a completed earlier step: ' + value.$ref);
      let current = completed.get(stepId);
      for (const part of parts) {
        if (!part || ['__proto__','prototype','constructor'].includes(part)) throw new Error('unsafe batch reference path.');
        if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
        else if (isPlainObject(current) && Object.hasOwn(current, part)) current = current[part];
        else throw new Error('batch reference path not found: ' + value.$ref);
      }
      if (current === undefined) throw new Error('batch reference resolved to undefined: ' + value.$ref);
      return current;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = resolveBatchRefs(item, completed, depth + 1);
    return output;
  }

  function displayApprovalValue(value, maxChars = 4000) {
    const escaped = String(value == null ? '' : value)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        character => '[BIDI U+' + character.charCodeAt(0).toString(16).toUpperCase() + ']');
    if (escaped.length <= maxChars) return escaped;
    const marker = ' … [DISPLAY TRUNCATED]';
    return escaped.slice(0, Math.max(0, maxChars - marker.length)) + marker;
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
    if (tool === 'computer') {
      if (args.action === 'connect') {
        return header + resultWarning + 'Open the Colab notebook in the normal browser and establish the direct local-to-Colab connection. This does not load the model. The user may need to connect a runtime and run the notebook cell.';
      }
      if (args.action === 'enable') {
        return header + resultWarning + 'Enable screenshot understanding in Colab. If no runtime is connected, the notebook opens and requires the user to run its server cell. When connected, this may mount Google Drive, download several gigabytes of model files, and compile the runtime.';
      }
      if (args.action === 'screenshot') {
        const source = args.source === 'workspace_file' ? 'workspace image: ' + displayApprovalValue(args.path || '(missing path)', 1200) : 'current primary Windows display';
        return header + resultWarning + 'Capture and send one image for visual analysis. Source: ' + source +
          '\nThe image is sent directly to the authenticated temporary Colab HTTPS endpoint; the screenshot is not uploaded as a separate GitHub artifact. The model report returns through the shared mailbox, so it may contain details visible on your screen. Only proceed when that disclosure is acceptable.';
      }
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
      if (localTools.getToolPolicy('apply_patch', args).sensitivePath) {
        return header + resultWarning + 'This patch touches a file whose name looks sensitive. The patch will not be read or applied until you approve it.\n\nPatch preview (first 2500 characters):\n' +
          displayApprovalValue(String(args.patch || '').slice(0, 2500), 9000);
      }
      const plans = localTools.parsePatch(args.patch, root);
      return header + resultWarning + 'Review the files this patch will modify:\n' +
        plans.map(item => item.kind.toUpperCase() + '  ' + displayApprovalValue(item.relative, 500)).join('\n') +
        '\n\nPatch preview (line breaks are shown as \\\\n; first 2500 characters):\n' +
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
    if (tool === 'run_tests') return header + resultWarning + (args.command
      ? 'Run this explicit PowerShell test command. It runs with your Windows user permissions and may have side effects:\n\n' + displayApprovalValue(args.command, 4000) + '\n\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.'
      : 'Detect and run the project-native test command. Tests execute project code and may have side effects.\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.');
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
          trimmed[key] = trimmed[key].slice(0, 10000) + '\n[OUTPUT TRUNCATED before mailbox publication. This is not a safety denial; inspect status/exitCode/stderr. For listings, request smaller stable-sorted pages using Select-Object -Skip/-First.]';
        }
      }
      serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_RESULT_CHARS) return trimmed;
    }
    return {
      truncatedForMailbox: true,
      message: 'Tool output exceeded the repository return limit. This is incomplete output, not evidence of a safety block. Retry with smaller stable-sorted pages, a narrower query, or a file section.',
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
          { name: 'batch', mode: 'local-batch' },
          { name: 'get_agent_context', mode: 'read' },
          { name: 'upload_workspace_file', mode: 'approval-required' },
          { name: 'computer', mode: 'action-dependent-approval' },
          { name: 'refresh_environment_context', mode: 'repository-bridge-control' }
        );
        output.tools = output.tools.filter(item => !BLOCKED_TOOLS_FOR_MAILBOX.has(item.name)).map(item => ({
          ...item,
          description: TOOL_DESCRIPTIONS[item.name] || ('Run the ' + item.name + ' workspace tool.'),
          parameters: parameterSchema(item.name),
          ...(TOOL_RESULT_SUMMARIES[item.name] ? { returns: TOOL_RESULT_SUMMARIES[item.name] } : {}),
          permission_note: item.name === 'batch'
            ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? 'Auto-accept everything is enabled; protected steps run without per-operation approval dialogs.'
            : 'The batch call itself is not approval; protected steps show their own native Windows dialog.')
            : item.mode === 'action-dependent-approval'
              ? 'Native approval is required for connect, enable, and screenshot actions; status, disable, and wait do not prompt. Auto-accept everything may bypass those dialogs.'
              : item.mode === 'approval' || item.mode === 'approval-required' || item.mode === 'read-or-approval-for-secret-like-paths'
              ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
                ? 'Auto-accept everything is enabled; this protected call runs without a per-operation dialog.'
                : 'This call may display a native Windows approval dialog before execution.')
              : item.mode === 'automatic-workspace-write'
                ? 'Normally runs automatically for workspace-relative paths; secret-like paths still require native Windows approval.'
                : 'No approval dialog is normally required; the app still validates paths and arguments.'
        }));
        output.catalog_version = 2;
        output.tool_calling = {
          mode: 'repository-mailbox-batch',
          catalog_version: 2,
          rule: 'Submit up to 100 local steps in one request rather than one request per file. Independent lightweight file operations can run with maxConcurrency=100; default is 32. File/path conflicts and shell, tests, Git mutations, and unknown-side-effect operations are ordered automatically. For large file-output batches, fetch every part listed in result.output_artifacts concurrently, then review/process outputs together. $ref arguments wait for their source step. Inspect exitCode, timedOut, stdout, and stderr before dependent actions.',
          reference_syntax: '{"$ref":"priorStepId.result.content"}'
        };
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


  async function executeBatch(args, parentId) {
    const completed = new Map();
    const taskById = new Map();
    const outcomeById = new Map();
    const steps = args.steps;
    const concurrency = Number.isInteger(args.maxConcurrency) ? args.maxConcurrency : DEFAULT_BATCH_CONCURRENCY;
    const stopOnError = args.stopOnError !== false;
    let active = 0;
    const waiters = [];
    let firstFailureIndex = Number.POSITIVE_INFINITY;
    let stoppedAt = null;

    async function acquireSlot() {
      if (active < concurrency) { active++; return; }
      await new Promise(resolve => waiters.push(resolve));
    }
    function releaseSlot() {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
    function itemFor(step, outcome, skipped = false) {
      const item = {
        id: step.id,
        tool: step.tool,
        call_id: outcome.call_id || (String(parentId).slice(0, 55) + '-' + step.id),
        ok: outcome.ok === true,
        status: skipped ? 'skipped' : outcome.ok === true ? 'success' : outcome.cancelled ? 'cancelled' : 'failed'
      };
      if (skipped) item.skipped = true;
      if (outcome.cancelled) item.cancelled = true;
      if (outcome.error) item.error = outcome.error;
      if (outcome.message && !outcome.ok) item.message = outcome.message;
      if (outcome.result !== undefined) item.result = outcome.result;
      if (outcome.result && Number.isInteger(outcome.result.exitCode)) item.exit_code = outcome.result.exitCode;
      if (outcome.result && outcome.result.timedOut === true) item.timed_out = true;
      return item;
    }

    for (const [index, step] of steps.entries()) {
      const dependencies = inferBatchDependencies(steps, index);
      const task = (async () => {
        await Promise.all(dependencies.map(id => taskById.get(id)));
        const failedDependency = dependencies.find(id => !outcomeById.get(id) || outcomeById.get(id).ok !== true);
        if (failedDependency) {
          const skipped = { ok: false, skipped: true, error: 'Not started because dependency ' + failedDependency + ' did not succeed.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        if (stopOnError && index > firstFailureIndex) {
          const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        await acquireSlot();
        try {
          if (stopOnError && index > firstFailureIndex) {
            const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
            completed.set(step.id, skipped);
            outcomeById.set(step.id, skipped);
            return skipped;
          }
          let outcome;
          try {
            const resolvedArgs = resolveBatchRefs(step.args, completed);
            const childId = (String(parentId).slice(0, 55) || 'batch') + '-' + step.id;
            outcome = await runTool(step.tool, resolvedArgs, childId);
          } catch (error) {
            outcome = { ok: false, error: String(error && error.message || error) };
          }
          completed.set(step.id, outcome);
          outcomeById.set(step.id, outcome);
          if (!outcome.ok && stopOnError && index < firstFailureIndex) {
            firstFailureIndex = index;
            stoppedAt = step.id;
          }
          return outcome;
        } finally {
          releaseSlot();
        }
      })();
      taskById.set(step.id, task);
    }

    await Promise.all(taskById.values());
    const resultSteps = steps.map(step => {
      const outcome = outcomeById.get(step.id) || { ok: false, skipped: true, error: 'Step did not run.' };
      return itemFor(step, outcome, outcome.skipped === true);
    });
    const failed = resultSteps.some(item => !item.ok);
    const completedSteps = resultSteps.filter(item => !item.skipped).length;
    return {
      ok: !failed,
      result: {
        steps: resultSteps,
        completed_steps: completedSteps,
        skipped_steps: resultSteps.filter(item => item.skipped).length,
        requested_steps: steps.length,
        max_concurrency: concurrency,
        stopped_at: stoppedAt
      }
    };
  }


  function inferProjectCommands(project, projectCommands) {
    const entries = new Set((project && project.topLevelEntries || []).map(String));
    const scripts = projectCommands && projectCommands.scripts && typeof projectCommands.scripts === 'object' ? projectCommands.scripts : {};
    const commands = [];
    if (typeof scripts.test === 'string') commands.push({ name: 'test', command: 'npm test', source: 'package.json scripts.test' });
    if (typeof scripts.check === 'string') commands.push({ name: 'check', command: 'npm run check', source: 'package.json scripts.check' });
    if (typeof scripts.lint === 'string') commands.push({ name: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' });
    if (entries.has('pyproject.toml') || entries.has('pytest.ini') || entries.has('tests')) commands.push({ name: 'test', command: 'python -m pytest', source: 'Python project marker; verify dependencies first' });
    if (entries.has('Cargo.toml')) commands.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' });
    if (entries.has('go.mod')) commands.push({ name: 'test', command: 'go test ./...', source: 'go.mod' });
    if (entries.has('pom.xml')) commands.push({ name: 'test', command: 'mvn test', source: 'pom.xml' });
    if (entries.has('gradlew.bat')) commands.push({ name: 'test', command: '.\\gradlew.bat test', source: 'gradlew.bat' });
    else if (entries.has('build.gradle') || entries.has('build.gradle.kts')) commands.push({ name: 'test', command: 'gradle test', source: 'Gradle build file' });
    if (entries.has('global.json') || [...entries].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) commands.push({ name: 'test', command: 'dotnet test', source: '.NET project marker' });
    const seen = new Set();
    return commands.filter(item => { const key = item.command.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  async function executeAgentContext(root, requestId) {
    const [environment, project, tree, instructionReport, capabilities] = await Promise.all([
      localTools.executeTool(root, 'environment_info', {}),
      localTools.executeTool(root, 'project_status', {}),
      localTools.executeTool(root, 'directory_tree', { path: '.', maxDepth: isFilesystemRoot(root) ? 1 : 2, maxEntries: 180, format: 'paths' }),
      localTools.executeTool(root, 'discover_instructions', {}),
      executeLocalTool(root, 'get_capabilities', {}, requestId + '-catalog')
    ]);
    const found = instructionReport && Array.isArray(instructionReport.instructions) ? instructionReport.instructions : [];
    const instructionFiles = found.map(item => ({
      path: item.path,
      bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
      sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex'),
      contents_included: false
    }));
    let projectCommands = null;
    const manifestPath = path.join(root, 'package.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile() && fs.statSync(manifestPath).size <= 256 * 1024) {
      try {
        const manifestFile = await localTools.executeTool(root, 'read_file', { path: 'package.json' });
        const manifest = JSON.parse(manifestFile.content);
        projectCommands = {
          manifest: 'package.json',
          name: typeof manifest.name === 'string' ? manifest.name : null,
          packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
          engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
          scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
        };
      } catch { projectCommands = { manifest: 'package.json', parse_error: true }; }
    }
    const suggestedCommands = inferProjectCommands(project, projectCommands);
    return {
      protocol: 'chatgpt-local-agent-context/v1',
      generated_at: new Date().toISOString(),
      workspace_selected: true,
      workspace_mode: isFilesystemRoot(root) ? 'drive-root' : 'folder',
      path_style: process.platform === 'win32' ? 'Windows' : process.platform,
      workspace_path_guidance: isFilesystemRoot(root)
        ? 'The selected workspace is an entire drive. Use drive-relative paths such as Users/Example/Projects/app.js or an absolute Windows path within the selected drive. The background index lists only the root entries; inspect relevant folders on demand.'
        : 'Use workspace-relative paths or absolute Windows paths that resolve inside the selected workspace.',
      environment,
      project,
      project_commands: projectCommands,
      suggested_commands: suggestedCommands,
      execution_policy: {
        auto_accept_all: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true,
        note: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
          ? 'The user explicitly enabled app-wide auto-accept. Do not try to override or infer approval for anything outside the registered tool/policy boundary.'
          : 'Auto-accept is disabled; protected operations may require native approval.'
      },
      directory_overview: tree,
      instruction_files: instructionFiles,
      tool_catalog: {
        protocol: capabilities.protocol,
        catalog_version: 2,
        tools: capabilities.tools,
        tool_calling: capabilities.tool_calling
      },
      retrieval_rules: [
        'The connected GitHub MCP does not expose these local tools as native functions. For a Windows task, read bridge/context/latest.json and bridge/context/capabilities.json, then create bridge/requests/<unique-id>.json with protocol chatgpt-local-repo-bridge/v1, request_id, created_at, tool, and args; read bridge/results/<same-id>.json.',
        'Immediately invoke get_agent_context through that mailbox protocol before asking for machine facts. Use the published schemas exactly; do not treat a missing native function name or a server-sandbox path miss as proof that Windows access is blocked.',
        'Discover installed software, games, versions, paths, project files and configuration with targeted local tools before asking the user. Ask only for genuinely missing intent after discovery.',
        'If a matching result is absent, inspect the matching claim and worker state and re-read the same result. Do not replay an uncertain side effect or create a duplicate request.',
        'The shared snapshot is refreshed in the background by the Windows worker. Request a fresh live context when a just-made workspace change matters.',
        'Fetch full instruction contents and source files only when relevant to the current task.',
        'Use batch for up to 50 known operations to minimize GitHub request/result round trips; references may only point to earlier completed steps.',
        isFilesystemRoot(root)
          ? 'The entire drive is the workspace. The background index intentionally contains only top-level names; use list_dir, directory_tree, glob_file_search, or search with a targeted path to explore a subdirectory. Do not recursively dump the whole drive.'
          : 'Use paths relative to the selected workspace, or absolute Windows paths that remain inside it. Protected steps follow the current local approval setting.',
        'The shell runs as the signed-in Windows user and is not sandboxed.'
      ],
      development_workflow: {
        purpose: 'Use the actual Windows environment as the working environment, through its GitHub mailbox.',
        rules: [
          'First inspect the published context and exact schemas, then submit a real local-tool request using the mailbox JSON envelope. Native GitHub MCP function names and local mailbox tool names are different interfaces.',
          'Start with get_agent_context; it returns Windows/runtime facts, project discovery, instruction metadata, a bounded directory view, and the local tool catalog in one result.',
          'For unknown environment facts, run targeted discovery before asking the user: check installed application/game manifests, executable version metadata, likely install locations, frameworks and relevant project files.',
          'Batch independent read-only inspections. Use one small inspection request, one focused edit request, and one verification request rather than one request per file or command.',
          'Match every result to its request_id. Inspect status, nested ok, exitCode, timedOut, stdout/stderr and truncation. A request or claim alone is not completion.',
          'If the result is missing, inspect its claim and worker state and reread that result. Never replay an uncertain side-effecting request.',
          'Treat actual local output as authoritative; GitHub Actions and the ChatGPT server sandbox cannot establish local Windows state.',
          'Keep permission and workspace-path protections intact. When an approval or genuine failure blocks an operation, diagnose the exact result and try a supported alternative before falling back to manual instructions.',
          'For substantial tasks, define measurable acceptance criteria and a short implementation plan before editing; keep it proportional to scope.',
          'Match architecture to scope. A complex game, app, or multi-system feature should use coherent modules and clear interfaces, not a single-file shortcut unless explicitly requested.',
          'Inspect relevant entry points, manifests, existing modules and tests before choosing the design; preserve unrelated changes.',
          'Implement in small, integrated vertical slices. Batch independent inspections and verification, and represent dependencies explicitly with result references.',
          'After edits, run project-native checks and tests, build the actual target when available, and perform an end-to-end UI smoke test for user-facing software when practical. Fix failures and rerun verification.',
          'Report only verified outcomes and name important unknowns.'
        ]
      },
      detail: { directory_tree_tool: 'directory_tree', instruction_tool: 'discover_instructions', capabilities_tool: 'get_capabilities' }
    };
  }

  async function runTool(tool, inputArgs, callId = null) {
    const root = getWorkspaceRoot();
    const args = { ...(inputArgs || {}) };
    const id = callId || randomUUID();
    let result;
    try {
      validateArgs(tool, args);
      if (tool === 'batch') {
        result = await executeBatch(args, id);
      } else if (tool === 'get_agent_context') {
        result = { ok: true, result: await executeAgentContext(root, id) };
      } else {
        const isComputerTool = COMPUTER_TOOLS.has(tool);
        if (isComputerTool && !visionService) throw new Error('The computer screenshot service is unavailable in this app build.');
        if (isComputerTool && !['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'].includes(args.action)) {
          throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
        }
        if (isComputerTool && args.action === 'wait' && typeof args.request_id !== 'string') {
          throw new Error('computer(action=wait) requires the request_id returned by computer(action=screenshot).');
        }
        if (isComputerTool && args.action === 'screenshot' && args.source === 'workspace_file' && typeof args.path !== 'string') {
          throw new Error('computer(action=screenshot, source=workspace_file) requires path.');
        }
        const policy = tool === 'upload_workspace_file'
          ? { tool, requiresApproval: true, automatic: false }
          : isComputerTool
            ? { tool, requiresApproval: ['connect', 'enable', 'screenshot'].includes(args.action), automatic: false }
            : localTools.getToolPolicy(tool, args);
        if (policy.requiresApproval) {
          const approved = typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? true
            : await askApproval(tool, args, root);
          if (!approved) {
            result = { ok: false, cancelled: true, message: 'User cancelled the operation. Nothing was executed.' };
          } else {
            if (policy.sensitivePath || tool === 'read_file') args.approved = true;
            const output = isComputerTool
              ? await computerServiceCall(visionService, args, id)
              : await executeLocalTool(root, tool, args, id);
            if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
              result = {
                ok: false,
                error: isComputerTool
                  ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                  : tool + ' exited with code ' + output.exitCode + '.',
                result: output
              };
            } else {
              result = { ok: true, result: output };
            }
          }
        } else {
          const output = isComputerTool
            ? await computerServiceCall(visionService, args, id)
            : await executeLocalTool(root, tool, args, id);
          if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
            result = {
              ok: false,
              error: isComputerTool
                ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                : tool + ' exited with code ' + output.exitCode + '.',
              result: output
            };
          } else {
            result = { ok: true, result: output };
          }
        }
      }
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    return boundedResult({
      protocol: 'chatgpt-local-tool-result-v2',
      status: result.ok ? 'success' : result.cancelled ? 'cancelled' : 'failed',
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
 },
  x: { type: 'number', description: 'Horizontal coordinate in pixels measured against the latest desktop screenshot, origin top-left.', minimum: 0 },
  y: { type: 'number', description: 'Vertical coordinate in pixels measured against the latest desktop screenshot, origin top-left.', minimum: 0 },
  fromX: { type: 'number', description: 'Starting horizontal pixel coordinate for drag or interpolated movement.', minimum: 0 },
  fromY: { type: 'number', description: 'Starting vertical pixel coordinate for drag or interpolated movement.', minimum: 0 },
  button: { type: 'string', description: 'Mouse button: left, right, or middle.', enum: ['left', 'right', 'middle'], default: 'left' },
  clicks: { type: 'integer', description: 'Number of clicks from 1–3.', minimum: 1, maximum: 3, default: 1 },
  deltaX: { type: 'integer', description: 'Horizontal wheel delta; one typical notch is 120 or -120.', minimum: -12000, maximum: 12000, default: 0 },
  deltaY: { type: 'integer', description: 'Vertical wheel delta; one typical notch is 120 or -120.', minimum: -12000, maximum: 12000, default: 0 },
  durationMs: { type: 'integer', description: 'Smooth move/drag or wait duration, max 5000 ms (move/drag max 3000).', minimum: 0, maximum: 5000, default: 0 },
  key: { type: 'string', description: 'A key name such as W, ENTER, ESC, CTRL, SPACE, LEFT, or F1.', maxLength: 20 },
  keys: { type: 'array', description: 'Keys for a hotkey combination.', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 20 } },
  text: { type: 'string', description: 'Text to type via Unicode input (up to 2,000 characters).', maxLength: 2000 },
  observe: { type: 'boolean', description: 'For sequence, capture/analyze a fresh screenshot after actions. Defaults to true.', default: true },
  frameWidth: { type: 'integer', description: 'Optional coordinate frame width.', minimum: 1, maximum: 20000 },
  frameHeight: { type: 'integer', description: 'Optional coordinate frame height.', minimum: 1, maximum: 20000 },
  command: { type: 'string', description: 'PowerShell command to execute from the workspace. Arbitrary commands run with the signed-in user permissions and require local approval.', minLength: 1, maxLength: 20000 },
  maxDepth: { type: 'integer', description: 'Maximum directory depth (1–12). Defaults to 4.', minimum: 1, maximum: 12, default: 4 },
  maxEntries: { type: 'integer', description: 'Maximum tree entries (1–2,000). Defaults to 500.', minimum: 1, maximum: 2000, default: 500 },
  format: { type: 'string', description: 'Use paths for a compact path-only listing, or entries for structured file records.', enum: ['entries', 'paths'], default: 'entries' },
  startLine: { type: 'integer', description: 'First 1-based line to return. For a complete read, continue at the prior result nextStartLine.', minimum: 1 },
  startCharacter: { type: 'integer', description: 'Unicode code-point offset within startLine; resume a long line at the prior result nextStartCharacter. Defaults to 0.', minimum: 0 }, 
  endLine: { type: 'integer', description: 'Last line to return, 1-based and inclusive. At most 5,000 lines can be read in one call.' , minimum: 1 },
  maxResults: { type: 'integer', description: 'Maximum matching lines to return (1–150). Defaults to 100.', minimum: 1, maximum: 150, default: 100 },
  contextLines: { type: 'integer', description: 'Number of diff context lines (0–20).', minimum: 0, maximum: 20, default: 3 },
  maxCount: { type: 'integer', description: 'Maximum Git log entries (1–100). Defaults to 20.', minimum: 1, maximum: 100, default: 20 },
  timeoutMs: { type: 'integer', description: 'Operation timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 },
  recursive: { type: 'boolean', description: 'Recursively create a directory and its parents. Defaults to true.', default: true },
  staged: { type: 'boolean', description: 'When true, show the staged diff instead of the unstaged diff.', default: false },
  regex: { type: 'boolean', description: 'Interpret query as a regular expression. Defaults to false.', default: false },
  caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to false.', default: false },
  stopOnError: { type: 'boolean', description: 'Stop launching queued batch steps after a failure; already-running independent steps may finish. Defaults to true.', default: true },
  maxConcurrency: { type: 'integer', description: 'Maximum independent steps to execute at once (1–100). Defaults to 32. Use 100 for large, lightweight, independent file operations; conflicting paths and shell, tests, and Git mutations are automatically ordered.', minimum: 1, maximum: 100, default: 32 },
  paths: { type: 'array', description: 'Optional list of workspace-relative paths. When set, limits the operation to those paths.', items: { type: 'string' }, maxItems: 100 },
  items: { type: 'array', description: 'Plan steps as strings or objects containing step and optional status.', maxItems: 30, items: { anyOf: [
    { type: 'string', maxLength: 1000 },
    { type: 'object', properties: { step: { type: 'string', maxLength: 1000 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['step'], additionalProperties: false }
  ] } },
  steps: { type: 'array', description: 'Ordered local tool calls (up to 100). Each step needs a unique id, a tool name, and args. References may only point to completed earlier steps.', minItems: 1, maxItems: 100 },
});
const TOOL_PARAMETER_OVERRIDES = Object.freeze({
  computer: {
    action: { enum: ['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'] },
    source: { enum: ['desktop', 'workspace_file'], default: 'desktop' },
    path: { description: 'Optional image path within the workspace; required when action=screenshot and source=workspace_file.' },
    waitMs: { default: 5000 },
    request_id: { description: 'Existing screenshot request ID returned by computer(action=screenshot). Format: computer- followed by 24 lowercase hexadecimal characters.', pattern: '^computer-[a-f0-9]{24}$' }
  },
  list_dir: { path: { description: 'Directory to list, relative to the selected workspace. Defaults to . (workspace root).', default: '.' } },
  directory_tree: {
    path: { description: 'Subdirectory to walk, relative to the selected workspace. Defaults to . (workspace root).', default: '.' },
    maxDepth: { default: 4 },
    maxEntries: { default: 500 }
  },
  glob_file_search: {
    pattern: { default: '**/*', description: 'Glob pattern relative to path, for example **/*.js or src/**/*.ts. Maximum 300 characters.' },
    path: { description: 'Optional starting directory relative to the workspace, or an absolute path inside it. Defaults to the workspace root.', default: '.' }
  },
  search: { path: { description: 'Optional directory to search, relative to the workspace or an absolute path inside it. Defaults to the workspace root.', default: '.' } },
  git_diff: { contextLines: { default: 3 } },
  create_directory: { recursive: { description: 'Create missing parent directories as needed. Defaults to true.', default: true } },
  delete_path: { recursive: { description: 'Set true to delete a non-empty directory tree. Defaults to false; without it, only files and empty directories can be deleted.', default: false } },
  git_log: { path: { description: 'Optional workspace-relative path to limit the history.' } },
  git_show: { ref: { default: 'HEAD' } },
  git_commit: { paths: { description: 'Optional paths to stage before committing. If omitted, only changes already staged are committed.', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
  discover_instructions: { paths: { description: 'Optional relative files/directories whose ancestor AGENTS.md files should be found. Maximum 50 paths.', items: { type: 'string' }, maxItems: 50 } },
  run_tests: { command: { description: 'Optional override PowerShell command. If omitted, detect and run the project-native test command. Requires local approval.', minLength: 1, maxLength: 20000 } },
  git_fetch: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_pull: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_push: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_clone: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  shell: { timeoutMs: { description: 'PowerShell timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  run_tests: { timeoutMs: { description: 'Test-command timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  batch: {
    steps: {
      description: '1–100 calls. Independent calls run concurrently (default limit 32; maximum 100); a {"$ref":"stepId.result.content"} value makes a step wait for that earlier step. File/path conflicts and shell/tests/Git mutations are ordered automatically. Each step follows the current local approval setting.',
      minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique step ID used by result references.', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$' },
          tool: { type: 'string', description: 'Callable local tool for this step.', enum: Object.keys(TOOL_ARGUMENT_KEYS).filter(name => name !== 'batch' && name !== 'refresh_environment_context' && !BLOCKED_TOOLS_FOR_MAILBOX.has(name)) },
          args: { type: 'object', description: 'Arguments matching the named tool schema. A value can be {"$ref":"earlierStep.result.someField"} to insert that prior result.', additionalProperties: true }
        },
        required: ['id', 'tool', 'args'],
        additionalProperties: false
      }
    }
  }
});
const TOOL_RESULT_SUMMARIES = Object.freeze({
  get_capabilities: 'Returns catalog_version, tool protocol, callable tools with schemas/permission notes/result summaries, and the batch/reference contract.',
  project_status: 'Returns isGitRepository, detectedTechnologies, topLevelEntries, and Git status when applicable.',
  environment_info: 'Returns platform, architecture, OS/runtime version, CPU and memory metadata. Identity-sensitive fields are redacted before repository publication.',
  list_dir: 'Returns the relative directory path, sorted entries (name/type/size), and a truncated flag.',
  directory_tree: 'Returns relative start path, applied maxDepth, entry count, truncation flag, and relative path/type/size entries.',
  glob_file_search: 'Returns the original glob pattern, match count, truncation flag, and relative file paths.',
  read_file: 'Returns exact full-file bytes, SHA-256 and totalLines, plus a lossless bounded page: returnedLineCount/returnedBytes, requested and returned line ranges, rangeComplete, hasMoreInRange, hasMoreInFile, reachedEof, fileComplete and nextStartLine/nextStartCharacter. Resume with the returned cursor until hasMoreInFile=false; only a single response starting at line 1 can have fileComplete=true. Each content page is at most 12 KiB.',
  search: 'Returns query, scanned-file count, match count, truncation flag, and matches with path/line/column/text.',
  write_file: 'Returns relative path, byte count, and before/after SHA-256 hashes.',
  apply_patch: 'Returns changed-file count, relative changed paths, and per-file actions.',
  git_status: 'Returns current branch/working-tree status, Git output, exit code, and stderr.',
  git_diff: 'Returns Git diff command, exitCode, stdout/stderr, and whether output was truncated.',
  shell: 'Returns PowerShell command, working directory, exitCode, timeout state, stdout/stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  run_tests: 'Returns test command result with exitCode, timeout state, stdout, stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  file_info: 'Returns relative path, file type, byte size, timestamps, permissions, and SHA-256 for regular files.',
  git_log: 'Returns Git command metadata and commits with SHA, short SHA, author, ISO date, and subject.',
  git_show: 'Returns Git command, exitCode, stdout/stderr, and output-truncation flag.',
  git_branches: 'Returns local branches with name, current-branch flag, short SHA, and upstream when configured.',
  git_changed_files: 'Returns change count, per-file index/worktree status and path, plus truncation and Git exit information.',
  discover_instructions: 'Returns applicable AGENTS.md paths and contents for the root and ancestor directories of supplied paths.',
  init: 'Returns initialized flag, AGENTS.md path, and either bytes written or reason it was left untouched.',
  create_directory: 'Returns created flag, relative path, and recursive mode.',
  move_path: 'Returns moved flag and relative source/destination paths.',
  delete_path: 'Returns deleted flag, relative path, and deleted entry type.',
  git_create_branch: 'Returns created flag and branch name.',
  git_switch_branch: 'Returns switched flag, branch name, and Git output/exit status.',
  git_commit: 'Returns committed flag and Git output/exit status, including the resulting commit hash in stdout when successful.',
  git_fetch: 'Returns exitCode, stdout/stderr and timeout status for the fetch operation.',
  git_pull: 'Returns exitCode, stdout/stderr and timeout status for the pull operation.',
  git_push: 'Returns exitCode, stdout/stderr and timeout status for the push operation.',
  git_clone: 'Returns exitCode, stdout/stderr and timeout status for the clone operation.',
  update_plan: 'Returns the current ordered plan with IDs, step text and pending/in_progress/completed status.',
  upload_workspace_file: 'Returns the repository artifact path/URL, media type, byte size, SHA-256, visibility and retrieval note.',
  computer: 'Returns actual Colab/model readiness and, when requested, a verified screenshot report or pending request ID. Pending is not completed inference.',
  refresh_environment_context: 'Returns the compact context index, including current agent_context, project-native command hints and tool catalog.',
  batch: 'Returns ordered steps with IDs, tool names, success/failed/cancelled status, errors/cancellation details, exit codes, and actual results even for failed commands.',
  get_agent_context: 'Returns a compact environment/project snapshot, project scripts, suggested native commands, instruction file paths/hashes/sizes, bounded tree and complete tool catalog.'
});
function parameterSchema(tool) {
  const names = (TOOL_ARGUMENT_KEYS[tool] || []).filter(name => name !== 'approved');
  const overrides = TOOL_PARAMETER_OVERRIDES[tool] || {};
  const properties = {};
  for (const name of names) {
    const base = BASE_FIELD_SCHEMAS[name] || { type: 'string', description: 'Argument ' + name + ' for ' + tool + '.' };
    const override = overrides[name] || {};
    properties[name] = { ...base, ...override };
    if (tool === 'git_fetch' || tool === 'git_pull' || tool === 'git_push' || tool === 'git_clone') {
      if (name === 'timeoutMs' && !override.default) properties[name] = { ...properties[name], default: 60000 };
    }
  }
  if (tool === 'batch') {
    properties.steps = { ...BASE_FIELD_SCHEMAS.steps, ...overrides.steps };
  }
  return { type: 'object', properties, required: REQUIRED_ARGUMENTS[tool] || [], additionalProperties: false };
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function computerServiceCall(service, args, requestId) {
  switch (args.action) {
    case 'status': return service.status(args);
    case 'connect': return service.connectColab();
    case 'enable': return service.activate(args, requestId);
    case 'disable': return service.deactivate(args, requestId);
    case 'screenshot': return service.analyzeScreenshot(args, requestId);
    case 'wait': return service.wait(args);
    default: throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
  }
}

function computerOutputFailed(action, output) {
  if (!output || output.status === 'error' || output.status === 'inference_failed') return true;
  if (action === 'screenshot') return !['report_available', 'inference_in_progress'].includes(output.status);
  if (action === 'wait') return ['inactive', 'needs_authentication', 'gpu_unavailable', 'disconnected'].includes(output.status);
  return false;
}

function createToolBridge(deps) {
  const { dialog, getMainWindow, getWorkspaceRoot, localTools, githubAuth, uploadWorkspaceFile, getAutoAcceptAll, visionService } = deps;
  const COMPUTER_TOOLS = new Set(['computer']);

  function validateArgs(tool, args) {
    if (BLOCKED_TOOLS_FOR_MAILBOX.has(tool)) {
      throw new Error('The repository mailbox cannot invoke the app GitHub API directly.');
    }
    const allowed = TOOL_ARGUMENT_KEYS[tool];
    if (!allowed) throw new Error('Unknown local tool: ' + tool);
    if (!isPlainObject(args)) throw new Error('Tool args must be a JSON object.');
    const extra = Object.keys(args).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error('Unsupported argument field(s) for ' + tool + ': ' + extra.join(', '));
    if (tool === 'batch') validateBatchArgs(args);
  }

  function validateBatchArgs(args) {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > MAX_BATCH_STEPS) {
      throw new Error('batch.steps must contain between 1 and ' + MAX_BATCH_STEPS + ' tool steps.');
    }
    if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
      throw new Error('batch.stopOnError must be a boolean.');
    }
    if (args.maxConcurrency !== undefined && (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1 || args.maxConcurrency > MAX_BATCH_CONCURRENCY)) {
      throw new Error('batch.maxConcurrency must be an integer from 1 to ' + MAX_BATCH_CONCURRENCY + '.');
    }
    const ids = new Set();
    for (const [index, step] of args.steps.entries()) {
      if (!isPlainObject(step)) throw new Error('batch step ' + (index + 1) + ' must be an object.');
      if (Object.keys(step).some(key => !['id','tool','args'].includes(key))) throw new Error('batch step contains unsupported fields.');
      if (typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(step.id)) throw new Error('batch step IDs must be 1–20 simple characters.');
      if (ids.has(step.id)) throw new Error('duplicate batch step ID: ' + step.id);
      if (typeof step.tool !== 'string' || step.tool === 'batch' || step.tool === 'refresh_environment_context' || BLOCKED_TOOLS_FOR_MAILBOX.has(step.tool)) {
        throw new Error('batch step ' + step.id + ' uses an unsupported or non-nestable tool.');
      }
      if (!isPlainObject(step.args)) throw new Error('batch step ' + step.id + ' args must be an object.');
      if (Object.hasOwn(step.args, 'approved')) throw new Error('batch steps cannot bypass local approval with an approved argument.');
      validateArgs(step.tool, step.args);
      for (const referencedId of collectBatchRefIds(step.args)) {
        if (!ids.has(referencedId)) throw new Error('batch reference must point to an earlier step: ' + referencedId);
      }
      ids.add(step.id);
    }
  }

  function collectBatchRefIds(value, refs = new Set(), depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) { for (const item of value) collectBatchRefIds(item, refs, depth + 1); return refs; }
    if (!isPlainObject(value)) return refs;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      if (!parts[0] || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('unsafe batch reference path.');
      refs.add(parts[0]);
      return refs;
    }
    for (const item of Object.values(value)) collectBatchRefIds(item, refs, depth + 1);
    return refs;
  }

  function normalizeBatchPath(value) {
    return String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  }

  function batchFootprint(step) {
    const args = step.args || {};
    const reads = [];
    const writes = [];
    let barrier = false;
    const add = (set, value) => {
      const normalized = normalizeBatchPath(value);
      if (normalized) set.push(normalized);
    };
    switch (step.tool) {
      case 'read_file':
      case 'file_info':
      case 'upload_workspace_file':
        add(reads, args.path);
        break;
      case 'write_file':
      case 'create_directory':
      case 'delete_path':
        add(writes, args.path);
        break;
      case 'move_path':
        add(writes, args.source);
        add(writes, args.destination);
        break;
      case 'init':
        add(writes, 'AGENTS.md');
        break;
      case 'apply_patch': {
        const paths = typeof args.patch === 'string'
          ? [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/gm)].map(match => match[1].trim())
          : [];
        for (const item of paths) add(writes, item);
        if (!writes.length) barrier = true;
        break;
      }
      case 'project_status':
      case 'list_dir':
      case 'directory_tree':
      case 'glob_file_search':
      case 'search':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
      case 'git_show':
      case 'git_branches':
      case 'git_changed_files':
      case 'discover_instructions':
      case 'get_agent_context':
        reads.push('*');
        break;
      case 'computer':
      case 'shell':
      case 'run_tests':
      case 'git_fetch':
      case 'git_pull':
      case 'git_push':
      case 'git_clone':
      case 'git_create_branch':
      case 'git_switch_branch':
      case 'git_commit':
      case 'refresh_environment_context':
        barrier = true;
        break;
      default:
        break;
    }
    return { reads, writes, barrier };
  }

  function batchFootprintsConflict(left, right) {
    if (left.barrier || right.barrier) return true;
    const overlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    return left.writes.some(a => right.reads.some(b => overlaps(a, b)) || right.writes.some(b => overlaps(a, b))) ||
      right.writes.some(a => left.reads.some(b => overlaps(a, b)));
  }

  function inferBatchDependencies(steps, index) {
    const current = steps[index];
    const dependencies = new Set(collectBatchRefIds(current.args));
    const currentFootprint = batchFootprint(current);
    for (let priorIndex = 0; priorIndex < index; priorIndex++) {
      const prior = steps[priorIndex];
      if (batchFootprintsConflict(batchFootprint(prior), currentFootprint)) dependencies.add(prior.id);
    }
    return [...dependencies];
  }

  function resolveBatchRefs(value, completed, depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) return value.map(item => resolveBatchRefs(item, completed, depth + 1));
    if (!isPlainObject(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      const stepId = parts.shift();
      if (!stepId || !completed.has(stepId)) throw new Error('batch reference must point to a completed earlier step: ' + value.$ref);
      let current = completed.get(stepId);
      for (const part of parts) {
        if (!part || ['__proto__','prototype','constructor'].includes(part)) throw new Error('unsafe batch reference path.');
        if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
        else if (isPlainObject(current) && Object.hasOwn(current, part)) current = current[part];
        else throw new Error('batch reference path not found: ' + value.$ref);
      }
      if (current === undefined) throw new Error('batch reference resolved to undefined: ' + value.$ref);
      return current;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = resolveBatchRefs(item, completed, depth + 1);
    return output;
  }

  function displayApprovalValue(value, maxChars = 4000) {
    const escaped = String(value == null ? '' : value)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        character => '[BIDI U+' + character.charCodeAt(0).toString(16).toUpperCase() + ']');
    if (escaped.length <= maxChars) return escaped;
    const marker = ' … [DISPLAY TRUNCATED]';
    return escaped.slice(0, Math.max(0, maxChars - marker.length)) + marker;
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
    if (tool === 'computer') {
      if (args.action === 'connect') {
        return header + resultWarning + 'Open the Colab notebook in the normal browser and establish the direct local-to-Colab connection. This does not load the model. The user may need to connect a runtime and run the notebook cell.';
      }
      if (args.action === 'enable') {
        return header + resultWarning + 'Enable screenshot understanding in Colab. If no runtime is connected, the notebook opens and requires the user to run its server cell. When connected, this may mount Google Drive, download several gigabytes of model files, and compile the runtime.';
      }
      if (args.action === 'screenshot') {
        const source = args.source === 'workspace_file' ? 'workspace image: ' + displayApprovalValue(args.path || '(missing path)', 1200) : 'current primary Windows display';
        return header + resultWarning + 'Capture and send one image for visual analysis. Source: ' + source +
          '\nThe image is sent directly to the authenticated temporary Colab HTTPS endpoint; the screenshot is not uploaded as a separate GitHub artifact. The model report returns through the shared mailbox, so it may contain details visible on your screen. Only proceed when that disclosure is acceptable.';
      }
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
      if (localTools.getToolPolicy('apply_patch', args).sensitivePath) {
        return header + resultWarning + 'This patch touches a file whose name looks sensitive. The patch will not be read or applied until you approve it.\n\nPatch preview (first 2500 characters):\n' +
          displayApprovalValue(String(args.patch || '').slice(0, 2500), 9000);
      }
      const plans = localTools.parsePatch(args.patch, root);
      return header + resultWarning + 'Review the files this patch will modify:\n' +
        plans.map(item => item.kind.toUpperCase() + '  ' + displayApprovalValue(item.relative, 500)).join('\n') +
        '\n\nPatch preview (line breaks are shown as \\\\n; first 2500 characters):\n' +
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
    if (tool === 'run_tests') return header + resultWarning + (args.command
      ? 'Run this explicit PowerShell test command. It runs with your Windows user permissions and may have side effects:\n\n' + displayApprovalValue(args.command, 4000) + '\n\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.'
      : 'Detect and run the project-native test command. Tests execute project code and may have side effects.\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.');
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
          trimmed[key] = trimmed[key].slice(0, 10000) + '\n[OUTPUT TRUNCATED before mailbox publication. This is not a safety denial; inspect status/exitCode/stderr. For listings, request smaller stable-sorted pages using Select-Object -Skip/-First.]';
        }
      }
      serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_RESULT_CHARS) return trimmed;
    }
    return {
      truncatedForMailbox: true,
      message: 'Tool output exceeded the repository return limit. This is incomplete output, not evidence of a safety block. Retry with smaller stable-sorted pages, a narrower query, or a file section.',
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
          { name: 'batch', mode: 'local-batch' },
          { name: 'get_agent_context', mode: 'read' },
          { name: 'upload_workspace_file', mode: 'approval-required' },
          { name: 'computer', mode: 'action-dependent-approval' },
          { name: 'refresh_environment_context', mode: 'repository-bridge-control' }
        );
        output.tools = output.tools.filter(item => !BLOCKED_TOOLS_FOR_MAILBOX.has(item.name)).map(item => ({
          ...item,
          description: TOOL_DESCRIPTIONS[item.name] || ('Run the ' + item.name + ' workspace tool.'),
          parameters: parameterSchema(item.name),
          ...(TOOL_RESULT_SUMMARIES[item.name] ? { returns: TOOL_RESULT_SUMMARIES[item.name] } : {}),
          permission_note: item.name === 'batch'
            ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? 'Auto-accept everything is enabled; protected steps run without per-operation approval dialogs.'
            : 'The batch call itself is not approval; protected steps show their own native Windows dialog.')
            : item.mode === 'action-dependent-approval'
              ? 'Native approval is required for connect, enable, and screenshot actions; status, disable, and wait do not prompt. Auto-accept everything may bypass those dialogs.'
              : item.mode === 'approval' || item.mode === 'approval-required' || item.mode === 'read-or-approval-for-secret-like-paths'
              ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
                ? 'Auto-accept everything is enabled; this protected call runs without a per-operation dialog.'
                : 'This call may display a native Windows approval dialog before execution.')
              : item.mode === 'automatic-workspace-write'
                ? 'Normally runs automatically for workspace-relative paths; secret-like paths still require native Windows approval.'
                : 'No approval dialog is normally required; the app still validates paths and arguments.'
        }));
        output.catalog_version = 2;
        output.tool_calling = {
          mode: 'repository-mailbox-batch',
          catalog_version: 2,
          rule: 'Submit up to 100 local steps in one request rather than one request per file. Independent lightweight file operations can run with maxConcurrency=100; default is 32. File/path conflicts and shell, tests, Git mutations, and unknown-side-effect operations are ordered automatically. For large file-output batches, fetch every part listed in result.output_artifacts concurrently, then review/process outputs together. $ref arguments wait for their source step. Inspect exitCode, timedOut, stdout, and stderr before dependent actions.',
          reference_syntax: '{"$ref":"priorStepId.result.content"}'
        };
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


  async function executeBatch(args, parentId) {
    const completed = new Map();
    const taskById = new Map();
    const outcomeById = new Map();
    const steps = args.steps;
    const concurrency = Number.isInteger(args.maxConcurrency) ? args.maxConcurrency : DEFAULT_BATCH_CONCURRENCY;
    const stopOnError = args.stopOnError !== false;
    let active = 0;
    const waiters = [];
    let firstFailureIndex = Number.POSITIVE_INFINITY;
    let stoppedAt = null;

    async function acquireSlot() {
      if (active < concurrency) { active++; return; }
      await new Promise(resolve => waiters.push(resolve));
    }
    function releaseSlot() {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
    function itemFor(step, outcome, skipped = false) {
      const item = {
        id: step.id,
        tool: step.tool,
        call_id: outcome.call_id || (String(parentId).slice(0, 55) + '-' + step.id),
        ok: outcome.ok === true,
        status: skipped ? 'skipped' : outcome.ok === true ? 'success' : outcome.cancelled ? 'cancelled' : 'failed'
      };
      if (skipped) item.skipped = true;
      if (outcome.cancelled) item.cancelled = true;
      if (outcome.error) item.error = outcome.error;
      if (outcome.message && !outcome.ok) item.message = outcome.message;
      if (outcome.result !== undefined) item.result = outcome.result;
      if (outcome.result && Number.isInteger(outcome.result.exitCode)) item.exit_code = outcome.result.exitCode;
      if (outcome.result && outcome.result.timedOut === true) item.timed_out = true;
      return item;
    }

    for (const [index, step] of steps.entries()) {
      const dependencies = inferBatchDependencies(steps, index);
      const task = (async () => {
        await Promise.all(dependencies.map(id => taskById.get(id)));
        const failedDependency = dependencies.find(id => !outcomeById.get(id) || outcomeById.get(id).ok !== true);
        if (failedDependency) {
          const skipped = { ok: false, skipped: true, error: 'Not started because dependency ' + failedDependency + ' did not succeed.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        if (stopOnError && index > firstFailureIndex) {
          const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        await acquireSlot();
        try {
          if (stopOnError && index > firstFailureIndex) {
            const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
            completed.set(step.id, skipped);
            outcomeById.set(step.id, skipped);
            return skipped;
          }
          let outcome;
          try {
            const resolvedArgs = resolveBatchRefs(step.args, completed);
            const childId = (String(parentId).slice(0, 55) || 'batch') + '-' + step.id;
            outcome = await runTool(step.tool, resolvedArgs, childId);
          } catch (error) {
            outcome = { ok: false, error: String(error && error.message || error) };
          }
          completed.set(step.id, outcome);
          outcomeById.set(step.id, outcome);
          if (!outcome.ok && stopOnError && index < firstFailureIndex) {
            firstFailureIndex = index;
            stoppedAt = step.id;
          }
          return outcome;
        } finally {
          releaseSlot();
        }
      })();
      taskById.set(step.id, task);
    }

    await Promise.all(taskById.values());
    const resultSteps = steps.map(step => {
      const outcome = outcomeById.get(step.id) || { ok: false, skipped: true, error: 'Step did not run.' };
      return itemFor(step, outcome, outcome.skipped === true);
    });
    const failed = resultSteps.some(item => !item.ok);
    const completedSteps = resultSteps.filter(item => !item.skipped).length;
    return {
      ok: !failed,
      result: {
        steps: resultSteps,
        completed_steps: completedSteps,
        skipped_steps: resultSteps.filter(item => item.skipped).length,
        requested_steps: steps.length,
        max_concurrency: concurrency,
        stopped_at: stoppedAt
      }
    };
  }


  function inferProjectCommands(project, projectCommands) {
    const entries = new Set((project && project.topLevelEntries || []).map(String));
    const scripts = projectCommands && projectCommands.scripts && typeof projectCommands.scripts === 'object' ? projectCommands.scripts : {};
    const commands = [];
    if (typeof scripts.test === 'string') commands.push({ name: 'test', command: 'npm test', source: 'package.json scripts.test' });
    if (typeof scripts.check === 'string') commands.push({ name: 'check', command: 'npm run check', source: 'package.json scripts.check' });
    if (typeof scripts.lint === 'string') commands.push({ name: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' });
    if (entries.has('pyproject.toml') || entries.has('pytest.ini') || entries.has('tests')) commands.push({ name: 'test', command: 'python -m pytest', source: 'Python project marker; verify dependencies first' });
    if (entries.has('Cargo.toml')) commands.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' });
    if (entries.has('go.mod')) commands.push({ name: 'test', command: 'go test ./...', source: 'go.mod' });
    if (entries.has('pom.xml')) commands.push({ name: 'test', command: 'mvn test', source: 'pom.xml' });
    if (entries.has('gradlew.bat')) commands.push({ name: 'test', command: '.\\gradlew.bat test', source: 'gradlew.bat' });
    else if (entries.has('build.gradle') || entries.has('build.gradle.kts')) commands.push({ name: 'test', command: 'gradle test', source: 'Gradle build file' });
    if (entries.has('global.json') || [...entries].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) commands.push({ name: 'test', command: 'dotnet test', source: '.NET project marker' });
    const seen = new Set();
    return commands.filter(item => { const key = item.command.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  async function executeAgentContext(root, requestId) {
    const [environment, project, tree, instructionReport, capabilities] = await Promise.all([
      localTools.executeTool(root, 'environment_info', {}),
      localTools.executeTool(root, 'project_status', {}),
      localTools.executeTool(root, 'directory_tree', { path: '.', maxDepth: isFilesystemRoot(root) ? 1 : 2, maxEntries: 180, format: 'paths' }),
      localTools.executeTool(root, 'discover_instructions', {}),
      executeLocalTool(root, 'get_capabilities', {}, requestId + '-catalog')
    ]);
    const found = instructionReport && Array.isArray(instructionReport.instructions) ? instructionReport.instructions : [];
    const instructionFiles = found.map(item => ({
      path: item.path,
      bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
      sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex'),
      contents_included: false
    }));
    let projectCommands = null;
    const manifestPath = path.join(root, 'package.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile() && fs.statSync(manifestPath).size <= 256 * 1024) {
      try {
        const manifestFile = await localTools.executeTool(root, 'read_file', { path: 'package.json' });
        const manifest = JSON.parse(manifestFile.content);
        projectCommands = {
          manifest: 'package.json',
          name: typeof manifest.name === 'string' ? manifest.name : null,
          packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
          engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
          scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
        };
      } catch { projectCommands = { manifest: 'package.json', parse_error: true }; }
    }
    const suggestedCommands = inferProjectCommands(project, projectCommands);
    return {
      protocol: 'chatgpt-local-agent-context/v1',
      generated_at: new Date().toISOString(),
      workspace_selected: true,
      workspace_mode: isFilesystemRoot(root) ? 'drive-root' : 'folder',
      path_style: process.platform === 'win32' ? 'Windows' : process.platform,
      workspace_path_guidance: isFilesystemRoot(root)
        ? 'The selected workspace is an entire drive. Use drive-relative paths such as Users/Example/Projects/app.js or an absolute Windows path within the selected drive. The background index lists only the root entries; inspect relevant folders on demand.'
        : 'Use workspace-relative paths or absolute Windows paths that resolve inside the selected workspace.',
      environment,
      project,
      project_commands: projectCommands,
      suggested_commands: suggestedCommands,
      execution_policy: {
        auto_accept_all: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true,
        note: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
          ? 'The user explicitly enabled app-wide auto-accept. Do not try to override or infer approval for anything outside the registered tool/policy boundary.'
          : 'Auto-accept is disabled; protected operations may require native approval.'
      },
      directory_overview: tree,
      instruction_files: instructionFiles,
      tool_catalog: {
        protocol: capabilities.protocol,
        catalog_version: 2,
        tools: capabilities.tools,
        tool_calling: capabilities.tool_calling
      },
      retrieval_rules: [
        'The connected GitHub MCP does not expose these local tools as native functions. For a Windows task, read bridge/context/latest.json and bridge/context/capabilities.json, then create bridge/requests/<unique-id>.json with protocol chatgpt-local-repo-bridge/v1, request_id, created_at, tool, and args; read bridge/results/<same-id>.json.',
        'Immediately invoke get_agent_context through that mailbox protocol before asking for machine facts. Use the published schemas exactly; do not treat a missing native function name or a server-sandbox path miss as proof that Windows access is blocked.',
        'Discover installed software, games, versions, paths, project files and configuration with targeted local tools before asking the user. Ask only for genuinely missing intent after discovery.',
        'If a matching result is absent, inspect the matching claim and worker state and re-read the same result. Do not replay an uncertain side effect or create a duplicate request.',
        'The shared snapshot is refreshed in the background by the Windows worker. Request a fresh live context when a just-made workspace change matters.',
        'Fetch full instruction contents and source files only when relevant to the current task.',
        'Use batch for up to 50 known operations to minimize GitHub request/result round trips; references may only point to earlier completed steps.',
        isFilesystemRoot(root)
          ? 'The entire drive is the workspace. The background index intentionally contains only top-level names; use list_dir, directory_tree, glob_file_search, or search with a targeted path to explore a subdirectory. Do not recursively dump the whole drive.'
          : 'Use paths relative to the selected workspace, or absolute Windows paths that remain inside it. Protected steps follow the current local approval setting.',
        'The shell runs as the signed-in Windows user and is not sandboxed.'
      ],
      development_workflow: {
        purpose: 'Use the actual Windows environment as the working environment, through its GitHub mailbox.',
        rules: [
          'First inspect the published context and exact schemas, then submit a real local-tool request using the mailbox JSON envelope. Native GitHub MCP function names and local mailbox tool names are different interfaces.',
          'Start with get_agent_context; it returns Windows/runtime facts, project discovery, instruction metadata, a bounded directory view, and the local tool catalog in one result.',
          'For unknown environment facts, run targeted discovery before asking the user: check installed application/game manifests, executable version metadata, likely install locations, frameworks and relevant project files.',
          'Batch independent read-only inspections. Use one small inspection request, one focused edit request, and one verification request rather than one request per file or command.',
          'Match every result to its request_id. Inspect status, nested ok, exitCode, timedOut, stdout/stderr and truncation. A request or claim alone is not completion.',
          'If the result is missing, inspect its claim and worker state and reread that result. Never replay an uncertain side-effecting request.',
          'Treat actual local output as authoritative; GitHub Actions and the ChatGPT server sandbox cannot establish local Windows state.',
          'Keep permission and workspace-path protections intact. When an approval or genuine failure blocks an operation, diagnose the exact result and try a supported alternative before falling back to manual instructions.',
          'For substantial tasks, define measurable acceptance criteria and a short implementation plan before editing; keep it proportional to scope.',
          'Match architecture to scope. A complex game, app, or multi-system feature should use coherent modules and clear interfaces, not a single-file shortcut unless explicitly requested.',
          'Inspect relevant entry points, manifests, existing modules and tests before choosing the design; preserve unrelated changes.',
          'Implement in small, integrated vertical slices. Batch independent inspections and verification, and represent dependencies explicitly with result references.',
          'After edits, run project-native checks and tests, build the actual target when available, and perform an end-to-end UI smoke test for user-facing software when practical. Fix failures and rerun verification.',
          'Report only verified outcomes and name important unknowns.'
        ]
      },
      detail: { directory_tree_tool: 'directory_tree', instruction_tool: 'discover_instructions', capabilities_tool: 'get_capabilities' }
    };
  }

  async function runTool(tool, inputArgs, callId = null) {
    const root = getWorkspaceRoot();
    const args = { ...(inputArgs || {}) };
    const id = callId || randomUUID();
    let result;
    try {
      validateArgs(tool, args);
      if (tool === 'batch') {
        result = await executeBatch(args, id);
      } else if (tool === 'get_agent_context') {
        result = { ok: true, result: await executeAgentContext(root, id) };
      } else {
        const isComputerTool = COMPUTER_TOOLS.has(tool);
        if (isComputerTool && !visionService) throw new Error('The computer screenshot service is unavailable in this app build.');
        if (isComputerTool && !['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'].includes(args.action)) {
          throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
        }
        if (isComputerTool && args.action === 'wait' && typeof args.request_id !== 'string') {
          throw new Error('computer(action=wait) requires the request_id returned by computer(action=screenshot).');
        }
        if (isComputerTool && args.action === 'screenshot' && args.source === 'workspace_file' && typeof args.path !== 'string') {
          throw new Error('computer(action=screenshot, source=workspace_file) requires path.');
        }
        const policy = tool === 'upload_workspace_file'
          ? { tool, requiresApproval: true, automatic: false }
          : isComputerTool
            ? { tool, requiresApproval: ['connect', 'enable', 'screenshot'].includes(args.action), automatic: false }
            : localTools.getToolPolicy(tool, args);
        if (policy.requiresApproval) {
          const approved = typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? true
            : await askApproval(tool, args, root);
          if (!approved) {
            result = { ok: false, cancelled: true, message: 'User cancelled the operation. Nothing was executed.' };
          } else {
            if (policy.sensitivePath || tool === 'read_file') args.approved = true;
            const output = isComputerTool
              ? await computerServiceCall(visionService, args, id)
              : await executeLocalTool(root, tool, args, id);
            if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
              result = {
                ok: false,
                error: isComputerTool
                  ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                  : tool + ' exited with code ' + output.exitCode + '.',
                result: output
              };
            } else {
              result = { ok: true, result: output };
            }
          }
        } else {
          const output = isComputerTool
            ? await computerServiceCall(visionService, args, id)
            : await executeLocalTool(root, tool, args, id);
          if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
            result = {
              ok: false,
              error: isComputerTool
                ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                : tool + ' exited with code ' + output.exitCode + '.',
              result: output
            };
          } else {
            result = { ok: true, result: output };
          }
        }
      }
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    return boundedResult({
      protocol: 'chatgpt-local-tool-result-v2',
      status: result.ok ? 'success' : result.cancelled ? 'cancelled' : 'failed',
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
 },
    steps: {
      type: 'array',
      description: 'Ordered local mouse/keyboard inputs, up to 50 steps. Each step has a type and its action-specific fields; the steps run in one PowerShell process.',
      minItems: 1, maxItems: 50,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey', 'mouse_down', 'mouse_up', 'key_down', 'key_up', 'wait'] },
          x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
          fromX: { type: 'number', minimum: 0 }, fromY: { type: 'number', minimum: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
          deltaX: { type: 'integer', minimum: -12000, maximum: 12000, default: 0 },
          deltaY: { type: 'integer', minimum: -12000, maximum: 12000, default: 0 },
          durationMs: { type: 'integer', minimum: 0, maximum: 5000, default: 0 },
          key: { type: 'string', maxLength: 20 },
          keys: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 20 } },
          text: { type: 'string', maxLength: 2000 }
        },
        required: ['type'], additionalProperties: false
      }
    },
    observe: { default: true },
    frameWidth: {}, frameHeight: {}
  },
  list_dir: { path: { description: 'Directory to list, relative to the selected workspace. Defaults to . (workspace root).', default: '.' } },
  directory_tree: {
    path: { description: 'Subdirectory to walk, relative to the selected workspace. Defaults to . (workspace root).', default: '.' },
    maxDepth: { default: 4 },
    maxEntries: { default: 500 }
  },
  glob_file_search: {
    pattern: { default: '**/*', description: 'Glob pattern relative to path, for example **/*.js or src/**/*.ts. Maximum 300 characters.' },
    path: { description: 'Optional starting directory relative to the workspace, or an absolute path inside it. Defaults to the workspace root.', default: '.' }
  },
  search: { path: { description: 'Optional directory to search, relative to the workspace or an absolute path inside it. Defaults to the workspace root.', default: '.' } },
  git_diff: { contextLines: { default: 3 } },
  create_directory: { recursive: { description: 'Create missing parent directories as needed. Defaults to true.', default: true } },
  delete_path: { recursive: { description: 'Set true to delete a non-empty directory tree. Defaults to false; without it, only files and empty directories can be deleted.', default: false } },
  git_log: { path: { description: 'Optional workspace-relative path to limit the history.' } },
  git_show: { ref: { default: 'HEAD' } },
  git_commit: { paths: { description: 'Optional paths to stage before committing. If omitted, only changes already staged are committed.', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
  discover_instructions: { paths: { description: 'Optional relative files/directories whose ancestor AGENTS.md files should be found. Maximum 50 paths.', items: { type: 'string' }, maxItems: 50 } },
  run_tests: { command: { description: 'Optional override PowerShell command. If omitted, detect and run the project-native test command. Requires local approval.', minLength: 1, maxLength: 20000 } },
  git_fetch: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_pull: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_push: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_clone: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  shell: { timeoutMs: { description: 'PowerShell timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  run_tests: { timeoutMs: { description: 'Test-command timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  batch: {
    steps: {
      description: '1–100 calls. Independent calls run concurrently (default limit 32; maximum 100); a {"$ref":"stepId.result.content"} value makes a step wait for that earlier step. File/path conflicts and shell/tests/Git mutations are ordered automatically. Each step follows the current local approval setting.',
      minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique step ID used by result references.', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$' },
          tool: { type: 'string', description: 'Callable local tool for this step.', enum: Object.keys(TOOL_ARGUMENT_KEYS).filter(name => name !== 'batch' && name !== 'refresh_environment_context' && !BLOCKED_TOOLS_FOR_MAILBOX.has(name)) },
          args: { type: 'object', description: 'Arguments matching the named tool schema. A value can be {"$ref":"earlierStep.result.someField"} to insert that prior result.', additionalProperties: true }
        },
        required: ['id', 'tool', 'args'],
        additionalProperties: false
      }
    }
  }
});
const TOOL_RESULT_SUMMARIES = Object.freeze({
  get_capabilities: 'Returns catalog_version, tool protocol, callable tools with schemas/permission notes/result summaries, and the batch/reference contract.',
  project_status: 'Returns isGitRepository, detectedTechnologies, topLevelEntries, and Git status when applicable.',
  environment_info: 'Returns platform, architecture, OS/runtime version, CPU and memory metadata. Identity-sensitive fields are redacted before repository publication.',
  list_dir: 'Returns the relative directory path, sorted entries (name/type/size), and a truncated flag.',
  directory_tree: 'Returns relative start path, applied maxDepth, entry count, truncation flag, and relative path/type/size entries.',
  glob_file_search: 'Returns the original glob pattern, match count, truncation flag, and relative file paths.',
  read_file: 'Returns exact full-file bytes, SHA-256 and totalLines, plus a lossless bounded page: returnedLineCount/returnedBytes, requested and returned line ranges, rangeComplete, hasMoreInRange, hasMoreInFile, reachedEof, fileComplete and nextStartLine/nextStartCharacter. Resume with the returned cursor until hasMoreInFile=false; only a single response starting at line 1 can have fileComplete=true. Each content page is at most 12 KiB.',
  search: 'Returns query, scanned-file count, match count, truncation flag, and matches with path/line/column/text.',
  write_file: 'Returns relative path, byte count, and before/after SHA-256 hashes.',
  apply_patch: 'Returns changed-file count, relative changed paths, and per-file actions.',
  git_status: 'Returns current branch/working-tree status, Git output, exit code, and stderr.',
  git_diff: 'Returns Git diff command, exitCode, stdout/stderr, and whether output was truncated.',
  shell: 'Returns PowerShell command, working directory, exitCode, timeout state, stdout/stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  run_tests: 'Returns test command result with exitCode, timeout state, stdout, stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  file_info: 'Returns relative path, file type, byte size, timestamps, permissions, and SHA-256 for regular files.',
  git_log: 'Returns Git command metadata and commits with SHA, short SHA, author, ISO date, and subject.',
  git_show: 'Returns Git command, exitCode, stdout/stderr, and output-truncation flag.',
  git_branches: 'Returns local branches with name, current-branch flag, short SHA, and upstream when configured.',
  git_changed_files: 'Returns change count, per-file index/worktree status and path, plus truncation and Git exit information.',
  discover_instructions: 'Returns applicable AGENTS.md paths and contents for the root and ancestor directories of supplied paths.',
  init: 'Returns initialized flag, AGENTS.md path, and either bytes written or reason it was left untouched.',
  create_directory: 'Returns created flag, relative path, and recursive mode.',
  move_path: 'Returns moved flag and relative source/destination paths.',
  delete_path: 'Returns deleted flag, relative path, and deleted entry type.',
  git_create_branch: 'Returns created flag and branch name.',
  git_switch_branch: 'Returns switched flag, branch name, and Git output/exit status.',
  git_commit: 'Returns committed flag and Git output/exit status, including the resulting commit hash in stdout when successful.',
  git_fetch: 'Returns exitCode, stdout/stderr and timeout status for the fetch operation.',
  git_pull: 'Returns exitCode, stdout/stderr and timeout status for the pull operation.',
  git_push: 'Returns exitCode, stdout/stderr and timeout status for the push operation.',
  git_clone: 'Returns exitCode, stdout/stderr and timeout status for the clone operation.',
  update_plan: 'Returns the current ordered plan with IDs, step text and pending/in_progress/completed status.',
  upload_workspace_file: 'Returns the repository artifact path/URL, media type, byte size, SHA-256, visibility and retrieval note.',
  computer: 'Returns actual Colab/model readiness and, when requested, a verified screenshot report or pending request ID. Pending is not completed inference.',
  refresh_environment_context: 'Returns the compact context index, including current agent_context, project-native command hints and tool catalog.',
  batch: 'Returns ordered steps with IDs, tool names, success/failed/cancelled status, errors/cancellation details, exit codes, and actual results even for failed commands.',
  get_agent_context: 'Returns a compact environment/project snapshot, project scripts, suggested native commands, instruction file paths/hashes/sizes, bounded tree and complete tool catalog.'
});
function parameterSchema(tool) {
  const names = (TOOL_ARGUMENT_KEYS[tool] || []).filter(name => name !== 'approved');
  const overrides = TOOL_PARAMETER_OVERRIDES[tool] || {};
  const properties = {};
  for (const name of names) {
    const base = BASE_FIELD_SCHEMAS[name] || { type: 'string', description: 'Argument ' + name + ' for ' + tool + '.' };
    const override = overrides[name] || {};
    properties[name] = { ...base, ...override };
    if (tool === 'git_fetch' || tool === 'git_pull' || tool === 'git_push' || tool === 'git_clone') {
      if (name === 'timeoutMs' && !override.default) properties[name] = { ...properties[name], default: 60000 };
    }
  }
  if (tool === 'batch') {
    properties.steps = { ...BASE_FIELD_SCHEMAS.steps, ...overrides.steps };
  }
  return { type: 'object', properties, required: REQUIRED_ARGUMENTS[tool] || [], additionalProperties: false };
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function computerServiceCall(service, args, requestId) {
  switch (args.action) {
    case 'status': return service.status(args);
    case 'connect': return service.connectColab();
    case 'enable': return service.activate(args, requestId);
    case 'disable': return service.deactivate(args, requestId);
    case 'screenshot': return service.analyzeScreenshot(args, requestId);
    case 'wait': return service.wait(args);
    default: throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
  }
}

function computerOutputFailed(action, output) {
  if (!output || output.status === 'error' || output.status === 'inference_failed') return true;
  if (action === 'screenshot') return !['report_available', 'inference_in_progress'].includes(output.status);
  if (action === 'wait') return ['inactive', 'needs_authentication', 'gpu_unavailable', 'disconnected'].includes(output.status);
  return false;
}

function createToolBridge(deps) {
  const { dialog, getMainWindow, getWorkspaceRoot, localTools, githubAuth, uploadWorkspaceFile, getAutoAcceptAll, visionService } = deps;
  const COMPUTER_TOOLS = new Set(['computer']);

  function validateArgs(tool, args) {
    if (BLOCKED_TOOLS_FOR_MAILBOX.has(tool)) {
      throw new Error('The repository mailbox cannot invoke the app GitHub API directly.');
    }
    const allowed = TOOL_ARGUMENT_KEYS[tool];
    if (!allowed) throw new Error('Unknown local tool: ' + tool);
    if (!isPlainObject(args)) throw new Error('Tool args must be a JSON object.');
    const extra = Object.keys(args).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error('Unsupported argument field(s) for ' + tool + ': ' + extra.join(', '));
    if (tool === 'batch') validateBatchArgs(args);
  }

  function validateBatchArgs(args) {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > MAX_BATCH_STEPS) {
      throw new Error('batch.steps must contain between 1 and ' + MAX_BATCH_STEPS + ' tool steps.');
    }
    if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
      throw new Error('batch.stopOnError must be a boolean.');
    }
    if (args.maxConcurrency !== undefined && (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1 || args.maxConcurrency > MAX_BATCH_CONCURRENCY)) {
      throw new Error('batch.maxConcurrency must be an integer from 1 to ' + MAX_BATCH_CONCURRENCY + '.');
    }
    const ids = new Set();
    for (const [index, step] of args.steps.entries()) {
      if (!isPlainObject(step)) throw new Error('batch step ' + (index + 1) + ' must be an object.');
      if (Object.keys(step).some(key => !['id','tool','args'].includes(key))) throw new Error('batch step contains unsupported fields.');
      if (typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(step.id)) throw new Error('batch step IDs must be 1–20 simple characters.');
      if (ids.has(step.id)) throw new Error('duplicate batch step ID: ' + step.id);
      if (typeof step.tool !== 'string' || step.tool === 'batch' || step.tool === 'refresh_environment_context' || BLOCKED_TOOLS_FOR_MAILBOX.has(step.tool)) {
        throw new Error('batch step ' + step.id + ' uses an unsupported or non-nestable tool.');
      }
      if (!isPlainObject(step.args)) throw new Error('batch step ' + step.id + ' args must be an object.');
      if (Object.hasOwn(step.args, 'approved')) throw new Error('batch steps cannot bypass local approval with an approved argument.');
      validateArgs(step.tool, step.args);
      for (const referencedId of collectBatchRefIds(step.args)) {
        if (!ids.has(referencedId)) throw new Error('batch reference must point to an earlier step: ' + referencedId);
      }
      ids.add(step.id);
    }
  }

  function collectBatchRefIds(value, refs = new Set(), depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) { for (const item of value) collectBatchRefIds(item, refs, depth + 1); return refs; }
    if (!isPlainObject(value)) return refs;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      if (!parts[0] || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('unsafe batch reference path.');
      refs.add(parts[0]);
      return refs;
    }
    for (const item of Object.values(value)) collectBatchRefIds(item, refs, depth + 1);
    return refs;
  }

  function normalizeBatchPath(value) {
    return String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  }

  function batchFootprint(step) {
    const args = step.args || {};
    const reads = [];
    const writes = [];
    let barrier = false;
    const add = (set, value) => {
      const normalized = normalizeBatchPath(value);
      if (normalized) set.push(normalized);
    };
    switch (step.tool) {
      case 'read_file':
      case 'file_info':
      case 'upload_workspace_file':
        add(reads, args.path);
        break;
      case 'write_file':
      case 'create_directory':
      case 'delete_path':
        add(writes, args.path);
        break;
      case 'move_path':
        add(writes, args.source);
        add(writes, args.destination);
        break;
      case 'init':
        add(writes, 'AGENTS.md');
        break;
      case 'apply_patch': {
        const paths = typeof args.patch === 'string'
          ? [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/gm)].map(match => match[1].trim())
          : [];
        for (const item of paths) add(writes, item);
        if (!writes.length) barrier = true;
        break;
      }
      case 'project_status':
      case 'list_dir':
      case 'directory_tree':
      case 'glob_file_search':
      case 'search':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
      case 'git_show':
      case 'git_branches':
      case 'git_changed_files':
      case 'discover_instructions':
      case 'get_agent_context':
        reads.push('*');
        break;
      case 'computer':
      case 'shell':
      case 'run_tests':
      case 'git_fetch':
      case 'git_pull':
      case 'git_push':
      case 'git_clone':
      case 'git_create_branch':
      case 'git_switch_branch':
      case 'git_commit':
      case 'refresh_environment_context':
        barrier = true;
        break;
      default:
        break;
    }
    return { reads, writes, barrier };
  }

  function batchFootprintsConflict(left, right) {
    if (left.barrier || right.barrier) return true;
    const overlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    return left.writes.some(a => right.reads.some(b => overlaps(a, b)) || right.writes.some(b => overlaps(a, b))) ||
      right.writes.some(a => left.reads.some(b => overlaps(a, b)));
  }

  function inferBatchDependencies(steps, index) {
    const current = steps[index];
    const dependencies = new Set(collectBatchRefIds(current.args));
    const currentFootprint = batchFootprint(current);
    for (let priorIndex = 0; priorIndex < index; priorIndex++) {
      const prior = steps[priorIndex];
      if (batchFootprintsConflict(batchFootprint(prior), currentFootprint)) dependencies.add(prior.id);
    }
    return [...dependencies];
  }

  function resolveBatchRefs(value, completed, depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) return value.map(item => resolveBatchRefs(item, completed, depth + 1));
    if (!isPlainObject(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      const stepId = parts.shift();
      if (!stepId || !completed.has(stepId)) throw new Error('batch reference must point to a completed earlier step: ' + value.$ref);
      let current = completed.get(stepId);
      for (const part of parts) {
        if (!part || ['__proto__','prototype','constructor'].includes(part)) throw new Error('unsafe batch reference path.');
        if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
        else if (isPlainObject(current) && Object.hasOwn(current, part)) current = current[part];
        else throw new Error('batch reference path not found: ' + value.$ref);
      }
      if (current === undefined) throw new Error('batch reference resolved to undefined: ' + value.$ref);
      return current;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = resolveBatchRefs(item, completed, depth + 1);
    return output;
  }

  function displayApprovalValue(value, maxChars = 4000) {
    const escaped = String(value == null ? '' : value)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        character => '[BIDI U+' + character.charCodeAt(0).toString(16).toUpperCase() + ']');
    if (escaped.length <= maxChars) return escaped;
    const marker = ' … [DISPLAY TRUNCATED]';
    return escaped.slice(0, Math.max(0, maxChars - marker.length)) + marker;
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
    if (tool === 'computer') {
      if (args.action === 'connect') {
        return header + resultWarning + 'Open the Colab notebook in the normal browser and establish the direct local-to-Colab connection. This does not load the model. The user may need to connect a runtime and run the notebook cell.';
      }
      if (args.action === 'enable') {
        return header + resultWarning + 'Enable screenshot understanding in Colab. If no runtime is connected, the notebook opens and requires the user to run its server cell. When connected, this may mount Google Drive, download several gigabytes of model files, and compile the runtime.';
      }
      if (args.action === 'screenshot') {
        const source = args.source === 'workspace_file' ? 'workspace image: ' + displayApprovalValue(args.path || '(missing path)', 1200) : 'current primary Windows display';
        return header + resultWarning + 'Capture and send one image for visual analysis. Source: ' + source +
          '\nThe image is sent directly to the authenticated temporary Colab HTTPS endpoint; the screenshot is not uploaded as a separate GitHub artifact. The model report returns through the shared mailbox, so it may contain details visible on your screen. Only proceed when that disclosure is acceptable.';
      }
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
      if (localTools.getToolPolicy('apply_patch', args).sensitivePath) {
        return header + resultWarning + 'This patch touches a file whose name looks sensitive. The patch will not be read or applied until you approve it.\n\nPatch preview (first 2500 characters):\n' +
          displayApprovalValue(String(args.patch || '').slice(0, 2500), 9000);
      }
      const plans = localTools.parsePatch(args.patch, root);
      return header + resultWarning + 'Review the files this patch will modify:\n' +
        plans.map(item => item.kind.toUpperCase() + '  ' + displayApprovalValue(item.relative, 500)).join('\n') +
        '\n\nPatch preview (line breaks are shown as \\\\n; first 2500 characters):\n' +
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
    if (tool === 'run_tests') return header + resultWarning + (args.command
      ? 'Run this explicit PowerShell test command. It runs with your Windows user permissions and may have side effects:\n\n' + displayApprovalValue(args.command, 4000) + '\n\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.'
      : 'Detect and run the project-native test command. Tests execute project code and may have side effects.\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.');
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
          trimmed[key] = trimmed[key].slice(0, 10000) + '\n[OUTPUT TRUNCATED before mailbox publication. This is not a safety denial; inspect status/exitCode/stderr. For listings, request smaller stable-sorted pages using Select-Object -Skip/-First.]';
        }
      }
      serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_RESULT_CHARS) return trimmed;
    }
    return {
      truncatedForMailbox: true,
      message: 'Tool output exceeded the repository return limit. This is incomplete output, not evidence of a safety block. Retry with smaller stable-sorted pages, a narrower query, or a file section.',
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
          { name: 'batch', mode: 'local-batch' },
          { name: 'get_agent_context', mode: 'read' },
          { name: 'upload_workspace_file', mode: 'approval-required' },
          { name: 'computer', mode: 'action-dependent-approval' },
          { name: 'refresh_environment_context', mode: 'repository-bridge-control' }
        );
        output.tools = output.tools.filter(item => !BLOCKED_TOOLS_FOR_MAILBOX.has(item.name)).map(item => ({
          ...item,
          description: TOOL_DESCRIPTIONS[item.name] || ('Run the ' + item.name + ' workspace tool.'),
          parameters: parameterSchema(item.name),
          ...(TOOL_RESULT_SUMMARIES[item.name] ? { returns: TOOL_RESULT_SUMMARIES[item.name] } : {}),
          permission_note: item.name === 'batch'
            ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? 'Auto-accept everything is enabled; protected steps run without per-operation approval dialogs.'
            : 'The batch call itself is not approval; protected steps show their own native Windows dialog.')
            : item.mode === 'action-dependent-approval'
              ? 'Native approval is required for connect, enable, and screenshot actions; status, disable, and wait do not prompt. Auto-accept everything may bypass those dialogs.'
              : item.mode === 'approval' || item.mode === 'approval-required' || item.mode === 'read-or-approval-for-secret-like-paths'
              ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
                ? 'Auto-accept everything is enabled; this protected call runs without a per-operation dialog.'
                : 'This call may display a native Windows approval dialog before execution.')
              : item.mode === 'automatic-workspace-write'
                ? 'Normally runs automatically for workspace-relative paths; secret-like paths still require native Windows approval.'
                : 'No approval dialog is normally required; the app still validates paths and arguments.'
        }));
        output.catalog_version = 2;
        output.tool_calling = {
          mode: 'repository-mailbox-batch',
          catalog_version: 2,
          rule: 'Submit up to 100 local steps in one request rather than one request per file. Independent lightweight file operations can run with maxConcurrency=100; default is 32. File/path conflicts and shell, tests, Git mutations, and unknown-side-effect operations are ordered automatically. For large file-output batches, fetch every part listed in result.output_artifacts concurrently, then review/process outputs together. $ref arguments wait for their source step. Inspect exitCode, timedOut, stdout, and stderr before dependent actions.',
          reference_syntax: '{"$ref":"priorStepId.result.content"}'
        };
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


  async function executeBatch(args, parentId) {
    const completed = new Map();
    const taskById = new Map();
    const outcomeById = new Map();
    const steps = args.steps;
    const concurrency = Number.isInteger(args.maxConcurrency) ? args.maxConcurrency : DEFAULT_BATCH_CONCURRENCY;
    const stopOnError = args.stopOnError !== false;
    let active = 0;
    const waiters = [];
    let firstFailureIndex = Number.POSITIVE_INFINITY;
    let stoppedAt = null;

    async function acquireSlot() {
      if (active < concurrency) { active++; return; }
      await new Promise(resolve => waiters.push(resolve));
    }
    function releaseSlot() {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
    function itemFor(step, outcome, skipped = false) {
      const item = {
        id: step.id,
        tool: step.tool,
        call_id: outcome.call_id || (String(parentId).slice(0, 55) + '-' + step.id),
        ok: outcome.ok === true,
        status: skipped ? 'skipped' : outcome.ok === true ? 'success' : outcome.cancelled ? 'cancelled' : 'failed'
      };
      if (skipped) item.skipped = true;
      if (outcome.cancelled) item.cancelled = true;
      if (outcome.error) item.error = outcome.error;
      if (outcome.message && !outcome.ok) item.message = outcome.message;
      if (outcome.result !== undefined) item.result = outcome.result;
      if (outcome.result && Number.isInteger(outcome.result.exitCode)) item.exit_code = outcome.result.exitCode;
      if (outcome.result && outcome.result.timedOut === true) item.timed_out = true;
      return item;
    }

    for (const [index, step] of steps.entries()) {
      const dependencies = inferBatchDependencies(steps, index);
      const task = (async () => {
        await Promise.all(dependencies.map(id => taskById.get(id)));
        const failedDependency = dependencies.find(id => !outcomeById.get(id) || outcomeById.get(id).ok !== true);
        if (failedDependency) {
          const skipped = { ok: false, skipped: true, error: 'Not started because dependency ' + failedDependency + ' did not succeed.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        if (stopOnError && index > firstFailureIndex) {
          const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        await acquireSlot();
        try {
          if (stopOnError && index > firstFailureIndex) {
            const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
            completed.set(step.id, skipped);
            outcomeById.set(step.id, skipped);
            return skipped;
          }
          let outcome;
          try {
            const resolvedArgs = resolveBatchRefs(step.args, completed);
            const childId = (String(parentId).slice(0, 55) || 'batch') + '-' + step.id;
            outcome = await runTool(step.tool, resolvedArgs, childId);
          } catch (error) {
            outcome = { ok: false, error: String(error && error.message || error) };
          }
          completed.set(step.id, outcome);
          outcomeById.set(step.id, outcome);
          if (!outcome.ok && stopOnError && index < firstFailureIndex) {
            firstFailureIndex = index;
            stoppedAt = step.id;
          }
          return outcome;
        } finally {
          releaseSlot();
        }
      })();
      taskById.set(step.id, task);
    }

    await Promise.all(taskById.values());
    const resultSteps = steps.map(step => {
      const outcome = outcomeById.get(step.id) || { ok: false, skipped: true, error: 'Step did not run.' };
      return itemFor(step, outcome, outcome.skipped === true);
    });
    const failed = resultSteps.some(item => !item.ok);
    const completedSteps = resultSteps.filter(item => !item.skipped).length;
    return {
      ok: !failed,
      result: {
        steps: resultSteps,
        completed_steps: completedSteps,
        skipped_steps: resultSteps.filter(item => item.skipped).length,
        requested_steps: steps.length,
        max_concurrency: concurrency,
        stopped_at: stoppedAt
      }
    };
  }


  function inferProjectCommands(project, projectCommands) {
    const entries = new Set((project && project.topLevelEntries || []).map(String));
    const scripts = projectCommands && projectCommands.scripts && typeof projectCommands.scripts === 'object' ? projectCommands.scripts : {};
    const commands = [];
    if (typeof scripts.test === 'string') commands.push({ name: 'test', command: 'npm test', source: 'package.json scripts.test' });
    if (typeof scripts.check === 'string') commands.push({ name: 'check', command: 'npm run check', source: 'package.json scripts.check' });
    if (typeof scripts.lint === 'string') commands.push({ name: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' });
    if (entries.has('pyproject.toml') || entries.has('pytest.ini') || entries.has('tests')) commands.push({ name: 'test', command: 'python -m pytest', source: 'Python project marker; verify dependencies first' });
    if (entries.has('Cargo.toml')) commands.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' });
    if (entries.has('go.mod')) commands.push({ name: 'test', command: 'go test ./...', source: 'go.mod' });
    if (entries.has('pom.xml')) commands.push({ name: 'test', command: 'mvn test', source: 'pom.xml' });
    if (entries.has('gradlew.bat')) commands.push({ name: 'test', command: '.\\gradlew.bat test', source: 'gradlew.bat' });
    else if (entries.has('build.gradle') || entries.has('build.gradle.kts')) commands.push({ name: 'test', command: 'gradle test', source: 'Gradle build file' });
    if (entries.has('global.json') || [...entries].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) commands.push({ name: 'test', command: 'dotnet test', source: '.NET project marker' });
    const seen = new Set();
    return commands.filter(item => { const key = item.command.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  async function executeAgentContext(root, requestId) {
    const [environment, project, tree, instructionReport, capabilities] = await Promise.all([
      localTools.executeTool(root, 'environment_info', {}),
      localTools.executeTool(root, 'project_status', {}),
      localTools.executeTool(root, 'directory_tree', { path: '.', maxDepth: isFilesystemRoot(root) ? 1 : 2, maxEntries: 180, format: 'paths' }),
      localTools.executeTool(root, 'discover_instructions', {}),
      executeLocalTool(root, 'get_capabilities', {}, requestId + '-catalog')
    ]);
    const found = instructionReport && Array.isArray(instructionReport.instructions) ? instructionReport.instructions : [];
    const instructionFiles = found.map(item => ({
      path: item.path,
      bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
      sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex'),
      contents_included: false
    }));
    let projectCommands = null;
    const manifestPath = path.join(root, 'package.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile() && fs.statSync(manifestPath).size <= 256 * 1024) {
      try {
        const manifestFile = await localTools.executeTool(root, 'read_file', { path: 'package.json' });
        const manifest = JSON.parse(manifestFile.content);
        projectCommands = {
          manifest: 'package.json',
          name: typeof manifest.name === 'string' ? manifest.name : null,
          packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
          engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
          scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
        };
      } catch { projectCommands = { manifest: 'package.json', parse_error: true }; }
    }
    const suggestedCommands = inferProjectCommands(project, projectCommands);
    return {
      protocol: 'chatgpt-local-agent-context/v1',
      generated_at: new Date().toISOString(),
      workspace_selected: true,
      workspace_mode: isFilesystemRoot(root) ? 'drive-root' : 'folder',
      path_style: process.platform === 'win32' ? 'Windows' : process.platform,
      workspace_path_guidance: isFilesystemRoot(root)
        ? 'The selected workspace is an entire drive. Use drive-relative paths such as Users/Example/Projects/app.js or an absolute Windows path within the selected drive. The background index lists only the root entries; inspect relevant folders on demand.'
        : 'Use workspace-relative paths or absolute Windows paths that resolve inside the selected workspace.',
      environment,
      project,
      project_commands: projectCommands,
      suggested_commands: suggestedCommands,
      execution_policy: {
        auto_accept_all: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true,
        note: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
          ? 'The user explicitly enabled app-wide auto-accept. Do not try to override or infer approval for anything outside the registered tool/policy boundary.'
          : 'Auto-accept is disabled; protected operations may require native approval.'
      },
      directory_overview: tree,
      instruction_files: instructionFiles,
      tool_catalog: {
        protocol: capabilities.protocol,
        catalog_version: 2,
        tools: capabilities.tools,
        tool_calling: capabilities.tool_calling
      },
      retrieval_rules: [
        'The connected GitHub MCP does not expose these local tools as native functions. For a Windows task, read bridge/context/latest.json and bridge/context/capabilities.json, then create bridge/requests/<unique-id>.json with protocol chatgpt-local-repo-bridge/v1, request_id, created_at, tool, and args; read bridge/results/<same-id>.json.',
        'Immediately invoke get_agent_context through that mailbox protocol before asking for machine facts. Use the published schemas exactly; do not treat a missing native function name or a server-sandbox path miss as proof that Windows access is blocked.',
        'Discover installed software, games, versions, paths, project files and configuration with targeted local tools before asking the user. Ask only for genuinely missing intent after discovery.',
        'If a matching result is absent, inspect the matching claim and worker state and re-read the same result. Do not replay an uncertain side effect or create a duplicate request.',
        'The shared snapshot is refreshed in the background by the Windows worker. Request a fresh live context when a just-made workspace change matters.',
        'Fetch full instruction contents and source files only when relevant to the current task.',
        'Use batch for up to 50 known operations to minimize GitHub request/result round trips; references may only point to earlier completed steps.',
        isFilesystemRoot(root)
          ? 'The entire drive is the workspace. The background index intentionally contains only top-level names; use list_dir, directory_tree, glob_file_search, or search with a targeted path to explore a subdirectory. Do not recursively dump the whole drive.'
          : 'Use paths relative to the selected workspace, or absolute Windows paths that remain inside it. Protected steps follow the current local approval setting.',
        'The shell runs as the signed-in Windows user and is not sandboxed.'
      ],
      development_workflow: {
        purpose: 'Use the actual Windows environment as the working environment, through its GitHub mailbox.',
        rules: [
          'First inspect the published context and exact schemas, then submit a real local-tool request using the mailbox JSON envelope. Native GitHub MCP function names and local mailbox tool names are different interfaces.',
          'Start with get_agent_context; it returns Windows/runtime facts, project discovery, instruction metadata, a bounded directory view, and the local tool catalog in one result.',
          'For unknown environment facts, run targeted discovery before asking the user: check installed application/game manifests, executable version metadata, likely install locations, frameworks and relevant project files.',
          'Batch independent read-only inspections. Use one small inspection request, one focused edit request, and one verification request rather than one request per file or command.',
          'Match every result to its request_id. Inspect status, nested ok, exitCode, timedOut, stdout/stderr and truncation. A request or claim alone is not completion.',
          'If the result is missing, inspect its claim and worker state and reread that result. Never replay an uncertain side-effecting request.',
          'Treat actual local output as authoritative; GitHub Actions and the ChatGPT server sandbox cannot establish local Windows state.',
          'Keep permission and workspace-path protections intact. When an approval or genuine failure blocks an operation, diagnose the exact result and try a supported alternative before falling back to manual instructions.',
          'For substantial tasks, define measurable acceptance criteria and a short implementation plan before editing; keep it proportional to scope.',
          'Match architecture to scope. A complex game, app, or multi-system feature should use coherent modules and clear interfaces, not a single-file shortcut unless explicitly requested.',
          'Inspect relevant entry points, manifests, existing modules and tests before choosing the design; preserve unrelated changes.',
          'Implement in small, integrated vertical slices. Batch independent inspections and verification, and represent dependencies explicitly with result references.',
          'After edits, run project-native checks and tests, build the actual target when available, and perform an end-to-end UI smoke test for user-facing software when practical. Fix failures and rerun verification.',
          'Report only verified outcomes and name important unknowns.'
        ]
      },
      detail: { directory_tree_tool: 'directory_tree', instruction_tool: 'discover_instructions', capabilities_tool: 'get_capabilities' }
    };
  }

  async function runTool(tool, inputArgs, callId = null) {
    const root = getWorkspaceRoot();
    const args = { ...(inputArgs || {}) };
    const id = callId || randomUUID();
    let result;
    try {
      validateArgs(tool, args);
      if (tool === 'batch') {
        result = await executeBatch(args, id);
      } else if (tool === 'get_agent_context') {
        result = { ok: true, result: await executeAgentContext(root, id) };
      } else {
        const isComputerTool = COMPUTER_TOOLS.has(tool);
        if (isComputerTool && !visionService) throw new Error('The computer screenshot service is unavailable in this app build.');
        if (isComputerTool && !['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'].includes(args.action)) {
          throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
        }
        if (isComputerTool && args.action === 'wait' && typeof args.request_id !== 'string') {
          throw new Error('computer(action=wait) requires the request_id returned by computer(action=screenshot).');
        }
        if (isComputerTool && args.action === 'screenshot' && args.source === 'workspace_file' && typeof args.path !== 'string') {
          throw new Error('computer(action=screenshot, source=workspace_file) requires path.');
        }
        const policy = tool === 'upload_workspace_file'
          ? { tool, requiresApproval: true, automatic: false }
          : isComputerTool
            ? { tool, requiresApproval: ['connect', 'enable', 'screenshot'].includes(args.action), automatic: false }
            : localTools.getToolPolicy(tool, args);
        if (policy.requiresApproval) {
          const approved = typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? true
            : await askApproval(tool, args, root);
          if (!approved) {
            result = { ok: false, cancelled: true, message: 'User cancelled the operation. Nothing was executed.' };
          } else {
            if (policy.sensitivePath || tool === 'read_file') args.approved = true;
            const output = isComputerTool
              ? await computerServiceCall(visionService, args, id)
              : await executeLocalTool(root, tool, args, id);
            if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
              result = {
                ok: false,
                error: isComputerTool
                  ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                  : tool + ' exited with code ' + output.exitCode + '.',
                result: output
              };
            } else {
              result = { ok: true, result: output };
            }
          }
        } else {
          const output = isComputerTool
            ? await computerServiceCall(visionService, args, id)
            : await executeLocalTool(root, tool, args, id);
          if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
            result = {
              ok: false,
              error: isComputerTool
                ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                : tool + ' exited with code ' + output.exitCode + '.',
              result: output
            };
          } else {
            result = { ok: true, result: output };
          }
        }
      }
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    return boundedResult({
      protocol: 'chatgpt-local-tool-result-v2',
      status: result.ok ? 'success' : result.cancelled ? 'cancelled' : 'failed',
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
 },
  x: { type: 'number', description: 'Horizontal coordinate in pixels measured against the latest desktop screenshot, origin top-left.', minimum: 0 },
  y: { type: 'number', description: 'Vertical coordinate in pixels measured against the latest desktop screenshot, origin top-left.', minimum: 0 },
  fromX: { type: 'number', description: 'Starting horizontal pixel coordinate for drag or interpolated movement.', minimum: 0 },
  fromY: { type: 'number', description: 'Starting vertical pixel coordinate for drag or interpolated movement.', minimum: 0 },
  button: { type: 'string', description: 'Mouse button: left, right, or middle.', enum: ['left', 'right', 'middle'], default: 'left' },
  clicks: { type: 'integer', description: 'Number of clicks from 1–3.', minimum: 1, maximum: 3, default: 1 },
  deltaX: { type: 'integer', description: 'Horizontal wheel delta; one typical notch is 120 or -120.', minimum: -12000, maximum: 12000, default: 0 },
  deltaY: { type: 'integer', description: 'Vertical wheel delta; one typical notch is 120 or -120.', minimum: -12000, maximum: 12000, default: 0 },
  durationMs: { type: 'integer', description: 'Smooth move/drag or wait duration, max 5000 ms (move/drag max 3000).', minimum: 0, maximum: 5000, default: 0 },
  key: { type: 'string', description: 'A key name such as W, ENTER, ESC, CTRL, SPACE, LEFT, or F1.', maxLength: 20 },
  keys: { type: 'array', description: 'Keys for a hotkey combination.', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 20 } },
  text: { type: 'string', description: 'Text to type via Unicode input (up to 2,000 characters).', maxLength: 2000 },
  observe: { type: 'boolean', description: 'For sequence, capture/analyze a fresh screenshot after actions. Defaults to true.', default: true },
  frameWidth: { type: 'integer', description: 'Optional coordinate frame width.', minimum: 1, maximum: 20000 },
  frameHeight: { type: 'integer', description: 'Optional coordinate frame height.', minimum: 1, maximum: 20000 },
  command: { type: 'string', description: 'PowerShell command to execute from the workspace. Arbitrary commands run with the signed-in user permissions and require local approval.', minLength: 1, maxLength: 20000 },
  maxDepth: { type: 'integer', description: 'Maximum directory depth (1–12). Defaults to 4.', minimum: 1, maximum: 12, default: 4 },
  maxEntries: { type: 'integer', description: 'Maximum tree entries (1–2,000). Defaults to 500.', minimum: 1, maximum: 2000, default: 500 },
  format: { type: 'string', description: 'Use paths for a compact path-only listing, or entries for structured file records.', enum: ['entries', 'paths'], default: 'entries' },
  startLine: { type: 'integer', description: 'First 1-based line to return. For a complete read, continue at the prior result nextStartLine.', minimum: 1 },
  startCharacter: { type: 'integer', description: 'Unicode code-point offset within startLine; resume a long line at the prior result nextStartCharacter. Defaults to 0.', minimum: 0 }, 
  endLine: { type: 'integer', description: 'Last line to return, 1-based and inclusive. At most 5,000 lines can be read in one call.' , minimum: 1 },
  maxResults: { type: 'integer', description: 'Maximum matching lines to return (1–150). Defaults to 100.', minimum: 1, maximum: 150, default: 100 },
  contextLines: { type: 'integer', description: 'Number of diff context lines (0–20).', minimum: 0, maximum: 20, default: 3 },
  maxCount: { type: 'integer', description: 'Maximum Git log entries (1–100). Defaults to 20.', minimum: 1, maximum: 100, default: 20 },
  timeoutMs: { type: 'integer', description: 'Operation timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 },
  recursive: { type: 'boolean', description: 'Recursively create a directory and its parents. Defaults to true.', default: true },
  staged: { type: 'boolean', description: 'When true, show the staged diff instead of the unstaged diff.', default: false },
  regex: { type: 'boolean', description: 'Interpret query as a regular expression. Defaults to false.', default: false },
  caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to false.', default: false },
  stopOnError: { type: 'boolean', description: 'Stop launching queued batch steps after a failure; already-running independent steps may finish. Defaults to true.', default: true },
  maxConcurrency: { type: 'integer', description: 'Maximum independent steps to execute at once (1–100). Defaults to 32. Use 100 for large, lightweight, independent file operations; conflicting paths and shell, tests, and Git mutations are automatically ordered.', minimum: 1, maximum: 100, default: 32 },
  paths: { type: 'array', description: 'Optional list of workspace-relative paths. When set, limits the operation to those paths.', items: { type: 'string' }, maxItems: 100 },
  items: { type: 'array', description: 'Plan steps as strings or objects containing step and optional status.', maxItems: 30, items: { anyOf: [
    { type: 'string', maxLength: 1000 },
    { type: 'object', properties: { step: { type: 'string', maxLength: 1000 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['step'], additionalProperties: false }
  ] } },
  steps: { type: 'array', description: 'Ordered local tool calls (up to 100). Each step needs a unique id, a tool name, and args. References may only point to completed earlier steps.', minItems: 1, maxItems: 100 },
});
const TOOL_PARAMETER_OVERRIDES = Object.freeze({
  computer: {
    action: { enum: ['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'] },
    source: { enum: ['desktop', 'workspace_file'], default: 'desktop' },
    path: { description: 'Optional image path within the workspace; required when action=screenshot and source=workspace_file.' },
    waitMs: { default: 5000 },
    request_id: { description: 'Existing screenshot request ID returned by computer(action=screenshot). Format: computer- followed by 24 lowercase hexadecimal characters.', pattern: '^computer-[a-f0-9]{24}$' }
  },
  list_dir: { path: { description: 'Directory to list, relative to the selected workspace. Defaults to . (workspace root).', default: '.' } },
  directory_tree: {
    path: { description: 'Subdirectory to walk, relative to the selected workspace. Defaults to . (workspace root).', default: '.' },
    maxDepth: { default: 4 },
    maxEntries: { default: 500 }
  },
  glob_file_search: {
    pattern: { default: '**/*', description: 'Glob pattern relative to path, for example **/*.js or src/**/*.ts. Maximum 300 characters.' },
    path: { description: 'Optional starting directory relative to the workspace, or an absolute path inside it. Defaults to the workspace root.', default: '.' }
  },
  search: { path: { description: 'Optional directory to search, relative to the workspace or an absolute path inside it. Defaults to the workspace root.', default: '.' } },
  git_diff: { contextLines: { default: 3 } },
  create_directory: { recursive: { description: 'Create missing parent directories as needed. Defaults to true.', default: true } },
  delete_path: { recursive: { description: 'Set true to delete a non-empty directory tree. Defaults to false; without it, only files and empty directories can be deleted.', default: false } },
  git_log: { path: { description: 'Optional workspace-relative path to limit the history.' } },
  git_show: { ref: { default: 'HEAD' } },
  git_commit: { paths: { description: 'Optional paths to stage before committing. If omitted, only changes already staged are committed.', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
  discover_instructions: { paths: { description: 'Optional relative files/directories whose ancestor AGENTS.md files should be found. Maximum 50 paths.', items: { type: 'string' }, maxItems: 50 } },
  run_tests: { command: { description: 'Optional override PowerShell command. If omitted, detect and run the project-native test command. Requires local approval.', minLength: 1, maxLength: 20000 } },
  git_fetch: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_pull: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_push: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  git_clone: { timeoutMs: { description: 'Operation timeout in milliseconds (1,000–180,000). Defaults to 120,000.', minimum: 1000, maximum: 180000, default: 120000 } },
  shell: { timeoutMs: { description: 'PowerShell timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  run_tests: { timeoutMs: { description: 'Test-command timeout in milliseconds (1,000–120,000). Defaults to 60,000.', minimum: 1000, maximum: 120000, default: 60000 } },
  batch: {
    steps: {
      description: '1–100 calls. Independent calls run concurrently (default limit 32; maximum 100); a {"$ref":"stepId.result.content"} value makes a step wait for that earlier step. File/path conflicts and shell/tests/Git mutations are ordered automatically. Each step follows the current local approval setting.',
      minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique step ID used by result references.', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$' },
          tool: { type: 'string', description: 'Callable local tool for this step.', enum: Object.keys(TOOL_ARGUMENT_KEYS).filter(name => name !== 'batch' && name !== 'refresh_environment_context' && !BLOCKED_TOOLS_FOR_MAILBOX.has(name)) },
          args: { type: 'object', description: 'Arguments matching the named tool schema. A value can be {"$ref":"earlierStep.result.someField"} to insert that prior result.', additionalProperties: true }
        },
        required: ['id', 'tool', 'args'],
        additionalProperties: false
      }
    }
  }
});
const TOOL_RESULT_SUMMARIES = Object.freeze({
  get_capabilities: 'Returns catalog_version, tool protocol, callable tools with schemas/permission notes/result summaries, and the batch/reference contract.',
  project_status: 'Returns isGitRepository, detectedTechnologies, topLevelEntries, and Git status when applicable.',
  environment_info: 'Returns platform, architecture, OS/runtime version, CPU and memory metadata. Identity-sensitive fields are redacted before repository publication.',
  list_dir: 'Returns the relative directory path, sorted entries (name/type/size), and a truncated flag.',
  directory_tree: 'Returns relative start path, applied maxDepth, entry count, truncation flag, and relative path/type/size entries.',
  glob_file_search: 'Returns the original glob pattern, match count, truncation flag, and relative file paths.',
  read_file: 'Returns exact full-file bytes, SHA-256 and totalLines, plus a lossless bounded page: returnedLineCount/returnedBytes, requested and returned line ranges, rangeComplete, hasMoreInRange, hasMoreInFile, reachedEof, fileComplete and nextStartLine/nextStartCharacter. Resume with the returned cursor until hasMoreInFile=false; only a single response starting at line 1 can have fileComplete=true. Each content page is at most 12 KiB.',
  search: 'Returns query, scanned-file count, match count, truncation flag, and matches with path/line/column/text.',
  write_file: 'Returns relative path, byte count, and before/after SHA-256 hashes.',
  apply_patch: 'Returns changed-file count, relative changed paths, and per-file actions.',
  git_status: 'Returns current branch/working-tree status, Git output, exit code, and stderr.',
  git_diff: 'Returns Git diff command, exitCode, stdout/stderr, and whether output was truncated.',
  shell: 'Returns PowerShell command, working directory, exitCode, timeout state, stdout/stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  run_tests: 'Returns test command result with exitCode, timeout state, stdout, stderr, timeoutMs, and explicit stdout_truncated/stderr_truncated flags when output exceeds the capture limit.',
  file_info: 'Returns relative path, file type, byte size, timestamps, permissions, and SHA-256 for regular files.',
  git_log: 'Returns Git command metadata and commits with SHA, short SHA, author, ISO date, and subject.',
  git_show: 'Returns Git command, exitCode, stdout/stderr, and output-truncation flag.',
  git_branches: 'Returns local branches with name, current-branch flag, short SHA, and upstream when configured.',
  git_changed_files: 'Returns change count, per-file index/worktree status and path, plus truncation and Git exit information.',
  discover_instructions: 'Returns applicable AGENTS.md paths and contents for the root and ancestor directories of supplied paths.',
  init: 'Returns initialized flag, AGENTS.md path, and either bytes written or reason it was left untouched.',
  create_directory: 'Returns created flag, relative path, and recursive mode.',
  move_path: 'Returns moved flag and relative source/destination paths.',
  delete_path: 'Returns deleted flag, relative path, and deleted entry type.',
  git_create_branch: 'Returns created flag and branch name.',
  git_switch_branch: 'Returns switched flag, branch name, and Git output/exit status.',
  git_commit: 'Returns committed flag and Git output/exit status, including the resulting commit hash in stdout when successful.',
  git_fetch: 'Returns exitCode, stdout/stderr and timeout status for the fetch operation.',
  git_pull: 'Returns exitCode, stdout/stderr and timeout status for the pull operation.',
  git_push: 'Returns exitCode, stdout/stderr and timeout status for the push operation.',
  git_clone: 'Returns exitCode, stdout/stderr and timeout status for the clone operation.',
  update_plan: 'Returns the current ordered plan with IDs, step text and pending/in_progress/completed status.',
  upload_workspace_file: 'Returns the repository artifact path/URL, media type, byte size, SHA-256, visibility and retrieval note.',
  computer: 'Returns actual Colab/model readiness and, when requested, a verified screenshot report or pending request ID. Pending is not completed inference.',
  refresh_environment_context: 'Returns the compact context index, including current agent_context, project-native command hints and tool catalog.',
  batch: 'Returns ordered steps with IDs, tool names, success/failed/cancelled status, errors/cancellation details, exit codes, and actual results even for failed commands.',
  get_agent_context: 'Returns a compact environment/project snapshot, project scripts, suggested native commands, instruction file paths/hashes/sizes, bounded tree and complete tool catalog.'
});
function parameterSchema(tool) {
  const names = (TOOL_ARGUMENT_KEYS[tool] || []).filter(name => name !== 'approved');
  const overrides = TOOL_PARAMETER_OVERRIDES[tool] || {};
  const properties = {};
  for (const name of names) {
    const base = BASE_FIELD_SCHEMAS[name] || { type: 'string', description: 'Argument ' + name + ' for ' + tool + '.' };
    const override = overrides[name] || {};
    properties[name] = { ...base, ...override };
    if (tool === 'git_fetch' || tool === 'git_pull' || tool === 'git_push' || tool === 'git_clone') {
      if (name === 'timeoutMs' && !override.default) properties[name] = { ...properties[name], default: 60000 };
    }
  }
  if (tool === 'batch') {
    properties.steps = { ...BASE_FIELD_SCHEMAS.steps, ...overrides.steps };
  }
  return { type: 'object', properties, required: REQUIRED_ARGUMENTS[tool] || [], additionalProperties: false };
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function computerServiceCall(service, args, requestId) {
  switch (args.action) {
    case 'status': return service.status(args);
    case 'connect': return service.connectColab();
    case 'enable': return service.activate(args, requestId);
    case 'disable': return service.deactivate(args, requestId);
    case 'screenshot': return service.analyzeScreenshot(args, requestId);
    case 'wait': return service.wait(args);
    default: throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
  }
}

function computerOutputFailed(action, output) {
  if (!output || output.status === 'error' || output.status === 'inference_failed') return true;
  if (action === 'screenshot') return !['report_available', 'inference_in_progress'].includes(output.status);
  if (action === 'wait') return ['inactive', 'needs_authentication', 'gpu_unavailable', 'disconnected'].includes(output.status);
  return false;
}

function createToolBridge(deps) {
  const { dialog, getMainWindow, getWorkspaceRoot, localTools, githubAuth, uploadWorkspaceFile, getAutoAcceptAll, visionService } = deps;
  const COMPUTER_TOOLS = new Set(['computer']);

  function validateArgs(tool, args) {
    if (BLOCKED_TOOLS_FOR_MAILBOX.has(tool)) {
      throw new Error('The repository mailbox cannot invoke the app GitHub API directly.');
    }
    const allowed = TOOL_ARGUMENT_KEYS[tool];
    if (!allowed) throw new Error('Unknown local tool: ' + tool);
    if (!isPlainObject(args)) throw new Error('Tool args must be a JSON object.');
    const extra = Object.keys(args).filter(key => !allowed.includes(key));
    if (extra.length) throw new Error('Unsupported argument field(s) for ' + tool + ': ' + extra.join(', '));
    if (tool === 'batch') validateBatchArgs(args);
  }

  function validateBatchArgs(args) {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > MAX_BATCH_STEPS) {
      throw new Error('batch.steps must contain between 1 and ' + MAX_BATCH_STEPS + ' tool steps.');
    }
    if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
      throw new Error('batch.stopOnError must be a boolean.');
    }
    if (args.maxConcurrency !== undefined && (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1 || args.maxConcurrency > MAX_BATCH_CONCURRENCY)) {
      throw new Error('batch.maxConcurrency must be an integer from 1 to ' + MAX_BATCH_CONCURRENCY + '.');
    }
    const ids = new Set();
    for (const [index, step] of args.steps.entries()) {
      if (!isPlainObject(step)) throw new Error('batch step ' + (index + 1) + ' must be an object.');
      if (Object.keys(step).some(key => !['id','tool','args'].includes(key))) throw new Error('batch step contains unsupported fields.');
      if (typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(step.id)) throw new Error('batch step IDs must be 1–20 simple characters.');
      if (ids.has(step.id)) throw new Error('duplicate batch step ID: ' + step.id);
      if (typeof step.tool !== 'string' || step.tool === 'batch' || step.tool === 'refresh_environment_context' || BLOCKED_TOOLS_FOR_MAILBOX.has(step.tool)) {
        throw new Error('batch step ' + step.id + ' uses an unsupported or non-nestable tool.');
      }
      if (!isPlainObject(step.args)) throw new Error('batch step ' + step.id + ' args must be an object.');
      if (Object.hasOwn(step.args, 'approved')) throw new Error('batch steps cannot bypass local approval with an approved argument.');
      validateArgs(step.tool, step.args);
      for (const referencedId of collectBatchRefIds(step.args)) {
        if (!ids.has(referencedId)) throw new Error('batch reference must point to an earlier step: ' + referencedId);
      }
      ids.add(step.id);
    }
  }

  function collectBatchRefIds(value, refs = new Set(), depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) { for (const item of value) collectBatchRefIds(item, refs, depth + 1); return refs; }
    if (!isPlainObject(value)) return refs;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      if (!parts[0] || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('unsafe batch reference path.');
      refs.add(parts[0]);
      return refs;
    }
    for (const item of Object.values(value)) collectBatchRefIds(item, refs, depth + 1);
    return refs;
  }

  function normalizeBatchPath(value) {
    return String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  }

  function batchFootprint(step) {
    const args = step.args || {};
    const reads = [];
    const writes = [];
    let barrier = false;
    const add = (set, value) => {
      const normalized = normalizeBatchPath(value);
      if (normalized) set.push(normalized);
    };
    switch (step.tool) {
      case 'read_file':
      case 'file_info':
      case 'upload_workspace_file':
        add(reads, args.path);
        break;
      case 'write_file':
      case 'create_directory':
      case 'delete_path':
        add(writes, args.path);
        break;
      case 'move_path':
        add(writes, args.source);
        add(writes, args.destination);
        break;
      case 'init':
        add(writes, 'AGENTS.md');
        break;
      case 'apply_patch': {
        const paths = typeof args.patch === 'string'
          ? [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/gm)].map(match => match[1].trim())
          : [];
        for (const item of paths) add(writes, item);
        if (!writes.length) barrier = true;
        break;
      }
      case 'project_status':
      case 'list_dir':
      case 'directory_tree':
      case 'glob_file_search':
      case 'search':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
      case 'git_show':
      case 'git_branches':
      case 'git_changed_files':
      case 'discover_instructions':
      case 'get_agent_context':
        reads.push('*');
        break;
      case 'computer':
      case 'shell':
      case 'run_tests':
      case 'git_fetch':
      case 'git_pull':
      case 'git_push':
      case 'git_clone':
      case 'git_create_branch':
      case 'git_switch_branch':
      case 'git_commit':
      case 'refresh_environment_context':
        barrier = true;
        break;
      default:
        break;
    }
    return { reads, writes, barrier };
  }

  function batchFootprintsConflict(left, right) {
    if (left.barrier || right.barrier) return true;
    const overlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    return left.writes.some(a => right.reads.some(b => overlaps(a, b)) || right.writes.some(b => overlaps(a, b))) ||
      right.writes.some(a => left.reads.some(b => overlaps(a, b)));
  }

  function inferBatchDependencies(steps, index) {
    const current = steps[index];
    const dependencies = new Set(collectBatchRefIds(current.args));
    const currentFootprint = batchFootprint(current);
    for (let priorIndex = 0; priorIndex < index; priorIndex++) {
      const prior = steps[priorIndex];
      if (batchFootprintsConflict(batchFootprint(prior), currentFootprint)) dependencies.add(prior.id);
    }
    return [...dependencies];
  }

  function resolveBatchRefs(value, completed, depth = 0) {
    if (depth > 30) throw new Error('batch reference nesting is too deep.');
    if (Array.isArray(value)) return value.map(item => resolveBatchRefs(item, completed, depth + 1));
    if (!isPlainObject(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref.length || value.$ref.length > 500) throw new Error('batch $ref must be a non-empty path string.');
      const parts = value.$ref.split('.');
      const stepId = parts.shift();
      if (!stepId || !completed.has(stepId)) throw new Error('batch reference must point to a completed earlier step: ' + value.$ref);
      let current = completed.get(stepId);
      for (const part of parts) {
        if (!part || ['__proto__','prototype','constructor'].includes(part)) throw new Error('unsafe batch reference path.');
        if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
        else if (isPlainObject(current) && Object.hasOwn(current, part)) current = current[part];
        else throw new Error('batch reference path not found: ' + value.$ref);
      }
      if (current === undefined) throw new Error('batch reference resolved to undefined: ' + value.$ref);
      return current;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = resolveBatchRefs(item, completed, depth + 1);
    return output;
  }

  function displayApprovalValue(value, maxChars = 4000) {
    const escaped = String(value == null ? '' : value)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g,
        character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        character => '[BIDI U+' + character.charCodeAt(0).toString(16).toUpperCase() + ']');
    if (escaped.length <= maxChars) return escaped;
    const marker = ' … [DISPLAY TRUNCATED]';
    return escaped.slice(0, Math.max(0, maxChars - marker.length)) + marker;
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
    if (tool === 'computer') {
      if (args.action === 'connect') {
        return header + resultWarning + 'Open the Colab notebook in the normal browser and establish the direct local-to-Colab connection. This does not load the model. The user may need to connect a runtime and run the notebook cell.';
      }
      if (args.action === 'enable') {
        return header + resultWarning + 'Enable screenshot understanding in Colab. If no runtime is connected, the notebook opens and requires the user to run its server cell. When connected, this may mount Google Drive, download several gigabytes of model files, and compile the runtime.';
      }
      if (args.action === 'screenshot') {
        const source = args.source === 'workspace_file' ? 'workspace image: ' + displayApprovalValue(args.path || '(missing path)', 1200) : 'current primary Windows display';
        return header + resultWarning + 'Capture and send one image for visual analysis. Source: ' + source +
          '\nThe image is sent directly to the authenticated temporary Colab HTTPS endpoint; the screenshot is not uploaded as a separate GitHub artifact. The model report returns through the shared mailbox, so it may contain details visible on your screen. Only proceed when that disclosure is acceptable.';
      }
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
      if (localTools.getToolPolicy('apply_patch', args).sensitivePath) {
        return header + resultWarning + 'This patch touches a file whose name looks sensitive. The patch will not be read or applied until you approve it.\n\nPatch preview (first 2500 characters):\n' +
          displayApprovalValue(String(args.patch || '').slice(0, 2500), 9000);
      }
      const plans = localTools.parsePatch(args.patch, root);
      return header + resultWarning + 'Review the files this patch will modify:\n' +
        plans.map(item => item.kind.toUpperCase() + '  ' + displayApprovalValue(item.relative, 500)).join('\n') +
        '\n\nPatch preview (line breaks are shown as \\\\n; first 2500 characters):\n' +
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
    if (tool === 'run_tests') return header + resultWarning + (args.command
      ? 'Run this explicit PowerShell test command. It runs with your Windows user permissions and may have side effects:\n\n' + displayApprovalValue(args.command, 4000) + '\n\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.'
      : 'Detect and run the project-native test command. Tests execute project code and may have side effects.\nTimeout: ' + (Number.isInteger(args.timeoutMs) ? args.timeoutMs : 60000) + ' ms.');
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
          trimmed[key] = trimmed[key].slice(0, 10000) + '\n[OUTPUT TRUNCATED before mailbox publication. This is not a safety denial; inspect status/exitCode/stderr. For listings, request smaller stable-sorted pages using Select-Object -Skip/-First.]';
        }
      }
      serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_RESULT_CHARS) return trimmed;
    }
    return {
      truncatedForMailbox: true,
      message: 'Tool output exceeded the repository return limit. This is incomplete output, not evidence of a safety block. Retry with smaller stable-sorted pages, a narrower query, or a file section.',
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
          { name: 'batch', mode: 'local-batch' },
          { name: 'get_agent_context', mode: 'read' },
          { name: 'upload_workspace_file', mode: 'approval-required' },
          { name: 'computer', mode: 'action-dependent-approval' },
          { name: 'refresh_environment_context', mode: 'repository-bridge-control' }
        );
        output.tools = output.tools.filter(item => !BLOCKED_TOOLS_FOR_MAILBOX.has(item.name)).map(item => ({
          ...item,
          description: TOOL_DESCRIPTIONS[item.name] || ('Run the ' + item.name + ' workspace tool.'),
          parameters: parameterSchema(item.name),
          ...(TOOL_RESULT_SUMMARIES[item.name] ? { returns: TOOL_RESULT_SUMMARIES[item.name] } : {}),
          permission_note: item.name === 'batch'
            ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? 'Auto-accept everything is enabled; protected steps run without per-operation approval dialogs.'
            : 'The batch call itself is not approval; protected steps show their own native Windows dialog.')
            : item.mode === 'action-dependent-approval'
              ? 'Native approval is required for connect, enable, and screenshot actions; status, disable, and wait do not prompt. Auto-accept everything may bypass those dialogs.'
              : item.mode === 'approval' || item.mode === 'approval-required' || item.mode === 'read-or-approval-for-secret-like-paths'
              ? (typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
                ? 'Auto-accept everything is enabled; this protected call runs without a per-operation dialog.'
                : 'This call may display a native Windows approval dialog before execution.')
              : item.mode === 'automatic-workspace-write'
                ? 'Normally runs automatically for workspace-relative paths; secret-like paths still require native Windows approval.'
                : 'No approval dialog is normally required; the app still validates paths and arguments.'
        }));
        output.catalog_version = 2;
        output.tool_calling = {
          mode: 'repository-mailbox-batch',
          catalog_version: 2,
          rule: 'Submit up to 100 local steps in one request rather than one request per file. Independent lightweight file operations can run with maxConcurrency=100; default is 32. File/path conflicts and shell, tests, Git mutations, and unknown-side-effect operations are ordered automatically. For large file-output batches, fetch every part listed in result.output_artifacts concurrently, then review/process outputs together. $ref arguments wait for their source step. Inspect exitCode, timedOut, stdout, and stderr before dependent actions.',
          reference_syntax: '{"$ref":"priorStepId.result.content"}'
        };
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


  async function executeBatch(args, parentId) {
    const completed = new Map();
    const taskById = new Map();
    const outcomeById = new Map();
    const steps = args.steps;
    const concurrency = Number.isInteger(args.maxConcurrency) ? args.maxConcurrency : DEFAULT_BATCH_CONCURRENCY;
    const stopOnError = args.stopOnError !== false;
    let active = 0;
    const waiters = [];
    let firstFailureIndex = Number.POSITIVE_INFINITY;
    let stoppedAt = null;

    async function acquireSlot() {
      if (active < concurrency) { active++; return; }
      await new Promise(resolve => waiters.push(resolve));
    }
    function releaseSlot() {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
    function itemFor(step, outcome, skipped = false) {
      const item = {
        id: step.id,
        tool: step.tool,
        call_id: outcome.call_id || (String(parentId).slice(0, 55) + '-' + step.id),
        ok: outcome.ok === true,
        status: skipped ? 'skipped' : outcome.ok === true ? 'success' : outcome.cancelled ? 'cancelled' : 'failed'
      };
      if (skipped) item.skipped = true;
      if (outcome.cancelled) item.cancelled = true;
      if (outcome.error) item.error = outcome.error;
      if (outcome.message && !outcome.ok) item.message = outcome.message;
      if (outcome.result !== undefined) item.result = outcome.result;
      if (outcome.result && Number.isInteger(outcome.result.exitCode)) item.exit_code = outcome.result.exitCode;
      if (outcome.result && outcome.result.timedOut === true) item.timed_out = true;
      return item;
    }

    for (const [index, step] of steps.entries()) {
      const dependencies = inferBatchDependencies(steps, index);
      const task = (async () => {
        await Promise.all(dependencies.map(id => taskById.get(id)));
        const failedDependency = dependencies.find(id => !outcomeById.get(id) || outcomeById.get(id).ok !== true);
        if (failedDependency) {
          const skipped = { ok: false, skipped: true, error: 'Not started because dependency ' + failedDependency + ' did not succeed.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        if (stopOnError && index > firstFailureIndex) {
          const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
          completed.set(step.id, skipped);
          outcomeById.set(step.id, skipped);
          return skipped;
        }
        await acquireSlot();
        try {
          if (stopOnError && index > firstFailureIndex) {
            const skipped = { ok: false, skipped: true, error: 'Not started because an earlier batch step failed or was cancelled.' };
            completed.set(step.id, skipped);
            outcomeById.set(step.id, skipped);
            return skipped;
          }
          let outcome;
          try {
            const resolvedArgs = resolveBatchRefs(step.args, completed);
            const childId = (String(parentId).slice(0, 55) || 'batch') + '-' + step.id;
            outcome = await runTool(step.tool, resolvedArgs, childId);
          } catch (error) {
            outcome = { ok: false, error: String(error && error.message || error) };
          }
          completed.set(step.id, outcome);
          outcomeById.set(step.id, outcome);
          if (!outcome.ok && stopOnError && index < firstFailureIndex) {
            firstFailureIndex = index;
            stoppedAt = step.id;
          }
          return outcome;
        } finally {
          releaseSlot();
        }
      })();
      taskById.set(step.id, task);
    }

    await Promise.all(taskById.values());
    const resultSteps = steps.map(step => {
      const outcome = outcomeById.get(step.id) || { ok: false, skipped: true, error: 'Step did not run.' };
      return itemFor(step, outcome, outcome.skipped === true);
    });
    const failed = resultSteps.some(item => !item.ok);
    const completedSteps = resultSteps.filter(item => !item.skipped).length;
    return {
      ok: !failed,
      result: {
        steps: resultSteps,
        completed_steps: completedSteps,
        skipped_steps: resultSteps.filter(item => item.skipped).length,
        requested_steps: steps.length,
        max_concurrency: concurrency,
        stopped_at: stoppedAt
      }
    };
  }


  function inferProjectCommands(project, projectCommands) {
    const entries = new Set((project && project.topLevelEntries || []).map(String));
    const scripts = projectCommands && projectCommands.scripts && typeof projectCommands.scripts === 'object' ? projectCommands.scripts : {};
    const commands = [];
    if (typeof scripts.test === 'string') commands.push({ name: 'test', command: 'npm test', source: 'package.json scripts.test' });
    if (typeof scripts.check === 'string') commands.push({ name: 'check', command: 'npm run check', source: 'package.json scripts.check' });
    if (typeof scripts.lint === 'string') commands.push({ name: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' });
    if (entries.has('pyproject.toml') || entries.has('pytest.ini') || entries.has('tests')) commands.push({ name: 'test', command: 'python -m pytest', source: 'Python project marker; verify dependencies first' });
    if (entries.has('Cargo.toml')) commands.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' });
    if (entries.has('go.mod')) commands.push({ name: 'test', command: 'go test ./...', source: 'go.mod' });
    if (entries.has('pom.xml')) commands.push({ name: 'test', command: 'mvn test', source: 'pom.xml' });
    if (entries.has('gradlew.bat')) commands.push({ name: 'test', command: '.\\gradlew.bat test', source: 'gradlew.bat' });
    else if (entries.has('build.gradle') || entries.has('build.gradle.kts')) commands.push({ name: 'test', command: 'gradle test', source: 'Gradle build file' });
    if (entries.has('global.json') || [...entries].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) commands.push({ name: 'test', command: 'dotnet test', source: '.NET project marker' });
    const seen = new Set();
    return commands.filter(item => { const key = item.command.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  async function executeAgentContext(root, requestId) {
    const [environment, project, tree, instructionReport, capabilities] = await Promise.all([
      localTools.executeTool(root, 'environment_info', {}),
      localTools.executeTool(root, 'project_status', {}),
      localTools.executeTool(root, 'directory_tree', { path: '.', maxDepth: isFilesystemRoot(root) ? 1 : 2, maxEntries: 180, format: 'paths' }),
      localTools.executeTool(root, 'discover_instructions', {}),
      executeLocalTool(root, 'get_capabilities', {}, requestId + '-catalog')
    ]);
    const found = instructionReport && Array.isArray(instructionReport.instructions) ? instructionReport.instructions : [];
    const instructionFiles = found.map(item => ({
      path: item.path,
      bytes: Buffer.byteLength(String(item.content || ''), 'utf8'),
      sha256: createHash('sha256').update(String(item.content || ''), 'utf8').digest('hex'),
      contents_included: false
    }));
    let projectCommands = null;
    const manifestPath = path.join(root, 'package.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile() && fs.statSync(manifestPath).size <= 256 * 1024) {
      try {
        const manifestFile = await localTools.executeTool(root, 'read_file', { path: 'package.json' });
        const manifest = JSON.parse(manifestFile.content);
        projectCommands = {
          manifest: 'package.json',
          name: typeof manifest.name === 'string' ? manifest.name : null,
          packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
          engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
          scripts: manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
        };
      } catch { projectCommands = { manifest: 'package.json', parse_error: true }; }
    }
    const suggestedCommands = inferProjectCommands(project, projectCommands);
    return {
      protocol: 'chatgpt-local-agent-context/v1',
      generated_at: new Date().toISOString(),
      workspace_selected: true,
      workspace_mode: isFilesystemRoot(root) ? 'drive-root' : 'folder',
      path_style: process.platform === 'win32' ? 'Windows' : process.platform,
      workspace_path_guidance: isFilesystemRoot(root)
        ? 'The selected workspace is an entire drive. Use drive-relative paths such as Users/Example/Projects/app.js or an absolute Windows path within the selected drive. The background index lists only the root entries; inspect relevant folders on demand.'
        : 'Use workspace-relative paths or absolute Windows paths that resolve inside the selected workspace.',
      environment,
      project,
      project_commands: projectCommands,
      suggested_commands: suggestedCommands,
      execution_policy: {
        auto_accept_all: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true,
        note: typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
          ? 'The user explicitly enabled app-wide auto-accept. Do not try to override or infer approval for anything outside the registered tool/policy boundary.'
          : 'Auto-accept is disabled; protected operations may require native approval.'
      },
      directory_overview: tree,
      instruction_files: instructionFiles,
      tool_catalog: {
        protocol: capabilities.protocol,
        catalog_version: 2,
        tools: capabilities.tools,
        tool_calling: capabilities.tool_calling
      },
      retrieval_rules: [
        'The connected GitHub MCP does not expose these local tools as native functions. For a Windows task, read bridge/context/latest.json and bridge/context/capabilities.json, then create bridge/requests/<unique-id>.json with protocol chatgpt-local-repo-bridge/v1, request_id, created_at, tool, and args; read bridge/results/<same-id>.json.',
        'Immediately invoke get_agent_context through that mailbox protocol before asking for machine facts. Use the published schemas exactly; do not treat a missing native function name or a server-sandbox path miss as proof that Windows access is blocked.',
        'Discover installed software, games, versions, paths, project files and configuration with targeted local tools before asking the user. Ask only for genuinely missing intent after discovery.',
        'If a matching result is absent, inspect the matching claim and worker state and re-read the same result. Do not replay an uncertain side effect or create a duplicate request.',
        'The shared snapshot is refreshed in the background by the Windows worker. Request a fresh live context when a just-made workspace change matters.',
        'Fetch full instruction contents and source files only when relevant to the current task.',
        'Use batch for up to 50 known operations to minimize GitHub request/result round trips; references may only point to earlier completed steps.',
        isFilesystemRoot(root)
          ? 'The entire drive is the workspace. The background index intentionally contains only top-level names; use list_dir, directory_tree, glob_file_search, or search with a targeted path to explore a subdirectory. Do not recursively dump the whole drive.'
          : 'Use paths relative to the selected workspace, or absolute Windows paths that remain inside it. Protected steps follow the current local approval setting.',
        'The shell runs as the signed-in Windows user and is not sandboxed.'
      ],
      development_workflow: {
        purpose: 'Use the actual Windows environment as the working environment, through its GitHub mailbox.',
        rules: [
          'First inspect the published context and exact schemas, then submit a real local-tool request using the mailbox JSON envelope. Native GitHub MCP function names and local mailbox tool names are different interfaces.',
          'Start with get_agent_context; it returns Windows/runtime facts, project discovery, instruction metadata, a bounded directory view, and the local tool catalog in one result.',
          'For unknown environment facts, run targeted discovery before asking the user: check installed application/game manifests, executable version metadata, likely install locations, frameworks and relevant project files.',
          'Batch independent read-only inspections. Use one small inspection request, one focused edit request, and one verification request rather than one request per file or command.',
          'Match every result to its request_id. Inspect status, nested ok, exitCode, timedOut, stdout/stderr and truncation. A request or claim alone is not completion.',
          'If the result is missing, inspect its claim and worker state and reread that result. Never replay an uncertain side-effecting request.',
          'Treat actual local output as authoritative; GitHub Actions and the ChatGPT server sandbox cannot establish local Windows state.',
          'Keep permission and workspace-path protections intact. When an approval or genuine failure blocks an operation, diagnose the exact result and try a supported alternative before falling back to manual instructions.',
          'For substantial tasks, define measurable acceptance criteria and a short implementation plan before editing; keep it proportional to scope.',
          'Match architecture to scope. A complex game, app, or multi-system feature should use coherent modules and clear interfaces, not a single-file shortcut unless explicitly requested.',
          'Inspect relevant entry points, manifests, existing modules and tests before choosing the design; preserve unrelated changes.',
          'Implement in small, integrated vertical slices. Batch independent inspections and verification, and represent dependencies explicitly with result references.',
          'After edits, run project-native checks and tests, build the actual target when available, and perform an end-to-end UI smoke test for user-facing software when practical. Fix failures and rerun verification.',
          'Report only verified outcomes and name important unknowns.'
        ]
      },
      detail: { directory_tree_tool: 'directory_tree', instruction_tool: 'discover_instructions', capabilities_tool: 'get_capabilities' }
    };
  }

  async function runTool(tool, inputArgs, callId = null) {
    const root = getWorkspaceRoot();
    const args = { ...(inputArgs || {}) };
    const id = callId || randomUUID();
    let result;
    try {
      validateArgs(tool, args);
      if (tool === 'batch') {
        result = await executeBatch(args, id);
      } else if (tool === 'get_agent_context') {
        result = { ok: true, result: await executeAgentContext(root, id) };
      } else {
        const isComputerTool = COMPUTER_TOOLS.has(tool);
        if (isComputerTool && !visionService) throw new Error('The computer screenshot service is unavailable in this app build.');
        if (isComputerTool && !['status', 'connect', 'enable', 'disable', 'screenshot', 'wait'].includes(args.action)) {
          throw new Error('Unsupported computer action. Use status, connect, enable, disable, screenshot, or wait.');
        }
        if (isComputerTool && args.action === 'wait' && typeof args.request_id !== 'string') {
          throw new Error('computer(action=wait) requires the request_id returned by computer(action=screenshot).');
        }
        if (isComputerTool && args.action === 'screenshot' && args.source === 'workspace_file' && typeof args.path !== 'string') {
          throw new Error('computer(action=screenshot, source=workspace_file) requires path.');
        }
        const policy = tool === 'upload_workspace_file'
          ? { tool, requiresApproval: true, automatic: false }
          : isComputerTool
            ? { tool, requiresApproval: ['connect', 'enable', 'screenshot'].includes(args.action), automatic: false }
            : localTools.getToolPolicy(tool, args);
        if (policy.requiresApproval) {
          const approved = typeof getAutoAcceptAll === 'function' && getAutoAcceptAll() === true
            ? true
            : await askApproval(tool, args, root);
          if (!approved) {
            result = { ok: false, cancelled: true, message: 'User cancelled the operation. Nothing was executed.' };
          } else {
            if (policy.sensitivePath || tool === 'read_file') args.approved = true;
            const output = isComputerTool
              ? await computerServiceCall(visionService, args, id)
              : await executeLocalTool(root, tool, args, id);
            if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
              result = {
                ok: false,
                error: isComputerTool
                  ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                  : tool + ' exited with code ' + output.exitCode + '.',
                result: output
              };
            } else {
              result = { ok: true, result: output };
            }
          }
        } else {
          const output = isComputerTool
            ? await computerServiceCall(visionService, args, id)
            : await executeLocalTool(root, tool, args, id);
          if ((isComputerTool && computerOutputFailed(args.action, output)) || (output && Number.isInteger(output.exitCode) && output.exitCode !== 0)) {
            result = {
              ok: false,
              error: isComputerTool
                ? (output && (output.error || output.message) || 'The computer action did not complete successfully.')
                : tool + ' exited with code ' + output.exitCode + '.',
              result: output
            };
          } else {
            result = { ok: true, result: output };
          }
        }
      }
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error) };
    }
    return boundedResult({
      protocol: 'chatgpt-local-tool-result-v2',
      status: result.ok ? 'success' : result.cancelled ? 'cancelled' : 'failed',
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
