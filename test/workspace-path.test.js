'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isFilesystemRoot, resolveWorkspaceRoot } = require('../desktop/workspace-path');

test('rejects a Windows drive root as a workspace folder', () => {
  assert.equal(isFilesystemRoot('C:\\', path.win32), true);
  assert.equal(
    resolveWorkspaceRoot('C:\\', 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace', path.win32),
    'C:\\Users\\Example\\Documents\\ChatGPTWorkspace'
  );
});

test('preserves a valid selected workspace directory', () => {
  assert.equal(
    resolveWorkspaceRoot('D:\\Projects\\my-work', 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace', path.win32),
    'D:\\Projects\\my-work'
  );
});

test('uses the fallback for missing, empty, or filesystem-root settings', () => {
  const fallback = 'C:\\Users\\Example\\Documents\\ChatGPTWorkspace';
  assert.equal(resolveWorkspaceRoot(undefined, fallback, path.win32), fallback);
  assert.equal(resolveWorkspaceRoot('   ', fallback, path.win32), fallback);
  assert.equal(resolveWorkspaceRoot('\\', fallback, path.win32), fallback);
});

test('does not return a filesystem root when both paths are invalid', () => {
  assert.throws(() => resolveWorkspaceRoot('C:\\', 'D:\\', path.win32), /No usable workspace directory/);
});
