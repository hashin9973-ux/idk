'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAgentRegistry,
  AGENT_RECORD_PROTOCOL,
  SESSION_RECORD_PROTOCOL,
  AGENT_ACTIVITY_RECENCY_WINDOW_MS
} = require('../desktop/agent-registry');

function mockMailbox(startTime = Date.now(), options = {}) {
  const records = new Map();
  let nextSha = 1;
  let deleteCallCount = 0;
  let now = startTime;
  const registry = createAgentRegistry({
    clock: () => now,
    maxSessions: Number.isInteger(options.maxSessions) ? options.maxSessions : 10000,
    async readRemoteFile(path) {
      const stored = records.get(path);
      return stored ? { value: structuredClone(stored.value), sha: stored.sha } : null;
    },
    async listFolder(folder) {
      const prefix = folder + '/';
      const children = new Map();
      for (const [recordPath, stored] of records.entries()) {
        if (!recordPath.startsWith(prefix)) continue;
        const remainder = recordPath.slice(prefix.length);
        const slash = remainder.indexOf('/');
        const name = slash < 0 ? remainder : remainder.slice(0, slash);
        if (!name) continue;
        if (slash >= 0) children.set(name, { name, path: prefix + name, type: 'dir' });
        else children.set(name, { name, path: recordPath, type: 'file', sha: stored.sha, size: JSON.stringify(stored.value).length });
      }
      return [...children.values()];
    },
    async readRemoteContent(path) {
      const stored = records.get(path);
      if (!stored) return null;
      const content = Buffer.isBuffer(stored.value) ? stored.value : Buffer.from(String(stored.value), 'utf8');
      return { content, sha: stored.sha };
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
    async deleteRemoteFiles(files) {
      deleteCallCount++;
      if (options.failDelete === true) throw new Error('simulated temporary transport failure');
      if (options.failDeleteResult && (!options.failDeleteAt || options.failDeleteAt === deleteCallCount)) return structuredClone(options.failDeleteResult);
      if (options.deleteThenFailResult) {
        for (const item of files) {
          const current = records.get(item.path);
          if (!current || current.sha !== item.sha) throw new Error('sha conflict during test mailbox cleanup');
        }
        for (const item of files) records.delete(item.path);
        return structuredClone(options.deleteThenFailResult);
      }
      for (const item of files) {
        const current = records.get(item.path);
        if (!current || current.sha !== item.sha) throw new Error('sha conflict during test mailbox cleanup');
      }
      for (const item of files) records.delete(item.path);
      return { deleted: files.length, commitSha: 'test-cleanup-commit' };
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
  assert.equal(first.inactivity_after_ms, undefined);

  for (const session of [first, second]) {
    const seat = records.get('local/agents/' + session.agent_id + '.json').value;
    const savedSession = records.get('local/sessions/' + session.session_id + '.json').value;
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


test('session authority stays in the app-local registry and elapsed time never expires a session', async () => {
  const { registry, records, advance } = mockMailbox();
  const session = await registry.startSession({ label: 'Long-lived app-local session' });
  const sessionPath = 'local/sessions/' + session.session_id + '.json';
  const seatPath = 'local/agents/' + session.agent_id + '.json';
  assert.ok(records.has(sessionPath));
  assert.ok(records.has(seatPath));
  assert.equal([...records.keys()].some(key => key.startsWith('bridge/sessions/') || key.startsWith('bridge/agents/')), false);
  advance(5 * 365 * 24 * 60 * 60 * 1000);
  const authenticated = await registry.authenticate({ session_id: session.session_id });
  assert.equal(authenticated.session_id, session.session_id);
  assert.equal(authenticated.agent_id, session.agent_id);
});
 
test('legacy expired status values do not invalidate or release persistent session IDs', async () => {
  const { registry, records } = mockMailbox();
  const session = await registry.startSession({ label: 'Legacy status migration' });
  const sessionPath = 'local/sessions/' + session.session_id + '.json';
  const stored = records.get(sessionPath);
  stored.value.status = 'expired';

  assert.equal((await registry.authenticate({ session_id: session.session_id })).session_id, session.session_id);
  const request = {
    request_id: 'req-agent001-legacy001',
    session_id: session.session_id,
    agent_id: session.agent_id
  };
  assert.equal(await registry.requestStarted(request), true);
  await registry.requestCompleted(request);
  assert.equal(records.get(sessionPath).value.status, 'active');
  assert.equal(records.get('local/agents/' + session.agent_id + '.json').value.current_session_id, session.session_id);
});

test('session identity remains valid after inactivity and its agent seat is never recycled', async () => {
  const { registry, records, advance } = mockMailbox();
  const first = await registry.startSession({ label: 'Persistent conversation' });
  assert.deepEqual(await registry.authenticate({ session_id: first.session_id }), {
    session_id: first.session_id, agent_id: first.agent_id, agent_label: first.label
  });
  await assert.rejects(registry.authenticate({}), /SESSION_ID_REQUIRED/);
  const request = { request_id: 'req-agent001-operation01', session_id: first.session_id, agent_id: first.agent_id };
  await registry.requestStarted(request);
  let state = await registry.statuses();
  assert.equal(state.agents[0].status, 'active');
  assert.equal(state.agents[0].busy, true);
  assert.deepEqual(state.agents[0].active_request_ids, [request.request_id]);
  advance(AGENT_ACTIVITY_RECENCY_WINDOW_MS + 1000);
  state = await registry.statuses(first.agent_id);
  assert.equal(state.agents[0].status, 'inactive', 'activity freshness is separate from session validity');
  assert.equal(state.agents[0].busy, true);
  const second = await registry.startSession({ label: 'Second conversation' });
  assert.equal(second.agent_id, 'agent-002', 'busy seat is not reused');
  const completed = await registry.requestCompleted(request);
  assert.deepEqual(completed.active_request_ids, []);
  state = await registry.statuses(first.agent_id);
  assert.equal(state.agents[0].status, 'active', 'completion refreshes activity');
  assert.equal(state.agents[0].busy, false);
  assert.ok(state.agents[0].recent_request_ids.includes(request.request_id));
  advance(AGENT_ACTIVITY_RECENCY_WINDOW_MS + 1);
  state = await registry.statuses();
  assert.equal(state.counts.inactive, 2);
  assert.equal(state.agents[0].reusable, false, 'an idle session still owns its seat');
  assert.equal((await registry.authenticate({ session_id: first.session_id })).agent_id, first.agent_id);
  const third = await registry.startSession({ label: 'Third conversation' });
  assert.equal(third.agent_id, 'agent-003', 'a new seat is allocated instead of recycling an idle session');
  assert.notEqual(third.session_id, first.session_id);
  assert.equal(records.get('local/agents/' + first.agent_id + '.json').value.current_session_id, first.session_id);
  assert.equal((await registry.authenticate({ session_id: first.session_id })).session_id, first.session_id);
});
test('dashboard custom messages are written to the exact active session inbox', async () => {
  const { registry, records } = mockMailbox();
  const recipient = await registry.startSession({ label: 'Agent receiving a custom message' });
  const sent = await registry.sendUserMessage(recipient.session_id, {
    message: 'Inspect the selected project and report the current test status.'
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.to_agent_id, recipient.agent_id);
  const record = records.get(registry.messagePath(recipient.agent_id, sent.message_id)).value;
  assert.equal(record.sender_type, 'user');
  assert.equal(record.sender_session_id, null);
  assert.equal(record.sender_agent_id, 'user');
  assert.equal(record.recipient_session_id, recipient.session_id);
  assert.match(record.message, /^\[Windows Bridge User\] Inspect the selected project/);
  const inbox = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].sender_label, 'Windows Bridge User');
  assert.equal(inbox.messages[0].message, record.message);
});

test('agents can reply to dashboard messages and the dashboard reads replies in the same session mailbox', async () => {
  const { registry, records } = mockMailbox();
  const recipient = await registry.startSession({ label: 'Agent receiving a dashboard message' });
  const sent = await registry.sendUserMessage(recipient.session_id, { message: 'Please report the result.' });
  const inbox = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].message_id, sent.message_id);

  const reply = await registry.replyToMessage(recipient.session_id, {
    message_id: sent.message_id,
    message: 'Completed: the local tests passed.'
  });
  assert.equal(reply.status, 'sent');
  assert.equal(reply.to_agent_id, 'user');
  assert.equal(reply.in_reply_to, sent.message_id);
  const replyRecord = records.get(registry.messagePath(recipient.agent_id, reply.message_id)).value;
  assert.equal(replyRecord.sender_session_id, recipient.session_id);
  assert.equal(replyRecord.recipient_session_id, recipient.session_id);
  assert.equal(replyRecord.sender_type, 'agent');
  assert.equal(replyRecord.recipient_type, 'user');
  assert.equal(replyRecord.recipient_agent_id, 'user');
  assert.equal(replyRecord.thread_id, sent.thread_id);

  const agentInbox = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(agentInbox.count, 0, 'an agent must not receive its own dashboard-directed reply as a new inbox message');
  const dashboardReplies = await registry.readDashboardReplies(recipient.session_id, { message_ids: [sent.message_id] });
  assert.equal(dashboardReplies.count, 1);
  assert.equal(dashboardReplies.messages[0].message_id, reply.message_id);
  assert.match(dashboardReplies.messages[0].message, /Completed: the local tests passed/);
  await assert.rejects(registry.readDashboardReplies('session-' + 'f'.repeat(32), { message_ids: [sent.message_id] }), /SESSION_ID_NOT_FOUND/);
});

test('agent-to-agent messages and replies use exact session inboxes even when seats are reusable', async () => {
  const { registry, advance, records } = mockMailbox();
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
  const immutablePath = registry.messagePath(recipient.agent_id, sent.message_id);
  const immutableBeforeRead = structuredClone(records.get(immutablePath).value);
  assert.equal(immutableBeforeRead.read_at, null);

  const incoming = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.deepEqual(records.get(immutablePath).value, immutableBeforeRead, 'read state must not mutate message bodies');
  assert.ok(records.has('messages/' + recipient.agent_id + '/' + sent.message_id + '.read.json'));
  assert.equal(incoming.count, 1);
  const original = incoming.messages[0];
  assert.equal(original.message, '[' + sender.session_id + '][' + sender.agent_id + '] Please check the API contract and report back.');
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
  assert.equal(response.messages[0].message, '[' + recipient.session_id + '][' + recipient.agent_id + '] Reviewed: the contract is consistent.');
  assert.equal(response.messages[0].in_reply_to, original.message_id);
  assert.equal(response.messages[0].thread_id, sent.thread_id);

  const status = await registry.statuses();
  assert.equal(status.count, 2);
  assert.deepEqual(status.agents.map(agent => agent.agent_id), ['agent-001', 'agent-002']);
  assert.equal(status.counts.active, 2);
  assert.equal(status.status_legend.busy.includes('executing'), true);

  advance(AGENT_ACTIVITY_RECENCY_WINDOW_MS + 1);
  const delivered = await registry.sendMessage(sender.session_id, {
    to_agent_id: recipient.agent_id, message: 'Are you there?'
  });
  assert.equal(delivered.status, 'sent', 'an idle session remains a valid message recipient');
  assert.equal(delivered.to_session_id, recipient.session_id);
  const inbox = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].message.includes('Are you there?'), true);
});

test('an idle session remains authenticated and keeps its agent seat indefinitely', async () => {
  const { registry, advance, records } = mockMailbox();
  const first = await registry.startSession({ label: 'Original conversation' });
  advance(365 * 24 * 60 * 60 * 1000);
  const status = await registry.statuses(first.agent_id);
  assert.equal(status.agents[0].status, 'inactive');
  assert.equal(status.agents[0].reusable, false);
  assert.equal((await registry.authenticate({ session_id: first.session_id })).session_id, first.session_id);
  const idleRequest = { request_id: 'req-agent001-idle001', session_id: first.session_id, agent_id: first.agent_id };
  assert.equal(await registry.requestStarted(idleRequest), true, 'a stable ID remains executable after a long idle interval');
  await registry.requestCompleted(idleRequest);
  const replacement = await registry.startSession({ label: 'Another conversation' });
  assert.equal(replacement.agent_id, 'agent-002');
  assert.notEqual(replacement.session_id, first.session_id);
  assert.equal(records.get('local/agents/' + first.agent_id + '.json').value.current_session_id, first.session_id);
});
test('recent legacy seats are protected until the recency window passes', async () => {
  const { registry, records, advance, now } = mockMailbox();
  const lastSeen = new Date(now()).toISOString();
  records.set('local/agents/agent-001.json', {
    value: {
      protocol: 'chatgpt-local-agent-record/v1', agent_id: 'agent-001',
      label: 'Legacy active agent', status: 'active', created_at: lastSeen,
      updated_at: lastSeen, last_seen_at: lastSeen, active_request_ids: [],
      recent_request_ids: [], last_request_id: null, last_completed_at: null
    }, sha: 'legacy-seat-sha'
  });
  const status = await registry.statuses();
  assert.equal(status.agents[0].status, 'active');
  assert.equal(status.agents[0].legacy_record, true);
  const newSession = await registry.startSession({ label: 'New conversation' });
  assert.equal(newSession.agent_id, 'agent-002');
  advance(AGENT_ACTIVITY_RECENCY_WINDOW_MS + 1);
  const replacement = await registry.startSession({ label: 'Replacement conversation' });
  assert.equal(replacement.agent_id, 'agent-001');
});


test('agent registry allocates one hundred simultaneous active conversations', async () => {
  const { registry } = mockMailbox();
  const sessions = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    registry.startSession({ label: 'Concurrent conversation ' + (index + 1) })
  ));
  const ids = sessions.map(item => item.agent_id);
  assert.equal(new Set(ids).size, 100);
  assert.ok(ids.includes('agent-021'));
  assert.ok(ids.includes('agent-100'));
  const status = await registry.statuses();
  assert.equal(status.count, 100);
  assert.equal(status.counts.active, 100);
  assert.equal(status.agents.filter(item => item.session_id).length, 100);
});


