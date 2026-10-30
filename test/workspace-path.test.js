'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isFilesystemRoot, resolveWorkspaceRoot, resolveSessionWorkspaceRoot, ensureWorkspaceDirectory } = require('../desktop/workspace-path');

test('allows an explicitly selected Windows drive root as a workspace', () => {
  assert.equal(isFilesystemRoot('C:\\', path.win32), true);
  assert.equal(
    resolveWorkspaceRoot('C:\\', 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace', path.win32),
    'C:\\'
  );
});

test('preserves a selected workspace folder', () => {
  assert.equal(
    resolveWorkspaceRoot('D:\\Projects\\my-work', 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace', path.win32),
    'D:\\Projects\\my-work'
  );
});

test('uses the fallback for missing or empty settings', () => {
  const fallback = 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace';
  assert.equal(resolveWorkspaceRoot(undefined, fallback, path.win32), fallback);
  assert.equal(resolveWorkspaceRoot('   ', fallback, path.win32), fallback);
});

test('recognizes filesystem roots using the supplied path implementation', () => {
  assert.equal(isFilesystemRoot('\\', path.win32), true);
  assert.equal(isFilesystemRoot('D:\\', path.win32), true);
  assert.equal(isFilesystemRoot('D:\\Projects', path.win32), false);
});

test('normalizes a drive-relative-looking picker result to the full drive root', () => {
  assert.equal(isFilesystemRoot('C:', path.win32), true);
  assert.equal(resolveWorkspaceRoot('C:', 'C:\\Users\\Example', path.win32), 'C:\\');
  assert.equal(resolveWorkspaceRoot('D:', 'C:\\Users\\Example', path.win32), 'D:\\');
});

test('resolves and restores separate workspace overrides by stable session ID', () => {
  const globalRoot = 'C:\\GlobalWorkspace';
  const firstSession = 'session-' + 'a'.repeat(32);
  const secondSession = 'session-' + 'b'.repeat(32);
  const recycledSeatNewSession = 'session-' + 'c'.repeat(32);
  const persistedSettings = JSON.stringify({ agentWorkspaces: {
    [firstSession]: 'D:',
    [secondSession]: 'E:\\AgentTwo'
  } });
  const restoredSettings = JSON.parse(persistedSettings);
  const overrides = restoredSettings.agentWorkspaces;

  assert.equal(resolveSessionWorkspaceRoot(firstSession, overrides, globalRoot, globalRoot, path.win32), 'D:\\');
  assert.equal(resolveSessionWorkspaceRoot(secondSession, overrides, globalRoot, globalRoot, path.win32), 'E:\\AgentTwo');
  assert.equal(resolveSessionWorkspaceRoot(recycledSeatNewSession, overrides, globalRoot, globalRoot, path.win32), globalRoot);
  assert.equal(resolveSessionWorkspaceRoot('invalid-session', overrides, globalRoot, globalRoot, path.win32), globalRoot);
  assert.equal(resolveSessionWorkspaceRoot(firstSession, [], globalRoot, globalRoot, path.win32), globalRoot);
});



test('does not call mkdir for an existing Windows drive root', () => {
  // Minimal test double: model Windows returning EPERM for mkdir on an existing drive root.
  const calls = [];
  const fsDouble = {
    existsSync(candidate) {
      assert.equal(candidate, 'C:\\');
      return true;
    },
    mkdirSync(candidate, options) {
      calls.push({ candidate, options });
      const error = new Error("EPERM: operation not permitted, mkdir 'C:\\'");
      error.code = 'EPERM';
      throw error;
    },
    statSync(candidate) {
      assert.equal(candidate, 'C:\\');
      return { isDirectory: () => true };
    }
  };

  assert.equal(ensureWorkspaceDirectory('C:\\', fsDouble), 'C:\\');
  assert.deepEqual(calls, []);
});

test('creates a missing workspace folder then validates it', () => {
  // Minimal test double for a new folder; the implementation must request recursive creation.
  let exists = false;
  let createOptions = null;
  const fsDouble = {
    existsSync() { return exists; },
    mkdirSync(candidate, options) {
      assert.equal(candidate, 'C:\\Projects\\Workspace');
      createOptions = options;
      exists = true;
    },
    statSync() { return { isDirectory: () => exists }; }
  };

  assert.equal(ensureWorkspaceDirectory('C:\\Projects\\Workspace', fsDouble), 'C:\\Projects\\Workspace');
  assert.deepEqual(createOptions, { recursive: true });
});

test('rejects an existing workspace path that is a file', () => {
  const fsDouble = {
    existsSync() { return true; },
    mkdirSync() { assert.fail('must not try to create a directory over a file'); },
    statSync() { return { isDirectory: () => false }; }
  };

  assert.throws(
    () => ensureWorkspaceDirectory('C:\\not-a-directory.txt', fsDouble),
    /configured workspace path exists but is not a directory/
  );
});
