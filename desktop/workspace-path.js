'use strict';

const path = require('node:path');

function isFilesystemRoot(resolvedPath, pathApi = path) {
  const root = pathApi.parse(resolvedPath).root;
  return Boolean(root && resolvedPath.toLowerCase() === root.toLowerCase());
}

/**
 * Resolve a saved workspace directory, rejecting drive/filesystem roots.
 * Invalid settings are redirected to the known-good fallback workspace.
 * pathApi is injectable so Windows path rules can be tested on any platform.
 */
function resolveWorkspaceRoot(configuredPath, fallbackPath, pathApi = path) {
  const candidates = [configuredPath, fallbackPath];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let resolvedPath;
    try {
      resolvedPath = pathApi.resolve(candidate.trim());
    } catch {
      continue;
    }
    if (!isFilesystemRoot(resolvedPath, pathApi)) return resolvedPath;
  }
  throw new Error('No usable workspace directory is configured. Choose a folder beneath the drive root or use the default Documents workspace.');
}

module.exports = { isFilesystemRoot, resolveWorkspaceRoot };
