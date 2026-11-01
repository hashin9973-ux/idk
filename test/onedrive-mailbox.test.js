'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOneDriveMailbox, detectOneDriveSyncRoot, validateRelativePath, BRIDGE_DIRECTORIES
} = require('../desktop/onedrive-mailbox');

async function makeMailbox(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onedrive-mailbox-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'OneDrive', 'Bridge');
  await fs.mkdir(root, { recursive: true });
  const settings = { repositoryBridge: { oneDrivePath: root } };
  const mailbox = createOneDriveMailbox({
    getSettings: () => settings,
    ...(options.fsImpl ? { fsImpl: options.fsImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {})
  });
  return { mailbox, root, settings, temp };
}

test('initialization uses Bridge as the mailbox root and creates only the five permitted folders', async t => {
  const { mailbox, root, temp } = await makeMailbox(t);
  const archive = path.join(path.dirname(root), 'raw');
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(archive, 'keep.txt'), 'archive');
  const state = await mailbox.ensureReady();
  assert.equal(state.cloudPath, 'Bridge');
  assert.equal(state.mailboxPath, root);
  assert.deepEqual((await fs.readdir(root)).sort(), [...BRIDGE_DIRECTORIES].sort());
  assert.equal(await fs.readFile(path.join(archive, 'keep.txt'), 'utf8'), 'archive');
  assert.equal((await fs.readdir(temp)).includes('runtime'), false);
});

test('mailbox paths allow only root Markdown files and agent-partitioned records', () => {
  assert.deepEqual(validateRelativePath('AGENT.md'), ['AGENT.md']);
  assert.deepEqual(validateRelativePath('request/agent-001/req-1.json'), ['request', 'agent-001', 'req-1.json']);
  assert.deepEqual(validateRelativePath('sandbox storage/agent-001/output.txt'), ['sandbox storage', 'agent-001', 'output.txt']);
  for (const value of [
    '', '../outside', 'request/../outside', 'request\\agent-001\\req.json',
    '/request/agent-001/req.json', 'bridge/request/agent-001/req.json',
    'runtime/request/agent-001/req.json', 'request/requests/req.json',
    'request/agent-001/nested/req.json', 'context/agent-001/x.json'
  ]) assert.throws(() => validateRelativePath(value));
});

test('OneDrive sync root autodetection points directly to Bridge', async t => {
  const { temp } = await makeMailbox(t);
  const consumer = path.join(temp, 'OneDriveConsumer');
  await fs.mkdir(path.join(consumer, 'Bridge'), { recursive: true });
  assert.equal(detectOneDriveSyncRoot({ OneDriveConsumer: consumer }, fsSync), consumer);
});

test('create-only agent requests are immutable and partitioned by agent', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const request = { protocol: 'chatgpt-local-repo-bridge/v1', request_id: 'req-1', agent_id: 'agent-001', tool: 'environment_info', args: {} };
  const first = await mailbox.writeJson('request/agent-001/req-1.json', request, null, true);
  assert.equal(first.ok, true);
  assert.match(first.sha, /^[a-f0-9]{64}$/);
  const second = await mailbox.writeJson('request/agent-001/req-1.json', { ...request, tool: 'exec_command' }, null, true);
  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  assert.deepEqual((await mailbox.readJson('request/agent-001/req-1.json')).value, request);
  assert.deepEqual((await mailbox.listFolder('request')).map(x => x.name), ['agent-001']);
});

test('claims and results use the same request ID inside the owning agent folder', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  await mailbox.writeJson('request/agent-007/r-123.json', { request_id: 'r-123', agent_id: 'agent-007' }, null, true);
  await mailbox.writeJson('claims/agent-007/r-123.json', { request_id: 'r-123', agent_id: 'agent-007' }, null, true);
  await mailbox.writeJson('result/agent-007/r-123.json', { request_id: 'r-123', agent_id: 'agent-007', status: 'completed' }, null, true);
  assert.equal((await mailbox.readJson('claims/agent-007/r-123.json')).value.request_id, 'r-123');
  assert.equal((await mailbox.readJson('result/agent-007/r-123.json')).value.request_id, 'r-123');
  await assert.rejects(mailbox.writeJson('result/agent-008/r-123.json', { request_id: 'r-123' }, null, true), /partitioned/);
});

