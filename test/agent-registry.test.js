'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAgentRegistry,
  AGENT_RECORD_PROTOCOL,
  SESSION_RECORD_PROTOCOL,
  SESSION_INACTIVE_AFTER_MS
} = require('../desktop/agent-registry');

function mockMailbox(startTime = Date.now()) {
  const records = new Map();
  let nextSha = 1;
  let now = startTime;
  const registry = createAgentRegistry({
    clock: () => now,
    async readRemoteFile(path) {
      const stored = records.get(path);
      return stored ? { value: structuredClone(stored.value), sha: stored.sha } : null;
    },
    async listFolder(folder) {
      const prefix = folder + '/';
      return [...records.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, stored]) => ({
          name: path.slice(prefix.length), path, type: 'file',
          sha: stored.sha, size: JSON.stringify(stored.value).length
        }));
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
  });
  return {
    registry, records,
    advance(ms) { now += ms; },
    setTime(value) { now = value; },
    now() { return now; }
  };
}

test('concurrent session starts allocate distinct randomized conversation IDs and reusable seats', async () => {
  const { registry, records } = mockMailbox();
  const [first, second] = await Promise.all([
    registry.startSession({ label: 'Conversation one' }),
    registry.startSession({ label: 'Conversation two' })
  ]);
  assert.deepEqual([first.agent_id, second.agent_id].sort(), ['agent-001', 'agent-002']);
  assert.match(first.session_id, /^session-[a-f0-9]{32}$/);
  assert.match(second.session_id, /^session-[a-f0-9]{32}$/);
  assert.notEqual(first.session_id, second.session_id);
  assert.equal(first.inactivity_after_ms, SESSION_INACTIVE_AFTER_MS);

  for (const session of [first, second]) {
    const seat = records.get('bridge/agents/' + session.agent_id + '.json').value;
    const savedSession = records.get('bridge/sessions/' + session.session_id + '.json').value;
    assert.equal(seat.protocol, AGENT_RECORD_PROTOCOL);
    assert.equal(seat.agent_id, session.agent_id);
    assert.equal(seat.current_session_id, session.session_id);
    assert.equal(seat.status, 'active');
    assert.equal(savedSession.protocol, SESSION_RECORD_PROTOCOL);
    assert.equal(savedSession.session_id, session.session_id);
    assert.equal(savedSession.agent_id, session.agent_id);
    assert.equal('agent_token' in seat, false);
    assert.equal('token_hash' in seat, false);
  }
});

test('session identity is mandatory, activity and busy state are separate, and inactive seats are reused', async () => {
  const { registry, records, advance, now } = mockMailbox();
  const first = await registry.startSession({ label: 'Temporary occupant' });
  assert.deepEqual(await registry.authenticate({ session_id: first.session_id }), {
    session_id: first.session_id, agent_id: first.agent_id, agent_label: first.label
  });
  await assert.rejects(registry.authenticate({}), /SESSION_ID_REQUIRED/);

  const request = {
    request_id: 'req-agent001-operation01',
    session_id: first.session_id,
    agent_id: first.agent_id
  };
  await registry.requestStarted(request);
  let state = await registry.statuses();
  assert.equal(state.counts.active, 1);
  assert.equal(state.counts.busy, 1);
  assert.equal(state.agents[0].status, 'active');
  assert.equal(state.agents[0].busy, true);
  assert.deepEqual(state.agents[0].active_request_ids, [request.request_id]);

  advance(SESSION_INACTIVE_AFTER_MS + 1000);
  state = await registry.statuses(first.agent_id);
  assert.equal(state.agents[0].status, 'inactive', 'active/inactive reports recent activity, not execution state');
  assert.equal(state.agents[0].busy, true);
  const second = await registry.startSession({ label: 'Second conversation' });
  assert.equal(second.agent_id, 'agent-002', 'busy seat is not reused even after the activity window');

  const completed = await registry.requestCompleted(request);
  assert.deepEqual(completed.active_request_ids, []);
  state = await registry.statuses(first.agent_id);
  assert.equal(state.agents[0].status, 'active', 'completion is recent activity');
  assert.equal(state.agents[0].busy, false);
  assert.ok(state.agents[0].recent_request_ids.includes(request.request_id));

  advance(SESSION_INACTIVE_AFTER_MS + 1);
  state = await registry.statuses();
  assert.equal(state.counts.inactive, 2);
  assert.equal(state.agents[0].reusable, true);

  const replacement = await registry.startSession({ label: 'Replacement conversation' });
  assert.equal(replacement.agent_id, first.agent_id);
  assert.notEqual(replacement.session_id, first.session_id);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_EXPIRED/);
  const seat = records.get('bridge/agents/' + first.agent_id + '.json').value;
  assert.equal(seat.current_session_id, replacement.session_id);
  assert.equal(seat.label, 'Replacement conversation');
});

test('agent-to-agent messages and replies use exact session inboxes even when seats are reusable', async () => {
  const { registry, advance } = mockMailbox();
  const sender = await registry.startSession({ label: 'Coordinator' });
  const recipient = await registry.startSession({ label: 'Implementer' });

  const sent = await registry.sendMessage(sender.session_id, {
    to_session_id: recipient.session_id,
    subject: 'Review',
    message: 'Please check the API contract and report back.'
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.to_agent_id, recipient.agent_id);
  assert.ok(sent.message_id);
  assert.equal(sent.thread_id, sent.message_id);

  const incoming = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(incoming.count, 1);
  const original = incoming.messages[0];
  assert.equal(original.message, 'Please check the API contract and report back.');
  assert.equal(original.sender_session_id, sender.session_id);
  assert.ok(original.read_at);

  const reply = await registry.replyToMessage(recipient.session_id, {
    message_id: original.message_id,
    message: 'Reviewed: the contract is consistent.'
  });
  assert.equal(reply.in_reply_to, original.message_id);
  assert.equal(reply.thread_id, sent.thread_id);
  const response = await registry.readMessages(sender.session_id, { unread_only: true });
  assert.equal(response.count, 1);
  assert.equal(response.messages[0].message, 'Reviewed: the contract is consistent.');
  assert.equal(response.messages[0].in_reply_to, original.message_id);

  const status = await registry.statuses();
  assert.equal(status.count, 2);
  assert.deepEqual(status.agents.map(agent => agent.agent_id), ['agent-001', 'agent-002']);
  assert.equal(status.counts.active, 2);
  assert.equal(status.status_legend.busy.includes('executing'), true);

  advance(SESSION_INACTIVE_AFTER_MS + 1);
  await assert.rejects(
    registry.sendMessage(sender.session_id, { to_agent_id: recipient.agent_id, message: 'Are you there?' }),
    /inactive/i
  );
});
