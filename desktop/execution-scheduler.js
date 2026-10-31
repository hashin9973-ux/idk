'use strict';

const os = require('node:os');
const DEFAULT_MAX_ACTIVE = 100;
const DEFAULT_MAX_BYPASS = 24;
const DEFAULT_MAX_QUEUED = 10000;
const DEFAULT_AGING_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_RESOURCE_LIMITS = Object.freeze({ filesystem: 64, 'disk-io': 16, 'source-analysis': 8, compilation: 2, editor: 1, cook: 1, packaging: 1, gpu: 1, 'binary-assets': 2, 'mailbox-network': 32, 'desktop-control': 1, audio: 1, shell: 4, git: 2 });

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
    ? Math.max(1, Math.min(options.maxActive, 100)) : DEFAULT_MAX_ACTIVE;
  const maxBypass = Number.isInteger(options.maxBypass)
    ? Math.max(1, Math.min(options.maxBypass, 128)) : DEFAULT_MAX_BYPASS;
  const maxQueued = Number.isInteger(options.maxQueued)
    ? Math.max(1, Math.min(options.maxQueued, 100000)) : DEFAULT_MAX_QUEUED;
  const agingIntervalMs = Number.isInteger(options.agingIntervalMs)
    ? Math.max(50, Math.min(options.agingIntervalMs, 60000)) : DEFAULT_AGING_INTERVAL_MS;
  const shutdownTimeoutMs = Number.isInteger(options.shutdownTimeoutMs)
    ? Math.max(0, Math.min(options.shutdownTimeoutMs, 120000)) : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const getFreeMemoryBytes = typeof options.getFreeMemoryBytes === 'function' ? options.getFreeMemoryBytes : () => os.freemem();
  const cpuCores = Math.max(1, os.cpus().length || 1);
  const totalMemoryBytes = Math.max(1, os.totalmem());
  const adaptiveLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    'source-analysis': Math.max(2, Math.min(DEFAULT_RESOURCE_LIMITS['source-analysis'], cpuCores)),
    compilation: Math.max(1, Math.min(DEFAULT_RESOURCE_LIMITS.compilation, Math.floor(cpuCores / 4) || 1, Math.floor(totalMemoryBytes / (8 * 1024 ** 3)) || 1))
  };
  const resourceLimits = { ...adaptiveLimits, ...(options.resourceLimits && typeof options.resourceLimits === 'object' ? options.resourceLimits : {}) };
  const memoryPressureReserveBytes = Math.max(1024 ** 3, Math.round(totalMemoryBytes * 0.08));
  const heavyPools = new Set(['compilation', 'editor', 'cook', 'packaging', 'gpu', 'binary-assets']);
  function resourceMetrics() {
    const sampledFreeMemoryBytes = Number(getFreeMemoryBytes());
    const freeMemoryBytes = Number.isFinite(sampledFreeMemoryBytes) ? Math.max(0, sampledFreeMemoryBytes) : 0;
    return { cpu_cores: cpuCores, total_memory_bytes: totalMemoryBytes, free_memory_bytes: freeMemoryBytes,
      process_rss_bytes: process.memoryUsage().rss, memory_pressure: freeMemoryBytes < memoryPressureReserveBytes,
      memory_pressure_reserve_bytes: memoryPressureReserveBytes };
  }
  function poolLimit(name, metrics = resourceMetrics()) {
    const configured = Number.isInteger(resourceLimits[name]) ? resourceLimits[name] : maxActive;
    return metrics.memory_pressure && heavyPools.has(name) ? Math.min(configured, 1) : configured;
  }
  for (const [name, limit] of Object.entries(resourceLimits)) resourceLimits[name] = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : DEFAULT_RESOURCE_LIMITS[name] || maxActive;
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
    const metrics = resourceMetrics();
    const poolUsage = {};
    for (const name of Object.keys(resourceLimits)) poolUsage[name] = { active: 0, limit: poolLimit(name, metrics) };
    for (const item of active.values()) for (const name of item.footprint.resourcePools || []) {
      if (!poolUsage[name]) poolUsage[name] = { active: 0, limit: maxActive };
      poolUsage[name].active++;
    }
    return {
      active: active.size,
      queued: queue.length,
      maxActive,
      maxQueued,
      resourcePools: poolUsage,
      resourceMetrics: metrics,
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
    const metrics = resourceMetrics();
    for (const pool of item.footprint.resourcePools || []) {
      const limit = poolLimit(pool, metrics);
      let used = 0;
      for (const running of active.values()) if ((running.footprint.resourcePools || []).includes(pool)) used++;
      if (used >= limit) return false;
    }
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
            resourcePools: [...new Set(Array.isArray(footprint.resourcePools) ? footprint.resourcePools.filter(value => typeof value === 'string' && value.length <= 80) : [])],
            barrier: footprint.barrier === true
          }
        : { reads: [], writes: [], resources: [], resourceReads: [], resourceWrites: [], resourcePools: [], barrier: true },
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
        releaseExternalSignal(item);
        return Promise.reject(abortError(item.externalSignal.reason));
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

  return { run, cancel, getState: state, getResourceLimit: name => poolLimit(String(name || '')), stop };
}

module.exports = {
  DEFAULT_MAX_ACTIVE,
  DEFAULT_RESOURCE_LIMITS,
  footprintsConflict,
  createExecutionScheduler
};
