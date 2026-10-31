'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskOrchestrator, pathsOverlap } = require('../desktop/task-orchestrator');

function mailbox() {
  const files = new Map();
  let revision = 0;
  return {
    files,
    async readRemoteFile(path) {
      const row = files.get(path);
      return row ? { value: structuredClone(row.value), sha: row.sha } : null;
    },
    async listFolder(folder) {
      return [...files.entries()].filter(([path]) => path.startsWith(folder.replace(/\/$/, '') + '/'))
        .map(([path, row]) => ({ name: path.slice(folder.length + 1), sha: row.sha }));
    },
    async writeRemoteJson(path, value, sha, createOnly) {
      const current = files.get(path);
      if (createOnly && current) throw new Error('409 conflict');
      if (!createOnly && (!current || current.sha !== sha)) throw new Error('409 conflict');
      revision++;
      files.set(path, { value: structuredClone(value), sha: 'sha-' + revision });
      return { ok: true };
    }
  };
}

const a = { session_id: 'session-' + 'a'.repeat(32), agent_id: 'agent-001' };
const b = { session_id: 'session-' + 'b'.repeat(32), agent_id: 'agent-002' };
const c = { session_id: 'session-' + 'c'.repeat(32), agent_id: 'agent-003' };
const d = { session_id: 'session-' + 'd'.repeat(32), agent_id: 'agent-004' };

test('task resources treat parent and child paths as conflicting', () => {
  assert.equal(pathsOverlap('Source/Game', 'Source/Game/Player.cpp'), true);
  assert.equal(pathsOverlap('Source/Game', 'Source/Engine'), false);
  assert.equal(pathsOverlap('.', 'Content/Map.umap'), true);
});

test('project tasks enforce dependency completion and atomic overlapping scope leases', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000, leaseMs: 1000 });
  const project = await tasks.initProject(a, { name: 'Game' });
  const first = await tasks.createTask(a, { project_id: project.project_id, title: 'Player module', objective: 'Implement player module', acceptance_criteria: ['Class compiles'], scope_paths: ['Source/Game/Player'] });
  const second = await tasks.createTask(b, { project_id: project.project_id, title: 'Player tests', objective: 'Implement player tests', acceptance_criteria: ['Tests pass'], scope_paths: ['Source/Game/Player/Tests'] , dependencies: [first.task_id] });
  await assert.rejects(tasks.claimTask(b, { task_id: second.task_id }), /TASK_DEPENDENCY_BLOCKED/);
  await tasks.claimTask(a, { task_id: first.task_id });
  await assert.rejects(tasks.claimTask(b, { task_id: first.task_id }), /TASK_ALREADY_CLAIMED/);
  await assert.rejects(tasks.claimTask(b, { task_id: (await tasks.createTask(a, { project_id: project.project_id, title: 'Player file', objective: 'Edit same area', acceptance_criteria: ['No conflict'], scope_paths: ['Source/Game/Player/Player.cpp'] })).task_id }), /TASK_SCOPE_CONFLICT/);
});

test('explicit hierarchical module scopes are case-insensitive project-wide ownership locks', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Module ownership' });
  const runtime = await tasks.createTask(a, {
    project_id: project.project_id, title: 'Runtime module', objective: 'Edit runtime',
    acceptance_criteria: ['Runtime builds'], scope_paths: ['Source/Game/Runtime'],
    scope_modules: ['Game.Runtime']
  });
  const nestedRuntime = await tasks.createTask(b, {
    project_id: project.project_id, title: 'Runtime AI', objective: 'Edit nested runtime module',
    acceptance_criteria: ['AI builds'], scope_paths: ['Source/Game/AI'],
    scope_modules: ['game.runtime.ai']
  });
  const editor = await tasks.createTask(c, {
    project_id: project.project_id, title: 'Editor module', objective: 'Edit editor',
    acceptance_criteria: ['Editor builds'], scope_paths: ['Source/Game/Editor'],
    scope_modules: ['Game.Editor']
  });
  const descriptiveOnly = await tasks.createTask(d, {
    project_id: project.project_id, title: 'Metadata only', objective: 'Keep label descriptive',
    acceptance_criteria: ['Tests build'], scope_paths: ['Source/Game/Tests'],
    module: 'Game.Runtime'
  });
  await tasks.claimTask(a, { task_id: runtime.task_id });
  await assert.rejects(tasks.claimTask(b, { task_id: nestedRuntime.task_id }), /TASK_SCOPE_CONFLICT/);
  const editorClaim = await tasks.claimTask(c, { task_id: editor.task_id });
  assert.deepEqual(editorClaim.module_ownership, ['Game.Editor']);
  const metadataClaim = await tasks.claimTask(d, { task_id: descriptiveOnly.task_id });
  assert.deepEqual(metadataClaim.module_ownership, []);
});

