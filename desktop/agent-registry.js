'use strict';

const { randomBytes } = require('node:crypto');

const AGENT_RECORD_PROTOCOL = 'chatgpt-local-agent-seat/v2';
const SESSION_RECORD_PROTOCOL = 'chatgpt-local-agent-session/v1';
const REQUEST_RECORD_PROTOCOL = 'chatgpt-local-repo-bridge/v1';
const REVOCATION_RECORD_PROTOCOL = 'chatgpt-local-agent-session-revocation/v1';
const EVICTION_RECORD_PROTOCOL = 'chatgpt-local-agent-session-eviction/v1';
// Local operator messages use a dedicated sender identity and do not borrow an agent session.
const AGENT_ID_PATTERN = /^agent-[0-9]{3,}$/;
const SESSION_ID_PATTERN = /^session-[a-f0-9]{32}$/;
const MESSAGE_ID_PATTERN = /^msg-[0-9]{13}-[a-f0-9]{32}$/;
// Recent-activity display window only; it never expires a session or releases its seat.
const AGENT_ACTIVITY_RECENCY_WINDOW_MS = 10 * 60 * 1000;
const AGENT_STALE_AFTER_MS = AGENT_ACTIVITY_RECENCY_WINDOW_MS;

function safeLabel(value, fallback) {
  const label = String(value || '').replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return label || fallback;
}

function cleanMessage(value, maxLength, field) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string.');
  const result = value.replace(/\u0000/g, '').trim();
  if (!result) throw new Error(field + ' must not be empty.');
  if (result.length > maxLength) throw new Error(field + ' exceeds the ' + maxLength + '-character limit.');
  return result;
}

function formatAgentMessage(session, value) {
  const body = cleanMessage(value, 20000, 'message');
  const prefix = '[' + session.session_id + '][' + session.agent_id + ']';
  return body.startsWith(prefix) ? body : prefix + ' ' + body;
}