test('manual allocation cannot steal an idle session seat until explicit disconnect', async () => {
  const { registry, advance } = mockMailbox();
  const first = await registry.startSession({ label: 'Existing seat' });
  const second = await registry.startSession({ label: 'Second seat' });
  advance(AGENT_ACTIVITY_RECENCY_WINDOW_MS + 1);
  await assert.rejects(registry.startSession({ label: 'Should not steal seat', agent_id: second.agent_id }), /currently active or busy/);
  assert.equal((await registry.authenticate({ session_id: second.session_id })).agent_id, second.agent_id);
  const disconnected = await registry.disconnectSession(second.session_id);
  assert.equal(disconnected.disconnected, true);
  const third = await registry.startSession({ label: 'Selected seat after disconnect', agent_id: second.agent_id });
  assert.equal(third.agent_id, second.agent_id);
  assert.notEqual(third.session_id, second.session_id);
  await registry.requestStarted({ request_id: 'busy-seat-check', session_id: third.session_id, agent_id: third.agent_id });
  await assert.rejects(registry.startSession({ label: 'Busy seat should fail', agent_id: third.agent_id }), /currently active or busy/);
  assert.equal(first.agent_id, 'agent-001');
});
test('manual session allocation permits only the next sequential seat for a new agent ID', async () => {
  const { registry } = mockMailbox();
  const created = await registry.startSession({ label: 'New seat', agent_id: 'agent-001' });
  assert.equal(created.agent_id, 'agent-001');
  const second = await registry.startSession({ label: 'Next explicit ID', agent_id: 'agent-002' });
  assert.equal(second.agent_id, 'agent-002');
  await assert.rejects(
    registry.startSession({ label: 'Skip an ID', agent_id: 'agent-004' }),
    /not an existing reusable seat or the next available seat/
  );
});


