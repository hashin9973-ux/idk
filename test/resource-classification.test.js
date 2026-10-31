'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutionScheduler } = require('../desktop/execution-scheduler');
const { resourcePoolsForTool, getExecutionFootprint } = require('../desktop/tool-bridge');

test('resource classification applies I/O, analysis, build, engine and desktop pools', () => {
  assert.deepEqual(resourcePoolsForTool('write_file'), ['filesystem', 'disk-io']);
  assert.deepEqual(resourcePoolsForTool('project_search'), ['source-analysis', 'disk-io']);
  assert.deepEqual(resourcePoolsForTool('run_tests'), ['compilation', 'disk-io']);
  assert.deepEqual(resourcePoolsForTool('shell', { command: 'RunUAT.bat BuildCookRun' }), ['cook']);
  assert.deepEqual(resourcePoolsForTool('shell', { command: 'UnrealEditor-Cmd.exe -run=Something' }), ['editor']);
  assert.deepEqual(resourcePoolsForTool('shell', { command: 'npm run package' }), ['packaging']);
  assert.deepEqual(resourcePoolsForTool('shell', { command: 'assetregistry uasset export' }), ['binary-assets']);
  assert.deepEqual(resourcePoolsForTool('computer'), ['desktop-control']);
  assert.ok(getExecutionFootprint('git_worktree', { operation: 'integrate' }).resourcePools.includes('git'));
});

test('scheduler reports host CPU/memory and adaptive compilation capacity', () => {
  const scheduler = createExecutionScheduler();
  try {
    const state = scheduler.getState();
    assert.ok(Number.isInteger(state.resourceMetrics.cpu_cores) && state.resourceMetrics.cpu_cores > 0);
    assert.ok(Number(state.resourceMetrics.total_memory_bytes) > 0);
    assert.ok(Number(state.resourceMetrics.free_memory_bytes) > 0);
    assert.equal(typeof state.resourceMetrics.memory_pressure, 'boolean');
    assert.ok(state.resourcePools.compilation.limit >= 1 && state.resourcePools.compilation.limit <= 2);
  } finally {
    void scheduler.stop();
  }
});