test('independent review, real worktree integration callback, and complete verification gate tasks', async () => {
  const deps = mailbox();
  let integrationCalls = 0, verificationCalls = 0;
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Game' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'Gameplay', objective: 'Implement gameplay', acceptance_criteria: ['Works'], scope_paths: ['Source/Game'] });
  await tasks.claimTask(a, { task_id: task.task_id, branch: 'task/gameplay', worktree_path: '.bridge-worktrees/gameplay' });
  await tasks.updateTask(a, { task_id: task.task_id, status: 'in_progress' });
  await tasks.submitTask(a, { task_id: task.task_id, commit_sha: 'a'.repeat(40), changed_paths: ['Source/Game/Player.cpp'], evidence: [{ kind: 'implementation', summary: 'Implemented.' }] });
  await assert.rejects(tasks.reviewTask(a, { task_id: task.task_id, verdict: 'approve' }), /different session/);
  await tasks.reviewTask(b, { task_id: task.task_id, verdict: 'approve' });
  await assert.rejects(tasks.integrateTask(b, { task_id: task.task_id, target_branch: 'main' }, async () => ({
    integrated: true, source_commit: 'c'.repeat(40), target_before: 'd'.repeat(40),
    changed_paths: ['Source/Game/Player.cpp'], merge_commit: 'b'.repeat(40)
  })), /did not verify the submitted commit and actual changed paths/);
  const integrated = await tasks.integrateTask(b, { task_id: task.task_id, target_branch: 'main' }, async input => {
    integrationCalls++;
    assert.deepEqual(input, {
      operation: 'integrate', path: '.bridge-worktrees/gameplay', branch: 'task/gameplay', targetBranch: 'main',
      submittedCommitSha: 'a'.repeat(40), scopePaths: ['Source/Game'],
      expectedChangedPaths: ['Source/Game/Player.cpp']
    });
    return {
      integrated: true, source_commit: 'a'.repeat(40), target_before: 'd'.repeat(40),
      changed_paths: ['Source/Game/Player.cpp'], merge_commit: 'b'.repeat(40)
    };
  });
  assert.equal(integrated.status, 'verification');
  assert.equal(integrated.integration.source_commit, 'a'.repeat(40));
  assert.deepEqual(integrated.integration.changed_paths, ['Source/Game/Player.cpp']);
  const verified = await tasks.verifyTask(b, { task_id: task.task_id, checks: [
    { kind: 'build', summary: 'Build succeeded', command: 'build' },
    { kind: 'test', summary: 'Tests passed', command: 'test' },
    { kind: 'runtime', summary: 'Runtime smoke test passed', command: 'smoke' }
  ] }, async input => { verificationCalls++; return { exitCode: 0, durationMs: 12, stdout: 'ok', stderr: '' }; });
  assert.equal(verified.status, 'verified');
  assert.equal(integrationCalls, 1);
  assert.equal(verificationCalls, 3);
});

test('task submission cannot claim changes outside the reserved path scope', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator(deps);
  const project = await tasks.initProject(a, { name: 'Game' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'UI', objective: 'UI changes', acceptance_criteria: ['Works'], scope_paths: ['Source/UI'] });
  await tasks.claimTask(a, { task_id: task.task_id });
  await assert.rejects(tasks.submitTask(a, { task_id: task.task_id, commit_sha: 'c'.repeat(40), changed_paths: ['Source/Net/Socket.cpp'], evidence: [{ kind: 'implementation', summary: 'Done' }] }), /SUBMISSION_OUT_OF_SCOPE/);
});