test('explicit revocation persists a tombstone, releases only the reusable seat, and rejects stale session activity', async () => {
  const { registry, records } = mockMailbox();
  const first = await registry.startSession({ label: 'Session to revoke' });
  const activeRequest = { request_id: 'revoke-request-1', session_id: first.session_id, agent_id: first.agent_id };
  await registry.requestStarted(activeRequest);

  const revoked = await registry.revokeSession(first.session_id);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.agent_id, first.agent_id);
  assert.deepEqual(revoked.cancelled_request_ids, [activeRequest.request_id]);
  assert.equal(await registry.isRevoked(first.session_id), true);
  assert.ok(records.has('local/revoked-sessions/' + first.session_id + '.json'));
  assert.equal(records.get('local/sessions/' + first.session_id + '.json').value.status, 'revoked');
  assert.equal(records.get('local/agents/' + first.agent_id + '.json').value.current_session_id, null);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_REVOKED/);
  await assert.rejects(registry.requestStarted(activeRequest), /SESSION_REVOKED/);
  await assert.rejects(registry.sendUserMessage(first.session_id, { message: 'stale session' }), /SESSION_REVOKED/);

  const replacement = await registry.startSession({ label: 'Replacement session' });
  assert.equal(replacement.agent_id, first.agent_id, 'the reusable seat is immediately available');
  assert.notEqual(replacement.session_id, first.session_id, 'revoked conversation IDs are never reused');
  assert.equal(await registry.isRevoked(first.session_id), true);
  assert.equal(records.get('local/agents/' + first.agent_id + '.json').value.current_session_id, replacement.session_id);

  await registry.requestCompleted(activeRequest);
  assert.equal(records.get('local/sessions/' + first.session_id + '.json').value.status, 'revoked',
    'a late completion must not reactivate a revoked session');
});

