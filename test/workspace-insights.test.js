'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectWorkspace, detectProjectTypes } = require('../desktop/workspace-insights');

test('project markers recognize common game and application project roots', () => {
  assert.deepEqual(detectProjectTypes([
    { name: 'Assets', isDirectory: true },
    { name: 'ProjectSettings', isDirectory: true },
    { name: 'Sample.uproject', isFile: true }
  ]), ['Unreal Engine', 'Unity']);
});

test('workspace inspection identifies a single nested project without walking recursively', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-insights-'));
  try {
    const project = path.join(root, 'Game');
    fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(project, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    const calls = [];
    const profile = await inspectWorkspace(root, {
      skipToolchainDiscovery: true,
      execFileAsync: async (_command, args) => {
        calls.push(args);
        throw new Error('not a git repository');
      }
    });
    assert.equal(profile.workspaceRoot, root);
    assert.equal(profile.detectedProjectRoot, project);
    assert.deepEqual(profile.projectTypes, ['Unity']);
    assert.equal(profile.nestedProjectCandidates.length, 1);
    assert.ok(profile.projectSupport.projects.some(item => item.root === 'Game' && item.projectTypes.includes('Unity')));
    assert.ok(profile.projectSupport.scan.entriesVisited > 0);
    assert.equal(profile.git.repository, false);
    assert.equal(calls.length, 1, 'only the bounded git-root probe is attempted for a non-repository');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace inspection reports git root, branch, and tracked working-tree dirtiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-insights-git-'));
  try {
    const calls = [];
    const profile = await inspectWorkspace(root, {
      execFileAsync: async (_command, args) => {
        calls.push(args);
        if (args[2] === 'rev-parse' && args[3] === '--show-toplevel') return { stdout: root };
        if (args[2] === 'rev-parse' && args[3] === '--abbrev-ref') return { stdout: 'feature/test\n' };
        if (args[2] === 'status') return { stdout: ' M src/main.js\n' };
        throw new Error('unexpected git invocation');
      }
    });
    assert.deepEqual(profile.git, { repository: true, root, branch: 'feature/test', dirty: true });
    assert.ok(Array.isArray(profile.projectSupport.projects));
    assert.equal(calls.length, 3);
    assert.ok(calls.every(args => args[0] === '-C' && args[1] === root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