test('dashboard summary is read-only and aggregates projects, task states and ownership leases', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Dashboard game board' });
  await tasks.createTask(a, { project_id: project.project_id, title: 'Ready task', objective: 'Ready', acceptance_criteria: ['exists'], scope_paths: ['Source/Ready'] });
  const summary = await tasks.dashboard();
  assert.equal(summary.project_count, 1);
  assert.equal(summary.projects.length, 1);
  assert.equal(summary.projects[0].project_id, project.project_id);
  assert.equal(summary.projects[0].task_counts.ready, 1);
  assert.equal(summary.projects[0].tasks[0].title, 'Ready task');
});

test('ordinary task claim cannot bypass an independent review gate', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Review gate' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'Gate', objective: 'Prove gates', acceptance_criteria: ['reviewed'], scope_paths: ['Source/Gate'] });
  await tasks.claimTask(a, { task_id: task.task_id });
  await tasks.updateTask(a, { task_id: task.task_id, status: 'in_progress' });
  await tasks.submitTask(a, { task_id: task.task_id, commit_sha: 'd'.repeat(40), changed_paths: ['Source/Gate/Gate.cpp'], evidence: [{ kind: 'implementation', summary: 'Submitted' }] });
  await assert.rejects(tasks.claimTask(b, { task_id: task.task_id }), /TASK_STAGE_LOCKED/);
});

test('ready transition releases the previous task ownership lease', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Release gate' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'Release', objective: 'Release scope', acceptance_criteria: ['released'], scope_paths: ['Source/Release'] });
  await tasks.claimTask(a, { task_id: task.task_id });
  await tasks.updateTask(a, { task_id: task.task_id, status: 'ready' });
  const board = await tasks.getProject(project.project_id);
  assert.equal(board.active_lease_count, 0);
});


test('one session cannot claim overlapping scopes through two different tasks', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator(deps);
  const project = await tasks.initProject(a, { name: 'Same-session isolation' });
  const first = await tasks.createTask(a, { project_id: project.project_id, title: 'Core', objective: 'Edit core', acceptance_criteria: ['Done'], scope_paths: ['Source/Core'] });
  const second = await tasks.createTask(a, { project_id: project.project_id, title: 'Core child', objective: 'Edit same core', acceptance_criteria: ['Done'], scope_paths: ['Source/Core/Player'] });
  await tasks.claimTask(a, { task_id: first.task_id });
  await assert.rejects(tasks.claimTask(a, { task_id: second.task_id }), /TASK_SCOPE_CONFLICT/);
});

test('same dedupe key under concurrent calls creates one durable task', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator(deps);
  const project = await tasks.initProject(a, { name: 'Dedupe' });
  const args = { project_id: project.project_id, title: 'Unique feature', objective: 'Implement once', acceptance_criteria: ['One task'], dedupe_key: 'feature:unique' };
  const [first, second] = await Promise.all([tasks.createTask(a, args), tasks.createTask(b, args)]);
  assert.equal(first.task_id, second.task_id);
  assert.equal(Number(first.deduplicated === true) + Number(second.deduplicated === true), 1);
  const list = await tasks.listTasks(a, { project_id: project.project_id, limit: 100 });
  assert.equal(list.count, 1);
});

test('task list cursor advances by scanned mailbox records without repeating rows', async () => {
  const deps = mailbox();
  let now = 1800000000000;
  const tasks = createTaskOrchestrator({ ...deps, clock: () => ++now });
  const project = await tasks.initProject(a, { name: 'Pagination' });
  for (let i = 0; i < 45; i++) await tasks.createTask(a, {
    project_id: project.project_id, title: 'Task ' + i, objective: 'Pagination test', acceptance_criteria: ['Exists']
  });
  const first = await tasks.listTasks(a, { project_id: project.project_id, limit: 30 });
  assert.equal(first.count, 30);
  assert.equal(first.next_offset, 30);
  const second = await tasks.listTasks(a, { project_id: project.project_id, limit: 30, offset: first.next_offset });
  assert.equal(second.count, 15);
  const ids = [...first.tasks, ...second.tasks].map(item => item.task_id);
  assert.equal(new Set(ids).size, 45);
});


