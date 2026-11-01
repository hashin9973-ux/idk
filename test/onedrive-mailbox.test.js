'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOneDriveMailbox,
  detectOneDriveSyncRoot,
  validateRelativePath
} = require('../desktop/onedrive-mailbox');

async function makeMailbox(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onedrive-mailbox-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const runtime = path.join(temp, 'OneDrive', 'Bridge', 'runtime');
  const settings = { repositoryBridge: { oneDrivePath: runtime } };
  const mailbox = createOneDriveMailbox({ getSettings: () => settings });
  return { mailbox, runtime, settings, temp };
}

test('OneDrive mailbox prepares its Bridge/runtime tree without touching the archive sibling', async t => {
  const { mailbox, runtime } = await makeMailbox(t);
  const archive = path.join(path.dirname(path.dirname(runtime)), 'raw');
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(archive, 'keep.txt'), 'archive');
  const state = await mailbox.ensureReady();
  assert.equal(state.transport, 'onedrive-synced-folder');
  assert.equal(state.cloudPath, 'Bridge/runtime');
  assert.equal(await fs.readFile(path.join(archive, 'keep.txt'), 'utf8'), 'archive');
  for (const relative of ['bridge/requests', 'bridge/results', 'bridge/agents', 'bridge/sessions', 'bridge/vision/reports']) {
    assert.equal((await fs.stat(path.join(runtime, relative))).isDirectory(), true);
  }
});

test('mailbox paths are confined below bridge and reject traversal and Windows separators', () => {
  assert.deepEqual(validateRelativePath('bridge/requests/request-1.json'), ['bridge', 'requests', 'request-1.json']);
  for (const value of ['', '../outside', 'bridge/../outside', 'bridge\\requests\\x.json', '/bridge/requests/x.json', 'other/requests/x.json']) {
    assert.throws(() => validateRelativePath(value), /Unsafe|below bridge/);
  }
});

test('OneDrive sync root autodetection checks the standard Windows OneDrive variables', async t => {
  const { temp } = await makeMailbox(t);
  const consumer = path.join(temp, 'OneDriveConsumer');
  await fs.mkdir(consumer, { recursive: true });
  assert.equal(detectOneDriveSyncRoot({ OneDriveConsumer: consumer, OneDriveCommercial: 'Z:\\not-found' }), consumer);
  assert.equal(detectOneDriveSyncRoot({ OneDrive: path.join(temp, 'missing') }), '');
});

test('create-only request writes are immutable and return a verifiable content hash', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const request = { protocol: 'chatgpt-local-repo-request/v1', request_id: 'req-1', tool: 'environment_info', args: {} };
  const first = await mailbox.writeJson('bridge/requests/req-1.json', request, null, true);
  assert.equal(first.ok, true);
  assert.match(first.sha, /^[a-f0-9]{64}$/);
  const second = await mailbox.writeJson('bridge/requests/req-1.json', { ...request, tool: 'shell' }, null, true);
  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  assert.deepEqual((await mailbox.readJson('bridge/requests/req-1.json')).value, request);
});

test('mutable writes require the expected hash when a record already exists', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  await mailbox.writeJson('bridge/state/windows-app.json', { revision: 1 });
  const first = await mailbox.readJson('bridge/state/windows-app.json');
  const update = await mailbox.writeJson('bridge/state/windows-app.json', { revision: 2 }, first.sha, false);
  assert.equal(update.ok, true);
  assert.equal((await mailbox.readJson('bridge/state/windows-app.json')).value.revision, 2);
  await assert.rejects(
    mailbox.writeJson('bridge/state/windows-app.json', { revision: 3 }, first.sha, false),
    error => error && error.code === 'MAILBOX_CONFLICT'
  );
});

test('artifact content is binary-safe, create-only and readable with a SHA-256 digest', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const written = await mailbox.writeContent('bridge/artifacts/req-1/image.bin', bytes);
  assert.equal(written.ok, true);
  const read = await mailbox.readContent('bridge/artifacts/req-1/image.bin');
  assert.deepEqual(read.content, bytes);
  assert.equal(read.sha, written.sha);
  const unchanged = await mailbox.writeContent('bridge/artifacts/req-1/image.bin', bytes, { allowUnchanged: true });
  assert.equal(unchanged.unchanged, true);
  await assert.rejects(
    mailbox.writeContent('bridge/artifacts/req-1/image.bin', Buffer.from('different')),
    /already exists|conflict/i
  );
});

test('cleanup verifies every SHA before deleting any mailbox record', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  await mailbox.writeJson('bridge/results/a.json', { result: 'a' }, null, true);
  await mailbox.writeJson('bridge/results/b.json', { result: 'b' }, null, true);
  const a = await mailbox.readJson('bridge/results/a.json');
  const b = await mailbox.readJson('bridge/results/b.json');
  await assert.rejects(
    mailbox.deleteFiles([{ path: 'bridge/results/a.json', sha: a.sha }, { path: 'bridge/results/b.json', sha: '0'.repeat(64) }]),
    error => error && error.code === 'MAILBOX_CONFLICT'
  );
  assert.ok(await mailbox.readJson('bridge/results/a.json'));
  assert.ok(await mailbox.readJson('bridge/results/b.json'));
  const deleted = await mailbox.deleteFiles([{ path: 'bridge/results/a.json', sha: a.sha }]);
  assert.equal(deleted.deleted, 1);
  assert.equal(await mailbox.readJson('bridge/results/a.json'), null);
});

test('mailbox rejects symbolic-link ancestor directories before reading or writing outside the runtime root', async t => {
  const { mailbox, runtime, temp } = await makeMailbox(t);
  await mailbox.ensureReady();
  const outside = path.join(temp, 'outside-mailbox');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'request.json'), JSON.stringify({ tool: 'shell' }));
  const bridgePath = path.join(runtime, 'bridge');
  const backupPath = path.join(runtime, 'bridge-original');
  await fs.rename(bridgePath, backupPath);
  try {
    await fs.symlink(outside, bridgePath, 'junction');
  } catch (error) {
    await fs.rename(backupPath, bridgePath);
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(mailbox.readJson('bridge/requests/request.json'), /symbolic link/i);
  await assert.rejects(mailbox.writeJson('bridge/requests/new.json', { tool: 'safe' }, null, true), /symbolic link/i);
  await fs.unlink(bridgePath);
  await fs.rename(backupPath, bridgePath);
});

test('mailbox refuses symbolic links and non-file entries instead of following them', async t => {
  const { mailbox, runtime, temp } = await makeMailbox(t);
  await mailbox.ensureReady();
  const outside = path.join(temp, 'outside.txt');
  await fs.writeFile(outside, 'outside');
  const target = path.join(runtime, 'bridge', 'requests', 'linked.json');
  try {
    await fs.symlink(outside, target, 'file');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(mailbox.readJson('bridge/requests/linked.json'), /regular file|symbolic link/i);
  await assert.rejects(mailbox.listFolder('bridge/requests'), /symbolic link/i);
});

