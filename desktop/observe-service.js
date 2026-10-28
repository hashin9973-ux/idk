'use strict';

const crypto = require('node:crypto');

const OBSERVE_PROTOCOL = 'chatgpt-windows-observe-context/v1';
const DEFAULT_SAMPLE_FPS = 2;
const OBSERVE_FPS_OPTIONS = Object.freeze([0.5, 1, 2, 4, 8]);
const SAMPLE_INTERVAL_MS = 1000 / DEFAULT_SAMPLE_FPS;
const PUBLISH_INTERVAL_MS = 1000;
const PASSIVE_VISION_MIN_INTERVAL_MS = 1000;
const PASSIVE_VISION_RETRY_INTERVAL_MS = 5000;

function normalizeSampleFps(value) {
  const fps = Number(value);
  if (!OBSERVE_FPS_OPTIONS.includes(fps)) throw new Error('Observe FPS must be one of: ' + OBSERVE_FPS_OPTIONS.join(', ') + '.');
  return fps;
}

function intervalForFps(value) {
  return Math.round(1000 / normalizeSampleFps(value));
}
const FRAME_LIMIT = 10;
const MAX_CONTEXT_BYTES = 350000;

function safeText(value, limit = 500) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
}

function createObserveService(deps = {}) {
  const {
    githubAuth,
    captureScreenshot,
    fingerprintScreenshot,
    getAccessibleSnapshot,
    analyzeFrame,
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
  let publicationRevision = 0;
  let publishedRevision = 0;
  let disposed = false;
  let lastFingerprint = '';
  let lastPublishedAt = 0;
  let lastError = '';
  let sequence = 0;
  let observeEpoch = 0;
  let frames = [];
  let latestCapturedFrame = null;
  let pendingVisionFrame = null;
  let visionInFlight = false;
  let lastVisionAttemptAt = 0;
  let lastVisionCompletedAt = null;
  let latestVisionStatus = 'idle';
  let lastVisionError = '';
  let currentSha = null;
  let lastCaptureAt = null;
  let lastChangeAt = null;
  let captureCount = 0;
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
      capture_count: captureCount,
      skipped_samples: skippedSamples,
      sequence,
      last_capture_at: lastCaptureAt ? new Date(lastCaptureAt).toISOString() : null,
      last_change_at: lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
      last_publish_at: lastPublishedAt ? new Date(lastPublishedAt).toISOString() : null,
      last_vision_completed_at: lastVisionCompletedAt ? new Date(lastVisionCompletedAt).toISOString() : null,
      passive_vision_status: latestVisionStatus,
      passive_vision_error: lastVisionError,
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
      sample_interval_ms: intervalForFps(sampleFps),
      capture_count: enabledValue ? captureCount : 0,
      skipped_samples: enabledValue ? skippedSamples : 0,
      last_capture_at: enabledValue && lastCaptureAt ? new Date(lastCaptureAt).toISOString() : null,
      last_change_at: enabledValue && lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
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
    if (publishInFlight || !enabled || disposed || publicationRevision <= publishedRevision) return;
    publishInFlight = true;
    try {
      const delay = PUBLISH_INTERVAL_MS - (now() - lastPublishedAt);
      if (delay > 0) await sleep(delay);
      if (!enabled || disposed) return;
      const targetRevision = publicationRevision;
      await publish(true);
      publishedRevision = targetRevision;
      lastError = '';
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe publish failed', 500);
    } finally {
      publishInFlight = false;
      if (enabled && !disposed && publicationRevision > publishedRevision) {
        // Coalesce changes that arrived while the last GitHub update was in flight.
        void publishLatestWhenDue();
      }
    }
  }

  let contextInFlight = false;
  let pendingCapture = null;

  function getLatestFrame(maxAgeMs = 2500) {
    if (!enabled || disposed || !latestCapturedFrame) return null;
    const capturedAt = Number(latestCapturedFrame.captured_at) || 0;
    const ageMs = Math.max(0, now() - capturedAt);
    if (!capturedAt || ageMs > maxAgeMs) return null;
    return { ...latestCapturedFrame, age_ms: ageMs };
  }

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
        if (now() - item.capturedAt > 2500 && accessibility && accessibility.available === true) {
          accessibility = { available: false, source: 'windows_uia', reason: 'snapshot_too_old_for_frame', truncated: false, node_count: accessibility.node_count ?? null };
        }
        const frame = {
          sequence: ++sequence,
          frame_id: safeText(captured.frame_id || '', 64),
          captured_at: new Date(item.capturedAt).toISOString(),
          capture_count_at_capture: captureCount,
          skipped_samples_at_capture: skippedSamples,
          screen,
          coordinate_system: {
            frame_id: safeText(captured.frame_id || '', 64),
            width_px: Number(screen.frame_width) || null,
            height_px: Number(screen.frame_height) || null,
            space: 'screenshot_jpeg_px', origin: 'top-left', x_axis: 'right', y_axis: 'down'
          },
          cursor: accessibility && accessibility.cursor || null,
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
          vision_status: typeof analyzeFrame === 'function' ? 'pending' : 'not_configured',
          vision_model: null,
          vision_completed_at: null,
          vision_error: null,
          vision: null,
          note: 'Image pixels stay local. Structured visual evidence is attached when passive model analysis completes; UI Automation and visual estimates remain separately attributed.'
        };
        frames.push(frame);
        if (frames.length > FRAME_LIMIT) frames = frames.slice(-FRAME_LIMIT);
        publicationRevision += 1;
        if (typeof analyzeFrame === 'function') {
          pendingVisionFrame = { sequence: frame.sequence, frameId: frame.frame_id, captured, screen, accessibility, epoch: item.epoch };
          void drainVisionQueue();
        }
        void publishLatestWhenDue();
      }
    } catch (error) {
      lastError = safeText(error && error.message || error || 'Observe context processing failed', 500);
    } finally {
      contextInFlight = false;
      if (pendingCapture && enabled && !disposed) void drainChangedCapture();
    }
  }

  async function drainVisionQueue() {
    if (visionInFlight || typeof analyzeFrame !== 'function' || !enabled || disposed) return;
    visionInFlight = true;
    try {
      while (pendingVisionFrame && enabled && !disposed) {
        const item = pendingVisionFrame;
        pendingVisionFrame = null;
        if (item.epoch !== observeEpoch) continue;
        const target = frames.find(frame => frame.sequence === item.sequence && frame.frame_id === item.frameId);
        if (!target) continue;
        const minInterval = lastVisionError ? PASSIVE_VISION_RETRY_INTERVAL_MS : PASSIVE_VISION_MIN_INTERVAL_MS;
        const delay = Math.max(0, minInterval - (now() - lastVisionAttemptAt));
        if (delay > 0) await sleep(delay);
        if (!enabled || disposed || item.epoch !== observeEpoch) break;
        const current = frames.find(frame => frame.sequence === item.sequence && frame.frame_id === item.frameId);
        if (!current) continue;
        lastVisionAttemptAt = now();
        latestVisionStatus = 'processing';
        current.vision_status = 'processing';
        publicationRevision += 1;
        void publishLatestWhenDue();
        try {
          const result = await analyzeFrame({
            captured: item.captured,
            frameId: item.frameId,
            screen: item.screen,
            accessibility: item.accessibility,
            waitMs: 120000
          });
          if (!enabled || disposed || item.epoch !== observeEpoch) break;
          const completedFrame = frames.find(frame => frame.sequence === item.sequence && frame.frame_id === item.frameId);
          if (!completedFrame) continue;
          let reportValue = null;
          if (result && result.status === 'report_available' && typeof result.report === 'string') {
            try { reportValue = JSON.parse(result.report); } catch {}
          }
          if (reportValue && result.input_image && result.input_image.frame_id === item.frameId &&
              reportValue.frame && reportValue.frame.width_px === item.screen.frame_width &&
              reportValue.frame.height_px === item.screen.frame_height) {
            const degraded = Boolean(reportValue.perception && reportValue.perception.degraded);
            completedFrame.vision_status = degraded ? 'degraded' : 'ready';
            completedFrame.vision_error = degraded
              ? safeText(reportValue.perception.error || result.model_error || 'Multimodal model unavailable; using OCR and Windows UI Automation evidence.', 500)
              : null;
            completedFrame.vision_model = safeText(result.model || 'SmolVLM2-2.2B-Instruct', 120);
            completedFrame.vision_completed_at = safeText(result.completed_at || new Date(now()).toISOString(), 40);
            completedFrame.vision = {
              schema_version: reportValue.schema_version || null,
              frame_id: item.frameId,
              coordinate_system: {
                space: 'screenshot_jpeg_px', origin: 'top-left', x_axis: 'right', y_axis: 'down',
                width_px: item.screen.frame_width, height_px: item.screen.frame_height
              },
              perception: reportValue.perception || { mode: 'multimodal_vision+ocr+uia', degraded: false },
              scene: reportValue.scene || null,
              regions: Array.isArray(reportValue.regions) ? reportValue.regions.slice(0, 10) : [],
              text_spans: Array.isArray(reportValue.text_spans) ? reportValue.text_spans.slice(0, 48) : [],
              controls: Array.isArray(reportValue.controls) ? reportValue.controls.slice(0, 32) : [],
              objects: Array.isArray(reportValue.objects) ? reportValue.objects.slice(0, 32) : [],
              focused_element: reportValue.focused_element || null,
              cursor: completedFrame.cursor || reportValue.cursor || null,
              ocr: reportValue.ocr && typeof reportValue.ocr === 'object'
                ? { available: reportValue.ocr.available === true, method: safeText(reportValue.ocr.method || '', 40),
                    reason: safeText(reportValue.ocr.reason || '', 100) || null,
                    text_spans: Array.isArray(reportValue.ocr.text_spans) ? reportValue.ocr.text_spans.slice(0, 64) : [] }
                : { available: false, text_spans: [] },
              interaction_guidance: {
                coordinate_frame_id: item.frameId,
                use_pixel_boxes: 'Use bbox_px from this exact frame and calculate center from its left/top/right/bottom edges; center_px is already derived locally.',
                source_priority: 'Use Windows UI Automation bounds where a target matches; otherwise visual estimates require confirmation.',
                stale_frame_rule: 'After any state-changing input, read the newest Observe frame before choosing the next coordinate.',
                ambiguity_rule: 'Do not click if target identity or box is ambiguous.'
              },
              evidence_policy: 'Windows UI Automation rectangles and native cursor position are system-derived; OCR text boxes are OCR-derived; visual-model rectangles remain estimates unless matched to UI Automation.'
            };
            lastVisionCompletedAt = now();
            latestVisionStatus = degraded ? 'degraded' : 'ready';
            lastVisionError = degraded ? completedFrame.vision_error : '';
          } else {
            const reason = result && (result.error || result.message) ||
              'Passive vision result was incomplete or did not match the observed frame ID and dimensions.';
            completedFrame.vision_status = 'unavailable';
            completedFrame.vision_error = safeText(reason, 500);
            completedFrame.vision_model = null;
            completedFrame.vision = null;
            lastVisionError = safeText(reason, 500);
            latestVisionStatus = 'unavailable';
          }
          publicationRevision += 1;
          void publishLatestWhenDue();
        } catch (error) {
          if (!enabled || disposed || item.epoch !== observeEpoch) break;
          const failedFrame = frames.find(frame => frame.sequence === item.sequence && frame.frame_id === item.frameId);
          if (failedFrame) {
            failedFrame.vision_status = 'unavailable';
            failedFrame.vision_error = safeText(error && error.message || error || 'Passive vision failed', 500);
            failedFrame.vision_model = null;
            failedFrame.vision = null;
            publicationRevision += 1;
            void publishLatestWhenDue();
          }
          lastVisionError = safeText(error && error.message || error || 'Passive vision failed', 500);
          latestVisionStatus = 'unavailable';
        }
      }
    } finally {
      visionInFlight = false;
      if (pendingVisionFrame && enabled && !disposed) void drainVisionQueue();
    }
  }

  async function captureOnce() {
    if (!enabled || disposed || inFlight) {
      skippedSamples += 1;
      return;
    }
    inFlight = true;
    try {
      const rawCaptured = await captureScreenshot();
      captureCount += 1;
      const capturedAt = Number(rawCaptured && rawCaptured.captured_at) || now();
      lastCaptureAt = capturedAt;
      const rawBytes = Buffer.isBuffer(rawCaptured) ? rawCaptured : rawCaptured && rawCaptured.bytes;
      if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0) throw new Error('Observe capture returned no image bytes.');
      const sourceFrameId = safeText(rawCaptured && rawCaptured.frame_id, 64);
      const captured = {
        ...(rawCaptured && typeof rawCaptured === 'object' && !Buffer.isBuffer(rawCaptured) ? rawCaptured : {}),
        bytes: rawBytes,
        captured_at: capturedAt,
        frame_id: sourceFrameId || crypto.createHash('sha256').update(rawBytes).digest('hex')
      };
      latestCapturedFrame = captured;
      const fingerprint = await fingerprintScreenshot(captured);
      // Prefer the real full-frame identity supplied by Electron. Lightweight test/alternate
      // capture providers can still use their explicit fingerprint to signal changed pixels.
      const frameChangeKey = sourceFrameId || fingerprint;
      if (!fingerprint || !frameChangeKey || frameChangeKey === lastFingerprint) return;
      lastFingerprint = frameChangeKey;
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
        await publish(true);
        publishedRevision = publicationRevision;
        lastError = '';
      } catch (error) {
        lastError = safeText(error && error.message || error || 'Observe FPS publish failed', 500);
        throw error;
      } finally {
        publishInFlight = false;
        if (enabled && !disposed && publicationRevision > publishedRevision) void publishLatestWhenDue();
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
      captureCount = 0;
      skippedSamples = 0;
      lastCaptureAt = null;
      lastChangeAt = null;
      latestCapturedFrame = null;
      pendingVisionFrame = null;
      lastVisionAttemptAt = 0;
      lastVisionCompletedAt = null;
      latestVisionStatus = typeof analyzeFrame === 'function' ? 'starting' : 'not_configured';
      lastVisionError = '';
      publicationRevision = 0;
      publishedRevision = 0;
      lastError = '';
      if (timer !== null) clearIntervalImpl(timer);
      timer = setIntervalImpl(() => { void captureOnce(); }, intervalForFps(sampleFps));
      // Serialize the initial status write with any frame publication.
      publishInFlight = true;
      try {
        await publish(true);
        publishedRevision = publicationRevision;
      } catch (error) {
        lastError = safeText(error && error.message || error, 500);
        enabled = false;
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        throw error;
      } finally {
        publishInFlight = false;
      }
      if (publicationRevision > publishedRevision) void publishLatestWhenDue();
      void captureOnce();
      return status();
    }

    enabled = false;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    frames = [];
    latestCapturedFrame = null;
    pendingCapture = null;
    pendingVisionFrame = null;
    latestVisionStatus = 'off';
    lastVisionError = '';
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
    latestCapturedFrame = null;
    pendingCapture = null;
    pendingVisionFrame = null;
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

  return { status, setEnabled, setFps, clearStaleContext, getLatestFrame, dispose };
}

module.exports = { createObserveService, OBSERVE_PROTOCOL, DEFAULT_SAMPLE_FPS, OBSERVE_FPS_OPTIONS, SAMPLE_INTERVAL_MS, PUBLISH_INTERVAL_MS, FRAME_LIMIT, intervalForFps };