test('revocation and request admission serialize on the same seat lock', async () => {
  const { registry } = mockMailbox();
  const session = await registry.startSession({ label: 'Concurrent revocation' });
  const request = { request_id: 'concurrent-request-1', session_id: session.session_id, agent_id: session.agent_id };
  const outcomes = await Promise.allSettled([
    registry.requestStarted(request),
    registry.revokeSession(session.session_id)
  ]);
  const revoked = outcomes.find(item => item.status === 'fulfilled' && item.value && item.value.revoked);
  assert.ok(revoked, 'the revocation operation must complete');
  await assert.rejects(registry.authenticate({ session_id: session.session_id }), /SESSION_REVOKED/);
  const activeIds = revoked.value.cancelled_request_ids;
  assert.ok(activeIds.length === 0 || activeIds.includes(request.request_id));
});

test('optional mailbox wipe removes only fully attributable records and preserves shared or incomplete records', async () => {
  const { registry, records } = mockMailbox();
  const target = await registry.startSession({ label: 'Wipe target' });
  const other = await registry.startSession({ label: 'Other agent' });
  const requestId = 'wipe-target-request';
  const request = { protocol: 'chatgpt-local-repo-bridge/v1', request_id: requestId, session_id: target.session_id, tool: 'read_file' };
  const claim = { protocol: 'chatgpt-local-repo-claim/v1', request_id: requestId, session_id: target.session_id, status: 'completed' };
  const result = { protocol: 'chatgpt-local-repo-result/v1', request_id: requestId, session_id: target.session_id, status: 'completed', artifacts: [] };
  const incompleteId = 'wipe-incomplete-request';
  records.set('request/' + target.agent_id + '/' + requestId + '.json', { value: request, sha: 'req-sha' });
  records.set('claims/' + target.agent_id + '/' + requestId + '.json', { value: claim, sha: 'claim-sha' });
  records.set('result/' + target.agent_id + '/' + requestId + '.json', { value: result, sha: 'result-sha' });
  records.set('sandbox storage/' + target.agent_id + '/' + requestId + '-orphaned-cancelled-output.txt', {
    value: 'artifact bytes owned by the request, but absent from its cancellation result manifest',
    sha: 'orphan-artifact-sha'
  });
  records.set('request/' + target.agent_id + '/' + incompleteId + '.json', {
    value: { ...request, request_id: incompleteId }, sha: 'incomplete-request-sha'
  });
  const targetMessage = {
    protocol: 'chatgpt-local-agent-message/v1', message_id: 'msg-0000000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sender_session_id: null, recipient_session_id: target.session_id, sender_agent_id: 'user',
    recipient_agent_id: target.agent_id, created_at: new Date().toISOString(), message: 'private'
  };
  const otherMessage = {
    ...targetMessage, message_id: 'msg-0000000000002-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    recipient_session_id: other.session_id, recipient_agent_id: other.agent_id
  };
  records.set('messages/' + target.agent_id + '/' + targetMessage.message_id + '.json',
    { value: targetMessage, sha: 'message-target-sha' });
  records.set('messages/' + other.agent_id + '/' + otherMessage.message_id + '.json',
    { value: otherMessage, sha: 'message-other-sha' });

  await registry.revokeSession(target.session_id);
  const cleanup = await registry.wipeMailbox(target.session_id);
  assert.equal(cleanup.status, 'completed_with_preserved_records');
  assert.equal(cleanup.deleted_request_records, 1);
  assert.equal(cleanup.preserved_request_records, 1);
  assert.equal(records.has('request/' + target.agent_id + '/' + requestId + '.json'), false);
  assert.equal(records.has('claims/' + target.agent_id + '/' + requestId + '.json'), false);
  assert.equal(records.has('result/' + target.agent_id + '/' + requestId + '.json'), false);
  assert.equal(records.has('sandbox storage/' + target.agent_id + '/' + requestId + '-orphaned-cancelled-output.txt'), false,
    'request-scoped orphan artifacts are removed even when the cancellation result has no manifest');
  assert.equal(records.has('request/' + target.agent_id + '/' + incompleteId + '.json'), true, 'incomplete session requests are preserved');
  assert.equal(records.has('messages/' + target.agent_id + '/' + targetMessage.message_id + '.json'), false);
  assert.equal(records.has('messages/' + other.agent_id + '/' + otherMessage.message_id + '.json'), true,
    'other sessions inbox records are preserved');
  assert.equal(records.has('local/sessions/' + target.session_id + '.json'), true);
  assert.equal(records.has('local/revoked-sessions/' + target.session_id + '.json'), true);
});


