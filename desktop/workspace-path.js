'use strict';

const path = require('node:path');

function isFilesystemRoot(resolvedPath, pathApi = path) {
  if (typeof resolvedPath !== 'string' || !resolvedPath.trim()) return false;
  const resolved = pathApi.resolve(resolvedPath);
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
      const resolved = pathApi.resolve(candidate.trim());
      if (resolved) return resolved;
    } catch {}
  }
  throw new Error('No usable workspace directory is configured. Choose a drive or folder, or use the default Documents workspace.');
}

module.exports = { isFilesystemRoot, resolveWorkspaceRoot };