test('disconnecting an implementation owner blocks and unassigns in-progress tasks, releasing their scope leases', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  const project = await tasks.initProject(a, { name: 'Detach active owner' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'Player work', objective: 'Implement player', acceptance_criteria: ['Builds'], scope_paths: ['Source/Game/Player'] });
  await tasks.claimTask(a, { task_id: task.task_id });
  await tasks.updateTask(a, { task_id: task.task_id, status: 'in_progress' });
  const detached = await tasks.detachSession(a.session_id, 'disconnected');
  assert.equal(detached.status, 'completed');
  assert.equal(detached.blocked_and_unassigned, 1);
  const saved = await tasks.getTask(b, { task_id: task.task_id });
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.assignee_session_id, null);
  assert.match(saved.blocked_reason, /disconnected/i);
  assert.equal((await tasks.getProject(project.project_id)).active_lease_count, 0);
  const replacement = await tasks.claimTask(b, { task_id: task.task_id });
  assert.equal(replacement.assignee_session_id, b.session_id);
});

test('detaching a submitted task preserves review gates and submission attribution while allowing independent reviewers and verifiers', async () => {
  const deps = mailbox();
  const tasks = createTaskOrchestrator({ ...deps, clock: () => 1800000000000 });
  let integrations = 0, verifications = 0;
  const project = await tasks.initProject(a, { name: 'Detach submitted owner' });
  const task = await tasks.createTask(a, { project_id: project.project_id, title: 'Submitted feature', objective: 'Implement and validate', acceptance_criteria: ['Builds'], scope_paths: ['Source/Game/Feature'] });
  await tasks.claimTask(a, { task_id: task.task_id, branch: 'task/feature', worktree_path: '.bridge-worktrees/feature' });
  await tasks.updateTask(a, { task_id: task.task_id, status: 'in_progress' });
  await tasks.submitTask(a, { task_id: task.task_id, commit_sha: 'e'.repeat(40), changed_paths: ['Source/Game/Feature/Feature.cpp'], evidence: [{ kind: 'implementation', summary: 'Implemented feature' }] });
  const detached = await tasks.detachSession(a.session_id, 'revoked');
  assert.equal(detached.gated_tasks_preserved, 1);
  let saved = await tasks.getTask(b, { task_id: task.task_id });
  assert.equal(saved.status, 'review');
  assert.equal(saved.assignee_session_id, null);
  assert.equal(saved.submissions[0].submitted_by_session_id, a.session_id);
  await assert.rejects(tasks.reviewTask(a, { task_id: task.task_id, verdict: 'approve' }), /original task implementer/);
  await tasks.reviewTask(b, { task_id: task.task_id, verdict: 'approve' });
  await assert.rejects(tasks.integrateTask(a, { task_id: task.task_id, target_branch: 'main' }, async () => {
    throw new Error('The original implementation session must not integrate its own task.');
  }), /separate integrator/);
  const integrated = await tasks.integrateTask(c, { task_id: task.task_id, target_branch: 'main' }, async input => {
    integrations++;
    assert.equal(input.branch, 'task/feature');
    assert.deepEqual(input, {
      operation: 'integrate', path: '.bridge-worktrees/feature', branch: 'task/feature', targetBranch: 'main',
      submittedCommitSha: 'e'.repeat(40), scopePaths: ['Source/Game/Feature'],
      expectedChangedPaths: ['Source/Game/Feature/Feature.cpp']
    });
    return {
      integrated: true, source_commit: 'e'.repeat(40), target_before: 'd'.repeat(40),
      changed_paths: ['Source/Game/Feature/Feature.cpp'], merge_commit: 'f'.repeat(40)
    };
  });
  assert.equal(integrated.status, 'verification');
  await assert.rejects(tasks.verifyTask(a, { task_id: task.task_id, checks: [
    { kind: 'build', summary: 'Build', command: 'build' },
    { kind: 'test', summary: 'Test', command: 'test' },
    { kind: 'runtime', summary: 'Runtime', command: 'runtime' }
  ] }, async () => { throw new Error('Original implementation session cannot verify itself.'); }), /original task implementer/);
  const verified = await tasks.verifyTask(d, { task_id: task.task_id, checks: [
    { kind: 'build', summary: 'Build passed', command: 'build' },
    { kind: 'test', summary: 'Tests passed', command: 'test' },
    { kind: 'runtime', summary: 'Runtime passed', command: 'runtime' }
  ] }, async () => { verifications++; return { exitCode: 0, durationMs: 10 }; });
  assert.equal(verified.status, 'verified');
  assert.equal(integrations, 1);
  assert.equal(verifications, 3);
  assert.equal((await tasks.getProject(project.project_id)).active_lease_count, 0);
});
