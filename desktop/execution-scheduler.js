'use strict';

const DEFAULT_MAX_ACTIVE = 16;
const DEFAULT_MAX_BYPASS = 24;
const DEFAULT_MAX_QUEUED = 10000;
const DEFAULT_AGING_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

function overlaps(a, b) {
  return a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function resourceOverlaps(a, b) {
  return a === '*' || b === '*' || a === b;
}

function footprintsConflict(a = {}, b = {}) {
  if (a.barrier || b.barrier) return true;
  const rightResources = new Set(b.resources || []);
  if ((a.resources || []).some(value => rightResources.has(value))) return true;
  if ((a.writes || []).some(value =>
    (b.reads || []).some(other => overlaps(value, other)) ||
    (b.writes || []).some(other => overlaps(value, other)))) return true;
  if ((b.writes || []).some(value => (a.reads || []).some(other => overlaps(value, other)))) return true;

  return (a.resourceWrites || []).some(value =>
    (b.resourceReads || []).some(other => resourceOverlaps(value, other)) ||
    (b.resourceWrites || []).some(other => resourceOverlaps(value, other))) ||
    (b.resourceWrites || []).some(value =>
      (a.resourceReads || []).some(other => resourceOverlaps(value, other)));
}

function abortError(reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason || 'Operation cancelled.'));
  if (!error.code) error.code = 'ABORT_ERR';
  if (error.name === 'Error') error.name = 'AbortError';
  return error;
}