function createAgentRegistry({ readRemoteFile, listFolder, writeRemoteJson, deleteRemoteFiles = null, isConflict, clock = () => Date.now(), maxSessions = 10000 }) {
  if (typeof readRemoteFile !== 'function' || typeof listFolder !== 'function' ||
      typeof writeRemoteJson !== 'function' || typeof isConflict !== 'function') {
    throw new TypeError('Agent registry dependencies are incomplete.');
  }

  const locks = new Map();
  const unreadMessageCountCache = new Map();
  const UNREAD_MESSAGE_SCAN_LIMIT = 25;
  const UNREAD_MESSAGE_CACHE_TTL_MS = 60 * 60 * 1000;

  function timestamp() { return new Date(clock()).toISOString(); }
  function seatPath(agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid Agent ID.');
    return 'bridge/agents/' + agentId + '.json';
  }
  function sessionPath(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session_id. Call session_start to create a session.');
    return 'bridge/sessions/' + sessionId + '.json';
  }
  function revocationPath(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session_id.');
    return 'bridge/revoked-sessions/' + sessionId + '.json';
  }
  function evictionPath(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session_id.');
    return 'bridge/evicted-sessions/' + sessionId + '.json';
  }
  function inboxPath(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid recipient session ID.');
    return 'bridge/agent-messages/' + sessionId;
  }
  function messagePath(sessionId, messageId) {
    if (!MESSAGE_ID_PATTERN.test(String(messageId || ''))) throw new Error('Invalid message_id.');
    return inboxPath(sessionId) + '/' + messageId + '.json';
  }
  function messageReceiptPath(sessionId, messageId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid recipient session ID.');
    if (!MESSAGE_ID_PATTERN.test(String(messageId || ''))) throw new Error('Invalid message_id.');
    return 'bridge/agent-message-receipts/' + sessionId + '/' + messageId + '.json';
  }

  async function withLock(key, operation) {
    const prior = locks.get(key) || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    const queued = prior.catch(() => {}).then(() => gate);
    locks.set(key, queued);
    await prior.catch(() => {});
    try { return await operation(); }
    finally {
      unlock();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }

  function withSessionLock(sessionId, operation) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('A valid session_id is required.');
    if (typeof operation !== 'function') throw new TypeError('A session lock operation is required.');
    return withLock('session:' + sessionId, operation);
  }

  function withSessionLocks(sessionIds, operation) {
    if (!Array.isArray(sessionIds) || typeof operation !== 'function') {
      throw new TypeError('Session IDs and a lock operation are required.');
    }
    const ordered = [...new Set(sessionIds)].sort();
    if (!ordered.length) throw new Error('At least one session_id is required.');
    for (const sessionId of ordered) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new Error('A valid session_id is required.');
      }
    }
    const acquire = index => index >= ordered.length
      ? operation()
      : withSessionLock(ordered[index], () => acquire(index + 1));
    return acquire(0);
  }

  function isConflictError(error) {
    try { return Boolean(isConflict(error)); }
    catch { return /conflict|sha was not supplied|does not match|409|422/i.test(String(error && error.message || error)); }
  }

  function validateSessionRecord(value, sessionId) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.protocol !== SESSION_RECORD_PROTOCOL || value.session_id !== sessionId ||
        !AGENT_ID_PATTERN.test(String(value.agent_id || ''))) {
      throw new Error('Session record ' + sessionId + ' is malformed; refusing to overwrite it.');
    }
    return value;
  }

  function validateSeatRecord(value, agentId) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.agent_id !== agentId) {
      throw new Error('Agent seat record ' + agentId + ' is malformed; refusing to overwrite it.');
    }
    if (value.protocol !== AGENT_RECORD_PROTOCOL && value.protocol !== 'chatgpt-local-agent-record/v1') {
      throw new Error('Agent seat record ' + agentId + ' has an unsupported protocol.');
    }
    if (value.protocol === AGENT_RECORD_PROTOCOL &&
        value.current_session_id && !SESSION_ID_PATTERN.test(String(value.current_session_id))) {
      throw new Error('Agent seat record ' + agentId + ' has a malformed current_session_id.');
    }
    return value;
  }

  async function readSeat(agentId) {
    const remote = await readRemoteFile(seatPath(agentId));
    if (!remote) return null;
    validateSeatRecord(remote.value, agentId);
    return remote;
  }

  async function readSession(sessionId) {
    const remote = await readRemoteFile(sessionPath(sessionId));
    if (!remote) return null;
    validateSessionRecord(remote.value, sessionId);
    return remote;
  }

  async function readRevocation(sessionId) {
    const remote = await readRemoteFile(revocationPath(sessionId));
    if (!remote) return null;
    const value = remote.value;
    if (!value || value.protocol !== REVOCATION_RECORD_PROTOCOL || value.session_id !== sessionId ||
        !AGENT_ID_PATTERN.test(String(value.agent_id || '')) || typeof value.revoked_at !== 'string') {
      throw new Error('Session revocation record ' + sessionId + ' is malformed; refusing to authenticate it.');
    }
    return remote;
  }

  async function isRevoked(sessionId) {
    return Boolean(await readRevocation(sessionId));
  }

  async function readEviction(sessionId) {
    const remote = await readRemoteFile(evictionPath(sessionId));
    if (!remote) return null;
    const value = remote.value;
    if (!value || value.protocol !== EVICTION_RECORD_PROTOCOL || value.session_id !== sessionId ||
        !AGENT_ID_PATTERN.test(String(value.agent_id || '')) || typeof value.evicted_at !== 'string') {
      throw new Error('Session eviction record ' + sessionId + ' is malformed; refusing to authenticate it.');
    }
    return remote;
  }

  async function isEvicted(sessionId) {
    const eviction = await readEviction(sessionId);
    return Boolean(eviction && !(await readSession(sessionId)));
  }

  async function assertNotEvicted(sessionId) {
    const eviction = await readEviction(sessionId);
    if (!eviction) return;
    // Eviction records are written before SHA-checked session deletion. A retained
    // session file means the tombstone is still pending and must not invalidate it.
    if (await readSession(sessionId)) return;
    if (eviction.value.previous_status === 'disconnected') {
      throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected before cap eviction.');
    }
    throw new Error('SESSION_EVICTED: This session ID was removed by the 10,000-ID registration cap. Start a new conversation session before using the bridge again.');
  }

  async function assertNotRevoked(sessionId) {
    if (await isRevoked(sessionId)) {
      throw new Error('SESSION_REVOKED: This ChatGPT session was explicitly revoked. Start a new conversation session before using the bridge again.');
    }
  }

  async function writeNewJson(path, value) {
    const saved = await writeRemoteJson(path, value, null, true);
    if (!saved || !saved.ok) throw new Error('Could not create immutable mailbox record ' + path + '.');
    return saved;
  }

  async function mutateJson(path, validate, mutator, retries = 6) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const remote = await readRemoteFile(path);
      if (!remote) throw new Error('Mailbox record was not found: ' + path);
      const current = validate(remote.value);
      const next = { ...mutator({ ...current }), updated_at: timestamp() };
      try {
        const saved = await writeRemoteJson(path, next, remote.sha, false);
        if (saved && saved.ok) return next;
        throw new Error('Mailbox record update conflicted: ' + path);
      } catch (error) {
        if (!isConflictError(error) || attempt === retries - 1) throw error;
      }
    }
    throw new Error('Could not update mailbox record after repeated conflicts: ' + path);
  }

  async function mutateSession(sessionId, mutator) {
    return mutateJson(sessionPath(sessionId), value => validateSessionRecord(value, sessionId), mutator);
  }

  async function listSeatIds() {
    const entries = await listFolder('bridge/agents');
    return [...new Set(entries
      .filter(item => item && typeof item.name === 'string')
      .map(item => item.name.split('/').pop())
      .filter(name => /^agent-[0-9]{3,}\.json$/.test(name))
      .map(name => name.slice(0, -5)))]
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  }

  function activityTime(seat, session) {
    const activityValues = [
      seat && seat.last_activity_at, seat && seat.last_seen_at,
      session && session.last_activity_at
    ].map(value => Date.parse(String(value || ''))).filter(Number.isFinite);
    if (activityValues.length) return Math.max(...activityValues);
    const fallbackValues = [
      seat && seat.updated_at, session && session.updated_at,
      seat && seat.created_at, session && session.created_at
    ].map(value => Date.parse(String(value || ''))).filter(Number.isFinite);
    return fallbackValues.length ? Math.max(...fallbackValues) : 0;
  }

  function isBusy(seat, session) {
    return Boolean(
      (Array.isArray(seat && seat.active_request_ids) && seat.active_request_ids.length) ||
      (Array.isArray(session && session.active_request_ids) && session.active_request_ids.length)
    );
  }

  function isSeatAvailable(seat, session) {
    if (!seat) return true;
    if (isBusy(seat, session)) return false;
    // Legacy v1 seat records have no stable conversation identity. Their migration
    // behavior remains time-bounded; v2 session IDs are never invalidated by idleness.
    if (seat.protocol !== AGENT_RECORD_PROTOCOL) {
      const last = activityTime(seat, null);
      return !last || clock() - last > AGENT_ACTIVITY_RECENCY_WINDOW_MS;
    }
    if (!seat.current_session_id) return true;
    if (!session) return true;
    return ['revoked', 'disconnected'].includes(session.status);
  }

  async function readSeatAndSession(agentId) {
    const remote = await readSeat(agentId);
    if (!remote) return { agent_id: agentId, remote: null, seat: null, sessionRemote: null, session: null };
    const seat = remote.value;
    let sessionRemote = null;
    if (seat.protocol === AGENT_RECORD_PROTOCOL && seat.current_session_id) {
      sessionRemote = await readSession(seat.current_session_id);
    }
    return { agent_id: agentId, remote, seat, sessionRemote, session: sessionRemote && sessionRemote.value || null };
  }

  function sessionLastActivityTime(session) {
    const last = Date.parse(String(session && session.last_activity_at || ''));
    if (Number.isFinite(last)) return last;
    const created = Date.parse(String(session && session.created_at || ''));
    return Number.isFinite(created) ? created : 0;
  }

  async function enforceSessionLimit() {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error('The session registration cap must be a positive integer.');
    }
    const evictedSessions = [];
    let names = [...new Set((await listFolder('bridge/sessions'))
      .map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /^session-[a-f0-9]{32}[.]json$/.test(name)))];

    while (names.length >= maxSessions) {
      if (typeof deleteRemoteFiles !== 'function') {
        throw new Error('SESSION_LIMIT_REACHED: SHA-checked session eviction is unavailable; no session was removed.');
      }
      const candidates = [];
      // Keep GitHub API pressure bounded when the registry reaches its 10,000-ID cap.
      for (let offset = 0; offset < names.length; offset += 32) {
        const batch = await Promise.all(names.slice(offset, offset + 32).map(async name => {
          const sessionId = name.slice(0, -5);
          const remote = await readSession(sessionId);
          return remote ? {
            sessionId, remote, session: remote.value,
            lastActivity: sessionLastActivityTime(remote.value)
          } : null;
        }));
        candidates.push(...batch.filter(Boolean));
      }
      candidates.sort((a, b) =>
        a.lastActivity - b.lastActivity || a.sessionId.localeCompare(b.sessionId));
      if (!candidates.length) {
        throw new Error('SESSION_LIMIT_REACHED: The mailbox is at its ' + maxSessions +
          '-ID cap, but no session record could be read safely for oldest-activity eviction.');
      }

      let removedThisPass = 0;
      let rescan = false;
      for (const candidate of candidates) {
        if (names.length < maxSessions) break;
        let outcome;
        try {
          outcome = await withSessionLock(candidate.sessionId, () =>
            withLock('seat:' + candidate.session.agent_id, async () => {
              const latest = await readSession(candidate.sessionId);
              if (!latest) return { kind: 'missing' };
              if (latest.sha !== candidate.remote.sha) return { kind: 'changed' };

              const existingEviction = await readEviction(candidate.sessionId);
              const seatRemote = await readSeat(candidate.session.agent_id);
              const ownsSeat = Boolean(seatRemote &&
                seatRemote.value.protocol === AGENT_RECORD_PROTOCOL &&
                seatRemote.value.current_session_id === candidate.sessionId);
              const evictedAt = timestamp();
              const eviction = existingEviction ? existingEviction.value : {
                protocol: EVICTION_RECORD_PROTOCOL,
                session_id: candidate.sessionId,
                agent_id: candidate.session.agent_id,
                evicted_at: evictedAt,
                last_activity_at: latest.value.last_activity_at || latest.value.created_at || null,
                previous_status: latest.value.status || 'unknown',
                active_request_ids: Array.isArray(latest.value.active_request_ids)
                  ? latest.value.active_request_ids.slice(-100) : [],
                reason: 'hard_registration_cap'
              };
              // Commit the tombstone before deleting the registration. If deletion
              // fails or the worker crashes, assertNotEvicted sees the still-present
              // session record and allows it; a retry can safely finish the deletion.
              if (!existingEviction) {
                try { await writeNewJson(evictionPath(candidate.sessionId), eviction); }
                catch (error) {
                  const confirmed = await readEviction(candidate.sessionId);
                  if (!confirmed) throw error;
                }
              }
              const deletion = await deleteRemoteFiles([{
                path: sessionPath(candidate.sessionId), sha: latest.sha
              }]);
              if (deletion && deletion.conflict === true) return { kind: 'changed' };
              if (!deletion || deletion.ok === false) {
                throw new Error('SHA-checked session deletion did not complete; the registered session remains valid.');
              }

              try {
                if (ownsSeat) {
                  await mutateJson(seatPath(candidate.session.agent_id),
                    value => validateSeatRecord(value, candidate.session.agent_id),
                    value => value.current_session_id !== candidate.sessionId ? value : ({
                      ...value,
                      current_session_id: null,
                      status: 'inactive',
                      active_request_ids: [],
                      last_evicted_session_id: candidate.sessionId,
                      last_evicted_at: evictedAt
                    }));
                }
              }
              return {
                kind: 'evicted',
                session_id: candidate.sessionId,
                agent_id: candidate.session.agent_id,
                last_activity_at: latest.value.last_activity_at || latest.value.created_at || null,
                previous_status: latest.value.status || 'unknown',
                cancelled_request_ids: Array.isArray(latest.value.active_request_ids)
                  ? latest.value.active_request_ids.slice(-100) : []
              };
            })
          );
        } catch (error) {
          if (isConflictError(error)) {
            rescan = true;
            break;
          }
          throw error;
        }
        if (outcome.kind === 'changed' || outcome.kind === 'missing') {
          rescan = true;
          break;
        }
        if (outcome.kind === 'evicted') {
          evictedSessions.push(outcome);
          names = names.filter(name => name !== candidate.sessionId + '.json');
          removedThisPass++;
        }
      }

      if (names.length < maxSessions) break;
      if (rescan) {
        names = [...new Set((await listFolder('bridge/sessions'))
          .map(item => String(item && (item.name || item.path) || '').split('/').pop())
          .filter(name => /^session-[a-f0-9]{32}[.]json$/.test(name)))];
        continue;
      }
      if (!removedThisPass) {
        throw new Error('SESSION_LIMIT_REACHED: No session could be safely evicted at the ' +
          maxSessions + '-ID registration cap.');
      }
    }
    return { count: names.length, evicted: evictedSessions };
  }

  async function removeUnassignedSession(sessionId) {
    if (typeof deleteRemoteFiles !== 'function') return;
    const remote = await readSession(sessionId);
    if (!remote) return;
    const seat = await readSeat(remote.value.agent_id);
    if (seat && seat.value.protocol === AGENT_RECORD_PROTOCOL &&
        seat.value.current_session_id === sessionId) return;
    const result = await deleteRemoteFiles([{ path: sessionPath(sessionId), sha: remote.sha }]);
    if (!result || result.ok === false || result.conflict === true) {
      throw new Error('Could not remove an unassigned session record after its seat allocation failed.');
    }
  }
  async function startSession(args = {}) {
    const label = safeLabel(args.label, 'ChatGPT session');
    const requestedAgentId = args.agent_id === undefined || args.agent_id === null || args.agent_id === ''
      ? null : String(args.agent_id);
    if (requestedAgentId && !AGENT_ID_PATTERN.test(requestedAgentId)) throw new Error('The selected agent ID is invalid.');
    return withLock('seat-allocation', async () => {
      const retention = await enforceSessionLimit();
      try {
      for (let attempt = 0; attempt < 64; attempt++) {
        const ids = await listSeatIds();
        const rows = await Promise.all(ids.map(readSeatAndSession));
        const highest = ids.reduce((max, id) => Math.max(max, Number(id.slice(6)) || 0), 0);
        const candidate = requestedAgentId
          ? rows.find(row => row.agent_id === requestedAgentId) || null
          : rows.find(row => !row.remote || !row.seat || isSeatAvailable(row.seat, row.session));
        if (requestedAgentId && candidate && candidate.remote && candidate.seat && !isSeatAvailable(candidate.seat, candidate.session)) {
          throw new Error('The selected agent seat is currently active or busy. Choose another available agent ID.');
        }
        if (requestedAgentId && !candidate && Number(requestedAgentId.slice(6)) !== highest + 1) {
          throw new Error('The selected agent ID is not an existing reusable seat or the next available seat.');
        }
        const agentId = requestedAgentId || candidate && candidate.agent_id || ('agent-' + String(highest + 1).padStart(3, '0'));
        const sessionId = 'session-' + randomBytes(16).toString('hex');
        const now = timestamp();
        const session = {
          protocol: SESSION_RECORD_PROTOCOL, session_id: sessionId, agent_id: agentId,
          label, status: 'active', created_at: now, updated_at: now, last_activity_at: now,
          last_request_id: null, last_completed_at: null, recent_request_ids: [], active_request_ids: []
        };
        try { await writeNewJson(sessionPath(sessionId), session); }
        catch (error) { if (isConflictError(error)) continue; throw error; }
        try {
          const allocated = await withLock('seat:' + agentId, async () => {
            const current = await readSeat(agentId);
            const seat = current && current.value;
            const currentSession = seat && seat.protocol === AGENT_RECORD_PROTOCOL && seat.current_session_id
              ? (await readSession(seat.current_session_id))?.value || null : null;
            if (seat && !isSeatAvailable(seat, currentSession)) return null;
            const nextSeat = {
              protocol: AGENT_RECORD_PROTOCOL, agent_id: agentId, current_session_id: sessionId,
              label, status: 'active', created_at: seat && seat.created_at || now,
              updated_at: now, last_activity_at: now, last_request_id: null, last_completed_at: null,
              recent_request_ids: [], active_request_ids: []
            };
            const saved = await writeRemoteJson(seatPath(agentId), nextSeat, current ? current.sha : null, !current);
            if (!saved || !saved.ok) return null;
            return {
              session_id: sessionId, agent_id: agentId, label, status: 'active', busy: false,
              last_activity_at: now, created_at: now,
              note: 'Session created after explicit desktop assignment. Keep this session_id for this ChatGPT conversation and include it on every subsequent bridge tool request. This session ID and its agent seat remain valid while idle; the seat is released only by an explicit disconnect or revoke/delete action.',
              context_message: 'You are assigned to ' + agentId + '. Your session_id is ' + sessionId + '. Keep this exact session_id for this ChatGPT conversation and include it on every ordinary bridge request. Read the all-agent status list and use agent messaging tools to coordinate. Inactivity never expires this session or releases its agent seat. At the hard 10,000-ID cap, the ID with the oldest last_activity_at is evicted. Pause temporarily blocks this session; disconnect explicitly releases its seat; delete/revoke permanently disables it.'
            };
          });
          if (!allocated) {
            await removeUnassignedSession(sessionId);
            if (requestedAgentId) throw new Error('The selected agent seat was claimed by another session before assignment completed. Retry session_start and choose an available seat.');
            continue;
          }
          return { ...allocated, evicted_sessions: retention.evicted || [] };
        } catch (error) {
          await removeUnassignedSession(sessionId);
          if (isConflictError(error)) {
            if (requestedAgentId) throw new Error('The selected agent seat changed during allocation. Retry session_start and choose an available seat.');
            continue;
          }
          throw error;
        }
      }
      throw new Error('Could not lease an available agent seat after repeated concurrent allocation attempts.');
      } catch (error) {
        if (retention.evicted && retention.evicted.length && error && typeof error === 'object') {
          error.evicted_sessions = retention.evicted;
        }
        throw error;
      }
    });
  }

  async function authenticate(request) {
    const sessionId = request && request.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('SESSION_ID_REQUIRED: Call session_start once at the beginning of this conversation, then include its session_id on every bridge tool request.');
    }
    await assertNotRevoked(sessionId);
    await assertNotEvicted(sessionId);
    const remote = await readSession(sessionId);
    if (!remote) throw new Error('SESSION_ID_NOT_FOUND: This session ID is not registered. Call session_start to create a new conversation session.');
    const session = remote.value;
    if (session.status === 'paused') throw new Error('SESSION_PAUSED: This agent session is temporarily paused. Resume it from its dashboard widget before sending more bridge requests.');
    if (session.status === 'disconnected') throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected from its agent seat. Start a new conversation session before using the bridge again.');
    return { session_id: sessionId, agent_id: session.agent_id, agent_label: session.label || session.agent_id };
  }

  async function requestStarted(request) {
    if (!request || !request.session_id || !request.agent_id) return false;
    return withSessionLock(request.session_id, () => withLock('seat:' + request.agent_id, async () => {
      await assertNotRevoked(request.session_id);
      await assertNotEvicted(request.session_id);
      const sessionRemote = await readSession(request.session_id);
      if (!sessionRemote) throw new Error('SESSION_ID_NOT_FOUND: The registered session record is missing.');
      if (sessionRemote.value.agent_id !== request.agent_id) {
        throw new Error('SESSION_IDENTITY_MISMATCH: The request agent_id does not own this session ID.');
      }
      if (sessionRemote.value.status === 'disconnected') {
        throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected.');
      }
      if (sessionRemote.value.status === 'paused') {
        throw new Error('SESSION_PAUSED: This session was paused before the request could execute.');
      }
      const now = timestamp();
      await mutateSession(request.session_id, current => {
        if (current.status === 'disconnected') throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected.');
        if (current.status === 'paused') throw new Error('SESSION_PAUSED: This session was paused before the request could execute.');
        const active = Array.isArray(current.active_request_ids) ? current.active_request_ids : [];
        const recent = Array.isArray(current.recent_request_ids) ? current.recent_request_ids : [];
        return {
          ...current, status: 'active', last_activity_at: now, last_request_id: request.request_id,
          recent_request_ids: [...recent.filter(id => id !== request.request_id), request.request_id].slice(-50),
          active_request_ids: [...new Set([...active, request.request_id])]
        };
      });
      const seatRemote = await readSeat(request.agent_id);
      if (seatRemote && seatRemote.value.protocol === AGENT_RECORD_PROTOCOL &&
          seatRemote.value.current_session_id === request.session_id) {
        await mutateJson(seatPath(request.agent_id), value => validateSeatRecord(value, request.agent_id), current => {
          if (current.current_session_id !== request.session_id) return current;
          return {
            ...current, status: 'active', last_activity_at: now, last_request_id: request.request_id,
            recent_request_ids: [...(Array.isArray(current.recent_request_ids) ? current.recent_request_ids.filter(id => id !== request.request_id) : []), request.request_id].slice(-50),
            active_request_ids: [...new Set([...(Array.isArray(current.active_request_ids) ? current.active_request_ids : []), request.request_id])]
          };
        });
      }
      return true;
    }));
  }

  async function requestCompleted(request) {
    if (!request || !request.session_id || !request.agent_id) return null;
    return withSessionLock(request.session_id, () => withLock('seat:' + request.agent_id, async () => {
      if (await isRevoked(request.session_id)) return null;
      const sessionRemote = await readSession(request.session_id);
      if (!sessionRemote || sessionRemote.value.status === 'disconnected') return null;
      const now = timestamp();
      const updatedSession = await mutateSession(request.session_id, current => ({
        ...current,
        status: current.status === 'paused' ? 'paused' : 'active',
        last_activity_at: now,
        last_completed_at: now,
        active_request_ids: (Array.isArray(current.active_request_ids) ? current.active_request_ids : []).filter(id => id !== request.request_id)
      }));
      const seat = await readSeat(request.agent_id);
      if (!seat || seat.value.protocol !== AGENT_RECORD_PROTOCOL ||
          seat.value.current_session_id !== request.session_id) {
        return updatedSession;
      }
      return mutateJson(seatPath(request.agent_id), value => validateSeatRecord(value, request.agent_id), current => {
        if (current.current_session_id !== request.session_id) return current;
        return {
          ...current,
          status: current.status === 'paused' ? 'paused' : 'active',
          last_activity_at: now,
          last_completed_at: now,
          active_request_ids: (Array.isArray(current.active_request_ids) ? current.active_request_ids : []).filter(id => id !== request.request_id)
        };
      });
    }));
  }

  async function setSessionPaused(sessionId, paused) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || typeof paused !== 'boolean') throw new Error('A valid session_id and pause boolean are required.');
    const initial = await readSession(sessionId);
    if (!initial) throw new Error('The selected session was not found.');
    const agentId = initial.value.agent_id;
    return withSessionLock(sessionId, () => withLock('seat:' + agentId, async () => {
      await assertNotRevoked(sessionId);
      await assertNotEvicted(sessionId);
      const remote = await readSession(sessionId);
      if (!remote) throw new Error('SESSION_ID_NOT_FOUND: The session record is missing.');
      const seat = await readSeat(agentId);
      if (!seat || seat.value.protocol !== AGENT_RECORD_PROTOCOL || seat.value.current_session_id !== sessionId) {
        throw new Error('AGENT_SEAT_UNAVAILABLE: This session ID remains registered, but its previous agent seat is no longer assigned to it.');
      }
      const current = remote.value;
      if (current.status === 'disconnected') throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected.');
      if (paused) {
        if (current.status === 'paused') return { paused: true, session_id: sessionId, agent_id: agentId, already_in_state: true };
        if (current.status !== 'active') throw new Error('Only an active session can be paused. Current status: ' + current.status);
        const at = timestamp();
        await mutateSession(sessionId, value => ({ ...value, status: 'paused', paused_at: at }));
        await mutateJson(seatPath(agentId), value => validateSeatRecord(value, agentId), value => ({ ...value, status: 'paused', paused_session_id: sessionId, paused_at: at }));
        return { paused: true, session_id: sessionId, agent_id: agentId, paused_at: at };
      }
      if (current.status !== 'paused') {
        if (current.status === 'active') return { paused: false, session_id: sessionId, agent_id: agentId, already_in_state: true };
        throw new Error('Only a paused session can be resumed. Current status: ' + current.status);
      }
      const at = timestamp();
      await mutateJson(seatPath(agentId), value => validateSeatRecord(value, agentId), value => ({
        ...value, status: 'active', last_activity_at: at, resumed_at: at, paused_session_id: null, paused_at: null
      }));
      await mutateSession(sessionId, value => ({ ...value, status: 'active', last_activity_at: at, resumed_at: at }));
      return { paused: false, session_id: sessionId, agent_id: agentId, resumed_at: at };
    }));
  }

  async function disconnectSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('A valid session_id is required.');
    await assertNotEvicted(sessionId);
    const initial = await readSession(sessionId);
    if (!initial) throw new Error('The selected session was not found.');
    const agentId = initial.value.agent_id;
    return withSessionLock(sessionId, () => withLock('seat:' + agentId, async () => {
      const remote = await readSession(sessionId);
      if (!remote) throw new Error('The session record is missing.');
      if (remote.value.status === 'revoked') throw new Error('SESSION_REVOKED: This session was permanently revoked and cannot be disconnected or restored.');
      if (remote.value.status === 'disconnected') return { disconnected: true, session_id: sessionId, agent_id: agentId, already_disconnected: true };
      const seat = await readSeat(agentId);
      const ownsSeat = Boolean(seat && seat.value.protocol === AGENT_RECORD_PROTOCOL && seat.value.current_session_id === sessionId);
      const at = timestamp();
      await mutateSession(sessionId, value => ({ ...value, status: 'disconnected', disconnected_at: at, ended_at: at, active_request_ids: [] }));
      if (ownsSeat) await mutateJson(seatPath(agentId), value => validateSeatRecord(value, agentId), value => ({
        ...value, current_session_id: null, status: 'inactive', active_request_ids: [], disconnected_session_id: sessionId, disconnected_at: at
      }));
      return { disconnected: true, session_id: sessionId, agent_id: agentId, seat_released: ownsSeat, disconnected_at: at };
    }));
  }

  async function revokeSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('A valid session_id is required to revoke an agent.');
    const initial = await readSession(sessionId);
    const existingRevocation = await readRevocation(sessionId);
    if (await isEvicted(sessionId)) throw new Error('SESSION_EVICTED: This session ID was already removed by the registration cap.');
    if (!initial && !existingRevocation) throw new Error('The selected session was not found; no agent seat was changed.');
    const agentId = initial ? initial.value.agent_id : existingRevocation.value.agent_id;
    if (existingRevocation && existingRevocation.value.agent_id !== agentId) throw new Error('The revocation record does not match the session owner.');
    return withSessionLock(sessionId, () => withLock('seat:' + agentId, async () => {
      const sessionRemote = await readSession(sessionId);
      const currentSession = sessionRemote && sessionRemote.value;
      if (currentSession && currentSession.agent_id !== agentId) throw new Error('The session owner changed; refusing to revoke a different seat.');
      const seatRemote = await readSeat(agentId);
      const seat = seatRemote && seatRemote.value;
      const ownsSeat = Boolean(seat && seat.protocol === AGENT_RECORD_PROTOCOL && seat.current_session_id === sessionId);
      const activeIds = [...new Set([
        ...(Array.isArray(currentSession && currentSession.active_request_ids) ? currentSession.active_request_ids : []),
        ...(ownsSeat && Array.isArray(seat.active_request_ids) ? seat.active_request_ids : [])
      ].filter(id => typeof id === 'string' && id.length > 0))];
      const now = timestamp();
      const tombstone = existingRevocation ? existingRevocation.value : {
        protocol: REVOCATION_RECORD_PROTOCOL, session_id: sessionId, agent_id: agentId,
        revoked_at: now, reason: 'operator_deleted_agent_widget', active_request_ids: activeIds
      };
      if (!existingRevocation) {
        try { await writeNewJson(revocationPath(sessionId), tombstone); }
        catch (error) {
          if (!isConflictError(error)) throw error;
          const confirmed = await readRevocation(sessionId);
          if (!confirmed || confirmed.value.session_id !== sessionId || confirmed.value.agent_id !== agentId) throw error;
        }
      }
      if (sessionRemote && currentSession.status !== 'revoked') {
        await mutateSession(sessionId, current => ({
          ...current, status: 'revoked', revoked_at: tombstone.revoked_at || now,
          ended_at: current.ended_at || now, active_request_ids: []
        }));
      }
      if (ownsSeat) {
        await mutateJson(seatPath(agentId), value => validateSeatRecord(value, agentId), current => {
          if (current.current_session_id !== sessionId) return current;
          return { ...current, current_session_id: null, status: 'inactive', active_request_ids: [],
            last_revoked_session_id: sessionId, last_revoked_at: tombstone.revoked_at || now };
        });
      }
      return { revoked: true, agent_id: agentId, session_id: sessionId,
        revoked_at: tombstone.revoked_at || now, cancelled_request_ids: activeIds,
        seat_released: ownsSeat,
        mailbox_cleanup: { status: 'not_requested', deleted_records: 0, deleted_files: 0 } };
    }));
  }

  async function wipeMailbox(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('A valid session_id is required for mailbox cleanup.');
    if (!(await isRevoked(sessionId))) throw new Error('Mailbox cleanup requires a persisted session revocation first.');
    if (typeof deleteRemoteFiles !== 'function') throw new Error('Safe mailbox deletion is unavailable; the session remains revoked.');
    const files = new Map();
    const addFile = (filePath, sha) => {
      if (typeof filePath === 'string' && typeof sha === 'string' && sha) files.set(filePath, sha);
    };
    const requestEntries = await listFolder('bridge/requests');
    const requestNames = [...new Set(requestEntries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(name)))];
    let deletedRequests = 0;
    let ownedRequestRecords = 0;
    const requestRecords = [];
    for (let start = 0; start < requestNames.length; start += 16) {
      const group = requestNames.slice(start, start + 16);
      const rows = await Promise.all(group.map(async name => {
        const requestId = name.slice(0, -5);
        const requestRemote = await readRemoteFile('bridge/requests/' + name);
        if (!requestRemote || !requestRemote.value || requestRemote.value.protocol !== REQUEST_RECORD_PROTOCOL ||
            requestRemote.value.request_id !== requestId || requestRemote.value.session_id !== sessionId) return null;
        ownedRequestRecords++;
        const [claim, result] = await Promise.all([
          readRemoteFile('bridge/claims/' + name), readRemoteFile('bridge/results/' + name)
        ]);
        if (!claim || !result || !claim.value || !result.value ||
            claim.value.protocol !== 'chatgpt-local-repo-claim/v1' || result.value.protocol !== 'chatgpt-local-repo-result/v1' ||
            claim.value.request_id !== requestId || claim.value.session_id !== sessionId || claim.value.status !== 'completed' ||
            result.value.request_id !== requestId || (result.value.session_id && result.value.session_id !== sessionId) ||
            !['completed', 'partial', 'failed', 'cancelled', 'rejected'].includes(result.value.status)) return null;
        return { requestId, requestRemote, claim, result };
      }));
      requestRecords.push(...rows.filter(Boolean));
    }
    const flatArtifacts = await listFolder('bridge/artifacts');
    for (const record of requestRecords) {
      const name = record.requestId + '.json';
      addFile('bridge/requests/' + name, record.requestRemote.sha);
      addFile('bridge/claims/' + name, record.claim.sha);
      addFile('bridge/results/' + name, record.result.sha);
      const manifest = Array.isArray(record.result.value.artifacts) ? record.result.value.artifacts : [];
      const requestArtifactPrefix = 'bridge/artifacts/' + record.requestId + '/';
      const legacyBatchArtifactPrefix = 'bridge/artifacts/' + record.requestId + '-batch-output-';
      const ownedPaths = new Set(manifest.map(item => item && item.path).filter(value =>
        typeof value === 'string' && (value.startsWith(requestArtifactPrefix) ||
          value.startsWith(legacyBatchArtifactPrefix))));
      const nested = await listFolder('bridge/artifacts/' + record.requestId);
      for (const item of [...flatArtifacts, ...nested]) {
        const itemPath = String(item && (item.path || item.name) || '');
        // A revoked request's result journal is intentionally replaced with a
        // compact cancellation record, so its original artifact manifest may
        // no longer exist. The request-ID-scoped folder/legacy prefix remain
        // authoritative ownership boundaries for orphaned request artifacts.
        const requestScoped = itemPath.startsWith(requestArtifactPrefix) || itemPath.startsWith(legacyBatchArtifactPrefix);
        if ((ownedPaths.has(itemPath) || requestScoped) && item && typeof item.sha === 'string') addFile(itemPath, item.sha);
      }
      deletedRequests++;
    }

    const sessionEntries = await listFolder('bridge/sessions');
    const recipientSessions = [...new Set(sessionEntries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /^session-[a-f0-9]{32}\.json$/.test(name)).map(name => name.slice(0, -5)))];
    if (!recipientSessions.includes(sessionId)) recipientSessions.push(sessionId);
    let deletedMessages = 0;
    for (let start = 0; start < recipientSessions.length; start += 12) {
      const group = recipientSessions.slice(start, start + 12);
      const inboxes = await Promise.all(group.map(async recipientSessionId => {
        let entries;
        try { entries = await listFolder(inboxPath(recipientSessionId)); }
        catch (error) { if (/not found|404/i.test(String(error && error.message || error))) entries = []; else throw error; }
        return { recipientSessionId, entries };
      }));
      for (const inbox of inboxes) {
        const candidates = inbox.entries.filter(item => /^msg-[0-9]{13}-[a-f0-9]{32}\.json$/.test(String(item && (item.name || item.path) || '').split('/').pop()));
        for (let batch = 0; batch < candidates.length; batch += 16) {
          const rows = await Promise.all(candidates.slice(batch, batch + 16).map(async item => {
            const name = String(item.name || item.path).split('/').pop();
            const messageId = name.slice(0, -5);
            const messageRemote = await readRemoteFile(messagePath(inbox.recipientSessionId, messageId));
            const record = messageRemote && messageRemote.value;
            if (!record || record.protocol !== 'chatgpt-local-agent-message/v1' || record.message_id !== messageId ||
                record.recipient_session_id !== inbox.recipientSessionId ||
                (record.sender_session_id !== sessionId && record.recipient_session_id !== sessionId)) return null;
            return { recipientSessionId: inbox.recipientSessionId, messageId, messageRemote };
          }));
          for (const item of rows.filter(Boolean)) {
            addFile(messagePath(item.recipientSessionId, item.messageId), item.messageRemote.sha);
            const receiptPath = messageReceiptPath(item.recipientSessionId, item.messageId);
            const receipt = await readRemoteFile(receiptPath);
            if (receipt && receipt.value && receipt.value.protocol === 'chatgpt-local-agent-message-receipt/v1' &&
                receipt.value.message_id === item.messageId && receipt.value.recipient_session_id === item.recipientSessionId) {
              addFile(receiptPath, receipt.sha);
            }
            deletedMessages++;
          }
        }
      }
    }
    const deletion = await deleteRemoteFiles([...files].map(([filePath, sha]) => ({ path: filePath, sha })));
    const preservedRequests = Math.max(0, ownedRequestRecords - deletedRequests);
    return {
      status: preservedRequests ? 'completed_with_preserved_records' : 'completed',
      deleted_records: deletedRequests + deletedMessages, deleted_files: deletion.deleted || files.size,
      deleted_request_records: deletedRequests, deleted_message_records: deletedMessages,
      preserved_request_records: preservedRequests,
      preservation_note: preservedRequests
        ? 'Some requests were retained because their claim/result journal was missing, active, incomplete, or could not be proven terminal. Retry cleanup after those operations settle.'
        : null,
      commit_sha: deletion.commitSha || null, preserved_session_and_revocation_records: true
    };
  }

  async function unreadMessageSummary(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return { count: 0, partial: false };
    const cached = unreadMessageCountCache.get(sessionId);
    if (cached && clock() - cached.checkedAt < UNREAD_MESSAGE_CACHE_TTL_MS) {
      unreadMessageCountCache.delete(sessionId);
      unreadMessageCountCache.set(sessionId, cached);
      return { count: cached.count, partial: cached.partial };
    }
    let entries;
    try { entries = await listFolder(inboxPath(sessionId)); }
    catch (error) {
      if (/not found|404/i.test(String(error && error.message || error))) entries = [];
      else throw error;
    }
    const allNames = [...new Set(entries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /\.json$/i.test(name) && MESSAGE_ID_PATTERN.test(name.slice(0, -5))))].sort();
    const names = allNames.slice(-UNREAD_MESSAGE_SCAN_LIMIT);
    let receiptEntries = [];
    if (names.length) {
      try { receiptEntries = await listFolder('bridge/agent-message-receipts/' + sessionId); }
      catch (error) {
        if (!/not found|404/i.test(String(error && error.message || error))) throw error;
      }
    }
    const receiptIds = new Set(receiptEntries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /\.json$/i.test(name) && MESSAGE_ID_PATTERN.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)));
    let unread = 0;
    const scannedIds = new Set(names.map(name => name.slice(0, -5)));
    for (let start = 0; start < names.length; start += 16) {
      const rows = await Promise.all(names.slice(start, start + 16).map(async name => {
        const messageId = name.slice(0, -5);
        const remote = await readRemoteFile(messagePath(sessionId, messageId));
        if (!remote) return null;
        const record = remote.value;
        if (!record || record.protocol !== 'chatgpt-local-agent-message/v1' ||
            record.message_id !== messageId || record.recipient_session_id !== sessionId) {
          throw new Error('Message record ' + messageId + ' is malformed or addressed to another session.');
        }
        return record;
      }));
      for (const record of rows) {
        if (record && record.sender_agent_id !== 'user' && record.sender_type !== 'user' &&
            !record.read_at && !receiptIds.has(record.message_id)) unread++;
      }
    }
    const summary = {
      count: unread, partial: allNames.length > names.length,
      scannedIds, checkedAt: clock()
    };
    unreadMessageCountCache.set(sessionId, summary);
    while (unreadMessageCountCache.size > 10000) {
      unreadMessageCountCache.delete(unreadMessageCountCache.keys().next().value);
    }
    return { count: summary.count, partial: summary.partial };
  }

  async function countUnreadMessages(sessionId) {
    return (await unreadMessageSummary(sessionId)).count;
  }

  async function statuses(filterAgentId = null) {
    if (filterAgentId && !AGENT_ID_PATTERN.test(filterAgentId)) throw new Error('agent_id has an invalid format.');
    const ids = filterAgentId ? [filterAgentId] : await listSeatIds();
    const rows = await Promise.all(ids.map(async agentId => {
      const row = await readSeatAndSession(agentId);
      if (!row.remote) return null;
      const seat = row.seat;
      if (seat.protocol !== AGENT_RECORD_PROTOCOL) {
        const lastActivity = activityTime(seat, null);
        const busy = isBusy(seat, null);
        const active = Boolean(lastActivity && clock() - lastActivity <= AGENT_ACTIVITY_RECENCY_WINDOW_MS);
        return {
          agent_id: agentId, label: seat.label || agentId, status: active ? 'active' : 'inactive', busy,
          session_id: null, last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null,
          last_request_id: seat.last_request_id || null, last_completed_at: seat.last_completed_at || null,
          recent_request_ids: Array.isArray(seat.recent_request_ids) ? seat.recent_request_ids.slice(-50) : [],
          active_request_ids: Array.isArray(seat.active_request_ids) ? seat.active_request_ids.slice(-50) : [],
          reusable: !busy && !active, legacy_record: true
        };
      }
      const session = row.session;
      const lastActivity = activityTime(seat, session);
      const busy = isBusy(seat, session);
      const active = Boolean(session && session.status === 'active' && lastActivity && clock() - lastActivity <= AGENT_ACTIVITY_RECENCY_WINDOW_MS);
      const paused = Boolean(session && session.status === 'paused');
      const unreadSummary = session && seat.current_session_id
        ? await unreadMessageSummary(seat.current_session_id) : { count: 0, partial: false };
      return {
        agent_id: agentId, label: seat.label || (session && session.label) || agentId,
        status: paused ? 'paused' : active ? 'active' : 'inactive', busy,
        session_id: seat.current_session_id || null, session_status: session && session.status || 'missing', paused,
        unread_message_count: unreadSummary.count,
        unread_message_count_partial: unreadSummary.partial,
        last_revoked_session_id: seat.last_revoked_session_id || null,
        last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null,
        last_request_id: seat.last_request_id || (session && session.last_request_id) || null,
        last_completed_at: seat.last_completed_at || (session && session.last_completed_at) || null,
        recent_request_ids: Array.isArray(seat.recent_request_ids) ? seat.recent_request_ids.slice(-50) : [],
        active_request_ids: [...new Set([
          ...(Array.isArray(seat.active_request_ids) ? seat.active_request_ids : []),
          ...(Array.isArray(session && session.active_request_ids) ? session.active_request_ids : [])
        ])].slice(-50),
        reusable: !busy && isSeatAvailable(seat, session)
      };
    }));
    const agents = rows.filter(Boolean);
    return {
      agents, count: agents.length,
      counts: {
        active: agents.filter(agent => agent.status === 'active').length,
        inactive: agents.filter(agent => agent.status === 'inactive').length,
        busy: agents.filter(agent => agent.busy).length,
        available: agents.filter(agent => agent.reusable).length
      },
      activity_status_window_ms: AGENT_ACTIVITY_RECENCY_WINDOW_MS,
      status_legend: {
        active: 'This seat has received bridge-tool activity within the recent-activity status window.',
        paused: 'This session is temporarily invalidated, keeps its seat, and can be resumed from its dashboard widget.',
        inactive: 'No recent bridge-tool activity is recorded. The session ID and its seat remain valid; inactivity is not expiration. The oldest ID can be evicted when the hard 10,000-ID registry cap is reached.',
        busy: 'One or more local bridge requests are still executing. Busy seats are not reassigned.',
        session_id: 'The conversation identity currently leased to this reusable seat; it is not a secret.'
      },
      note: 'The session_id and its agent_id seat remain bound to one ChatGPT conversation until explicit disconnect or revoke/delete, unless that exact ID is evicted as the oldest last-activity record at the hard 10,000-ID cap. active/inactive is only a recent-activity indicator; inactivity never releases the seat. Status includes every seat record found in bridge/agents; no credentials are included.'
    };
  }

  async function currentSession(sessionId) {
    await assertNotRevoked(sessionId);
    await assertNotEvicted(sessionId);
    const remote = await readSession(sessionId);
    if (!remote) throw new Error('SESSION_ID_NOT_FOUND: This session ID is not registered.');
    if (remote.value.status === 'disconnected') {
      throw new Error('SESSION_DISCONNECTED: This session was explicitly disconnected.');
    }
    if (remote.value.status === 'paused') throw new Error('SESSION_PAUSED: This session is temporarily paused.');
    const session = remote.value;
    const seatRemote = await readSeat(session.agent_id);
    const seat = seatRemote && seatRemote.value.protocol === AGENT_RECORD_PROTOCOL &&
      seatRemote.value.current_session_id === sessionId ? seatRemote.value : null;
    return { session, seat };
  }

  async function writeMessage(recipientSessionId, record) {
    const path = messagePath(recipientSessionId, record.message_id);
    const saved = await writeRemoteJson(path, record, null, true);
    if (!saved || !saved.ok) throw new Error('Message publication conflicted. Do not send a duplicate until the original message path has been checked.');
    return record;
  }

  async function sendMessage(sessionId, args = {}) {
    const hasAgent = Boolean(args.to_agent_id);
    const hasSession = Boolean(args.to_session_id);
    if (hasAgent === hasSession) throw new Error('Specify exactly one recipient: to_agent_id or to_session_id.');
    let recipientSessionId;
    if (hasAgent) {
      if (!AGENT_ID_PATTERN.test(String(args.to_agent_id))) throw new Error('to_agent_id has an invalid format.');
      const recipientSeat = await readSeat(args.to_agent_id);
      if (!recipientSeat || recipientSeat.value.protocol !== AGENT_RECORD_PROTOCOL || !recipientSeat.value.current_session_id) {
        throw new Error('The recipient seat has no current session.');
      }
      recipientSessionId = recipientSeat.value.current_session_id;
    } else {
      if (!SESSION_ID_PATTERN.test(String(args.to_session_id))) throw new Error('to_session_id has an invalid format.');
      recipientSessionId = args.to_session_id;
    }
    if (recipientSessionId === sessionId) throw new Error('Cannot send an agent message to your own current session.');

    return withSessionLocks([sessionId, recipientSessionId], async () => {
      const sender = await currentSession(sessionId);
      let recipientAgentId, recipientLabel;
      if (hasAgent) {
        const recipientSeat = await readSeat(args.to_agent_id);
        if (!recipientSeat || recipientSeat.value.protocol !== AGENT_RECORD_PROTOCOL ||
            recipientSeat.value.current_session_id !== recipientSessionId) {
          throw new Error('RECIPIENT_SESSION_CHANGED: The selected agent seat was reassigned before the message could be sent.');
        }
        recipientAgentId = args.to_agent_id;
        recipientLabel = recipientSeat.value.label || recipientAgentId;
      }
      const recipient = await currentSession(recipientSessionId);
      if (!hasAgent) recipientAgentId = recipient.session.agent_id;
      recipientLabel = recipientLabel || (recipient.seat && recipient.seat.label) || recipient.session.label || recipientAgentId;
      const subject = args.subject === undefined ? '' : String(args.subject).replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
      const id = 'msg-' + String(clock()).padStart(13, '0') + '-' + randomBytes(16).toString('hex');
      const record = {
        protocol: 'chatgpt-local-agent-message/v1', message_id: id, thread_id: id,
        sender_session_id: sessionId, sender_agent_id: sender.session.agent_id,
        recipient_session_id: recipientSessionId, recipient_agent_id: recipientAgentId,
        sender_label: sender.session.label || sender.session.agent_id, recipient_label: recipientLabel,
        subject, message: formatAgentMessage(sender.session, args.message),
        created_at: timestamp(), read_at: null, in_reply_to: null
      };
      await writeMessage(recipientSessionId, record);
      const cachedUnread = unreadMessageCountCache.get(recipientSessionId);
      if (cachedUnread && clock() - cachedUnread.checkedAt < UNREAD_MESSAGE_CACHE_TTL_MS) {
        cachedUnread.count++;
        cachedUnread.scannedIds.add(id);
        cachedUnread.checkedAt = clock();
      } else if (cachedUnread) {
        unreadMessageCountCache.delete(recipientSessionId);
      }
      return {
        message_id: id, thread_id: id, sender_agent_id: record.sender_agent_id,
        to_agent_id: recipientAgentId, to_session_id: recipientSessionId,
        subject, created_at: record.created_at, status: 'sent',
        note: 'Message delivered to that conversation session. The recipient can use read_agent_messages and reply_to_agent_message.'
      };
    });
  }

  async function sendUserMessage(sessionId, args = {}) {
    return withSessionLock(sessionId, async () => {
      const recipient = await currentSession(sessionId);
      const message = cleanMessage(args.message, 20000, 'message');
      const id = 'msg-' + String(clock()).padStart(13, '0') + '-' + randomBytes(16).toString('hex');
      const record = {
        protocol: 'chatgpt-local-agent-message/v1', message_id: id, thread_id: id,
        sender_session_id: null, sender_agent_id: 'user',
        recipient_session_id: sessionId, recipient_agent_id: recipient.session.agent_id,
        sender_label: 'Windows Bridge User',
        recipient_label: (recipient.seat && recipient.seat.label) || recipient.session.label || recipient.session.agent_id,
        subject: 'Message from Windows Bridge User',
        message: '[Windows Bridge User] ' + message,
        created_at: timestamp(), read_at: null, in_reply_to: null, sender_type: 'user'
      };
      await writeMessage(sessionId, record);
      return {
        message_id: id, thread_id: id, to_agent_id: recipient.session.agent_id,
        to_session_id: sessionId, created_at: record.created_at, status: 'sent',
        note: 'The message was published to this exact conversation session inbox. The agent can retrieve it with read_agent_messages.'
      };
    });
  }

  async function markMessageRead(sessionId, messageId, knownRecord = null) {
    const path = messagePath(sessionId, messageId);
    let value = knownRecord;
    if (!value) {
      const remote = await readRemoteFile(path);
      if (!remote) return null;
      value = remote.value;
    }
    if (!value || value.protocol !== 'chatgpt-local-agent-message/v1' ||
        value.message_id !== messageId || value.recipient_session_id !== sessionId) {
      throw new Error('Message record is malformed or addressed to another session.');
    }
    const receiptPath = messageReceiptPath(sessionId, messageId);
    const updateCachedUnread = () => {
      const cached = unreadMessageCountCache.get(sessionId);
      if (!cached) return;
      if (clock() - cached.checkedAt >= UNREAD_MESSAGE_CACHE_TTL_MS) {
        unreadMessageCountCache.delete(sessionId);
        return;
      }
      if (!cached.scannedIds.has(messageId)) return;
      cached.scannedIds.delete(messageId);
      if (value.sender_agent_id !== 'user' && value.sender_type !== 'user') cached.count = Math.max(0, cached.count - 1);
      cached.checkedAt = clock();
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await readRemoteFile(receiptPath);
      if (existing) {
        const receipt = existing.value;
        if (!receipt || receipt.protocol !== 'chatgpt-local-agent-message-receipt/v1' ||
            receipt.message_id !== messageId || receipt.recipient_session_id !== sessionId ||
            typeof receipt.read_at !== 'string') {
          throw new Error('Message read receipt is malformed or addressed to another session.');
        }
        updateCachedUnread();
        return { ...value, read_at: receipt.read_at };
      }
      const readAt = timestamp();
      const receipt = {
        protocol: 'chatgpt-local-agent-message-receipt/v1',
        message_id: messageId, recipient_session_id: sessionId,
        created_at: readAt, read_at: readAt
      };
      try {
        const saved = await writeRemoteJson(receiptPath, receipt, null, true);
        if (saved && saved.ok) {
          updateCachedUnread();
          return { ...value, read_at: readAt };
        }
      } catch (error) {
        if (!isConflictError(error) || attempt === 4) throw error;
      }
    }
    throw new Error('Could not publish a read receipt after repeated mailbox conflicts.');
  }

  async function readMessages(sessionId, args = {}) {
    return withSessionLock(sessionId, async () => {
    await currentSession(sessionId);
    const unreadOnly = args.unread_only !== false;
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20;
    let entries;
    try { entries = await listFolder(inboxPath(sessionId)); }
    catch (error) { if (/not found|404/i.test(String(error && error.message || error))) entries = []; else throw error; }
    const names = [...new Set(entries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /\.json$/i.test(name) && MESSAGE_ID_PATTERN.test(name.slice(0, -5))))]
      .sort().slice(-200);
    const found = [];
    for (let start = 0; start < names.length; start += 16) {
      const group = names.slice(start, start + 16);
      const rows = await Promise.all(group.map(async name => {
        const messageId = name.slice(0, -5);
        const remote = await readRemoteFile(messagePath(sessionId, messageId));
        if (!remote) return null;
        const record = remote.value;
        if (!record || record.protocol !== 'chatgpt-local-agent-message/v1' ||
            record.message_id !== messageId || record.recipient_session_id !== sessionId) {
          throw new Error('Message record ' + messageId + ' is malformed or addressed to another session.');
        }
        return record;
      }));
      found.push(...rows.filter(Boolean));
    }
    found.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    let receiptEntries;
    try { receiptEntries = await listFolder('bridge/agent-message-receipts/' + sessionId); }
    catch (error) { if (/not found|404/i.test(String(error && error.message || error))) receiptEntries = []; else throw error; }
    const receiptIds = new Set(receiptEntries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /\.json$/i.test(name) && MESSAGE_ID_PATTERN.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)));
    const selected = found.filter(record => record.recipient_agent_id !== 'user' && (!unreadOnly ||
      (!receiptIds.has(record.message_id) && !record.read_at))).slice(-limit);
    const read = [];
    for (const record of selected) read.push(await markMessageRead(sessionId, record.message_id, record));
    return {
      session_id: sessionId, unread_only: unreadOnly, count: read.filter(Boolean).length,
      scanned_recent_limit: 200, messages: read.filter(Boolean),
      note: 'Message bodies are immutable records. Read state is stored separately in bridge/agent-message-receipts; exact session IDs prevent delivery to a recycled seat occupant.'
    };
    });
  }

  async function readDashboardReplies(sessionId, args = {}) {
    return withSessionLock(sessionId, async () => {
    await currentSession(sessionId);
    const suppliedIds = args.message_ids;
    if (!Array.isArray(suppliedIds) || suppliedIds.length > 100 ||
        suppliedIds.some(id => typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id))) {
      throw new Error('message_ids must contain 1–100 valid message IDs.');
    }
    const wanted = new Set(suppliedIds);
    if (!wanted.size) return { session_id: sessionId, count: 0, messages: [] };
    let entries;
    try { entries = await listFolder(inboxPath(sessionId)); }
    catch (error) { if (/not found|404/i.test(String(error && error.message || error))) entries = []; else throw error; }
    const names = [...new Set(entries.map(item => String(item && (item.name || item.path) || '').split('/').pop())
      .filter(name => /\.json$/i.test(name) && MESSAGE_ID_PATTERN.test(name.slice(0, -5))))]
      .sort().slice(-200);
    const replies = [];
    for (let start = 0; start < names.length; start += 16) {
      const group = names.slice(start, start + 16);
      const rows = await Promise.all(group.map(async name => {
        const messageId = name.slice(0, -5);
        const remote = await readRemoteFile(messagePath(sessionId, messageId));
        if (!remote) return null;
        const record = remote.value;
        if (!record || record.protocol !== 'chatgpt-local-agent-message/v1' ||
            record.message_id !== messageId || record.recipient_session_id !== sessionId) {
          throw new Error('Message record ' + messageId + ' is malformed or addressed to another session.');
        }
        if (record.sender_session_id === sessionId && record.recipient_agent_id === 'user' &&
            wanted.has(record.in_reply_to)) return record;
        return null;
      }));
      replies.push(...rows.filter(Boolean));
    }
    replies.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return {
      session_id: sessionId, count: replies.length, messages: replies,
      note: 'Replies are read from the same session-scoped agent-message mailbox; no other session inbox is accessed.'
    };
    });
  }

  async function replyToMessage(sessionId, args = {}) {
    const originalId = String(args.message_id || '');
    const initial = await readRemoteFile(messagePath(sessionId, originalId));
    if (!initial) throw new Error('No message with this message_id exists in the current session inbox.');
    const initialRecord = initial.value;
    if (!initialRecord || initialRecord.protocol !== 'chatgpt-local-agent-message/v1' ||
        initialRecord.message_id !== originalId || initialRecord.recipient_session_id !== sessionId) {
      throw new Error('Only a message addressed to this session can be replied to.');
    }
    const initialIsDashboardUser = initialRecord.sender_type === 'user' && initialRecord.sender_agent_id === 'user' &&
      initialRecord.sender_session_id === null;
    const recipientSessionId = initialIsDashboardUser ? sessionId : initialRecord.sender_session_id;
    if (typeof recipientSessionId !== 'string' || !SESSION_ID_PATTERN.test(recipientSessionId)) {
      throw new Error('The original message sender session is invalid or unavailable.');
    }
    return withSessionLocks([sessionId, recipientSessionId], async () => {
    const sender = await currentSession(sessionId);
    const originalId = String(args.message_id || '');
    const remote = await readRemoteFile(messagePath(sessionId, originalId));
    if (!remote) throw new Error('No message with this message_id exists in the current session inbox.');
    const original = remote.value;
    if (!original || original.protocol !== 'chatgpt-local-agent-message/v1' ||
        original.message_id !== originalId || original.recipient_session_id !== sessionId) {
      throw new Error('Only a message addressed to this session can be replied to.');
    }
    const isDashboardUser = original.sender_type === 'user' && original.sender_agent_id === 'user' &&
      original.sender_session_id === null;
    let recipientSessionId;
    let recipientAgentId;
    let recipientLabel;
    if (isDashboardUser) {
      recipientSessionId = sessionId;
      recipientAgentId = 'user';
      recipientLabel = 'Windows Bridge User';
    } else {
      recipientSessionId = original.sender_session_id;
      const recipient = await currentSession(recipientSessionId);
      recipientAgentId = recipient.session.agent_id;
      recipientLabel = (recipient.seat && recipient.seat.label) || recipient.session.label || recipientAgentId;
    }
    const id = 'msg-' + String(clock()).padStart(13, '0') + '-' + randomBytes(16).toString('hex');
    const record = {
      protocol: 'chatgpt-local-agent-message/v1', message_id: id,
      thread_id: original.thread_id || original.message_id,
      sender_session_id: sessionId, sender_agent_id: sender.session.agent_id,
      recipient_session_id: recipientSessionId, recipient_agent_id: recipientAgentId,
      sender_label: sender.session.label || sender.session.agent_id,
      recipient_label: recipientLabel,
      subject: original.subject || '', message: formatAgentMessage(sender.session, args.message),
      created_at: timestamp(), read_at: null, in_reply_to: original.message_id,
      ...(isDashboardUser ? { sender_type: 'agent', recipient_type: 'user' } : {})
    };
    await writeMessage(recipientSessionId, record);
    await markMessageRead(sessionId, original.message_id, original);
    return {
      message_id: id, thread_id: record.thread_id, in_reply_to: original.message_id,
      sender_agent_id: record.sender_agent_id, to_agent_id: record.recipient_agent_id,
      to_session_id: recipientSessionId, created_at: record.created_at, status: 'sent'
    };
    });
  }

  return {
    startSession, authenticate, requestStarted, requestCompleted, statuses, revokeSession, wipeMailbox, isRevoked, isEvicted,
    setSessionPaused, disconnectSession, enforceSessionLimit, withSessionLock, withSessionLocks,
    sendMessage, sendUserMessage, readMessages, countUnreadMessages, readDashboardReplies, replyToMessage, seatPath, sessionPath, messagePath,
    AGENT_RECORD_PROTOCOL, SESSION_RECORD_PROTOCOL, REQUEST_RECORD_PROTOCOL, REVOCATION_RECORD_PROTOCOL, EVICTION_RECORD_PROTOCOL, AGENT_ACTIVITY_RECENCY_WINDOW_MS
  };
}

module.exports = {
  createAgentRegistry, AGENT_RECORD_PROTOCOL, SESSION_RECORD_PROTOCOL, REVOCATION_RECORD_PROTOCOL, EVICTION_RECORD_PROTOCOL,
  AGENT_ID_PATTERN, SESSION_ID_PATTERN, MESSAGE_ID_PATTERN,
  AGENT_ACTIVITY_RECENCY_WINDOW_MS, AGENT_STALE_AFTER_MS
};
