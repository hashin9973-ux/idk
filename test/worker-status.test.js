'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isNetworkError, resolveWorkerStatus } = require('../desktop/worker-status');

const now = Date.parse('2026-10-29T21:40:00.000Z');

function state(overrides = {}) {
  return {
    configured: true,
    running: true,
    lastPollAt: '2026-10-29T21:39:50.000Z',
    lastPollError: '',
    lastError: '',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:39:58.000Z',
      lastRequestCommitProbeError: null
    },
    ...overrides
  };
}

test('a recent successful full-tree scan means the worker is online', () => {
  assert.equal(resolveWorkerStatus(state(), 'attention', now), 'online');
});

test('legacy fast commit probes may cover a stale GitHub tree scan', () => {
  const current = state({
    lastPollAt: '2026-10-29T21:38:00.000Z',
    lastPollError: 'GitHub HTTP 429: API rate limit exceeded',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:39:58.000Z',
      lastRequestCommitProbeError: null
    }
  });
  assert.equal(resolveWorkerStatus(current, 'attention', now), 'online');
});

test('a successful scan keeps status online if the fast probe has a transient error', () => {
  const current = state({
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:39:58.000Z',
      lastRequestCommitProbeError: 'GitHub HTTP 503: Service Unavailable'
    }
  });
  assert.equal(resolveWorkerStatus(current, 'connecting', now), 'online');
});

test('stale scans and stale failed probes report reconnecting for transient HTTP failures', () => {
  const current = state({
    lastPollAt: '2026-10-29T21:38:00.000Z',
    lastPollError: '',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:38:00.000Z',
      lastRequestCommitProbeError: 'GitHub HTTP 429: API rate limit exceeded'
    }
  });
  assert.equal(resolveWorkerStatus(current, 'online', now), 'reconnecting');
});

test('persistent authorization or protocol errors still report attention', () => {
  const current = state({
    lastPollAt: '2026-10-29T21:38:00.000Z',
    lastPollError: 'GitHub HTTP 403: Resource not accessible by integration',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:38:00.000Z',
      lastRequestCommitProbeError: 'GitHub HTTP 403: Resource not accessible by integration'
    }
  });
  assert.equal(resolveWorkerStatus(current, 'connecting', now), 'attention');
});

test('transient GitHub API status codes are classified as retryable transport errors', () => {
  for (const message of [
    'GitHub HTTP 408: Request Timeout',
    'GitHub HTTP 425: Too Early',
    'GitHub HTTP 429: API rate limit exceeded',
    'GitHub HTTP 500: Internal Server Error',
    'GitHub HTTP 502: Bad Gateway',
    'GitHub HTTP 503: Service Unavailable',
    'GitHub HTTP 403: API rate limit exceeded'
  ]) assert.equal(isNetworkError(message), true, message);
  assert.equal(isNetworkError('GitHub HTTP 403: Resource not accessible by integration'), false);
  assert.equal(isNetworkError('Invalid mailbox protocol'), false);
});

test('configuration and stopped-worker status preserve their existing semantics', () => {
  assert.equal(resolveWorkerStatus({ configured: false, running: true }, 'attention', now), 'setup');
  assert.equal(resolveWorkerStatus({ configured: true, running: false }, 'offline', now), 'offline');
  assert.equal(resolveWorkerStatus({ configured: true, running: false }, 'connecting', now), 'connecting');
});

test('OneDrive status ignores legacy GitHub probe timestamps and classifies sync errors', () => {
  const current = state({
    transport: 'onedrive-synced-folder',
    lastPollAt: '2026-10-29T21:38:00.000Z',
    lastPollError: 'OneDrive sync is temporarily unavailable',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:39:58.000Z',
      lastRequestCommitProbeError: null
    }
  });
  assert.equal(resolveWorkerStatus(current, 'online', now), 'reconnecting');
  assert.equal(isNetworkError('OneDrive sync is temporarily unavailable'), true);
  assert.equal(isNetworkError('EBUSY: file is locked by the sync client'), true);
  assert.equal(isNetworkError('EACCES: access denied'), false);
});

test('future-dated probe timestamps beyond one minute do not count as fresh for legacy transport', () => {
  const current = state({
    lastPollAt: '2026-10-29T21:38:00.000Z',
    requestPolling: {
      requestTreeScanIntervalMs: 10000,
      requestCommitProbeIntervalMs: 2000,
      lastRequestCommitProbeAt: '2026-10-29T21:50:00.000Z',
      lastRequestCommitProbeError: null
    }
  });
  assert.equal(resolveWorkerStatus(current, 'online', now), 'reconnecting');
});
