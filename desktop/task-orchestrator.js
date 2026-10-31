'use strict';

const { randomBytes } = require('node:crypto');

const TASK_PROTOCOL = 'chatgpt-local-project-task/v1';
const PROJECT_PROTOCOL = 'chatgpt-local-project-coordination/v1';
const TASK_ID_PATTERN = /^task-[0-9]{13}-[a-f0-9]{16}$/;
const PROJECT_ID_PATTERN = /^project-[a-f0-9]{24}$/;
const SESSION_ID_PATTERN = /^session-[a-f0-9]{32}$/;
const AGENT_ID_PATTERN = /^agent-[0-9]{3,}$/;
const ACTIVE_TASK_STATES = new Set(['proposed', 'ready', 'claimed', 'in_progress', 'blocked', 'review', 'integration', 'verification', 'needs_rework']);
const TERMINAL_TASK_STATES = new Set(['verified', 'completed', 'failed', 'cancelled']);
const TASK_STATES = new Set([...ACTIVE_TASK_STATES, ...TERMINAL_TASK_STATES]);
const MAX_PROJECT_BYTES = 900 * 1024;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function boundedText(value, max, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(field + ' is required.');
    return '';
  }
  if (typeof value !== 'string') throw new Error(field + ' must be a string.');
  const text = value.trim().replace(/\u0000/g, '');
  if (required && !text) throw new Error(field + ' must not be empty.');
  if (text.length > max) throw new Error(field + ' exceeds ' + max + ' characters.');
  return text;
}

function normalizeScopePath(value) {
  const raw = boundedText(value, 512, 'scope path', true).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (raw === '.' || raw === '') return '.';
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('Task scope paths must be workspace-relative and cannot contain parent traversal.');
  }
  return raw;
}

