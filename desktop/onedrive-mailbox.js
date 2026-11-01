'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BRIDGE_DIRECTORIES = Object.freeze([
  'requests', 'claims', 'results', 'agents', 'sessions', 'evicted-sessions',
  'revoked-sessions', 'agent-messages', 'agent-message-receipts', 'artifacts',
  'context', 'state', 'projects', 'tasks', 'vision', 'vision/requests',
  'vision/results', 'vision/claims', 'vision/reports'
]);
const MAX_MAILBOX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_READ_ATTEMPTS = 5;
const TRANSIENT_SYNC_READ_CODES = new Set([
  'EACCES', 'EBUSY', 'EAGAIN', 'EIO', 'ENODATA', 'ENOENT', 'EPERM', 'ESTALE'
]);
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function detectOneDriveSyncRoot(env = process.env, fsImpl = fsSync) {
  for (const key of ['OneDriveConsumer', 'OneDriveCommercial', 'OneDrive']) {
    const candidate = env && typeof env[key] === 'string' ? env[key].trim() : '';
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      const stat = fsImpl.statSync(candidate);
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch {}
  }
  return '';
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') ||
      relativePath.includes('\\') || relativePath.split('/').some(part =>
        !part || part === '.' || part === '..' || !SAFE_SEGMENT.test(part))) {
    throw new Error('Unsafe OneDrive mailbox path.');
  }
  const parts = relativePath.split('/');
  if (parts[0] !== 'bridge' || parts.length < 2) {
    throw new Error('Mailbox paths must be below bridge/.');
  }
  return parts;
}