test('Markdown control files can be published at the mailbox root', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const written = await mailbox.writeContent('AGENT.md', '# Operating guide\n', { createOnly: true });
  assert.equal(written.ok, true);
  assert.equal((await mailbox.readContent('AGENT.md')).content.toString('utf8'), '# Operating guide\n');
  await assert.rejects(mailbox.writeContent('README.md', 'not allowed'), /allowed Bridge folders/);
});

test('mutable writes require the expected hash when a record already exists', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const relative = 'STATUS.md';
  await mailbox.writeContent(relative, 'revision 1');
  const first = await mailbox.readContent(relative);
  await assert.rejects(mailbox.writeContent(relative, 'revision 2', { createOnly: false }), error => error && error.code === 'MAILBOX_CONFLICT');
  const update = await mailbox.writeContent(relative, 'revision 2', { createOnly: false, expectedSha: first.sha });
  assert.equal(update.ok, true);
  assert.equal((await mailbox.readContent(relative)).content.toString('utf8'), 'revision 2');
});

test('agent sandbox artifacts are binary-safe, create-only and readable with a SHA-256 digest', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const written = await mailbox.writeContent('sandbox storage/agent-001/image.bin', bytes);
  assert.equal(written.ok, true);
  const read = await mailbox.readContent('sandbox storage/agent-001/image.bin');
  assert.deepEqual(read.content, bytes);
  assert.equal(read.sha, written.sha);
  const unchanged = await mailbox.writeContent('sandbox storage/agent-001/image.bin', bytes, { allowUnchanged: true });
  assert.equal(unchanged.unchanged, true);
  const conflict = await mailbox.writeContent('sandbox storage/agent-001/image.bin', Buffer.from('different'));
  assert.equal(conflict.conflict, true);
});

test('cleanup verifies every SHA before deleting any agent record', async t => {
  const { mailbox } = await makeMailbox(t);
  await mailbox.ensureReady();
  await mailbox.writeJson('result/agent-001/a.json', { result: 'a' }, null, true);
  await mailbox.writeJson('result/agent-001/b.json', { result: 'b' }, null, true);
  const a = await mailbox.readJson('result/agent-001/a.json');
  const b = await mailbox.readJson('result/agent-001/b.json');
  await assert.rejects(mailbox.deleteFiles([
    { path: 'result/agent-001/a.json', sha: a.sha },
    { path: 'result/agent-001/b.json', sha: '0'.repeat(64) }
  ]), error => error && error.code === 'MAILBOX_CONFLICT');
  assert.ok(await mailbox.readJson('result/agent-001/a.json'));
  assert.ok(await mailbox.readJson('result/agent-001/b.json'));
  assert.equal((await mailbox.deleteFiles([{ path: 'result/agent-001/a.json', sha: a.sha }])).deleted, 1);
  assert.equal(await mailbox.readJson('result/agent-001/a.json'), null);
});

test('mailbox rejects symbolic-link ancestors before reading or writing outside Bridge', async t => {
  const { mailbox, root, temp } = await makeMailbox(t);
  await mailbox.ensureReady();
  const outside = path.join(temp, 'outside-mailbox');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'request.json'), JSON.stringify({ tool: 'exec_command' }));
  const requestPath = path.join(root, 'request');
  const backupPath = path.join(root, 'request-original');
  await fs.rename(requestPath, backupPath);
  try { await fs.symlink(outside, requestPath, 'junction'); }
  catch (error) {
    await fs.rename(backupPath, requestPath);
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(mailbox.readJson('request/agent-001/request.json'), /symbolic link/i);
  await assert.rejects(mailbox.writeJson('request/agent-001/new.json', { safe: true }, null, true), /symbolic link/i);
  await fs.unlink(requestPath);
  await fs.rename(backupPath, requestPath);
});