test('the per-session publication lock orders result commits before or after revocation', async () => {
  const { registry } = mockMailbox();
  const session = await registry.startSession({ label: 'Serialized result publication' });
  let markEntered;
  let releasePublication;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const held = new Promise(resolve => { releasePublication = resolve; });
  let revokedDuringPublication = null;
  const publication = registry.withSessionLock(session.session_id, async () => {
    revokedDuringPublication = await registry.isRevoked(session.session_id);
    markEntered();
    await held;
  });
  await entered;

  let revokeFinished = false;
  const revocation = registry.revokeSession(session.session_id).then(value => {
    revokeFinished = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(revokeFinished, false, 'revocation must wait for the in-flight result publication lock');
  assert.equal(revokedDuringPublication, false);

  releasePublication();
  await publication;
  const result = await revocation;
  assert.equal(result.revoked, true);
  assert.equal(await registry.isRevoked(session.session_id), true);
});


test('revocation is ordered before later dashboard messages to that session', async () => {
  const { registry, records } = mockMailbox();
  const session = await registry.startSession({ label: 'Message race target' });
  let enteredLock;
  let releaseLock;
  const entered = new Promise(resolve => { enteredLock = resolve; });
  const held = new Promise(resolve => { releaseLock = resolve; });
  const blocker = registry.withSessionLock(session.session_id, async () => {
    enteredLock();
    await held;
  });
  await entered;

  const revocation = registry.revokeSession(session.session_id);
  await new Promise(resolve => setTimeout(resolve, 10));
  const sending = registry.sendUserMessage(session.session_id, { message: 'must not arrive after deletion' });
  releaseLock();
  await blocker;
  await revocation;
  await assert.rejects(sending, /SESSION_REVOKED/);
  assert.deepEqual(
    [...records.keys()].filter(path => path.startsWith('messages/' + session.agent_id + '/')),
    [],
    'no new inbox message may be written after the revocation tombstone'
  );
});

test('agent-to-agent sends serialize against recipient revocation', async () => {
  const { registry, records } = mockMailbox();
  const sender = await registry.startSession({ label: 'Message sender' });
  const recipient = await registry.startSession({ label: 'Message recipient' });
  let enteredLock;
  let releaseLock;
  const entered = new Promise(resolve => { enteredLock = resolve; });
  const held = new Promise(resolve => { releaseLock = resolve; });
  const blocker = registry.withSessionLock(recipient.session_id, async () => {
    enteredLock();
    await held;
  });
  await entered;

  const revocation = registry.revokeSession(recipient.session_id);
  await new Promise(resolve => setTimeout(resolve, 10));
  const sending = registry.sendMessage(sender.session_id, {
    to_session_id: recipient.session_id, subject: 'Race test', message: 'must not arrive after deletion'
  });
  releaseLock();
  await blocker;
  await revocation;
  await assert.rejects(sending, /SESSION_REVOKED/);
  assert.deepEqual(
    [...records.keys()].filter(path => path.startsWith('messages/' + recipient.agent_id + '/')),
    [],
    'no agent-to-agent inbox message may be written after recipient revocation'
  );
});


test('session pause blocks authentication, retains its seat, and resumes without changing identity', async () => {
  const { registry, records } = mockMailbox();
  const session = await registry.startSession({ label: 'Pause lifecycle' });
  assert.match(session.context_message, /agent-001/);
  assert.match(session.context_message, new RegExp(session.session_id));
  const paused = await registry.setSessionPaused(session.session_id, true);
  assert.equal(paused.paused, true);
  await assert.rejects(registry.authenticate({ session_id: session.session_id }), /SESSION_PAUSED/);
  const seatWhilePaused = records.get('local/agents/agent-001.json').value;
  assert.equal(seatWhilePaused.current_session_id, session.session_id);
  assert.equal(seatWhilePaused.status, 'paused');
  const statusWhilePaused = await registry.statuses();
  assert.equal(statusWhilePaused.agents[0].status, 'paused');
  const resumed = await registry.setSessionPaused(session.session_id, false);
  assert.equal(resumed.paused, false);
  assert.equal((await registry.authenticate({ session_id: session.session_id })).agent_id, 'agent-001');
  assert.equal(records.get('local/sessions/' + session.session_id + '.json').value.status, 'active');
});

test('disconnect releases the reusable seat while preserving a permanently detached session record', async () => {
  const { registry, records } = mockMailbox();
  const session = await registry.startSession({ label: 'Disconnect lifecycle' });
  const result = await registry.disconnectSession(session.session_id);
  assert.equal(result.disconnected, true);
  assert.equal(result.seat_released, true);
  assert.equal(records.get('local/sessions/' + session.session_id + '.json').value.status, 'disconnected');
  assert.equal(records.get('local/agents/agent-001.json').value.current_session_id, null);
  await assert.rejects(registry.authenticate({ session_id: session.session_id }), /SESSION_DISCONNECTED/);
  const replacement = await registry.startSession({ label: 'Replacement session' });
  assert.equal(replacement.agent_id, 'agent-001');
  assert.notEqual(replacement.session_id, session.session_id);
  assert.ok(records.has('local/sessions/' + session.session_id + '.json'));
});

test('the 10,000-ID hard cap evicts the oldest last-activity session automatically', async () => {
  const { registry, records, advance } = mockMailbox(Date.now(), { maxSessions: 2 });
  const first = await registry.startSession({ label: 'Oldest registered session' });
  advance(1000);
  const second = await registry.startSession({ label: 'Newer registered session' });
  advance(1000);
  const third = await registry.startSession({ label: 'Session created at the hard cap' });

  assert.equal(records.has('local/sessions/' + first.session_id + '.json'), false);
  assert.equal(records.has('local/evicted-sessions/' + first.session_id + '.json'), true);
  assert.equal(records.get('local/evicted-sessions/' + first.session_id + '.json').value.reason, 'hard_registration_cap');
  assert.deepEqual(third.evicted_sessions.map(item => item.session_id), [first.session_id]);
  assert.equal([...records.keys()].filter(path => path.startsWith('local/sessions/')).length, 2);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_EVICTED/);
  assert.equal((await registry.authenticate({ session_id: second.session_id })).session_id, second.session_id);
  assert.equal((await registry.authenticate({ session_id: third.session_id })).session_id, third.session_id);
});

test('the hard cap evicts the oldest paused or busy session and returns active requests for cancellation', async () => {
  const { registry, advance, records } = mockMailbox(Date.now(), { maxSessions: 2 });
  const paused = await registry.startSession({ label: 'Oldest paused session' });
  await registry.setSessionPaused(paused.session_id, true);
  advance(1000);
  const busy = await registry.startSession({ label: 'Busy session' });
  const request = { request_id: 'req-agent002-busy001', session_id: busy.session_id, agent_id: busy.agent_id };
  await registry.requestStarted(request);
  advance(1000);

  const third = await registry.startSession({ label: 'Replacement after eviction' });
  assert.deepEqual(third.evicted_sessions.map(item => item.session_id), [paused.session_id]);
  assert.equal(records.has('local/evicted-sessions/' + paused.session_id + '.json'), true);
  assert.equal(records.get('local/sessions/' + busy.session_id + '.json').value.active_request_ids.includes(request.request_id), true,
    'the newer busy session remains registered and its operation is not selected as the oldest');
  assert.equal((await registry.authenticate({ session_id: busy.session_id })).session_id, busy.session_id);
});

test('a busy session is eligible for oldest-activity eviction and its active request IDs are preserved', async () => {
  const { registry, advance, records } = mockMailbox(Date.now(), { maxSessions: 2 });
  const busy = await registry.startSession({ label: 'Oldest busy session' });
  const request = { request_id: 'req-agent001-running001', session_id: busy.session_id, agent_id: busy.agent_id };
  await registry.requestStarted(request);
  advance(1000);
  const newer = await registry.startSession({ label: 'Newer session' });
  advance(1000);
  const replacement = await registry.startSession({ label: 'Third session' });

  assert.deepEqual(replacement.evicted_sessions.map(item => item.session_id), [busy.session_id]);
  assert.deepEqual(replacement.evicted_sessions[0].cancelled_request_ids, [request.request_id]);
  assert.equal(records.has('local/sessions/' + busy.session_id + '.json'), false);
  assert.equal(records.has('local/evicted-sessions/' + busy.session_id + '.json'), true);
  assert.equal((await registry.authenticate({ session_id: newer.session_id })).session_id, newer.session_id);
});

test('failed SHA-checked eviction leaves the oldest session registered and usable', async () => {
  const options = { maxSessions: 1, failDelete: true };
  const { registry, records, advance } = mockMailbox(Date.now(), options);
  const first = await registry.startSession({ label: 'Must survive failed eviction' });
  advance(1000);
  await assert.rejects(registry.startSession({ label: 'Retry after transport failure' }), /simulated temporary transport failure/);
  assert.equal(records.has('local/sessions/' + first.session_id + '.json'), true);
  assert.equal(records.has('local/evicted-sessions/' + first.session_id + '.json'), true,
    'the eviction intent is durable before deletion so a retry can complete it safely');
  assert.equal(await registry.isEvicted(first.session_id), false,
    'a pending eviction tombstone is not a completed eviction');
  assert.equal((await registry.authenticate({ session_id: first.session_id })).session_id, first.session_id,
    'a pending tombstone does not invalidate a session whose registration still exists');

  options.failDelete = false;
  const next = await registry.startSession({ label: 'Retry succeeds' });
  assert.deepEqual(next.evicted_sessions.map(item => item.session_id), [first.session_id]);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_EVICTED/);
});


