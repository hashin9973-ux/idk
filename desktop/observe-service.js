'use strict';

const crypto = require('node:crypto');

const OBSERVE_PROTOCOL = 'chatgpt-windows-observe-context/v1';
const SAMPLE_INTERVAL_MS = 250;
const PUBLISH_INTERVAL_MS = 1000;
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
    now = () => Date.now(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
  } = deps;

  let enabled = false;
  let timer = null;
  let inFlight = false;
  let disposed = false;
  let lastFingerprint = '';
  let lastPublishedAt = 0;
  let lastError = '';
  let sequence = 0;
  let frames = [];
  let currentSha = null;
  let lastCaptureAt = null;
  let lastChangeAt = null;
  let skippedSamples = 0;

  function status() {
    return {
      enabled,
      status: disposed ? 'disposed' : !enabled ? 'off' : lastError ? 'attention' : inFlight ? 'capturing' : 'watching',
      fps: 4,
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
      sample_fps: 4,
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

  async function captureOnce() {
    if (!enabled || disposed || inFlight) {
      skippedSamples += 1;
      return;
    }
    inFlight = true;
    try {
      const captured = await captureScreenshot();
      lastCaptureAt = Number(captured && captured.captured_at) || now();
      const fingerprint = await fingerprintScreenshot(captured);
      if (!fingerprint || fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      lastChangeAt = lastCaptureAt;

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
      const frame = {
        sequence: ++sequence,
        captured_at: new Date(lastCaptureAt).toISOString(),
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
        fingerprint: fingerprint.slice(0, 64),
        note: 'UI Automation is grounded evidence. This frame does not contain full pixel-level scene understanding; visual OCR/model enrichment is not yet attached.'
      };
      frames.push(frame);
      if (frames.length > FRAME_LIMIT) frames = frames.slice(-FRAME_LIMIT);

      // Coalesce bursts of visual changes. Capture samples at 4 fps, but publish at most once per second.
      const delay = PUBLISH_INTERVAL_MS - (now() - lastPublishedAt);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        if (!enabled || disposed) return;
      }
      await publish(true);
      lastError = '';
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe capture failed', 500);
    } finally {
      inFlight = false;
    }
  }

  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('Observe state must be a boolean.');
    if (disposed) throw new Error('Observe service has been disposed.');
    if (value === enabled) return status();
    if (value) {
      if (!githubAuth || typeof githubAuth.requestApi !== 'function') throw new Error('Sign in to GitHub before enabling Observe mode.');
      enabled = true;
      lastFingerprint = '';
      frames = [];
      sequence = 0;
      lastError = '';
      if (timer !== null) clearIntervalImpl(timer);
      timer = setIntervalImpl(() => { void captureOnce(); }, SAMPLE_INTERVAL_MS);
      // Publish the enabled state immediately, then capture the first frame.
      try { await publish(true); } catch (error) {
        lastError = safeText(error && error.message || error, 500);
        enabled = false;
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        throw error;
      }
      void captureOnce();
      return status();
    }

    enabled = false;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    frames = [];
    lastFingerprint = '';
    lastError = '';
    // Clear live context on GitHub. GitHub's prior commit history may still contain old snapshots.
    await publish(false);
    frames = [];
    return status();
  }

  async function dispose() {
    if (disposed) return;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    enabled = false;
    frames = [];
    disposed = true;
  }

  return { status, setEnabled, dispose };
}

module.exports = { createObserveService, OBSERVE_PROTOCOL, SAMPLE_INTERVAL_MS, PUBLISH_INTERVAL_MS, FRAME_LIMIT };