test('partial JSON caused by synchronization is retried and accepted after the file becomes complete', async t => {
  let repaired = false;
  let target = '';
  const { mailbox, root } = await makeMailbox(t, {
    sleep: async () => {
      if (!repaired) {
        repaired = true;
        await fs.writeFile(target, '{"protocol":"complete","revision":2}\n', 'utf8');
      }
    }
  });
  await mailbox.ensureReady();
  await fs.mkdir(path.join(root, 'request', 'agent-001'), { recursive: true });
  target = path.join(root, 'request', 'agent-001', 'partial.json');
  await fs.writeFile(target, '{"protocol":', 'utf8');
  const loaded = await mailbox.readJson('request/agent-001/partial.json');
  assert.equal(repaired, true);
  assert.deepEqual(loaded.value, { protocol: 'complete', revision: 2 });
});

test('concurrent same-path mutable writes serialize and reject stale expected hashes', async t => {
  const delayedFs = Object.create(fs);
  delayedFs.open = async (filePath, flags, ...rest) => {
    if (String(filePath).includes('.pending-')) await new Promise(resolve => setTimeout(resolve, 25));
    return fs.open(filePath, flags, ...rest);
  };
  const { mailbox } = await makeMailbox(t, { fsImpl: delayedFs });
  await mailbox.ensureReady();
  await mailbox.writeContent('STATUS.md', 'revision 1');
  const original = await mailbox.readContent('STATUS.md');
  const outcomes = await Promise.allSettled([
    mailbox.writeContent('STATUS.md', 'revision 2', { createOnly: false, expectedSha: original.sha }),
    mailbox.writeContent('STATUS.md', 'revision 3', { createOnly: false, expectedSha: original.sha })
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const failed = outcomes.find(item => item.status === 'rejected');
  assert.equal(failed.reason.code, 'MAILBOX_CONFLICT');
});

test('immutable publication fails closed when the sync filesystem cannot atomically create a file', async t => {
  const noHardLinks = Object.create(fs);
  noHardLinks.link = async () => { const error = new Error('hard links are not supported'); error.code = 'ENOTSUP'; throw error; };
  const { mailbox, root } = await makeMailbox(t, { fsImpl: noHardLinks });
  await mailbox.ensureReady();
  await assert.rejects(mailbox.writeJson('request/agent-001/no-link.json', { request_id: 'no-link' }, null, true),
    error => error && error.code === 'ONEDRIVE_ATOMIC_CREATE_UNSUPPORTED');
  await assert.rejects(fs.stat(path.join(root, 'request', 'agent-001', 'no-link.json')), error => error && error.code === 'ENOENT');
});

test('access-denied mailbox reads fail immediately instead of retrying as sync races', async t => {
  let sleepCalls = 0;
  let deniedReads = 0;
  const deniedFs = Object.create(fs);
  deniedFs.open = async (filePath, flags, ...rest) => {
    const name = path.basename(String(filePath));
    if (flags === 'r' && name.startsWith('denied-')) {
      deniedReads++;
      const error = new Error('Access denied by filesystem permissions.');
      error.code = name.includes('eacces') ? 'EACCES' : 'EPERM';
      throw error;
    }
    return fs.open(filePath, flags, ...rest);
  };
  const { mailbox, root } = await makeMailbox(t, { fsImpl: deniedFs, sleep: async () => { sleepCalls++; } });
  await mailbox.ensureReady();
  for (const code of ['eacces', 'eperm']) {
    const relative = 'request/agent-001/denied-' + code + '.json';
    await fs.mkdir(path.join(root, 'request', 'agent-001'), { recursive: true });
    await fs.writeFile(path.join(root, ...relative.split('/')), '{"request_id":"permission-test"}\n', 'utf8');
    await assert.rejects(mailbox.readJson(relative), error => error && error.code === code.toUpperCase());
  }
  assert.equal(deniedReads, 2);
  assert.equal(sleepCalls, 0);
});
