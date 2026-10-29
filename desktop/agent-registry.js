'use strict';

const { createHash, randomUUID } = require('node:crypto');

const AGENT_RECORD_PROTOCOL = 'chatgpt-local-agent-record/v1';
const AGENT_ID_PATTERN = /^agent-[0-9]{3,}$/;
const AGENT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function sanitizeLabel(value, fallback) {
  const label = String(value || '').replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return label || fallback;
}

function newToken() {
  return createHash('sha256').update(randomUUID() + randomUUID()).digest('hex');
}

function createAgentRegistry({ readRemoteFile, listFolder, writeRemoteJson, isConflict }) {
  if (typeof readRemoteFile !== 'function' || typeof listFolder !== 'function' ||
      typeof writeRemoteJson !== 'function' || typeof isConflict !== 'function') {
    throw new TypeError('Agent registry dependencies are incomplete.');
  }

  const activeRequestCounts = new Map();
  const locks = new Map();

  function recordPath(agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) throw new Error('Invalid Agent ID.');
    return 'bridge/agents/' + agentId + '.json';
  }

  async function withAgentLock(agentId, operation) {
    const prior = locks.get(agentId) || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    const queued = prior.catch(() => {}).then(() => gate);
    locks.set(agentId, queued);
    await prior.catch(() => {});
    try {
      return await operation();
    } finally {
      unlock();
      if (locks.get(agentId) === queued) locks.delete(agentId);
    }
  }

  async function readRecord(agentId) {
    const remote = await readRemoteFile(recordPath(agentId));
    if (!remote) return null;
    const record = remote.value;
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        record.protocol !== AGENT_RECORD_PROTOCOL || record.agent_id !== agentId ||
        typeof record.token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.token_hash)) {
      throw new Error('The Agent ID registry record is malformed; refusing to overwrite it.');
    }
    return remote;
  }

  async function mutateRecord(agentId, token, mutator) {
    return withAgentLock(agentId, async () => {
      const expectedTokenHash = tokenHash(token);
      for (let attempt = 0; attempt < 6; attempt++) {
        const remote = await readRecord(agentId);
        if (!remote) throw new Error('Agent ID ' + agentId + ' is not registered. Do not borrow an ID from another conversation.');
        if (remote.value.token_hash !== expectedTokenHash) {
          throw new Error('Agent registration token does not match ' + agentId + '. Recover this conversation’s original token or register a new Agent ID.');
        }
        const next = { ...mutator({ ...remote.value }), updated_at: new Date().toISOString() };
        try {
          await writeRemoteJson(recordPath(agentId), next, remote.sha, false);
          return next;
        } catch (error) {
          if (!isConflict(error) || attempt === 5) throw error;
        }
      }
      throw new Error('Could not update Agent ID status after resolving repository write conflicts.');
    });
  }

  async function register(args = {}) {
    const hasId = Boolean(args.agent_id);
    const hasToken = Boolean(args.agent_token);
    if (hasId || hasToken) {
      if (!(hasId && hasToken)) throw new Error('Restoring an Agent ID requires both agent_id and agent_token.');
      if (typeof args.agent_id !== 'string' || !AGENT_ID_PATTERN.test(args.agent_id) ||
          typeof args.agent_token !== 'string' || !/^[a-f0-9]{64}$/.test(args.agent_token)) {
        throw new Error('The supplied Agent ID or registration token is malformed.');
      }
      const now = new Date().toISOString();
      const record = await mutateRecord(args.agent_id, args.agent_token, current => ({
        ...current,
        status: (activeRequestCounts.get(args.agent_id) || 0) > 0 ? 'active' : 'idle',
        last_seen_at: now,
        active_request_ids: Array.isArray(current.active_request_ids) ? current.active_request_ids : []
      }));
      return {
        agent_id: record.agent_id,
        agent_token: args.agent_token,
        label: record.label,
        status: record.status,
        restored: true,
        created_at: record.created_at,
        last_seen_at: record.last_seen_at,
        note: 'Restored this conversation’s existing Agent ID. Reuse this ID and token on all subsequent mailbox requests.'
      };
    }

    const requestedLabel = sanitizeLabel(args.label, '');
    for (let attempt = 0; attempt < 32; attempt++) {
      const entries = await listFolder('bridge/agents');
      const used = new Set(entries
        .filter(item => item && typeof item.name === 'string' && /^agent-[0-9]+\.json$/.test(item.name))
        .map(item => item.name.slice(0, -5)));
      let ordinal = 1;
      while (used.has('agent-' + String(ordinal).padStart(3, '0'))) ordinal++;
      const agentId = 'agent-' + String(ordinal).padStart(3, '0');
      const token = newToken();
      const now = new Date().toISOString();
      const record = {
        protocol: AGENT_RECORD_PROTOCOL,
        agent_id: agentId,
        token_hash: tokenHash(token),
        label: requestedLabel || 'Agent ' + ordinal,
        status: 'idle',
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        last_completed_at: null,
        last_request_id: null,
        recent_request_ids: [],
        active_request_ids: []
      };
      try {
        const saved = await writeRemoteJson(recordPath(agentId), record, null, true);
        if (saved.ok) {
          return {
            agent_id: agentId,
            agent_token: token,
            label: record.label,
            status: record.status,
            restored: false,
            created_at: now,
            last_seen_at: now,
            note: 'Allocated the next unused Agent ID. Keep the ID and token in this conversation; the bridge updates status on later requests.'
          };
        }
      } catch (error) {
        if (!isConflict(error) || attempt === 31) throw error;
      }
    }
    throw new Error('Could not allocate a unique Agent ID after repeated concurrent registration attempts.');
  }

  async function authenticate(request) {
    if (!request.agent_id) return true;
    const remote = await readRecord(request.agent_id);
    if (!remote) throw new Error('Agent ID ' + request.agent_id + ' is not registered.');
    if (remote.value.token_hash !== tokenHash(request.agent_token)) {
      throw new Error('Agent registration token does not match ' + request.agent_id + '. Check this conversation’s registration result.');
    }
    return true;
  }

  async function requestStarted(request) {
    if (!request.agent_id) return false;
    const agentId = request.agent_id;
    const count = (activeRequestCounts.get(agentId) || 0) + 1;
    activeRequestCounts.set(agentId, count);
    try {
      await mutateRecord(agentId, request.agent_token, record => {
        const recent = Array.isArray(record.recent_request_ids) ? record.recent_request_ids : [];
        const active = Array.isArray(record.active_request_ids) ? record.active_request_ids : [];
        return {
          ...record,
          status: 'active',
          last_seen_at: new Date().toISOString(),
          last_request_id: request.request_id,
          recent_request_ids: [...recent.filter(id => id !== request.request_id), request.request_id].slice(-25),
          active_request_ids: [...new Set([...active, request.request_id])]
        };
      });
      return true;
    } catch (error) {
      if (count <= 1) activeRequestCounts.delete(agentId);
      else activeRequestCounts.set(agentId, count - 1);
      throw error;
    }
  }

  async function requestCompleted(request) {
    if (!request.agent_id) return;
    const agentId = request.agent_id;
    const remaining = Math.max(0, (activeRequestCounts.get(agentId) || 1) - 1);
    if (remaining === 0) activeRequestCounts.delete(agentId);
    else activeRequestCounts.set(agentId, remaining);
    const now = new Date().toISOString();
    return mutateRecord(agentId, request.agent_token, record => ({
      ...record,
      status: remaining > 0 ? 'active' : 'idle',
      last_seen_at: now,
      last_completed_at: now,
      active_request_ids: (Array.isArray(record.active_request_ids) ? record.active_request_ids : [])
        .filter(id => id !== request.request_id)
    }));
  }

  async function statuses(filterAgentId = null) {
    if (filterAgentId && !AGENT_ID_PATTERN.test(filterAgentId)) throw new Error('Agent ID has an invalid format.');
    const entries = await listFolder('bridge/agents');
    const ids = entries
      .filter(item => item && typeof item.name === 'string' && /^agent-[0-9]+\.json$/.test(item.name))
      .map(item => item.name.slice(0, -5))
      .filter(id => !filterAgentId || id === filterAgentId)
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
    const rows = await Promise.all(ids.map(async agentId => {
      const remote = await readRecord(agentId);
      if (!remote) return null;
      const record = remote.value;
      const activeCount = activeRequestCounts.get(agentId) || 0;
      const lastSeen = Date.parse(record.last_seen_at || record.created_at || '');
      const inactiveFor = Number.isFinite(lastSeen) ? Math.max(0, Date.now() - lastSeen) : Infinity;
      const status = record.status === 'released' ? 'released' : activeCount > 0 ? 'active' :
        record.status === 'active' || inactiveFor > AGENT_STALE_AFTER_MS ? 'stale' : 'idle';
      return {
        agent_id: agentId,
        label: record.label || agentId,
        status,
        created_at: record.created_at || null,
        updated_at: record.updated_at || null,
        last_seen_at: record.last_seen_at || null,
        last_completed_at: record.last_completed_at || null,
        last_request_id: record.last_request_id || null,
        recent_request_ids: Array.isArray(record.recent_request_ids) ? record.recent_request_ids.slice(-25) : [],
        active_request_ids: activeCount > 0 && Array.isArray(record.active_request_ids) ? record.active_request_ids : []
      };
    }));
    const agents = rows.filter(Boolean);
    return {
      agents,
      count: agents.length,
      counts: {
        active: agents.filter(agent => agent.status === 'active').length,
        idle: agents.filter(agent => agent.status === 'idle').length,
        stale: agents.filter(agent => agent.status === 'stale').length,
        released: agents.filter(agent => agent.status === 'released').length
      },
      status_legend: {
        active: 'A request from this agent is currently executing in this Windows worker.',
        idle: 'The agent has checked in within the last 24 hours and has no active request.',
        stale: 'The agent has not checked in recently, or a worker stopped while it was marked active. Its ID is not reused automatically.',
        released: 'Registered IDs are never recycled; explicit release support is not enabled.'
      },
      note: 'Registration tokens are omitted. Agent IDs are routing labels, not access-control boundaries for a shared mailbox.'
    };
  }

  return { register, authenticate, requestStarted, requestCompleted, statuses, recordPath, AGENT_RECORD_PROTOCOL };
}

module.exports = { createAgentRegistry, AGENT_RECORD_PROTOCOL, AGENT_ID_PATTERN, AGENT_STALE_AFTER_MS };
