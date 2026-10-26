'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isFilesystemRoot, resolveWorkspaceRoot } = require('../desktop/workspace-path');

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