test('cap eviction does not erase the explicit-disconnect reason', async () => {
  const { registry, advance } = mockMailbox(Date.now(), { maxSessions: 1 });
  const disconnected = await registry.startSession({ label: 'Explicitly disconnected before cap' });
  await registry.disconnectSession(disconnected.session_id);
  advance(1000);
  const next = await registry.startSession({ label: 'Replacement ID' });
  assert.deepEqual(next.evicted_sessions.map(item => item.session_id), [disconnected.session_id]);
  await assert.rejects(registry.authenticate({ session_id: disconnected.session_id }), /SESSION_DISCONNECTED/);
});


test('oldest-session eviction errors are propagated when a requested seat is unavailable', async () => {
  const { registry, records, advance } = mockMailbox(Date.now(), { maxSessions: 2 });
  const oldest = await registry.startSession({ label: 'Session selected for cap eviction' });
  advance(1000);
  const occupied = await registry.startSession({ label: 'Requested occupied seat' });
  advance(1000);

  let failure;
  try {
    await registry.startSession({ label: 'Must report eviction even on allocation failure', agent_id: occupied.agent_id });
  } catch (error) {
    failure = error;
  }

  assert.match(String(failure && failure.message), /currently active or busy/);
  assert.deepEqual(failure.evicted_sessions.map(item => item.session_id), [oldest.session_id]);
  assert.equal(records.has('local/sessions/' + oldest.session_id + '.json'), false);
  assert.equal(await registry.isEvicted(oldest.session_id), true);
  assert.equal((await registry.authenticate({ session_id: occupied.session_id })).session_id, occupied.session_id);
});

