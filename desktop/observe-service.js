'use strict';

const crypto = require('node:crypto');

const OBSERVE_PROTOCOL = 'chatgpt-windows-observe-context/v1';
const DEFAULT_SAMPLE_FPS = 2;
const OBSERVE_FPS_OPTIONS = Object.freeze([0.5, 1, 2, 4, 8]);
const SAMPLE_INTERVAL_MS = 1000 / DEFAULT_SAMPLE_FPS;
const PUBLISH_INTERVAL_MS = 1000;

function normalizeSampleFps(value) {
  const fps = Number(value);
  if (!OBSERVE_FPS_OPTIONS.includes(fps)) throw new Error('Observe FPS must be one of: ' + OBSERVE_FPS_OPTIONS.join(', ') + '.');
  return fps;
}

function intervalForFps(value) {
  return Math.round(1000 / normalizeSampleFps(value));
}
const FRAME_LIMIT = 10;
const MAX_CONTEXT_BYTES = 180000;

function safeText(value, limit = 500) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
}

function createObserveService(deps = {}) {
  const {
    githubAuth,
    captureScreenshot,
    fingerprintScreenshot,
    getAccessibleSnapshot,
    getSampleFps = () => DEFAULT_SAMPLE_FPS,
    now = () => Date.now(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = deps;

  let enabled = false;
  let timer = null;
  let inFlight = false;
  let publishInFlight = false;
  let publishedSequence = 0;
  let disposed = false;
  let lastFingerprint = '';
  let lastPublishedAt = 0;
  let lastError = '';
  let sequence = 0;
  let observeEpoch = 0;
  let frames = [];
  let currentSha = null;
  let lastCaptureAt = null;
  let lastChangeAt = null;
  let skippedSamples = 0;
  let sampleFps = (() => {
    try { return normalizeSampleFps(getSampleFps()); } catch { return DEFAULT_SAMPLE_FPS; }
  })();
  let startupCleanupPromise = null;

  async function waitForStartupCleanup() {
    if (startupCleanupPromise) await startupCleanupPromise.catch(() => {});
  }

  function status() {
    return {
      enabled,
      status: disposed ? 'disposed' : !enabled ? 'off' : lastError ? 'attention' : inFlight ? 'capturing' : 'watching',
      fps: sampleFps,
      sample_interval_ms: intervalForFps(sampleFps),
      frame_count: frames.length,
      sequence,
      last_capture_at: lastCaptureAt ? new Date(lastCaptureAt).toISOString() : null,
      last_change_at: lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
      last_publish_at: lastPublishedAt ? new Date(lastPublishedAt).toISOString() : null,
      skipped_samples: skippedSamples,
      error: lastError
    };
  }

  function getMailboxConfig() {
    const authSettings = githubAuth && typeof githubAuth.getState === 'function';
    if (!authSettings) throw new Error('GitHub authentication is unavailable.');
  }

  async function publish(enabledValue, errorMessage = '') {
    if (!githubAuth || typeof githubAuth.requestApi !== 'function') throw new Error('Sign in to GitHub to publish Observe context.');
    const payload = {
      protocol: OBSERVE_PROTOCOL,
      enabled: enabledValue,
      updated_at: new Date(now()).toISOString(),
      sample_fps: sampleFps,
      frame_count: enabledValue ? frames.length : 0,
      frames: enabledValue ? frames.slice(-FRAME_LIMIT) : [],
      status: enabledValue ? 'observing' : 'off',
      error: safeText(errorMessage, 500) || null
    };
    let content = JSON.stringify(payload);
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTEXT_BYTES) {
      const clippedFrames = payload.frames.slice();
      while (clippedFrames.length && Buffer.byteLength(JSON.stringify({ ...payload, frames: clippedFrames }), 'utf8') > MAX_CONTEXT_BYTES) clippedFrames.shift();
      payload.frames = clippedFrames;
      payload.frame_count = clippedFrames.length;
      payload.truncated = true;
      content = JSON.stringify(payload);
    }
    const path = '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json';
    // The SHA is process-local. After an app restart, fetch the current blob SHA before
    // updating an existing Contents API file; a missing file is the only create case.
    if (!currentSha) {
      try {
        const existing = await githubAuth.requestApi({
          method: 'GET', path, query: { ref: 'bridge-mailbox' }
        });
        const existingSha = existing && existing.result && existing.result.sha;
        if (typeof existingSha !== 'string' || !/^[a-f0-9]{40}$/i.test(existingSha)) {
          throw new Error('GitHub returned no valid blob SHA for the existing Observe context file.');
        }
        currentSha = existingSha;
      } catch (error) {
        if (!/GitHub HTTP 404: Not Found/i.test(String(error && error.message || error))) throw error;
      }
    }
    const body = {
      message: enabledValue ? '[observe] update live screen context' : '[observe] clear live screen context',
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: 'bridge-mailbox',
      ...(currentSha ? { sha: currentSha } : {})
    };
    const response = await githubAuth.requestApi({ method: 'PUT', path, body });
    if (response && response.result && response.result.content && response.result.content.sha) currentSha = response.result.content.sha;
    else if (response && response.result && response.result.content_sha) currentSha = response.result.content_sha;
    lastPublishedAt = now();
    return payload;
  }

  async function publishLatestWhenDue() {
    if (publishInFlight || !enabled || disposed || sequence <= publishedSequence) return;
    publishInFlight = true;
    try {
      const delay = PUBLISH_INTERVAL_MS - (now() - lastPublishedAt);
      if (delay > 0) await sleep(delay);
      if (!enabled || disposed) return;
      const published = await publish(true);
      publishedSequence = published.frames.length ? published.frames[published.frames.length - 1].sequence : 0;
      lastError = '';
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe publish failed', 500);
    } finally {
      publishInFlight = false;
      if (enabled && !disposed && sequence > publishedSequence) {
        // Coalesce changes that arrived while the last GitHub update was in flight.
        void publishLatestWhenDue();
      }
    }
  }

  let contextInFlight = false;
  let pendingCapture = null;

  async function drainChangedCapture() {
    if (contextInFlight || !pendingCapture || !enabled || disposed) return;
    contextInFlight = true;
    try {
      while (pendingCapture && enabled && !disposed) {
        const item = pendingCapture;
        pendingCapture = null;
        const captured = item.captured;
        if (item.epoch !== observeEpoch) continue;
        const screen = {
          width: Number(captured.screen_width || captured.width) || 0,
          height: Number(captured.screen_height || captured.height) || 0,
          frame_width: Number(captured.width) || 0,
          frame_height: Number(captured.height) || 0,
          display_id: safeText(captured.display_id, 80) || null
        };
        let accessibility = { available: false, source: 'windows_uia', reason: 'unavailable' };
        try {
          accessibility = await getAccessibleSnapshot({ screen, frame: { width: screen.frame_width, height: screen.frame_height } });
        } catch (error) {
          accessibility = { available: false, source: 'windows_uia', reason: safeText(error && error.message || error, 120) };
        }
        if (!enabled || disposed || item.epoch !== observeEpoch) break;
        const frame = {
          sequence: ++sequence,
          captured_at: new Date(item.capturedAt).toISOString(),
          screen,
          active_window: accessibility && accessibility.active_window || null,
          focused_control: accessibility && accessibility.focused_control || null,
          controls: Array.isArray(accessibility && accessibility.controls) ? accessibility.controls.slice(0, 250) : [],
          accessibility: {
            available: accessibility && accessibility.available === true,
            source: safeText(accessibility && accessibility.source || 'windows_uia', 40),
            reason: safeText(accessibility && accessibility.reason || '', 120),
            truncated: accessibility && accessibility.truncated === true,
            node_count: Number.isFinite(accessibility && accessibility.node_count) ? accessibility.node_count : null
          },
          fingerprint: item.fingerprint.slice(0, 64),
          note: 'UI Automation is grounded evidence. This frame does not contain full pixel-level scene understanding; visual OCR/model enrichment is not yet attached.'
        };
        frames.push(frame);
        if (frames.length > FRAME_LIMIT) frames = frames.slice(-FRAME_LIMIT);
        void publishLatestWhenDue();
      }
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe context processing failed', 500);
    } finally {
      contextInFlight = false;
      if (pendingCapture && enabled && !disposed) void drainChangedCapture();
    }
  }

  async function captureOnce() {
    if (!enabled || disposed || inFlight) {
      skippedSamples += 1;
      return;
    }
    inFlight = true;
    try {
      const captured = await captureScreenshot();
      const capturedAt = Number(captured && captured.captured_at) || now();
      lastCaptureAt = capturedAt;
      const fingerprint = await fingerprintScreenshot(captured);
      if (!fingerprint || fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      lastChangeAt = capturedAt;
      // If UI Automation is still processing, keep only the newest changed frame.
      // Sampling itself remains independent and continues at the 250 ms cadence.
      pendingCapture = { captured, capturedAt, fingerprint, epoch: observeEpoch };
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe capture failed', 500);
    } finally {
      inFlight = false;
      if (pendingCapture && enabled && !disposed) void drainChangedCapture();
    }
  }

  async function setFps(value) {
    await waitForStartupCleanup();
    const nextFps = normalizeSampleFps(value);
    if (disposed) throw new Error('Observe service has been disposed.');
    if (nextFps === sampleFps) return status();
    sampleFps = nextFps;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (enabled) timer = setIntervalImpl(() => { void captureOnce(); }, intervalForFps(sampleFps));
    if (enabled) {
      while (publishInFlight) await sleep(50);
      publishInFlight = true;
      try {
        const published = await publish(true);
        publishedSequence = published.frames.length ? published.frames[published.frames.length - 1].sequence : 0;
        lastError = '';
      } catch (error) {
        lastError = safeText(error && error.message || error || 'Observe FPS publish failed', 500);
        throw error;
      } finally {
        publishInFlight = false;
        if (enabled && !disposed && sequence > publishedSequence) void publishLatestWhenDue();
      }
    }
    return status();
  }

  async function setEnabled(value) {
    await waitForStartupCleanup();
    if (typeof value !== 'boolean') throw new Error('Observe state must be a boolean.');
    if (disposed) throw new Error('Observe service has been disposed.');
    if (value === enabled) return status();
    observeEpoch += 1;
    pendingCapture = null;
    if (value) {
      if (!githubAuth || typeof githubAuth.requestApi !== 'function') throw new Error('Sign in to GitHub before enabling Observe mode.');
      enabled = true;
      lastFingerprint = '';
      frames = [];
      sequence = 0;
      publishedSequence = 0;
      lastError = '';
      if (timer !== null) clearIntervalImpl(timer);
      timer = setIntervalImpl(() => { void captureOnce(); }, intervalForFps(sampleFps));
      // Serialize the initial status write with any frame publication.
      publishInFlight = true;
      try {
        const published = await publish(true);
        publishedSequence = published.frames.length ? published.frames[published.frames.length - 1].sequence : 0;
      } catch (error) {
        lastError = safeText(error && error.message || error, 500);
        enabled = false;
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        throw error;
      } finally {
        publishInFlight = false;
      }
      if (sequence > publishedSequence) void publishLatestWhenDue();
      void captureOnce();
      return status();
    }

    enabled = false;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    frames = [];
    pendingCapture = null;
    lastFingerprint = '';
    lastError = '';
    while (publishInFlight) await sleep(50);
    // Clear live context on GitHub. GitHub's prior commit history may still contain old snapshots.
    await publish(false);
    frames = [];
    return status();
  }

  async function clearStaleContext() {
    if (startupCleanupPromise) return startupCleanupPromise;
    startupCleanupPromise = (async () => {
      if (enabled || disposed || !githubAuth || typeof githubAuth.requestApi !== 'function') return status();
      const path = '/repos/hashin9973-ux/qdqwg/contents/bridge/vision/observe.json';
      try {
        const response = await githubAuth.requestApi({ method: 'GET', path, query: { ref: 'bridge-mailbox' } });
        const record = response && response.result;
        if (!record || typeof record.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(record.sha)) {
          throw new Error('GitHub returned an invalid Observe context file record.');
        }
        currentSha = record.sha;
        let payload = null;
        try {
          const raw = Buffer.from(String(record.content || ''), 'base64').toString('utf8');
          payload = JSON.parse(raw);
        } catch {}
        const hasLiveContext = !payload || payload.enabled === true ||
          (Array.isArray(payload.frames) && payload.frames.length > 0) ||
          (Number(payload.frame_count) || 0) > 0;
        if (hasLiveContext) {
          frames = [];
          pendingCapture = null;
          lastFingerprint = '';
          await publish(false);
          lastError = '';
        }
        return status();
      } catch (error) {
        if (/GitHub HTTP 404: Not Found/i.test(String(error && error.message || error))) return status();
        lastError = safeText(error && error.message || error || 'Could not clear stale Observe context', 500);
        throw error;
      }
    })();
    return startupCleanupPromise;
  }

  async function dispose() {
    if (disposed) return;
    await waitForStartupCleanup();
    const wasEnabled = enabled;
    observeEpoch += 1;
    enabled = false;
    pendingCapture = null;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    frames = [];
    lastFingerprint = '';
    if (wasEnabled) {
      try {
        while (publishInFlight) await sleep(50);
        await publish(false);
      } catch (error) { lastError = safeText(error && error.message || error, 500); }
    }
    disposed = true;
  }

  return { status, setEnabled, setFps, clearStaleContext, dispose };
}

module.exports = { createObserveService, OBSERVE_PROTOCOL, DEFAULT_SAMPLE_FPS, OBSERVE_FPS_OPTIONS, SAMPLE_INTERVAL_MS, PUBLISH_INTERVAL_MS, FRAME_LIMIT, intervalForFps };