function createOneDriveMailbox({
  getSettings,
  fsImpl = fs,
  env = process.env,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof getSettings !== 'function') throw new TypeError('OneDrive mailbox requires getSettings().');

  function configuredPath() {
    const settings = getSettings() || {};
    const config = settings.repositoryBridge && typeof settings.repositoryBridge === 'object'
      ? settings.repositoryBridge : {};
    const selected = typeof config.oneDrivePath === 'string' ? config.oneDrivePath.trim() : '';
    if (selected) {
      if (!path.isAbsolute(selected)) return '';
      const resolved = path.resolve(selected);
      const parts = resolved.split(path.sep).filter(Boolean);
      if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== 'runtime' ||
          parts[parts.length - 2].toLowerCase() !== 'bridge') return '';
      return resolved;
    }
    const detectedRoot = detectOneDriveSyncRoot(env, fsSync);
    return detectedRoot ? path.join(detectedRoot, 'Bridge', 'runtime') : '';
  }

  // Serialize same-path operations inside this app process. The SHA check is a
  // local conflict detector, not a distributed compare-and-swap against OneDrive.
  const pathLocks = new Map();

  async function withPathLock(target, operation) {
    const resolved = path.resolve(target);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = pathLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    pathLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pathLocks.get(key) === queued) pathLocks.delete(key);
    }
  }

  async function withPathLocks(targets, operation) {
    const ordered = [...new Set(targets.map(target => {
      const resolved = path.resolve(target);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }))].sort();
    async function acquire(index) {
      if (index >= ordered.length) return operation();
      return withPathLock(ordered[index], () => acquire(index + 1));
    }
    return acquire(0);
  }

  function resolvePath(relativePath) {
    const root = configuredPath();
    if (!root || !path.isAbsolute(root)) {
      throw new Error('Choose the OneDrive-synced Bridge/runtime folder in the app settings before connecting.');
    }
    const parts = validateRelativePath(relativePath);
    const target = path.resolve(root, ...parts);
    const relation = path.relative(root, target);
    if (!relation || relation.startsWith('..' + path.sep) || relation === '..' || path.isAbsolute(relation)) {
      throw new Error('OneDrive mailbox path escaped its configured runtime folder.');
    }
    return { root, target, parts };
  }

  async function lstatOptional(target) {
    try { return await fsImpl.lstat(target); }
    catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  }

  async function ensureDirectoryPath(target, { create = false } = {}) {
    const root = path.parse(path.resolve(target)).root;
    const segments = path.resolve(target).slice(root.length).split(path.sep).filter(Boolean);
    let cursor = root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      let stat = await lstatOptional(cursor);
      if (!stat && create) {
        try { await fsImpl.mkdir(cursor); }
        catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
        stat = await lstatOptional(cursor);
      }
      if (!stat) return false;
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('OneDrive mailbox path contains a non-directory or symbolic link: ' + cursor);
      }
    }
    return true;
  }

  async function ensureDirectory(target) {
    const ready = await ensureDirectoryPath(target, { create: true });
    if (!ready) throw new Error('Could not create OneDrive mailbox directory: ' + target);
  }

  async function ensureParent(target) {
    const parent = path.dirname(target);
    await ensureDirectory(parent);
  }

  async function readBytes(relativePath) {
    const { target } = resolvePath(relativePath);
    for (let attempt = 0; attempt < MAX_SYNC_READ_ATTEMPTS; attempt++) {
      let handle = null;
      try {
        if (!await ensureDirectoryPath(path.dirname(target))) return null;
        const stat = await lstatOptional(target);
        if (!stat) return null;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error('Mailbox entry is not a regular file: ' + relativePath);
        }
        if (stat.size > MAX_MAILBOX_FILE_BYTES) {
          throw new Error('OneDrive mailbox file exceeds the 8 MiB safety limit.');
        }
        handle = await fsImpl.open(target, 'r');
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_MAILBOX_FILE_BYTES) {
          throw new Error('OneDrive mailbox file changed to an invalid size while being read.');
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
            bytes.length !== after.size) {
          const error = new Error('OneDrive sync changed the mailbox file during the read; retrying is safe.');
          error.code = 'MAILBOX_TRANSIENT_READ';
          throw error;
        }
        return { bytes, sha: sha256(bytes), size: bytes.length, mtimeMs: after.mtimeMs };
      } catch (error) {
        const retryable = error && (
          error.code === 'MAILBOX_TRANSIENT_READ' || TRANSIENT_SYNC_READ_CODES.has(error.code)
        );
        if (!retryable || attempt === MAX_SYNC_READ_ATTEMPTS - 1) throw error;
        await sleep(100 + attempt * 100);
      } finally {
        if (handle) await handle.close();
      }
    }
    return null;
  }

  async function readJson(relativePath) {
    const attempts = 8;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const stored = await readBytes(relativePath);
      if (!stored) return null;
      try {
        const value = JSON.parse(stored.bytes.toString('utf8'));
        return {
          value,
          sha: stored.sha,
          entry: { type: 'file', sha: stored.sha, size: stored.size, mtimeMs: stored.mtimeMs }
        };
      } catch (error) {
        const transientRead = error && error.code === 'MAILBOX_TRANSIENT_READ';
        if (!(error instanceof SyntaxError) && !transientRead) throw error;
        if (attempt === attempts - 1) {
          if (error instanceof SyntaxError) {
            throw new Error('Malformed or partially synchronized JSON in OneDrive mailbox path ' + relativePath + '.');
          }
          throw error;
        }
        await sleep(80 + attempt * 40);
      }
    }
    return null;
  }

  async function readContent(relativePath) {
    const stored = await readBytes(relativePath);
    if (!stored) return null;
    return {
      content: stored.bytes,
      sha: stored.sha,
      entry: { type: 'file', sha: stored.sha, size: stored.size, mtimeMs: stored.mtimeMs }
    };
  }

  async function listFolder(relativePath) {
    const { target } = resolvePath(relativePath);
    if (!await ensureDirectoryPath(target)) return [];
    const children = await fsImpl.readdir(target, { withFileTypes: true });
    const result = [];
    for (const child of children) {
      if (!SAFE_SEGMENT.test(child.name) || child.name === '.' || child.name === '..') continue;
      if (child.isSymbolicLink()) throw new Error('OneDrive mailbox contains an unexpected symbolic link.');
      result.push({
        name: child.name,
        path: relativePath + '/' + child.name,
        type: child.isDirectory() ? 'dir' : child.isFile() ? 'file' : 'other',
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function writeBytes(relativePath, bytes, { createOnly = false, expectedSha = null, allowUnchanged = false } = {}) {
    const { target } = resolvePath(relativePath);
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length > MAX_MAILBOX_FILE_BYTES) throw new Error('OneDrive mailbox write exceeds the 8 MiB safety limit.');
    const contentSha = sha256(bytes);

    return withPathLock(target, async () => {
      await ensureParent(target);
      const existing = await readBytes(relativePath);
      if (existing) {
        if (allowUnchanged && existing.sha === contentSha) {
          return { ok: true, unchanged: true, sha: existing.sha, bytes: bytes.length, sha256: existing.sha };
        }
        if (createOnly) return { ok: false, conflict: true, sha: existing.sha };
        if (typeof expectedSha !== 'string' || !expectedSha) {
          const error = new Error('A current content hash is required before updating an existing OneDrive mailbox file: ' + relativePath);
          error.code = 'MAILBOX_CONFLICT';
          throw error;
        }
        if (existing.sha !== expectedSha) {
          const error = new Error('OneDrive mailbox file changed concurrently; refusing to overwrite ' + relativePath + '.');
          error.code = 'MAILBOX_CONFLICT';
          throw error;
        }
      } else if (expectedSha) {
        const error = new Error('OneDrive mailbox file disappeared before it could be updated: ' + relativePath);
        error.code = 'MAILBOX_CONFLICT';
        throw error;
      }

      const temp = target + '.pending-' + crypto.randomUUID();
      const handle = await fsImpl.open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        if (createOnly || !existing) {
          // A hard link publishes the fully written temporary file atomically and
          // fails when the destination already exists. Never fall back to writing
          // a partially visible final JSON file on filesystems without link support.
          try {
            await fsImpl.link(temp, target);
          } catch (error) {
            if (error && error.code === 'EEXIST') {
              const raced = await readBytes(relativePath);
              if (allowUnchanged && raced && raced.sha === contentSha) {
                return { ok: true, unchanged: true, sha: raced.sha, bytes: bytes.length, sha256: raced.sha };
              }
              return { ok: false, conflict: true, sha: raced && raced.sha || null };
            }
            if (error && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
              const unsupported = new Error('This OneDrive sync folder does not support atomic create-only mailbox writes; the worker refused a non-atomic fallback.');
              unsupported.code = 'ONEDRIVE_ATOMIC_CREATE_UNSUPPORTED';
              throw unsupported;
            }
            throw error;
          }
        } else {
          // Re-read after staging to catch local or synchronized changes that
          // arrived while the temporary file was being written. This narrows the
          // race window but cannot make OneDrive a distributed compare-and-swap.
          const latest = await readBytes(relativePath);
          if (!latest || latest.sha !== expectedSha) {
            const error = new Error('OneDrive mailbox file changed while the update was staged; refusing to replace ' + relativePath + '.');
            error.code = 'MAILBOX_CONFLICT';
            throw error;
          }
          await fsImpl.rename(temp, target);
        }

        // Verify what is visible at the final path before reporting publication.
        // A sync conflict that replaces our write is surfaced rather than silently
        // reported as success; this read-back is still not a cloud acknowledgement.
        const published = await readBytes(relativePath);
        if (!published || published.sha !== contentSha) {
          const error = new Error('OneDrive mailbox file changed during local publication; the final content hash did not match.');
          error.code = 'MAILBOX_SYNC_CONFLICT';
          throw error;
        }
        return { ok: true, unchanged: false, sha: contentSha, bytes: bytes.length, sha256: contentSha };
      } finally {
        await fsImpl.unlink(temp).catch(() => {});
      }
    });
  }

  async function writeJson(relativePath, value, expectedSha = null, createOnly = false) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    return writeBytes(relativePath, bytes, { createOnly, expectedSha });
  }

  async function writeContent(relativePath, content, options = {}) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    return writeBytes(relativePath, bytes, {
      createOnly: options.createOnly !== false,
      expectedSha: options.expectedSha || null,
      allowUnchanged: options.allowUnchanged === true
    });
  }

  async function deleteFiles(files) {
    const unique = new Map();
    for (const item of Array.isArray(files) ? files : []) {
      if (!item || typeof item.path !== 'string' || typeof item.sha !== 'string' || !item.sha) {
        throw new Error('OneDrive cleanup requires a safe path and expected content hash for each file.');
      }
      const parts = validateRelativePath(item.path);
      if (!['sessions', 'requests', 'results', 'claims', 'artifacts', 'agent-messages', 'agent-message-receipts', 'agents', 'evicted-sessions', 'revoked-sessions'].includes(parts[1])) {
        throw new Error('OneDrive cleanup refused a protected mailbox path: ' + item.path);
      }
      unique.set(item.path, item.sha);
    }
    const entries = [...unique].map(([relativePath, expectedSha]) => ({
      path: relativePath, sha: expectedSha, target: resolvePath(relativePath).target
    })).sort((a, b) => a.target.localeCompare(b.target));

    return withPathLocks(entries.map(item => item.target), async () => {
      // Lock all target paths in stable order to prevent this process's writers
      // from racing the cleanup. Revalidate the complete set immediately before
      // unlinking. OneDrive can still synchronize an external version between
      // verification and unlink; local hashes are not a distributed CAS.
      for (const item of entries) {
        const current = await readBytes(item.path);
        if (!current || current.sha !== item.sha) {
          const error = new Error('OneDrive mailbox changed during cleanup; no files were deleted.');
          error.code = 'MAILBOX_CONFLICT';
          throw error;
        }
      }
      for (const item of entries) {
        const latest = await readBytes(item.path);
        if (!latest || latest.sha !== item.sha) {
          const error = new Error('OneDrive mailbox changed immediately before cleanup; no files were deleted.');
          error.code = 'MAILBOX_CONFLICT';
          throw error;
        }
      }
      let deleted = 0;
      for (const item of entries) {
        await fsImpl.unlink(item.target);
        deleted++;
      }
      return { deleted };
    });
  }

  async function ensureReady() {
    const root = configuredPath();
    if (!root) throw new Error('OneDrive is not configured. Select the local OneDrive-synced Bridge/runtime folder.');
    if (!path.isAbsolute(root)) throw new Error('The OneDrive mailbox folder must be an absolute local path.');
    await ensureDirectory(root);
    await ensureDirectory(path.join(root, 'sandbox'));
    const bridgeRoot = path.join(root, 'bridge');
    await ensureDirectory(bridgeRoot);
    for (const relative of BRIDGE_DIRECTORIES) {
      await ensureDirectory(path.join(bridgeRoot, ...relative.split('/')));
    }
    const probe = path.join(root, 'bridge', 'state', '.windows-bridge-write-check-' + crypto.randomUUID());
    const handle = await fsImpl.open(probe, 'wx');
    try { await handle.writeFile('ok'); await handle.sync(); }
    finally { await handle.close(); }
    await fsImpl.unlink(probe);
    return getState();
  }

  function getState() {
    const root = configuredPath();
    return {
      configured: Boolean(root),
      rootPath: root || '',
      runtimePath: root || '',
      transport: 'onedrive-synced-folder',
      cloudPath: 'Bridge/runtime',
      status: root ? 'configured' : 'not_configured'
    };
  }

  return { ensureReady, getState, readJson, readContent, listFolder, writeJson, writeContent, deleteFiles };
}

module.exports = {
  createOneDriveMailbox,
  detectOneDriveSyncRoot,
  validateRelativePath,
  BRIDGE_DIRECTORIES,
  MAX_MAILBOX_FILE_BYTES
};