test('a non-conflict deletion failure aborts cap enforcement without spinning', async () => {
  const options = { maxSessions: 1, failDeleteResult: { ok: false, conflict: false } };
  const { registry, records, advance } = mockMailbox(Date.now(), options);
  const retained = await registry.startSession({ label: 'Must remain registered' });
  advance(1000);

  await assert.rejects(registry.startSession(), /SHA-checked session deletion did not complete/);
  assert.equal(records.has('local/sessions/' + retained.session_id + '.json'), true);
  assert.equal(await registry.isEvicted(retained.session_id), false);
  assert.equal((await registry.authenticate({ session_id: retained.session_id })).session_id, retained.session_id);
});


test('partial over-cap cleanup reports already evicted IDs when a later deletion fails', async () => {
  const options = { maxSessions: 2, failDeleteAt: 2, failDeleteResult: { ok: false, conflict: false } };
  const { registry, records, advance, now } = mockMailbox(Date.now(), options);
  const first = await registry.startSession({ label: 'First and oldest' });
  advance(1000);
  const second = await registry.startSession({ label: 'Second' });
  const imported = 'session-' + 'f'.repeat(32);
  const at = new Date(now() + 1000).toISOString();
  records.set('local/sessions/' + imported + '.json', {
    value: {
      protocol: SESSION_RECORD_PROTOCOL, session_id: imported, agent_id: 'agent-900',
      label: 'Imported session', status: 'active', created_at: at, updated_at: at,
      last_activity_at: at, active_request_ids: [], recent_request_ids: []
    }, sha: 'imported-session-sha'
  });
  advance(1000);

  let failure;
  try {
    await registry.startSession({ label: 'Will fail after first eviction' });
  } catch (error) {
    failure = error;
  }

  assert.match(String(failure && failure.message), /SHA-checked session deletion did not complete/);
  assert.deepEqual(failure.evicted_sessions.map(item => item.session_id), [first.session_id]);
  assert.equal(records.has('local/sessions/' + first.session_id + '.json'), false);
  assert.equal(records.has('local/sessions/' + second.session_id + '.json'), true);
  assert.equal(records.has('local/evicted-sessions/' + first.session_id + '.json'), true);
  assert.equal(await registry.isEvicted(first.session_id), true);
});


