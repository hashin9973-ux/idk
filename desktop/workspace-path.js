'use strict';

const path = require('node:path');
const fs = require('node:fs');

function isFilesystemRoot(resolvedPath, pathApi = path) {
  if (typeof resolvedPath !== 'string' || !resolvedPath.trim()) return false;
  const candidate = /^[a-z]:$/i.test(resolvedPath.trim()) ? resolvedPath.trim() + pathApi.sep : resolvedPath.trim();
  const resolved = pathApi.resolve(candidate);
  const root = pathApi.parse(resolved).root;
  return Boolean(root && resolved.toLowerCase() === root.toLowerCase());
}

/**
 * Resolve the configured workspace. An explicitly selected filesystem/drive
 * root is valid; the caller is responsible for presenting the whole-drive
 * warning when the user selects one.
 */
function resolveWorkspaceRoot(configuredPath, fallbackPath, pathApi = path) {
  for (const candidate of [configuredPath, fallbackPath]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      // path.resolve('C:') is drive-relative on Windows, not the drive root.
      const value = /^[a-z]:$/i.test(candidate.trim()) ? candidate.trim() + pathApi.sep : candidate.trim();
      const resolved = pathApi.resolve(value);
      if (resolved) return resolved;
    } catch {}
  }
  throw new Error('No usable workspace directory is configured. Choose a drive or folder, or use the default Documents workspace.');
}

/**
 * Validate a workspace without trying to create it when it already exists.
 * This matters on Windows, where mkdir('C:\\', { recursive: true }) can throw
 * EPERM even though the drive root is a valid existing directory.
 */
function ensureWorkspaceDirectory(workspacePath, fsApi = fs) {
  if (!fsApi.existsSync(workspacePath)) {
    fsApi.mkdirSync(workspacePath, { recursive: true });
  }
  if (!fsApi.statSync(workspacePath).isDirectory()) {
    throw new Error('The configured workspace path exists but is not a directory: ' + workspacePath);
  }
  return workspacePath;
}

module.exports = { isFilesystemRoot, resolveWorkspaceRoot, ensureWorkspaceDirectory };
