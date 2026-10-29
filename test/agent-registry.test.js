'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRegistry, AGENT_RECORD_PROTOCOL, AGENT_STALE_AFTER_MS } = require('../desktop/agent-registry');

function mockMailbox() {
  const records = new Map();
  let nextSha = 1;
  return {
    records,
    registry: createAgentRegistry({
      async readRemoteFile(path) {
        const stored = records.get(path);
        return stored ? { value: structuredClone(stored.value), sha: stored.sha } : null;
      },
      async listFolder(folder) {
        const prefix = folder + '/';
        return [...records.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, stored]) => ({ name: path.slice(prefix.length), path, type: 'file', sha: stored.sha, size: JSON.stringify(stored.value).length }));
      },
      async writeRemoteJson(path, value, existingSha = null, createOnly = false) {
        const existing = records.get(path);
        if (createOnly && existing) return { ok: false, conflict: true, sha: existing.sha };
        if (existingSha && (!existing || existing.sha !== existingSha)) throw new Error('sha does not match current file');
        if (!existing && existingSha) throw new Error('Not Found (404)');
        const sha = 'test-sha-' + nextSha++;
        records.set(path, { value: structuredClone(value), sha });
        return { ok: true, sha };
      },
      isConflict(error) {
        return /conflict|sha does not match|not found/i.test(String(error && error.message || error));
      }
    })
  };
}

test('agent IDs allocate uniquely even when two conversations register concurrently', async () => {
  const { registry, records } = mockMailbox();
  const [first, second] = await Promise.all([registry.register({}), registry.register({})]);
  assert.deepEqual([first.agent_id, second.agent_id].sort(), ['agent-001', 'agent-002']);
  assert.notEqual(first.agent_token, second.agent_token);
  for (const agent of [first, second]) {
    const record = records.get('bridge/agents/' + agent.agent_id + '.json').value;
    assert.equal(record.protocol, AGENT_RECORD_PROTOCOL);
    assert.equal(record.agent_id, agent.agent_id);
    assert.equal(record.status, 'idle');
    assert.match(record.token_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(record).includes(agent.agent_token), false);
  }
});

test('agent token validates requests, supports restoring an identity, and rejects another token', async () => {
  const { registry } = mockMailbox();
  const registered = await registry.register({ label: 'Conversation one' });
  assert.equal(await registry.authenticate({ agent_id: registered.agent_id, agent_token: registered.agent_token }), true);
  const restored = await registry.register({ agent_id: registered.agent_id, agent_token: registered.agent_token });
  assert.equal(restored.agent_id, registered.agent_id);
  assert.equal(restored.agent_token, registered.agent_token);
  assert.equal(restored.restored, true);
  await assert.rejects(
    registry.authenticate({ agent_id: registered.agent_id, agent_token: '0'.repeat(64) }),
    /token does not match/i
  );
  await assert.rejects(
    registry.register({ agent_id: 'agent-999', agent_token: 'a'.repeat(64) }),
    /not registered/i
  );
});

test('agent status transitions active to idle, preserves request history, and marks old IDs stale without recycling', async () => {
  const { registry, records } = mockMailbox();
  const registered = await registry.register({});
  const request = { request_id: 'agent-001-request-one', agent_id: registered.agent_id, agent_token: registered.agent_token };
  await registry.requestStarted(request);
  let status = await registry.statuses(registered.agent_id);
  assert.equal(status.counts.active, 1);
  assert.equal(status.agents[0].status, 'active');
  assert.deepEqual(status.agents[0].active_request_ids, [request.request_id]);

  await registry.requestCompleted(request);
  status = await registry.statuses(registered.agent_id);
  assert.equal(status.counts.idle, 1);
  assert.equal(status.agents[0].status, 'idle');
  assert.deepEqual(status.agents[0].active_request_ids, []);
  assert.equal(status.agents[0].last_request_id, request.request_id);
  assert.ok(status.agents[0].recent_request_ids.includes(request.request_id));
  assert.equal('agent_token' in status.agents[0], false);
  assert.equal('token_hash' in status.agents[0], false);

  const recordPath = 'bridge/agents/' + registered.agent_id + '.json';
  const stored = records.get(recordPath);
  const oldTime = new Date(Date.now() - AGENT_STALE_AFTER_MS - 1000).toISOString();
  records.set(recordPath, { ...stored, value: { ...stored.value, status: 'idle', last_seen_at: oldTime } });
  status = await registry.statuses(registered.agent_id);
  assert.equal(status.agents[0].status, 'stale');

  const next = await registry.register({});
  assert.equal(next.agent_id, 'agent-002', 'stale IDs are never reused automatically');
});