test('a delete response lost after the remote commit is reconciled as a completed eviction', async () => {
  const { registry, records, advance } = mockMailbox(Date.now(), {
    maxSessions: 1,
    deleteThenFailResult: { ok: false, conflict: false }
  });
  const first = await registry.startSession({ label: 'Deleted despite ambiguous response' });
  advance(1000);

  const next = await registry.startSession({ label: 'Retry reconciles completed delete' });
  assert.deepEqual(next.evicted_sessions.map(item => item.session_id), [first.session_id]);
  assert.equal(records.has('local/sessions/' + first.session_id + '.json'), false);
  assert.equal(records.has('local/evicted-sessions/' + first.session_id + '.json'), true);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_EVICTED/);
  assert.equal((await registry.authenticate({ session_id: next.session_id })).session_id, next.session_id);
});
test('the cap removes enough oldest records to return below its hard limit', async () => {
  const { registry, records, advance, now } = mockMailbox(Date.now(), { maxSessions: 2 });
  const first = await registry.startSession({ label: 'First' });
  advance(1000);
  const second = await registry.startSession({ label: 'Second' });
  // Model a pre-existing over-cap mailbox produced by an older build or concurrent writer.
  for (let index = 0; index < 2; index++) {
    const sessionId = 'session-' + String(index + 1).padStart(32, 'a');
    const at = new Date(now() + (index + 1) * 1000).toISOString();
    records.set('local/sessions/' + sessionId + '.json', {
      value: {
        protocol: SESSION_RECORD_PROTOCOL, session_id: sessionId, agent_id: 'agent-900',
        label: 'Imported over-cap session ' + index, status: 'active',
        created_at: at, updated_at: at, last_activity_at: at,
        active_request_ids: [], recent_request_ids: []
      }, sha: 'seed-sha-' + index
    });
  }
  advance(1000);
  const third = await registry.startSession({ label: 'Trim over-cap inventory' });
  assert.equal([...records.keys()].filter(path => path.startsWith('local/sessions/')).length, 2);
  assert.ok(third.evicted_sessions.length >= 2);
  assert.equal(records.has('local/evicted-sessions/' + first.session_id + '.json'), true);
  assert.equal(records.has('local/evicted-sessions/' + second.session_id + '.json'), true);
  assert.equal(records.has('local/sessions/' + 'session-' + String(1).padStart(32, 'a') + '.json'), false);
  assert.equal(records.has('local/sessions/' + 'session-' + String(2).padStart(32, 'a') + '.json'), true);
  assert.equal((await registry.authenticate({ session_id: third.session_id })).session_id, third.session_id);
});
test('dashboard unread message counts are read-only and use exact session receipts', async () => {
  const { registry, records } = mockMailbox();
  const sender = await registry.startSession({ label: 'Unread sender' });
  const recipient = await registry.startSession({ label: 'Unread recipient' });
  const sent = await registry.sendMessage(sender.session_id, {
    to_session_id: recipient.session_id, subject: 'Unread test', message: 'Incoming agent message'
  });
  await registry.sendUserMessage(recipient.session_id, { message: 'User messages are not counted as incoming agent messages.' });
  const unread = await registry.statuses(recipient.agent_id);
  assert.equal(unread.agents[0].unread_message_count, 1);
  assert.equal(unread.agents[0].unread_message_count_partial, false);
  await registry.sendMessage(sender.session_id, {
    to_session_id: recipient.session_id, subject: 'Unread test 2', message: 'Cache increment test'
  });
  const afterSecondSend = await registry.statuses(recipient.agent_id);
  assert.equal(afterSecondSend.agents[0].unread_message_count, 2, 'a new agent message increments a warmed cache');
  assert.equal(records.has('messages/' + recipient.agent_id + '/' + sent.message_id + '.read.json'), false,
    'counting unread messages must not mark them as read');
  const read = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.equal(read.count, 3, 'the existing inbox reader still includes user and both agent messages');
  const afterRead = await registry.statuses(recipient.agent_id);
  assert.equal(afterRead.agents[0].unread_message_count, 0);
  assert.equal(records.has('messages/' + recipient.agent_id + '/' + sent.message_id + '.read.json'), true);
});
