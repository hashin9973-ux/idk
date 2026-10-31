'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAgentRegistry,
  AGENT_RECORD_PROTOCOL,
  SESSION_RECORD_PROTOCOL,
  SESSION_INACTIVE_AFTER_MS
} = require('../desktop/agent-registry');

function mockMailbox(startTime = Date.now(), options = {}) {
  const records = new Map();
  let nextSha = 1;
  let now = startTime;
  const registry = createAgentRegistry({
    clock: () => now,
    isSessionAutoExpireEnabled: () => options.autoExpire === true,
    maxSessions: Number.isInteger(options.maxSessions) ? options.maxSessions : 10000,
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
    async deleteRemoteFiles(files) {
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

test('dashboard custom messages are written to the exact active session inbox', async () => {
  const { registry, records } = mockMailbox();
  const recipient = await registry.startSession({ label: 'Agent receiving a custom message' });
  const sent = await registry.sendUserMessage(recipient.session_id, {
    message: 'Inspect the selected project and report the current test status.'
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.to_agent_id, recipient.agent_id);
  const record = records.get(registry.messagePath(recipient.session_id, sent.message_id)).value;
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
  const replyRecord = records.get(registry.messagePath(recipient.session_id, reply.message_id)).value;
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
  await assert.rejects(registry.readDashboardReplies('session-' + 'f'.repeat(32), { message_ids: [sent.message_id] }), /SESSION_EXPIRED/);
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
  const immutablePath = registry.messagePath(recipient.session_id, sent.message_id);
  const immutableBeforeRead = structuredClone(records.get(immutablePath).value);
  assert.equal(immutableBeforeRead.read_at, null);

  const incoming = await registry.readMessages(recipient.session_id, { unread_only: true });
  assert.deepEqual(records.get(immutablePath).value, immutableBeforeRead, 'read state must not mutate message bodies');
  assert.ok(records.has('bridge/agent-message-receipts/' + recipient.session_id + '/' + sent.message_id + '.json'));
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

  advance(SESSION_INACTIVE_AFTER_MS + 1);
  await assert.rejects(
    registry.sendMessage(sender.session_id, { to_agent_id: recipient.agent_id, message: 'Are you there?' }),
    /inactive|SESSION_EXPIRED/i
  );
});

test('an idle session is rejected after its inactivity lease expires', async () => {
  const { registry, advance } = mockMailbox();
  const first = await registry.startSession({ label: 'Original conversation' });
  advance(SESSION_INACTIVE_AFTER_MS + 1);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_EXPIRED/i);
  const replacement = await registry.startSession({ label: 'Replacement conversation' });
  assert.equal(replacement.agent_id, first.agent_id);
  assert.notEqual(replacement.session_id, first.session_id);
});

test('recent legacy seats are protected until their activity expires', async () => {
  const { registry, records, advance, now } = mockMailbox();
  const lastSeen = new Date(now()).toISOString();
  records.set('bridge/agents/agent-001.json', {
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
  advance(SESSION_INACTIVE_AFTER_MS + 1);
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


test('manual session allocation honors an explicitly selected inactive seat and rejects a busy seat', async () => {
  const { registry, advance } = mockMailbox();
  const first = await registry.startSession({ label: 'Existing seat' });
  const second = await registry.startSession({ label: 'Second seat' });
  advance(SESSION_INACTIVE_AFTER_MS + 1);
  const third = await registry.startSession({ label: 'Selected seat', agent_id: second.agent_id });
  assert.equal(third.agent_id, second.agent_id);
  assert.notEqual(third.session_id, second.session_id);
  await assert.rejects(
    registry.startSession({ label: 'Busy seat should fail', agent_id: third.agent_id }),
    /currently active or busy/
  );
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
  assert.ok(records.has('bridge/revoked-sessions/' + first.session_id + '.json'));
  assert.equal(records.get('bridge/sessions/' + first.session_id + '.json').value.status, 'revoked');
  assert.equal(records.get('bridge/agents/' + first.agent_id + '.json').value.current_session_id, null);
  await assert.rejects(registry.authenticate({ session_id: first.session_id }), /SESSION_REVOKED/);
  await assert.rejects(registry.requestStarted(activeRequest), /SESSION_REVOKED/);
  await assert.rejects(registry.sendUserMessage(first.session_id, { message: 'stale session' }), /SESSION_REVOKED/);

  const replacement = await registry.startSession({ label: 'Replacement session' });
  assert.equal(replacement.agent_id, first.agent_id, 'the reusable seat is immediately available');
  assert.notEqual(replacement.session_id, first.session_id, 'revoked conversation IDs are never reused');
  assert.equal(await registry.isRevoked(first.session_id), true);
  assert.equal(records.get('bridge/agents/' + first.agent_id + '.json').value.current_session_id, replacement.session_id);

  await registry.requestCompleted(activeRequest);
  assert.equal(records.get('bridge/sessions/' + first.session_id + '.json').value.status, 'revoked',
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
  records.set('bridge/requests/' + requestId + '.json', { value: request, sha: 'req-sha' });
  records.set('bridge/claims/' + requestId + '.json', { value: claim, sha: 'claim-sha' });
  records.set('bridge/results/' + requestId + '.json', { value: result, sha: 'result-sha' });
  records.set('bridge/artifacts/' + requestId + '/orphaned-cancelled-output.txt', {
    value: 'artifact bytes owned by the request, but absent from its cancellation result manifest',
    sha: 'orphan-artifact-sha'
  });
  records.set('bridge/requests/' + incompleteId + '.json', {
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
  records.set('bridge/agent-messages/' + target.session_id + '/' + targetMessage.message_id + '.json',
    { value: targetMessage, sha: 'message-target-sha' });
  records.set('bridge/agent-messages/' + other.session_id + '/' + otherMessage.message_id + '.json',
    { value: otherMessage, sha: 'message-other-sha' });

  await registry.revokeSession(target.session_id);
  const cleanup = await registry.wipeMailbox(target.session_id);
  assert.equal(cleanup.status, 'completed_with_preserved_records');
  assert.equal(cleanup.deleted_request_records, 1);
  assert.equal(cleanup.preserved_request_records, 1);
  assert.equal(records.has('bridge/requests/' + requestId + '.json'), false);
  assert.equal(records.has('bridge/claims/' + requestId + '.json'), false);
  assert.equal(records.has('bridge/results/' + requestId + '.json'), false);
  assert.equal(records.has('bridge/artifacts/' + requestId + '/orphaned-cancelled-output.txt'), false,
    'request-scoped orphan artifacts are removed even when the cancellation result has no manifest');
  assert.equal(records.has('bridge/requests/' + incompleteId + '.json'), true, 'incomplete session requests are preserved');
  assert.equal(records.has('bridge/agent-messages/' + target.session_id + '/' + targetMessage.message_id + '.json'), false);
  assert.equal(records.has('bridge/agent-messages/' + other.session_id + '/' + otherMessage.message_id + '.json'), true,
    'other sessions inbox records are preserved');
  assert.equal(records.has('bridge/sessions/' + target.session_id + '.json'), true);
  assert.equal(records.has('bridge/revoked-sessions/' + target.session_id + '.json'), true);
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
    [...records.keys()].filter(path => path.startsWith('bridge/agent-messages/' + session.session_id + '/')),
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
    [...records.keys()].filter(path => path.startsWith('bridge/agent-messages/' + recipient.session_id + '/')),
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
  const seatWhilePaused = records.get('bridge/agents/agent-001.json').value;
  assert.equal(seatWhilePaused.current_session_id, session.session_id);
  assert.equal(seatWhilePaused.status, 'paused');
  const statusWhilePaused = await registry.statuses();
  assert.equal(statusWhilePaused.agents[0].status, 'paused');
  const resumed = await registry.setSessionPaused(session.session_id, false);
  assert.equal(resumed.paused, false);
  assert.equal((await registry.authenticate({ session_id: session.session_id })).agent_id, 'agent-001');
  assert.equal(records.get('bridge/sessions/' + session.session_id + '.json').value.status, 'active');
});

test('disconnect releases the reusable seat while preserving a permanently detached session record', async () => {
  const { registry, records } = mockMailbox();
  const session = await registry.startSession({ label: 'Disconnect lifecycle' });
  const result = await registry.disconnectSession(session.session_id);
  assert.equal(result.disconnected, true);
  assert.equal(result.seat_released, true);
  assert.equal(records.get('bridge/sessions/' + session.session_id + '.json').value.status, 'disconnected');
  assert.equal(records.get('bridge/agents/agent-001.json').value.current_session_id, null);
  await assert.rejects(registry.authenticate({ session_id: session.session_id }), /SESSION_DISCONNECTED/);
  const replacement = await registry.startSession({ label: 'Replacement session' });
  assert.equal(replacement.agent_id, 'agent-001');
  assert.notEqual(replacement.session_id, session.session_id);
  assert.ok(records.has('bridge/sessions/' + session.session_id + '.json'));
});

test('session cap refuses creation when auto-expire is disabled', async () => {
  const { registry, records } = mockMailbox(Date.now(), { maxSessions: 2, autoExpire: false });
  const first = await registry.startSession();
  await registry.startSession();
  await assert.rejects(registry.startSession(), /SESSION_LIMIT_REACHED/);
  assert.ok(records.has('bridge/sessions/' + first.session_id + '.json'));
  assert.equal([...records.keys()].filter(key => key.startsWith('bridge/sessions/')).length, 2);
});

test('session auto-expire selects the oldest eligible non-busy inactive session at the hard cap', async () => {
  const start = Date.now();
  const { registry, records, advance, now } = mockMailbox(start, { maxSessions: 2, autoExpire: true });
  const oldest = await registry.startSession({ label: 'Oldest' });
  const newer = await registry.startSession({ label: 'Newer' });
  advance(9 * 60 * 1000);
  await registry.requestStarted({ session_id: newer.session_id, agent_id: newer.agent_id, request_id: 'req-newer-activity' });
  await registry.requestCompleted({ session_id: newer.session_id, agent_id: newer.agent_id, request_id: 'req-newer-activity' });
  advance(2 * 60 * 1000);
  const replacement = await registry.startSession({ label: 'Replacement' });
  assert.equal(replacement.agent_id, oldest.agent_id);
  assert.notEqual(replacement.session_id, oldest.session_id);
  assert.equal(records.has('bridge/sessions/' + oldest.session_id + '.json'), false);
  assert.equal(records.has('bridge/sessions/' + newer.session_id + '.json'), true);
  assert.ok(Date.parse(records.get('bridge/sessions/' + newer.session_id + '.json').value.last_activity_at) > start);
});

test('session auto-expire never evicts a paused session even when it is the only record', async () => {
  const { registry, records, advance } = mockMailbox(Date.now(), { maxSessions: 1, autoExpire: true });
  const session = await registry.startSession({ label: 'Paused retention guard' });
  await registry.setSessionPaused(session.session_id, true);
  advance(60 * 60 * 1000);
  await assert.rejects(registry.startSession(), /All 1 sessions are active, busy, paused/);
  assert.ok(records.has('bridge/sessions/' + session.session_id + '.json'));
  assert.equal(records.get('bridge/agents/agent-001.json').value.current_session_id, session.session_id);
});
