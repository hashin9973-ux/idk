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
  await assert.rejects(tasks.claimTask(b, { task_id: (await tasks.createTask(a, { project_id: project.project_id, title: 'Player file', objective: 'Edit same area', acceptance_criteria: ['No conflict'], scope_paths: ['Source/Game/Player.cpp'] })).task_id }), /TASK_SCOPE_CONFLICT/);
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
  const integrated = await tasks.integrateTask(b, { task_id: task.task_id, target_branch: 'main' }, async input => {
    integrationCalls++;
    assert.deepEqual(input, { operation: 'integrate', path: '.bridge-worktrees/gameplay', branch: 'task/gameplay', targetBranch: 'main' });
    return { integrated: true, merge_commit: 'b'.repeat(40) };
  });
  assert.equal(integrated.status, 'verification');
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
