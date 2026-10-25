'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_MAX_ENTRIES = 100000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_RECONCILE_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_POLL_MS = 30 * 1000;

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function entryType(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function scanWorkspace(rootInput, options = {}) {
  const root = path.resolve(rootInput);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('Filesystem index root must be a directory.');
  const maxEntries = Number.isInteger(options.maxEntries)
    ? Math.max(1, Math.min(options.maxEntries, 500000))
    : DEFAULT_MAX_ENTRIES;
  const entries = [];
  const stack = [{ absolute: root, relative: '' }];
  let truncated = false;
  let unreadableDirectories = 0;

  while (stack.length && entries.length < maxEntries) {
    const current = stack.pop();
    let children;
    try {
      children = await fsp.readdir(current.absolute, { withFileTypes: true });
    } catch {
      unreadableDirectories++;
      if (current.relative && entries.length < maxEntries) entries.push({ path: current.relative + '/', type: 'unreadable' });
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    const subdirectories = [];
    for (const child of children) {
      const relative = current.relative ? current.relative + '/' + child.name : child.name;
      const type = entryType(child);
      entries.push({ path: relative, type });
      if (type === 'directory') subdirectories.push({ absolute: path.join(current.absolute, child.name), relative });
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
    for (let i = subdirectories.length - 1; i >= 0; i--) stack.push(subdirectories[i]);
    if (truncated) break;
  }

  if (stack.length) truncated = true;
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
  return { root, entries, truncated, unreadableDirectories };
}

function renderIndex(entries, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const maxBytes = Number.isInteger(options.maxBytes)
    ? Math.max(1024, options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const scanTruncated = options.truncated === true;
  const header = [
    '# Windows Repository Bridge — Filesystem Index',
    '',
    '- Updated: ' + updatedAt,
    '- Entries scanned: ' + entries.length,
    '- Complete scan: ' + (scanTruncated ? 'no (limit reached or unreadable paths)' : 'yes'),
    '',
    'Paths are relative to the selected workspace. This index contains names and item types only, never file contents or absolute local paths.',
    'Directory paths end in /. Symbolic links are listed but never followed.',
    '',
    '~~~~text',
    '<workspace>/'
  ];
  const lines = entries.map(entry => {
    const suffix = entry.type === 'directory' ? '/' : entry.type === 'symlink' ? ' [symlink]' :
      entry.type === 'unreadable' ? ' [unreadable]' : entry.type === 'other' ? ' [other]' : '';
    // JSON-quote each path so unusual filenames cannot add fake lines or close the code fence.
    return JSON.stringify(entry.path + suffix);
  });
  let emitted = lines.length;
  let content = '';
  while (true) {
    const incomplete = scanTruncated || emitted < lines.length;
    const warning = incomplete ? ['', 'WARNING: Index is incomplete; entries may be missing.'] : [];
    const footer = ['~~~~', ...warning, ''];
    content = [...header, ...lines.slice(0, emitted), ...footer].join('\n');
    if (Buffer.byteLength(content, 'utf8') <= maxBytes || emitted === 0) break;
    emitted = Math.max(0, Math.floor(emitted * 0.8));
  }
  // Hash the actual published view, not hidden entries omitted by the byte cap.
  // Normalize only the "Updated" line so unchanged indexes do not produce commits every poll.
  const canonicalView = content.replace(/^- Updated: .*$/m, '- Updated: <timestamp>');
  return {
    content,
    hash: createHash('sha256').update(canonicalView, 'utf8').digest('hex'),
    entryCount: entries.length,
    publishedEntryCount: emitted,
    truncated: scanTruncated || emitted < lines.length,
    updatedAt
  };
}

async function writeAtomic(filePath, content) {
  const target = path.resolve(filePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

class FilesystemIndexMonitor {
  constructor(options = {}) {
    if (typeof options.root !== 'string' || !options.root.trim()) {
      throw new Error('Filesystem index monitor requires a workspace root.');
    }
    this.root = path.resolve(options.root);
    this.outputPath = typeof options.outputPath === 'string' ? path.resolve(options.outputPath) : '';
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : async () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
    this.maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.debounceMs = Number.isInteger(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    this.reconcileMs = Number.isInteger(options.reconcileMs) ? options.reconcileMs : DEFAULT_RECONCILE_MS;
    this.fallbackPollMs = Number.isInteger(options.fallbackPollMs) ? options.fallbackPollMs : DEFAULT_FALLBACK_POLL_MS;
    this.entries = new Map();
    this.contentHash = '';
    this.localContentHash = '';
    this.localUpdatedAt = null;
    this.updatedAt = null;
    this.running = false;
    this.watcher = null;
    this.debounceTimer = null;
    this.reconcileTimer = null;
    this.dirtyParents = new Set();
    this.fullRebuildRequested = false;
    this.flushing = false;
    this.rebuildPromise = null;
  }

  async start() {
    if (this.running) return;
    const stat = await fsp.stat(this.root);
    if (!stat.isDirectory()) throw new Error('Filesystem index root must be a directory.');
    this.running = true;
    this.openWatcher();
    this.reconcileTimer = setInterval(() => { void this.fullRebuild(); }, this.watcher ? this.reconcileMs : this.fallbackPollMs);
    // Index creation is asynchronous so a large workspace cannot hold up worker startup.
    void this.fullRebuild();
  }

  openWatcher() {
    if (!this.running) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (eventType, filename) => {
        // The index describes names, not contents or modification times.
        if (!this.running || eventType === 'change') return;
        if (filename === null || filename === undefined || String(filename) === '') {
          this.fullRebuildRequested = true;
        } else {
          const relative = normalizeRelative(filename);
          const absolute = path.resolve(this.root, relative);
          if (!isInside(this.root, absolute)) return;
          const parent = normalizeRelative(path.posix.dirname(relative));
          this.dirtyParents.add(parent === '.' ? '' : parent);
        }
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => { void this.flushChanges(); }, this.debounceMs);
      });
      this.watcher.on('error', error => {
        this.reportError(error);
        this.closeWatcher();
        this.startFallbackPolling();
      });
    } catch (error) {
      this.reportError(error);
      this.closeWatcher();
      this.startFallbackPolling();
    }
  }

  closeWatcher() {
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
  }

  startFallbackPolling() {
    if (!this.running) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => { void this.fullRebuild(); }, this.fallbackPollMs);
  }

  reportError(error) {
    try { this.onError(String(error && error.message || error).slice(0, 500)); } catch {}
  }

  removeSubtree(relative) {
    const prefix = relative ? relative + '/' : '';
    for (const key of this.entries.keys()) {
      if (key === relative || (prefix && key.startsWith(prefix))) this.entries.delete(key);
    }
  }

  async addSubtree(absolute, relative) {
    let stat;
    try { stat = await fsp.lstat(absolute); } catch { return; }
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    this.entries.set(relative, type);
    if (type !== 'directory') return;
    let children;
    try { children = await fsp.readdir(absolute, { withFileTypes: true }); }
    catch {
      this.entries.set(relative, 'unreadable');
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (!this.running || this.entries.size >= this.maxEntries) {
        this.fullRebuildRequested = true;
        return;
      }
      await this.addSubtree(path.join(absolute, child.name), relative + '/' + child.name);
    }
  }

  async refreshParent(parentRelative) {
    const normalized = normalizeRelative(parentRelative);
    const absoluteParent = normalized ? path.resolve(this.root, ...normalized.split('/')) : this.root;
    if (!isInside(this.root, absoluteParent)) return;
    let children;
    try {
      const stat = await fsp.stat(absoluteParent);
      if (!stat.isDirectory()) throw new Error('Parent is not a directory.');
      children = await fsp.readdir(absoluteParent, { withFileTypes: true });
    } catch {
      this.fullRebuildRequested = true;
      return;
    }
    const actualNames = new Set(children.map(item => item.name));
    const directKnown = [...this.entries.keys()].filter(key => {
      const parent = normalizeRelative(path.posix.dirname(key));
      return (parent === '.' ? '' : parent) === normalized && key !== normalized;
    });
    for (const known of directKnown) {
      if (!actualNames.has(path.posix.basename(known))) this.removeSubtree(known);
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = normalized ? normalized + '/' + child.name : child.name;
      const absolute = path.join(absoluteParent, child.name);
      const type = entryType(child);
      const prior = this.entries.get(relative);
      if (type === 'directory' && prior !== 'directory') {
        this.removeSubtree(relative);
        await this.addSubtree(absolute, relative);
      } else if (type !== 'directory') {
        if (prior === 'directory' || prior === 'unreadable') this.removeSubtree(relative);
        this.entries.set(relative, type);
      } else {
        this.entries.set(relative, 'directory');
      }
    }
  }

  async flushChanges() {
    if (!this.running || this.flushing) return;
    this.flushing = true;
    clearTimeout(this.debounceTimer);
    try {
      while (this.running && (this.fullRebuildRequested || this.dirtyParents.size)) {
        if (this.fullRebuildRequested) {
          this.fullRebuildRequested = false;
          this.dirtyParents.clear();
          await this.fullRebuild();
          continue;
        }
        const parents = [...this.dirtyParents];
        this.dirtyParents.clear();
        for (const parent of parents) {
          if (!this.running) break;
          await this.refreshParent(parent);
        }
        await this.emitIfChanged();
      }
    } catch (error) {
      this.reportError(error);
      this.fullRebuildRequested = true;
    } finally {
      this.flushing = false;
      if (this.running && (this.fullRebuildRequested || this.dirtyParents.size)) {
        this.debounceTimer = setTimeout(() => { void this.flushChanges(); }, 0);
      }
    }
  }

  async emitIfChanged(force = false, scanTruncated = false) {
    if (!this.running) return null;
    const entries = [...this.entries.entries()]
      .map(([entryPath, type]) => ({ path: entryPath, type }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
    const truncation = scanTruncated || this.entries.size >= this.maxEntries;
    let rendered = renderIndex(entries, {
      updatedAt: new Date().toISOString(),
      maxBytes: this.maxBytes,
      truncated: truncation
    });
    const localChanged = rendered.hash !== this.localContentHash;
    if (!localChanged && this.localUpdatedAt) {
      // "Updated" means the names/types changed, not merely that reconciliation ran.
      rendered = renderIndex(entries, {
        updatedAt: this.localUpdatedAt,
        maxBytes: this.maxBytes,
        truncated: truncation
      });
    } else {
      await writeAtomicIfConfigured(this.outputPath, rendered.content);
      this.localContentHash = rendered.hash;
      this.localUpdatedAt = rendered.updatedAt;
    }

    // Retry failed/offline publishing even when the local names-only snapshot is unchanged.
    if (!force && rendered.hash === this.contentHash) return null;
    const snapshot = { ...rendered, content: rendered.content, localPath: this.outputPath || null };
    try {
      const delivered = await this.onUpdate(snapshot);
      if (delivered === false) return snapshot;
    } catch (error) {
      // Keep the last-successful sync hash unchanged. Periodic reconciliation will retry.
      this.reportError(error);
      return snapshot;
    }
    this.contentHash = rendered.hash;
    this.updatedAt = rendered.updatedAt;
    return snapshot;
  }

  async fullRebuild() {
    if (!this.running) return null;
    if (this.rebuildPromise) {
      this.fullRebuildRequested = true;
      return this.rebuildPromise;
    }
    const task = (async () => {
      try {
        const scan = await scanWorkspace(this.root, { maxEntries: this.maxEntries });
        this.entries = new Map(scan.entries.map(entry => [entry.path, entry.type]));
        return await this.emitIfChanged(false, scan.truncated || scan.unreadableDirectories > 0);
      } catch (error) {
        this.reportError(error);
        return null;
      }
    })();
    this.rebuildPromise = task;
    try {
      return await task;
    } finally {
      this.rebuildPromise = null;
      // A watcher or reconcile tick may have arrived during this scan.
      if (this.running && (this.fullRebuildRequested || this.dirtyParents.size)) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => { void this.flushChanges(); }, 0);
      }
    }
  }

  async stop() {
    this.running = false;
    clearTimeout(this.debounceTimer);
    clearInterval(this.reconcileTimer);
    this.debounceTimer = null;
    this.reconcileTimer = null;
    this.closeWatcher();
    this.dirtyParents.clear();
  }

  getState() {
    return {
      running: this.running,
      entryCount: this.entries.size,
      updatedAt: this.updatedAt,
      truncated: this.entries.size >= this.maxEntries,
      localPath: this.outputPath || null
    };
  }
}

async function writeAtomicIfConfigured(filePath, content) {
  if (!filePath) return;
  await writeAtomic(filePath, content);
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
  scanWorkspace,
  renderIndex,
  FilesystemIndexMonitor
};
