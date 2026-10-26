'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  scanWorkspace,
  renderIndex,
  FilesystemIndexMonitor
} = require('../desktop/filesystem-index');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-index-'));
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'nested', 'app.js'), 'const privateContent = "never index this";\n', 'utf8');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=should-not-appear\n', 'utf8');
  return root;
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('workspace scan lists folders and files without reading or publishing file contents', async () => {
  const root = await fixture();
  try {
    const scan = await scanWorkspace(root);
    const names = scan.entries.map(entry => entry.path);
    assert.ok(names.includes('src'));
    assert.ok(names.includes('src/nested'));
    assert.ok(names.includes('src/nested/app.js'));
    assert.ok(names.includes('.env'));
    const rendered = renderIndex(scan.entries, { updatedAt: '2026-01-01T00:00:00.000Z' });
    assert.match(rendered.content, /src\/nested\/app\.js/);
    assert.match(rendered.content, /\.env/);
    assert.doesNotMatch(rendered.content, /should-not-appear|never index this|TOKEN=/);
    assert.equal(rendered.content.includes(root), false);
    assert.equal(rendered.truncated, false);
  } finally {
    await cleanup(root);
  }
});

test('scan marks a bounded listing as incomplete rather than claiming it is complete', async () => {
  const root = await fixture();
  try {
    const scan = await scanWorkspace(root, { maxEntries: 2 });
    assert.equal(scan.truncated, true);
    const rendered = renderIndex(scan.entries, { truncated: scan.truncated });
    assert.equal(rendered.truncated, true);
    assert.match(rendered.content, /incomplete/i);
  } finally {
    await cleanup(root);
  }
});

test('index warns in its header when output byte limits omit entries', () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({
    path: 'deep-folder/' + String(index).padStart(4, '0') + '/' + 'long-filename-'.repeat(5) + '.txt',
    type: 'file'
  }));
  const rendered = renderIndex(entries, { maxBytes: 1024 });
  assert.equal(rendered.truncated, true);
  assert.match(rendered.content, /Complete scan: no/);
  assert.match(rendered.content, /WARNING: Index is incomplete/);
  assert.ok(Buffer.byteLength(rendered.content, 'utf8') <= 1024);
});

test('monitor writes a local index, then reflects added and removed names', async () => {
  const root = await fixture();
  const output = path.join(root, 'filesystem-index.md');
  const monitor = new FilesystemIndexMonitor({
    root,
    outputPath: output,
    debounceMs: 20,
    reconcileMs: 1000,
    fallbackPollMs: 100
  });
  try {
    const initialUpdate = waitForNextUpdate(monitor);
    await monitor.start();
    const initial = await initialUpdate;
    assert.ok(initial.content.includes('src/nested/app.js'));
    assert.equal((await fs.readFile(output, 'utf8')).includes('should-not-appear'), false);

    const file = path.join(root, 'created.txt');
    const addedUpdate = waitForNextUpdate(monitor);
    await fs.writeFile(file, 'contents deliberately omitted from index', 'utf8');
    const added = await addedUpdate;
    assert.ok(added.content.includes('created.txt'));
    assert.equal(added.content.includes('contents deliberately omitted'), false);

    const removedUpdate = waitForNextUpdate(monitor);
    await fs.rm(file);
    const removed = await removedUpdate;
    assert.equal(removed.content.includes('created.txt'), false);
  } finally {
    await monitor.stop();
    await cleanup(root);
    await fs.rm(output, { force: true });
  }
});

function waitForNextUpdate(monitor) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      monitor.onUpdate = previous;
      reject(new Error('filesystem index update timed out'));
    }, 4000);
    const previous = monitor.onUpdate;
    monitor.onUpdate = async snapshot => {
      clearTimeout(timer);
      monitor.onUpdate = previous;
      await previous(snapshot);
      resolve(snapshot);
    };
  });
}

test('monitor retries a failed repository sync without requiring a local name change', async () => {
  const root = await fixture();
  const monitor = new FilesystemIndexMonitor({
    root,
    debounceMs: 20,
    reconcileMs: 1000,
    fallbackPollMs: 100
  });
  let attempts = 0;
  let markFirstFailure;
  const firstFailure = new Promise(resolve => { markFirstFailure = resolve; });
  let markRetry;
  const retrySucceeded = new Promise(resolve => { markRetry = resolve; });
  monitor.onError = () => markFirstFailure();
  monitor.onUpdate = async () => {
    attempts++;
    if (attempts === 1) throw new Error('simulated repository offline');
    markRetry();
  };
  try {
    await monitor.start();
    await Promise.race([
      firstFailure,
      new Promise((_, reject) => setTimeout(() => reject(new Error('initial sync failure was not reported')), 4000))
    ]);
    await monitor.fullRebuild();
    await Promise.race([
      retrySucceeded,
      new Promise((_, reject) => setTimeout(() => reject(new Error('filesystem index sync was not retried')), 4000))
    ]);
    assert.equal(attempts, 2);
  } finally {
    await monitor.stop();
    await cleanup(root);
  }
});

test('scan requires an existing directory', async () => {
  await assert.rejects(scanWorkspace(path.join(os.tmpdir(), 'missing-index-root-' + Date.now())), /ENOENT/);
});

test('drive-root scans keep only immediate children and mark scope in the published index', async () => {
  const root = path.parse(path.resolve(os.tmpdir())).root;
  const scan = await scanWorkspace(root, { maxEntries: 500 });
  assert.equal(scan.rootMode, 'drive-root');
  assert.ok(scan.entries.length <= 500);
  assert.equal(scan.entries.some(entry => entry.path.includes(path.sep) || entry.path.includes('/')), false);
  const rendered = renderIndex(scan.entries, { rootMode: scan.rootMode, truncated: scan.truncated });
  assert.match(rendered.content, /drive root top-level only/);
});