function pathsOverlap(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function createTaskOrchestrator({ readRemoteFile, listFolder, writeRemoteJson, clock = () => Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  if (typeof readRemoteFile !== 'function' || typeof listFolder !== 'function' || typeof writeRemoteJson !== 'function') {
    throw new TypeError('Task orchestrator mailbox dependencies are incomplete.');
  }
  const locks = new Map();

  function now() { return new Date(clock()).toISOString(); }
  function taskPath(taskId) {
    if (!TASK_ID_PATTERN.test(String(taskId || ''))) throw new Error('Invalid task_id.');
    return 'bridge/tasks/' + taskId + '.json';
  }
  function projectPath(projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId || ''))) throw new Error('Invalid project_id. Call task_project_init first.');
    return 'bridge/projects/' + projectId + '.json';
  }
  function withLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    locks.set(key, queued);
    return previous.catch(() => {}).then(operation).finally(() => {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    });
  }
  function validateProject(value, projectId) {
    if (!value || value.protocol !== PROJECT_PROTOCOL || value.project_id !== projectId || !Array.isArray(value.leases) || !Array.isArray(value.decisions)) {
      throw new Error('Project coordination record is malformed; refusing to overwrite it.');
    }
    return value;
  }
  function validateTask(value, taskId) {
    if (!value || value.protocol !== TASK_PROTOCOL || value.task_id !== taskId ||
        !PROJECT_ID_PATTERN.test(String(value.project_id || '')) || !TASK_STATES.has(value.status) ||
        !SESSION_ID_PATTERN.test(String(value.created_by_session_id || ''))) {
      throw new Error('Task record is malformed; refusing to overwrite it.');
    }
    return value;
  }
  async function readProject(projectId) {
    const remote = await readRemoteFile(projectPath(projectId));
    if (!remote) return null;
    validateProject(remote.value, projectId);
    return remote;
  }
  async function readTask(taskId) {
    const remote = await readRemoteFile(taskPath(taskId));
    if (!remote) return null;
    validateTask(remote.value, taskId);
    return remote;
  }
  async function createOnly(path, value) {
    const saved = await writeRemoteJson(path, value, null, true);
    if (!saved || !saved.ok) throw new Error('Could not publish immutable task record: ' + path);
    return saved;
  }
  async function mutateProject(projectId, mutator, retries = 10) {
    return withLock('project:' + projectId, async () => {
      for (let attempt = 0; attempt < retries; attempt++) {
        const remote = await readProject(projectId);
        if (!remote) throw new Error('Project coordination record was not found: ' + projectId);
        const next = { ...mutator(structuredClone(remote.value)), updated_at: now() };
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_PROJECT_BYTES) {
          throw new Error('Project coordination record reached its storage safety limit. Archive old decisions before continuing.');
        }
        try {
          const saved = await writeRemoteJson(projectPath(projectId), next, remote.sha, false);
          if (saved && saved.ok) return next;
        } catch (error) {
          if (!/conflict|sha|409|422/i.test(String(error && error.message || error)) || attempt === retries - 1) throw error;
        }
      }
      throw new Error('Project coordination update conflicted repeatedly. Retry with the same task_id after checking task state.');
    });
  }
  async function mutateTask(taskId, mutator, retries = 8) {
    return withLock('task:' + taskId, async () => {
      for (let attempt = 0; attempt < retries; attempt++) {
        const remote = await readTask(taskId);
        if (!remote) throw new Error('Task was not found: ' + taskId);
        const next = { ...mutator(structuredClone(remote.value)), updated_at: now() };
        try {
          const saved = await writeRemoteJson(taskPath(taskId), next, remote.sha, false);
          if (saved && saved.ok) return next;
        } catch (error) {
          if (!/conflict|sha|409|422/i.test(String(error && error.message || error)) || attempt === retries - 1) throw error;
        }
      }
      throw new Error('Task update conflicted repeatedly. Read the task before retrying.');
    });
  }
  function validateIdentity(identity) {
    if (!identity || !SESSION_ID_PATTERN.test(String(identity.session_id || '')) ||
        !AGENT_ID_PATTERN.test(String(identity.agent_id || ''))) {
      throw new Error('Authenticated session and agent identity are required for task operations.');
    }
  }
  function activeLeases(project, timestamp) {
    return project.leases.filter(item => Date.parse(item.expires_at) > timestamp);
  }
  function taskSummary(task) {
    return {
      task_id: task.task_id, title: task.title, status: task.status, priority: task.priority,
      assignee_session_id: task.assignee_session_id || null, assignee_agent_id: task.assignee_agent_id || null,
      dependency_count: task.dependencies.length, scope_paths: task.scope_paths,
      updated_at: task.updated_at, lease_expires_at: task.lease_expires_at || null
    };
  }

  async function initProject(identity, args = {}) {
    validateIdentity(identity);
    const name = boundedText(args.name || 'Project', 120, 'name', true);
    const description = boundedText(args.description, 2000, 'description');
    const projectId = args.project_id
      ? String(args.project_id)
      : 'project-' + randomBytes(12).toString('hex');
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error('project_id must match project- followed by 24 lowercase hexadecimal characters.');
    const createdAt = now();
    const record = {
      protocol: PROJECT_PROTOCOL, project_id: projectId, name, description,
      created_by_session_id: identity.session_id, created_by_agent_id: identity.agent_id,
      created_at: createdAt, updated_at: createdAt, leases: [], decisions: [],
      policy: {
        lease_ms: leaseMs,
        scope_conflict: 'Workspace-relative path scopes overlap when equal or when one is a parent directory of the other.',
        review: 'A reviewer must be a different session from the task owner.',
        verification: 'Integration and verification are separate gates; task completion requires recorded evidence.'
      }
    };
    await createOnly(projectPath(projectId), record);
    return { project_id: projectId, name, protocol: PROJECT_PROTOCOL, created_at: createdAt, note: 'Share this project_id with every collaborating session. Task records and file/module ownership are shared through the mailbox.' };
  }

  async function getProject(projectId) {
    const remote = await readProject(projectId);
    if (!remote) throw new Error('Project not found: ' + projectId);
    const project = remote.value;
    const leases = activeLeases(project, clock());
    return {
      project_id: project.project_id, name: project.name, description: project.description,
      created_at: project.created_at, updated_at: project.updated_at,
      active_lease_count: leases.length, active_leases: leases,
      decisions: project.decisions.slice(-50), policy: project.policy
    };
  }

  async function createTask(identity, args = {}) {
    validateIdentity(identity);
    const projectId = String(args.project_id || '');
    const project = await readProject(projectId);
    if (!project) throw new Error('Project not found. Call task_project_init before creating tasks.');
    const title = boundedText(args.title, 180, 'title', true);
    const objective = boundedText(args.objective, 6000, 'objective', true);
    const acceptance = Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria : [];
    if (acceptance.length < 1 || acceptance.length > 30) throw new Error('acceptance_criteria must contain 1–30 items.');
    const criteria = acceptance.map((item, index) => boundedText(item, 500, 'acceptance_criteria[' + index + ']', true));
    const dependencies = Array.isArray(args.dependencies) ? [...new Set(args.dependencies.map(String))] : [];
    if (dependencies.length > 64 || dependencies.some(id => !TASK_ID_PATTERN.test(id))) throw new Error('dependencies must contain at most 64 valid task IDs.');
    for (const dependencyId of dependencies) {
      const dependency = await readTask(dependencyId);
      if (!dependency || dependency.value.project_id !== projectId) throw new Error('Every dependency must exist in the same project: ' + dependencyId);
    }
    const scopes = Array.isArray(args.scope_paths) ? [...new Set(args.scope_paths.map(normalizeScopePath))] : [];
    if (scopes.length > 100) throw new Error('scope_paths may contain at most 100 paths.');
    const priority = Number.isInteger(args.priority) ? Math.min(100, Math.max(0, args.priority)) : 50;
    const dedupeKey = boundedText(args.dedupe_key, 160, 'dedupe_key');
    const timestamp = clock();
    const taskId = 'task-' + String(timestamp).padStart(13, '0') + '-' + randomBytes(8).toString('hex');
    const record = {
      protocol: TASK_PROTOCOL, task_id: taskId, project_id: projectId,
      title, objective, acceptance_criteria: criteria, priority,
      status: dependencies.length ? 'proposed' : 'ready',
      dependencies, scope_paths: scopes,
      module: boundedText(args.module, 180, 'module'),
      task_type: boundedText(args.task_type || 'implementation', 40, 'task_type'),
      dedupe_key: dedupeKey || null,
      created_by_session_id: identity.session_id, created_by_agent_id: identity.agent_id,
      created_at: new Date(timestamp).toISOString(), updated_at: new Date(timestamp).toISOString(),
      assignee_session_id: null, assignee_agent_id: null, attempts: 0, lease_expires_at: null,
      worktree_path: null, branch: null, submissions: [], reviews: [], integration: null,
      verification: null, blocked_reason: null, history: [{
        at: new Date(timestamp).toISOString(), by_session_id: identity.session_id,
        by_agent_id: identity.agent_id, action: 'created', status: dependencies.length ? 'proposed' : 'ready'
      }]
    };
    await createOnly(taskPath(taskId), record);
    return taskSummary(record);
  }

  async function listTasks(identity, args = {}) {
    validateIdentity(identity);
    const projectId = String(args.project_id || '');
    if (!(await readProject(projectId))) throw new Error('Project not found: ' + projectId);
    const entries = await listFolder('bridge/tasks');
    const names = [...new Set(entries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /^task-[0-9]{13}-[a-f0-9]{16}\.json$/.test(name)))].sort().reverse();
    const cursor = Number.isInteger(args.offset) ? Math.max(0, Math.min(names.length, args.offset)) : 0;
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 30;
    const matching = [];
    for (let start = cursor; start < names.length && matching.length < limit; start += 20) {
      const batch = names.slice(start, Math.min(names.length, start + 20));
      const rows = await Promise.all(batch.map(async name => {
        const remote = await readTask(name.slice(0, -5));
        return remote && remote.value.project_id === projectId ? remote.value : null;
      }));
      for (const task of rows) {
        if (!task) continue;
        if (args.status && task.status !== args.status) continue;
        if (args.assigned_to_me === true && task.assignee_session_id !== identity.session_id) continue;
        matching.push(taskSummary(task));
        if (matching.length >= limit) break;
      }
    }
    return { project_id: projectId, tasks: matching, count: matching.length, offset: cursor, next_offset: cursor + matching.length < names.length ? cursor + matching.length : null, scanned: Math.min(names.length, cursor + Math.max(limit, 20)) };
  }

  async function getTask(identity, args = {}) {
    validateIdentity(identity);
    const remote = await readTask(String(args.task_id || ''));
    if (!remote) throw new Error('Task not found.');
    if (args.project_id && remote.value.project_id !== args.project_id) throw new Error('Task does not belong to the requested project.');
    return remote.value;
  }

  async function claimTask(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const initial = await readTask(taskId);
    if (!initial) throw new Error('Task not found.');
    const task = initial.value;
    const projectId = task.project_id;
    const timestamp = clock();
    if (task.dependencies.length) {
      for (const dependencyId of task.dependencies) {
        const dependency = await readTask(dependencyId);
        if (!dependency || !['verified', 'completed'].includes(dependency.value.status)) {
          throw new Error('TASK_DEPENDENCY_BLOCKED: dependency ' + dependencyId + ' is not verified or completed.');
        }
      }
    }
    const scope = task.scope_paths.length ? task.scope_paths : ['.'];
    const leaseUntil = new Date(timestamp + leaseMs).toISOString();
    let leaseCreated = false;
    await mutateProject(projectId, project => {
      const live = activeLeases(project, timestamp);
      const sameTask = live.find(item => item.task_id === taskId);
      if (sameTask && sameTask.session_id !== identity.session_id) {
        throw new Error('TASK_ALREADY_CLAIMED: Another session currently owns this task.');
      }
      const conflict = live.find(item => item.task_id !== taskId && item.session_id !== identity.session_id &&
        item.scope_paths.some(a => scope.some(b => pathsOverlap(a, b))));
      if (conflict) {
        throw new Error('TASK_SCOPE_CONFLICT: ' + conflict.task_id + ' currently owns an overlapping file/module scope (' +
          conflict.scope_paths.join(', ') + '). Coordinate or wait for its lease to expire.');
      }
      const leases = live.filter(item => item.task_id !== taskId);
      leases.push({
        task_id: taskId, session_id: identity.session_id, agent_id: identity.agent_id,
        scope_paths: scope, expires_at: leaseUntil, claimed_at: sameTask && sameTask.claimed_at || new Date(timestamp).toISOString()
      });
      leaseCreated = true;
      return { ...project, leases };
    });
    try {
      const updated = await mutateTask(taskId, current => {
        if (current.project_id !== projectId) throw new Error('Task project changed; refusing claim.');
        if (TERMINAL_TASK_STATES.has(current.status)) throw new Error('A terminal task cannot be claimed.');
        if (current.assignee_session_id && current.assignee_session_id !== identity.session_id &&
            Date.parse(current.lease_expires_at || '') > timestamp) throw new Error('TASK_ALREADY_CLAIMED: The task lease is still active.');
        const worktreePath = args.worktree_path === undefined ? current.worktree_path : normalizeScopePath(args.worktree_path);
        const branch = args.branch === undefined ? current.branch : boundedText(args.branch, 120, 'branch');
        const history = [...current.history, {
          at: new Date(timestamp).toISOString(), by_session_id: identity.session_id,
          by_agent_id: identity.agent_id, action: 'claimed', status: 'claimed'
        }].slice(-100);
        return { ...current, status: 'claimed', assignee_session_id: identity.session_id,
          assignee_agent_id: identity.agent_id, attempts: current.attempts + 1,
          lease_expires_at: leaseUntil, worktree_path: worktreePath, branch,
          history, blocked_reason: null };
      });
      return { ...taskSummary(updated), lease_ms: leaseMs, ownership: scope, note: 'The project-wide ownership lease prevents another session from claiming an overlapping path scope until release or expiry. Renew it with task_heartbeat while working.' };
    } catch (error) {
      if (leaseCreated) {
        try {
          await mutateProject(projectId, project => ({ ...project, leases: project.leases.filter(item =>
            !(item.task_id === taskId && item.session_id === identity.session_id)) }));
        } catch {}
      }
      throw error;
    }
  }

  async function heartbeat(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const task = await readTask(taskId);
    if (!task || task.value.assignee_session_id !== identity.session_id) throw new Error('Only the current task owner can renew its lease.');
    if (!['claimed', 'in_progress', 'blocked', 'review', 'integration', 'verification'].includes(task.value.status)) {
      throw new Error('This task status cannot renew an ownership lease.');
    }
    const leaseUntil = new Date(clock() + leaseMs).toISOString();
    await mutateProject(task.value.project_id, project => ({
      ...project,
      leases: project.leases.map(item => item.task_id === taskId && item.session_id === identity.session_id
        ? { ...item, expires_at: leaseUntil } : item)
    }));
    const updated = await mutateTask(taskId, current => ({
      ...current, lease_expires_at: leaseUntil
    }));
    return { task_id: taskId, lease_expires_at: leaseUntil, status: updated.status };
  }

  async function updateTask(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const nextStatus = String(args.status || '');
    if (!['in_progress', 'blocked', 'ready', 'failed', 'cancelled'].includes(nextStatus)) {
      throw new Error('task_update.status must be in_progress, blocked, ready, failed, or cancelled. Use the dedicated submit/review/integrate/verify tools for gated transitions.');
    }
    const existing = await readTask(taskId);
    if (!existing || existing.value.assignee_session_id !== identity.session_id) throw new Error('Only the assigned session may update this task.');
    const reason = boundedText(args.reason, 2000, 'reason', nextStatus === 'blocked');
    if (['failed', 'cancelled'].includes(nextStatus)) await releaseTaskLease(existing.value.project_id, taskId, identity.session_id);
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: nextStatus, blocked_reason: nextStatus === 'blocked' ? reason : null,
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id, by_agent_id: identity.agent_id, action: 'status_changed', status: nextStatus, ...(reason ? { reason } : {}) }].slice(-100)
    }));
    if (!['failed', 'cancelled'].includes(nextStatus)) await heartbeat(identity, { task_id: taskId });
    return taskSummary(updated);
  }

  async function releaseTaskLease(projectId, taskId, sessionId) {
    await mutateProject(projectId, project => ({
      ...project, leases: project.leases.filter(item => !(item.task_id === taskId && item.session_id === sessionId))
    }));
  }

  async function submitTask(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const task = await readTask(taskId);
    if (!task || task.value.assignee_session_id !== identity.session_id) throw new Error('Only the assigned session may submit this task.');
    if (!['claimed', 'in_progress', 'needs_rework'].includes(task.value.status)) throw new Error('Task must be claimed, in progress, or needs_rework before submission.');
    const commit = boundedText(args.commit_sha, 40, 'commit_sha', true);
    if (!/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('commit_sha must be a Git commit hash.');
    const changed = Array.isArray(args.changed_paths) ? [...new Set(args.changed_paths.map(normalizeScopePath))] : [];
    if (changed.length > 200) throw new Error('changed_paths may contain at most 200 entries.');
    const outOfScope = changed.filter(path => !task.value.scope_paths.some(scope => pathsOverlap(scope, path)));
    if (task.value.scope_paths.length && outOfScope.length) throw new Error('SUBMISSION_OUT_OF_SCOPE: changed paths exceed the task ownership scope: ' + outOfScope.join(', '));
    const evidence = Array.isArray(args.evidence) ? args.evidence : [];
    if (evidence.length < 1 || evidence.length > 30) throw new Error('evidence must contain 1–30 verification/build/test evidence items.');
    const normalizedEvidence = evidence.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('evidence[' + index + '] must be an object.');
      const kind = String(item.kind || '');
      if (!['implementation', 'build', 'test', 'runtime', 'review'].includes(kind)) throw new Error('Unsupported evidence kind at index ' + index + '.');
      const exitCode = item.exit_code === undefined ? null : item.exit_code;
      if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) throw new Error('evidence exit_code must be an integer from 0–255.');
      return { kind, summary: boundedText(item.summary, 1000, 'evidence summary', true),
        ...(item.command ? { command: boundedText(item.command, 1000, 'evidence command') } : {}),
        ...(exitCode !== null ? { exit_code: exitCode } : {}),
        ...(item.request_id ? { request_id: boundedText(item.request_id, 120, 'evidence request_id') } : {}) };
    });
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: 'review',
      submissions: [...current.submissions, {
        commit_sha: commit, branch: boundedText(args.branch || current.branch, 120, 'branch'),
        worktree_path: normalizeScopePath(args.worktree_path || current.worktree_path || '.'),
        changed_paths: changed, evidence: normalizedEvidence,
        submitted_by_session_id: identity.session_id, submitted_at: timestamp
      }].slice(-20),
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id, by_agent_id: identity.agent_id, action: 'submitted', status: 'review', commit_sha: commit }].slice(-100),
      branch: boundedText(args.branch || current.branch, 120, 'branch'),
      worktree_path: normalizeScopePath(args.worktree_path || current.worktree_path || '.')
    }));
    await heartbeat(identity, { task_id: taskId });
    return taskSummary(updated);
  }

  async function reviewTask(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const verdict = String(args.verdict || '');
    if (!['approve', 'reject'].includes(verdict)) throw new Error('verdict must be approve or reject.');
    const task = await readTask(taskId);
    if (!task || task.value.status !== 'review') throw new Error('Only a task in review can be reviewed.');
    if (task.value.assignee_session_id === identity.session_id) throw new Error('Independent review requires a different session from the task owner.');
    const comment = boundedText(args.comment, 3000, 'comment', verdict === 'reject');
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: verdict === 'approve' ? 'integration' : 'needs_rework',
      reviews: [...current.reviews, { reviewer_session_id: identity.session_id, reviewer_agent_id: identity.agent_id,
        verdict, comment, reviewed_at: timestamp }].slice(-20),
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id, by_agent_id: identity.agent_id,
        action: 'review_' + verdict, status: verdict === 'approve' ? 'integration' : 'needs_rework' }].slice(-100)
    }));
    if (verdict === 'reject') await heartbeat({ ...identity, session_id: task.value.assignee_session_id, agent_id: task.value.assignee_agent_id }, { task_id: taskId }).catch(() => {});
    return taskSummary(updated);
  }

  async function integrateTask(identity, args = {}, executeIntegration) {
    validateIdentity(identity);
    if (typeof executeIntegration !== 'function') throw new Error('The local Git integration executor is unavailable.');
    const taskId = String(args.task_id || '');
    const task = await readTask(taskId);
    if (!task || task.value.status !== 'integration') throw new Error('Only an approved task in integration can be merged.');
    if (task.value.assignee_session_id === identity.session_id) throw new Error('A separate integrator session is required.');
    const submission = task.value.submissions[task.value.submissions.length - 1];
    if (!submission || !/^[a-f0-9]{7,40}$/i.test(submission.commit_sha)) throw new Error('The task has no valid submitted commit.');
    const path = boundedText(args.worktree_path || submission.worktree_path, 512, 'worktree_path', true);
    const branch = boundedText(args.branch || submission.branch, 120, 'branch', true);
    const targetBranch = boundedText(args.target_branch, 120, 'target_branch', true);
    const output = await executeIntegration({ operation: 'integrate', path, branch, targetBranch });
    if (!output || output.integrated !== true || !/^[a-f0-9]{7,40}$/i.test(String(output.merge_commit || ''))) {
      throw new Error('The local Git worktree integration did not confirm a merge commit.');
    }
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: 'verification',
      integration: { source_branch: branch, target_branch: targetBranch,
        merge_commit: output.merge_commit, merged_at: timestamp, integrated_by_session_id: identity.session_id },
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id,
        by_agent_id: identity.agent_id, action: 'integrated', status: 'verification', merge_commit: output.merge_commit }].slice(-100)
    }));
    return { ...taskSummary(updated), integration: updated.integration };
  }

  async function verifyTask(identity, args = {}, executeVerification) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const task = await readTask(taskId);
    if (!task || task.value.status !== 'verification') throw new Error('Only an integrated task awaiting verification can be verified.');
    if (task.value.assignee_session_id === identity.session_id) throw new Error('Independent verification requires a session other than the task owner.');
    const checks = Array.isArray(args.checks) ? args.checks : [];
    if (checks.length < 1 || checks.length > 10) throw new Error('checks must contain 1–10 build/test/runtime checks.');
    const results = [];
    for (const check of checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error('Each verification check must be an object.');
      const kind = String(check.kind || '');
      if (!['build', 'test', 'runtime'].includes(kind)) throw new Error('Verification kind must be build, test, or runtime.');
      const summary = boundedText(check.summary, 1000, 'verification summary', true);
      if (typeof check.command !== 'string' || !check.command.trim()) throw new Error('Each verification check requires a runnable command.');
      if (typeof executeVerification !== 'function') throw new Error('The local verification executor is unavailable.');
      const command = boundedText(check.command, 4000, 'verification command', true);
      const output = await executeVerification({ command, timeoutMs: Number.isInteger(check.timeout_ms) ? Math.min(Math.max(check.timeout_ms, 1000), 120000) : 120000 });
      results.push({ kind, summary, command, exit_code: Number.isInteger(output && output.exitCode) ? output.exitCode : 1,
        duration_ms: Number.isFinite(output && output.durationMs) ? output.durationMs : null,
        request_id: output && output.call_id || null,
        stdout_tail: String(output && output.stdout || '').slice(-2000),
        stderr_tail: String(output && output.stderr || '').slice(-2000) });
    }
    const missingKinds = ['build', 'test', 'runtime'].filter(kind => !results.some(item => item.kind === kind));
    if (missingKinds.length) throw new Error('Independent verification must include build, test, and runtime checks. Missing: ' + missingKinds.join(', '));
    const failed = results.filter(item => item.exit_code !== 0);
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: failed.length ? 'needs_rework' : 'verified',
      verification: { verified_by_session_id: identity.session_id, verified_by_agent_id: identity.agent_id,
        verified_at: timestamp, checks: results, passed: failed.length === 0 },
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id, by_agent_id: identity.agent_id,
        action: failed.length ? 'verification_failed' : 'verified', status: failed.length ? 'needs_rework' : 'verified' }].slice(-100)
    }));
    if (!failed.length) await releaseTaskLease(task.value.project_id, taskId, task.value.assignee_session_id);
    return { ...taskSummary(updated), verification: updated.verification, failed_checks: failed.map(item => item.kind) };
  }

  async function addDecision(identity, args = {}) {
    validateIdentity(identity);
    const projectId = String(args.project_id || '');
    const decision = boundedText(args.decision, 3000, 'decision', true);
    const rationale = boundedText(args.rationale, 5000, 'rationale', true);
    const impacts = Array.isArray(args.affected_modules) ? [...new Set(args.affected_modules.map(x => boundedText(x, 180, 'affected_modules item', true)))] : [];
    if (impacts.length > 50) throw new Error('affected_modules may contain at most 50 entries.');
    const refs = Array.isArray(args.references) ? args.references.map(x => boundedText(x, 300, 'reference', true)) : [];
    if (refs.length > 30) throw new Error('references may contain at most 30 entries.');
    const record = { decision_id: 'decision-' + randomBytes(12).toString('hex'),
      decision, rationale, affected_modules: impacts, references: refs,
      created_at: now(), created_by_session_id: identity.session_id, created_by_agent_id: identity.agent_id };
    const updated = await mutateProject(projectId, project => ({ ...project, decisions: [...project.decisions, record].slice(-200) }));
    return { project_id: projectId, ...record, retained_decisions: updated.decisions.length };
  }

  async function releaseTaskLease(projectId, taskId, sessionId) {
    await mutateProject(projectId, project => ({
      ...project, leases: project.leases.filter(item => !(item.task_id === taskId && item.session_id === sessionId))
    }));
  }

  async function cancelTask(identity, args = {}) {
    validateIdentity(identity);
    const taskId = String(args.task_id || '');
    const task = await readTask(taskId);
    if (!task) throw new Error('Task not found.');
    if (task.value.created_by_session_id !== identity.session_id && task.value.assignee_session_id !== identity.session_id) {
      throw new Error('Only the task creator or current owner may cancel it.');
    }
    const timestamp = now();
    const updated = await mutateTask(taskId, current => ({
      ...current, status: 'cancelled',
      history: [...current.history, { at: timestamp, by_session_id: identity.session_id, by_agent_id: identity.agent_id, action: 'cancelled', status: 'cancelled' }].slice(-100)
    }));
    if (updated.assignee_session_id) await releaseTaskLease(updated.project_id, taskId, updated.assignee_session_id);
    return taskSummary(updated);
  }

  return {
    initProject, getProject, createTask, listTasks, getTask, claimTask, heartbeat,
    updateTask, submitTask, reviewTask, integrateTask, verifyTask, addDecision, cancelTask,
    taskPath, projectPath, TASK_PROTOCOL, PROJECT_PROTOCOL, TASK_STATES
  };
}

module.exports = {
  createTaskOrchestrator, TASK_PROTOCOL, PROJECT_PROTOCOL, TASK_ID_PATTERN, PROJECT_ID_PATTERN,
  TASK_STATES, pathsOverlap, normalizeScopePath
};