function createExecutionScheduler(options = {}) {
  const maxActive = Number.isInteger(options.maxActive)
    ? Math.max(1, Math.min(options.maxActive, 64)) : DEFAULT_MAX_ACTIVE;
  const maxBypass = Number.isInteger(options.maxBypass)
    ? Math.max(1, Math.min(options.maxBypass, 128)) : DEFAULT_MAX_BYPASS;
  const maxQueued = Number.isInteger(options.maxQueued)
    ? Math.max(1, Math.min(options.maxQueued, 100000)) : DEFAULT_MAX_QUEUED;
  const agingIntervalMs = Number.isInteger(options.agingIntervalMs)
    ? Math.max(50, Math.min(options.agingIntervalMs, 60000)) : DEFAULT_AGING_INTERVAL_MS;
  const shutdownTimeoutMs = Number.isInteger(options.shutdownTimeoutMs)
    ? Math.max(0, Math.min(options.shutdownTimeoutMs, 120000)) : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const queue = [];
  const active = new Map();
  let sequence = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let finished = 0;
  let totalWait = 0;
  let totalDuration = 0;
  let stopped = false;
  let stopPromise = null;

  function state() {
    const now = Date.now();
    return {
      active: active.size,
      queued: queue.length,
      maxActive,
      maxQueued,
      completed,
      failed,
      cancelled,
      finished,
      averageQueueWaitMs: finished ? Math.round(totalWait / finished) : 0,
      averageExecutionMs: finished ? Math.round(totalDuration / finished) : 0,
      activeTasks: [...active.values()].map(item => ({
        id: item.id, tool: item.tool, priority: item.priority,
        startedAt: item.startedAt, runningForMs: Math.max(0, now - item.startedAtMs),
        cancelRequested: item.controller.signal.aborted
      })),
      queuedTasks: queue.slice(0, 100).map(item => ({
        id: item.id, tool: item.tool, priority: item.priority,
        queuedAt: item.queuedAt, waitingForMs: Math.max(0, now - item.enqueuedAt),
        bypasses: item.bypasses, barrier: item.footprint.barrier === true
      })),
      queuedTasksTruncated: queue.length > 100,
      stopped
    };
  }

  function emit() {
    try { onChange(state()); } catch {}
  }

  function releaseExternalSignal(item) {
    if (item.externalSignal && item.externalAbortListener) {
      item.externalSignal.removeEventListener('abort', item.externalAbortListener);
    }
    item.externalAbortListener = null;
  }

  function finishQueued(item, reason) {
    const index = queue.indexOf(item);
    if (index < 0) return false;
    queue.splice(index, 1);
    const error = abortError(reason);
    item.status = 'cancelled';
    item.controller.abort(error);
    releaseExternalSignal(item);
    totalWait += Math.max(0, Date.now() - item.enqueuedAt);
    finished += 1;
    cancelled += 1;
    item.reject(error);
    item.finish();
    emit();
    pump();
    return true;
  }

  function canStart(item) {
    if (stopped || active.size >= maxActive) return false;
    if (item.footprint.barrier) {
      return active.size === 0 && !queue.some(other =>
        other !== item && other.sequence < item.sequence);
    }
    for (const running of active.values()) {
      if (footprintsConflict(item.footprint, running.footprint)) return false;
    }
    return !queue.some(other => other !== item && other.sequence < item.sequence &&
      (other.footprint.barrier || other.bypasses >= maxBypass));
  }

  function effectivePriority(item, now) {
    const age = Math.floor(Math.max(0, now - item.enqueuedAt) / agingIntervalMs);
    return Math.max(0, item.priority - age);
  }

  function chooseNext() {
    const now = Date.now();
    const ordered = [...queue].sort((a, b) =>
      effectivePriority(a, now) - effectivePriority(b, now) ||
      a.sequence - b.sequence);
    for (const item of ordered) {
      if (!canStart(item)) {
        item.bypasses += 1;
        continue;
      }
      return item;
    }
    return null;
  }

  async function executeItem(item) {
    const startedAtMs = Date.now();
    item.startedAtMs = startedAtMs;
    item.startedAt = new Date(startedAtMs).toISOString();
    item.status = 'running';
    active.set(item.id, item);
    totalWait += Math.max(0, startedAtMs - item.enqueuedAt);
    emit();
    try {
      if (item.controller.signal.aborted) throw abortError(item.controller.signal.reason);
      const result = await item.execute({ id: item.id, signal: item.controller.signal });
      item.status = 'completed';
      completed += 1;
      item.resolve(result);
    } catch (error) {
      const cancelledTask = item.controller.signal.aborted ||
        (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
      if (cancelledTask) {
        item.status = 'cancelled';
        cancelled += 1;
        item.reject(abortError(item.controller.signal.reason || error));
      } else {
        item.status = 'failed';
        failed += 1;
        item.reject(error);
      }
    } finally {
      active.delete(item.id);
      finished += 1;
      totalDuration += Math.max(0, Date.now() - startedAtMs);
      releaseExternalSignal(item);
      item.finish();
      emit();
      pump();
    }
  }

  function pump() {
    if (stopped) return;
    while (active.size < maxActive && queue.length) {
      const item = chooseNext();
      if (!item) break;
      const index = queue.indexOf(item);
      if (index < 0) continue;
      queue.splice(index, 1);
      void executeItem(item);
    }
    emit();
  }

  function run(footprint, execute, meta = {}) {
    if (stopped) return Promise.reject(new Error('Execution scheduler is stopped.'));
    if (typeof execute !== 'function') return Promise.reject(new Error('Scheduled operation must be a function.'));
    if (queue.length >= maxQueued) return Promise.reject(new Error('Execution scheduler queue is full.'));
    const id = String(meta.id || 'task-' + (++sequence));
    if (active.has(id) || queue.some(item => item.id === id)) {
      return Promise.reject(new Error('Duplicate active or queued task ID: ' + id));
    }
    const controller = new AbortController();
    const item = {
      id,
      tool: String(meta.tool || 'unknown'),
      priority: Number.isFinite(meta.priority) ? Math.max(0, Math.min(100, meta.priority)) : 10,
      sequence: ++sequence,
      enqueuedAt: Date.now(),
      queuedAt: new Date().toISOString(),
      bypasses: 0,
      footprint: footprint && typeof footprint === 'object'
        ? {
            reads: Array.isArray(footprint.reads) ? footprint.reads : [],
            writes: Array.isArray(footprint.writes) ? footprint.writes : [],
            resources: Array.isArray(footprint.resources) ? footprint.resources : [],
            resourceReads: Array.isArray(footprint.resourceReads) ? footprint.resourceReads : [],
            resourceWrites: Array.isArray(footprint.resourceWrites) ? footprint.resourceWrites : [],
            barrier: footprint.barrier === true
          }
        : { reads: [], writes: [], resources: [], resourceReads: [], resourceWrites: [], barrier: true },
      controller,
      externalSignal: meta.signal && typeof meta.signal.addEventListener === 'function' ? meta.signal : null,
      externalAbortListener: null,
      execute,
      resolve: null,
      reject: null,
      finish: null,
      done: null,
      status: 'queued'
    };
    item.done = new Promise(resolve => { item.finish = resolve; });
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    if (item.externalSignal) {
      item.externalAbortListener = () => cancel(id, item.externalSignal.reason);
      if (item.externalSignal.aborted) {
        finishQueued(item, item.externalSignal.reason);
        return promise;
      }
      item.externalSignal.addEventListener('abort', item.externalAbortListener, { once: true });
    }
    queue.push(item);
    emit();
    pump();
    return promise;
  }

  function cancel(id, reason = 'Operation cancelled.') {
    const key = String(id || '');
    const queued = queue.find(item => item.id === key);
    if (queued) return finishQueued(queued, reason);
    const running = active.get(key);
    if (!running || running.controller.signal.aborted) return false;
    running.controller.abort(abortError(reason));
    emit();
    return true;
  }

  async function stop(options = {}) {
    if (!stopPromise) {
      stopped = true;
      for (const item of [...queue]) finishQueued(item, 'Execution scheduler stopped before the task started.');
      for (const item of active.values()) {
        if (!item.controller.signal.aborted) item.controller.abort(abortError('Execution scheduler is shutting down.'));
      }
      emit();
      const timeoutMs = Number.isInteger(options.timeoutMs)
        ? Math.max(0, Math.min(options.timeoutMs, 120000)) : shutdownTimeoutMs;
      const activeDone = [...active.values()].map(item => item.done);
      if (!activeDone.length || timeoutMs === 0) {
        stopPromise = Promise.resolve({ stopped: true, drained: active.size === 0, activeRemaining: active.size, queued: queue.length });
      } else {
        stopPromise = Promise.race([
          Promise.allSettled(activeDone).then(() => ({ drained: true })),
          new Promise(resolve => {
            const timer = setTimeout(() => resolve({ drained: false }), timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
          })
        ]).then(result => ({
          stopped: true, drained: result.drained === true,
          activeRemaining: active.size, queued: queue.length
        }));
      }
    }
    return stopPromise;
  }

  return { run, cancel, getState: state, stop };
}

module.exports = {
  DEFAULT_MAX_ACTIVE,
  footprintsConflict,
  createExecutionScheduler
};
