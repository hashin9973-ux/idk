'use strict';

function isNetworkError(message) {
  // Network, sharing, synchronization, and server errors are transient mailbox
  // transport conditions, not proof that the user must repair configuration.
  return /network|offline|internet|fetch failed|failed to fetch|enotfound|eai_again|econn|etimedout|timed out|socket|dns|unable to connect|connection refused|temporarily unavailable|connection reset|bad gateway|service unavailable|gateway timeout|OneDrive sync|OneDrive synchronization|(?:EAGAIN|EBUSY|EIO|ENODATA|ESTALE)|GitHub HTTP (?:408|425|429|5\\d\\d):|GitHub HTTP 403:.*(?:rate.?limit|secondary rate|abuse detection|temporarily blocked)/i.test(String(message || ''));
}

function timestampFresh(value, now, windowMs) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -60000 && age <= windowMs;
}

function resolveWorkerStatus(state, fallbackStatus = 'connecting', now = Date.now()) {
  const current = state || {};
  if (!current.configured) return 'setup';
  if (!current.running) return fallbackStatus;

  const polling = current.requestPolling || {};
  const scanInterval = Math.max(1000, Number(polling.requestTreeScanIntervalMs) || 5000);
  const scanFreshnessWindowMs = Math.max(15000, scanInterval * 3);
  const scanFresh = timestampFresh(current.lastPollAt, now, scanFreshnessWindowMs);

  // The fast commit probe belongs only to the legacy test transport. The
  // OneDrive worker uses its successful local poll timestamp as its live signal.
  const probeInterval = Math.max(1000, Number(polling.requestCommitProbeIntervalMs) || 2000);
  const probeFreshnessWindowMs = Math.max(10000, probeInterval * 4);
  const probeFresh = current.transport !== 'onedrive-synced-folder' &&
    timestampFresh(polling.lastRequestCommitProbeAt, now, probeFreshnessWindowMs) &&
    !String(polling.lastRequestCommitProbeError || '').trim();
  if (scanFresh || probeFresh) return 'online';

  const connectionError = String(current.lastPollError || polling.lastRequestCommitProbeError || current.lastError || '');
  if (connectionError && isNetworkError(connectionError)) return 'reconnecting';
  if (connectionError) return 'attention';
  return 'reconnecting';
}

module.exports = { isNetworkError, resolveWorkerStatus };
