'use strict';

const test = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createVisionService,
  buildGaplessPlaybackScript,
  DIRECT_VISION_PROTOCOL,
  VISION_WORKER_API_VERSION,
  REQUIRED_VISION_FEATURES,
  TTS_PROTOCOL,
  TTS_VOICE,
  TTS_SPEAKER_ID,
  validateVisionContext,
  safeTunnelUrl,
  safeApiKey,
  parseTunnelEndpoint,
  scaleWavVolume
} = require('../desktop/colab-direct-service');

const API_KEY = 'a'.repeat(43);
const TUNNEL_HOST = 'https://direct-vision-test.trycloudflare.com';
const ENDPOINT = TUNNEL_HOST + '/' + API_KEY;
const serviceTestCalls = new WeakMap();

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function createVisionReport(width, height) {
  return {
    schema_version: 'windows-vision-context/v2',
    frame: { width_px: width, height_px: height, coordinate_space: 'screenshot_jpeg_px', origin: 'top-left' },
    scene: {
      summary: 'A test window is visible.',
      active_application: 'Test window',
      window_title: 'Test window',
      screen_type: 'desktop',
      current_state: 'Idle test screen.',
      visible_dialogs: [],
      task_relevant_facts: ['The primary test window is visible.'],
      uncertainties: ['Small text may be unreadable.']
    },
    regions: [{ id: 'r1', label: 'main window', purpose: 'Primary visible interface', bbox_1000: [0, 0, 1000, 1000], bbox_px: [0, 0, width, height] }],
    text_spans: [{ text: 'Test window', region_id: 'r1', kind: 'heading', bbox_1000: [10, 10, 200, 80], bbox_px: [Math.floor(width * 0.01), Math.floor(height * 0.01), Math.floor(width * 0.2), Math.floor(height * 0.08)] }],
    controls: [{
      id: 'c1', label: 'OK', role: 'button', region_id: 'r1', bbox_1000: [100, 100, 250, 180],
      bbox_px: [Math.floor(width * 0.1), Math.floor(height * 0.1), Math.floor(width * 0.25), Math.floor(height * 0.18)],
      center_px: [999, 999], coordinate_source: 'vision_estimate', state: 'enabled',
      relation: 'In the main window', targetability: 'clear', position_verification: 'unverified_visual_estimate'
    }],
    objects: [],
    perception: { mode: 'multimodal_vision+ocr+uia', degraded: false, error: null },
    focused_element: null,
    cursor: { visible: false, bbox_1000: null, bbox_px: null, location: 'Not confidently visible.' },
    accessibility: { available: false, source: 'windows_uia', reason: 'not_available', active_window: null, focused_control: null, controls: [], truncated: false, node_count: 0 },
    ocr: { available: false, method: 'tesseract', reason: 'ocr_unavailable', text_spans: [] },
    limitations: ['Visual target positions are estimates and have not been independently verified.']
  };
}


function fixture(options = {}) {
  let state = {
    protocol: DIRECT_VISION_PROTOCOL,
    vision_worker_api_version: 5,
    features: ['passive-smolvlm2', 'detailed-qwen', 'frame-id-validation', 'tts-piper-libritts-high', 'passive-vision-capability-validation', 'coordinate-rich-context-v2', 'ocr-accessibility-fallback', 'tts-chunked-playback', 'unicode-speech-normalization', 'expanded-observe-context-v3', 'passive-latest-frame-scheduling', 'safe-http-request-bodies', 'tts-streamed-prefetch', 'tts-server-synthesis-metrics-v1'],
    tts_ready: true,
    tts_model_loaded: true,
    tts_error: null,
    tts_voice: 'en_US-libritts-high',
    tts_speaker_id: 0,
    tts_sample_rate: 22050,
    passive_model_loaded: true,
    detailed_model_parked: true,
    status: 'inactive',
    enabled: false,
    model_loaded: false,
    heartbeat_at: new Date().toISOString(),
    model: 'test-model',
    gpu: 'Test GPU',
    vram_mib: 16384
  };
  let clipboardText = options.initialClipboard || '';
  let latestPassiveFrame = options.latestFrame || null;
  const calls = [];
  const inputCalls = [];
  let ttsRequestCount = 0;
  let activeTtsRequests = 0;
  let maxActiveTtsRequests = 0;
  const asyncResults = new Map();
  const inputControl = {
    run: async (steps, frame) => { inputCalls.push({ steps, frame }); return { status: 'input_completed', actions_executed: steps.length, coordinate_frame: frame }; },
    releaseAll: async () => ({ released: 0 }),
    dispose: async () => {}
  };
  const mailbox = {
    getState: () => ({ configured: true, runtimePath: 'C:\\OneDrive\\Bridge\\runtime', transport: 'onedrive-synced-folder' }),
    async readJson(relativePath) {
      if (relativePath !== 'bridge/state/windows-app.json') return null;
      return {
        value: { protocol: 'chatgpt-local-repo-state/v1', status: 'idle' },
        sha: 'state-sha256'
      };
    }
  };
  const service = createVisionService({
    mailbox,
    getSettings: () => ({ repositoryBridge: { oneDrivePath: 'C:\\OneDrive\\Bridge\\runtime' } }),
    getWorkspaceRoot: () => '',
    captureScreenshot: async () => ({
      bytes: Buffer.from('desktop-source-image'), filename: 'desktop.png',
      ...(Number.isFinite(options.capturedAt) ? { captured_at: options.capturedAt } : {})
    }),
    getAccessibleSnapshot: options.getAccessibleSnapshot,
    getLatestFrame: maxAgeMs => {
      if (!latestPassiveFrame) return null;
      const ageMs = Math.max(0, Date.now() - Number(latestPassiveFrame.captured_at || 0));
      return ageMs <= maxAgeMs ? { ...latestPassiveFrame, age_ms: ageMs } : null;
    },
    encodeJpeg: async bytes => ({ bytes: Buffer.from('compressed-jpeg-' + bytes.toString()), width: 640, height: 360, quality: 72 }),
    openColabNotebook: async url => { calls.push({ type: 'opened_colab', url }); return { opened: true }; },
    readClipboardText: () => clipboardText,
    inputControl,
    playAudio: options.playAudio,
    clipboardPollIntervalMs: options.clipboardPollIntervalMs || 5,
    clipboardWatchTimeoutMs: options.clipboardWatchTimeoutMs || 2000,
    pollIntervalMs: 10,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      if (options.failHost && parsed.hostname === options.failHost) {
        throw new Error('test endpoint unavailable');
      }
      const prefix = '/' + API_KEY;
      const route = parsed.pathname.startsWith(prefix + '/') ? parsed.pathname.slice(prefix.length) : parsed.pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({
        type: 'direct_http',
        method: init.method || 'GET',
        path: parsed.pathname,
        route,
        authorization: init.headers && init.headers.Authorization,
        body
      });
      if (route === '/health') {
        if (options.healthDelayMs) await new Promise(resolve => setTimeout(resolve, options.healthDelayMs));
        if (options.healthStatus) {
          return { ok: false, status: options.healthStatus, json: async () => { throw new Error('non-JSON tunnel error page'); } };
        }
        return response(200, { ...state, heartbeat_at: new Date().toISOString() });
      }
      if (route === '/registration/ack') {
        if (options.failRegistrationAck) return response(503, { protocol: DIRECT_VISION_PROTOCOL, error: 'test HTTPS acknowledgement failure' });
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, desktop_registered: true });
      }
      if (route === '/activate') {
        state = { ...state, status: 'ready', enabled: true, model_loaded: true, passive_model_loaded: true, detailed_model_parked: true };
        return response(202, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: true });
      }
      if (route === '/deactivate') {
        state = { ...state, status: 'inactive', enabled: false };
        return response(200, { protocol: DIRECT_VISION_PROTOCOL, accepted: true, enabled: false, runtime_kept_alive: true });
      }
      if (route === '/tts/stream') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const emit = record => controller.enqueue(encoder.encode(JSON.stringify(record) + '\n'));
            emit({
              protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
              request_id: body.request_id, status: 'stream_started',
              chunks_total: body.chunks.length, voice: 'en_US-libritts-high', speaker_id: 0
            });
            for (const chunk of body.chunks) {
              ttsRequestCount += 1;
              activeTtsRequests += 1;
              maxActiveTtsRequests = Math.max(maxActiveTtsRequests, activeTtsRequests);
              try {
                if (options.ttsDelayMs) await new Promise(resolve => setTimeout(resolve, options.ttsDelayMs));
                if (options.failTtsRequestAt === ttsRequestCount) {
                  emit({
                    protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
                    request_id: body.request_id, status: 'failed',
                    failed_chunk_request_id: chunk.request_id, chunks_total: body.chunks.length,
                    error: 'Injected test-only failure for background Piper chunk.'
                  });
                  controller.close();
                  return;
                }
                const audio = Buffer.alloc(48);
                audio.write('RIFF', 0, 'ascii'); audio.writeUInt32LE(40, 4); audio.write('WAVE', 8, 'ascii');
                audio.write('fmt ', 12, 'ascii'); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20);
                audio.writeUInt16LE(1, 22); audio.writeUInt32LE(22050, 24); audio.writeUInt32LE(44100, 28);
                audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36, 'ascii');
                audio.writeUInt32LE(4, 40);
                const audioHash = require('node:crypto').createHash('sha256').update(audio).digest('hex');
                emit({
                  protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
                  batch_request_id: body.request_id, request_id: chunk.request_id,
                  status: 'completed', voice: 'en_US-libritts-high', speaker_id: 0,
                  sample_rate: 22050, channels: 1, duration_seconds: 0.001,
                  content_type: 'audio/wav', audio_bytes: audio.length,
                  audio_sha256: audioHash, audio_base64: audio.toString('base64')
                });
              } finally {
                activeTtsRequests -= 1;
              }
            }
            emit({
              protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
              request_id: body.request_id, status: 'completed', chunks_total: body.chunks.length
            });
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
      }
      if (route === '/tts') {
        ttsRequestCount += 1;
        activeTtsRequests += 1;
        maxActiveTtsRequests = Math.max(maxActiveTtsRequests, activeTtsRequests);
        try {
          if (options.ttsDelayMs) await new Promise(resolve => setTimeout(resolve, options.ttsDelayMs));
          // These are test-only HTTP failures; real production code never uses this injection.
          if (options.malformedTtsRequestAt === ttsRequestCount) {
            return response(400, { error: 'Malformed JSON' });
          }
          if (options.failTtsRequestAt === ttsRequestCount) {
            return response(options.failTtsStatus || 503, {
              protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
              request_id: body.request_id, status: 'error',
              error: 'Injected test-only failure for background Piper chunk.'
            });
          }
          const audio = Buffer.alloc(48);
          audio.write('RIFF', 0, 'ascii'); audio.writeUInt32LE(40, 4); audio.write('WAVE', 8, 'ascii');
          audio.write('fmt ', 12, 'ascii'); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20);
          audio.writeUInt16LE(1, 22); audio.writeUInt32LE(22050, 24); audio.writeUInt32LE(44100, 28);
          audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36, 'ascii');
          audio.writeUInt32LE(4, 40);
          const audioHash = require('node:crypto').createHash('sha256').update(audio).digest('hex');
          return response(200, {
            protocol: DIRECT_VISION_PROTOCOL, tts_protocol: 'piper-libritts-tts/v1',
            request_id: body.request_id, status: 'completed', voice: 'en_US-libritts-high',
            speaker_id: 0, sample_rate: 22050, channels: 1, duration_seconds: 0.001,
            content_type: 'audio/wav', audio_bytes: audio.length, audio_sha256: audioHash,
            audio_base64: audio.toString('base64')
          });
        } finally {
          activeTtsRequests -= 1;
        }
      }
      if (route.startsWith('/result/')) {
        const requestId = route.slice('/result/'.length);
        const pending = asyncResults.get(requestId);
        if (!pending) return response(404, { error: 'unknown test result request' });
        if (Date.now() < pending.readyAt) {
          return response(202, {
            protocol: DIRECT_VISION_PROTOCOL, request_id: requestId, status: 'processing',
            input_sha256: pending.result.input_sha256, input_frame_id: pending.result.input_frame_id,
            model_role: pending.result.model_role, poll_after_ms: 5
          });
        }
        return response(200, pending.result);
      }
      if (route === '/analyze') {
        if (options.analyzeDelayMs) {
          await new Promise(resolve => setTimeout(resolve, options.analyzeDelayMs));
        }
        const result = {
          protocol: 'chatgpt-colab-vision-result/v1',
          request_id: body.request_id,
          status: 'completed',
          input_sha256: body.sha256,
          input_frame_id: body.frame_id,
          model_role: body.model_role || 'detailed',
          model: body.model_role === 'passive' ? 'SmolVLM2-2.2B-Instruct' : 'test-model',
          model_repository: 'test-model-repo',
          inference_ms: 75,
          completed_at: new Date().toISOString(),
          report: JSON.stringify(createVisionReport(640, 360))
        };
        if (options.asyncAnalyze) {
          asyncResults.set(body.request_id, {
            readyAt: Date.now() + (options.asyncAnalyzeDelayMs || 35),
            result
          });
          return response(202, {
            protocol: DIRECT_VISION_PROTOCOL, request_id: body.request_id, status: 'processing',
            input_sha256: body.sha256, input_frame_id: body.frame_id,
            model_role: body.model_role || 'detailed', poll_after_ms: 5
          });
        }
        return response(200, result);
      }
      return response(404, { error: 'not found' });
    }
  });
  serviceTestCalls.set(service, calls);
  return {
    service, calls, inputCalls,
    getMaxActiveTtsRequests: () => maxActiveTtsRequests,
    getState: () => state,
    setState: patch => { state = { ...state, ...patch }; },
    setClipboard: value => { clipboardText = value; },
    getClipboard: () => clipboardText,
    setLatestFrame: value => { latestPassiveFrame = value; }
  };
}

async function waitForConnected(service) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const status = await service.status();
    if (status.connection_registered && status.runtime_fresh) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Windows app did not connect to the detected public endpoint');
}

async function openAndPublishEndpoint(f, endpoint = ENDPOINT) {
  const result = await f.service.connectColab();
  assert.equal(result.status, 'waiting_for_runtime');
  assert.equal(result.opened, true);
  assert.equal(result.endpoint_watch_active, true);
  const openedUrl = f.calls.find(call => call.type === 'opened_colab')?.url;
  assert.equal(openedUrl, 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb');
  f.setClipboard(endpoint);
  return waitForConnected(f.service);
}

test('Colab vision notebook uses a 16,384-token context and reports the configured window', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const pythonSource = (notebook.cells || [])
    .filter(cell => cell.cell_type === 'code' && Array.isArray(cell.source))
    .map(cell => cell.source.join(''))
    .join('\n');

  assert.match(pythonSource, /VISION_CONTEXT_TOKENS = 16384/);
  assert.match(pythonSource, /PASSIVE_CONTEXT_TOKENS = 8192/);
  assert.match(pythonSource, /PASSIVE_MAX_OUTPUT_TOKENS = 1400/);
  assert.match(pythonSource, /model_predict = PASSIVE_MAX_OUTPUT_TOKENS if model_role == "passive" else DETAILED_MAX_OUTPUT_TOKENS/);
  assert.ok(pythonSource.includes('PASSIVE_MODEL_REPO = "ahmadwaqar/smolvlm2-2.2b-instruct"'));
  assert.ok(pythonSource.includes('PASSIVE_MODEL = "ahmadwaqar/smolvlm2-2.2b-instruct:latest"'));
  assert.ok(!pythonSource.includes('PASSIVE_MODEL = "richardyoung/smolvlm2-2.2b-instruct:Q4_K_M"'));
  assert.match(pythonSource, /PARKED_QWEN_MODEL = "bridge-qwen3-vl-4b-parked:latest"/);
  assert.match(pythonSource, /options = \{"num_ctx": int\(context_tokens\), "num_predict": 1\}/);
  assert.match(pythonSource, /context_tokens=VISION_CONTEXT_TOKENS/);
  assert.match(pythonSource, /context_tokens=PASSIVE_CONTEXT_TOKENS/);
  assert.match(pythonSource, /MODEL_MAX_EDGE = 16384/);
  assert.match(pythonSource, /OLLAMA_SWAP_FILE = Path\("\/content\/bridge-qwen-pagefile\.swap"\)/);
  assert.match(pythonSource, /"keep_alive": -1 if model_role == "passive" else 0/);
  assert.match(pythonSource, /"input_frame_id": input_frame_id/);
  assert.doesNotMatch(pythonSource, /"num_ctx": 4096/);
  assert.match(pythonSource, /"context_window_tokens": VISION_CONTEXT_TOKENS/);
});

test('Colab serves long vision inference asynchronously through a matching result ID', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const pythonSource = (notebook.cells || [])
    .filter(cell => cell.cell_type === 'code' && Array.isArray(cell.source))
    .map(cell => cell.source.join(''))
    .join('\n');

  assert.match(pythonSource, /def _run_vision_job\(body\):/);
  assert.match(pythonSource, /route is not None and route\.startswith\("\/result\/"\)/);
  assert.match(pythonSource, /threading\.Thread\([\s\S]*target=_run_vision_job/);
  assert.match(pythonSource, /MAX_ACTIVE_VISION_JOBS = 8/);
  assert.match(pythonSource, /MAX_RETAINED_VISION_RESULTS = 32/);
  assert.match(pythonSource, /current_status == "processing" and current_stage == "queued"/);
  assert.match(pythonSource, /publish_runtime\(\s*"processing", stage="detailed_inference"/);
  assert.match(pythonSource, /"status": "processing"/);
});

test('endpoint validation accepts only HTTPS Quick Tunnel URLs with a secret path token', () => {
  assert.equal(safeTunnelUrl(ENDPOINT), ENDPOINT);
  assert.deepEqual(parseTunnelEndpoint(ENDPOINT), { url: ENDPOINT, apiKey: API_KEY });
  assert.equal(safeTunnelUrl(TUNNEL_HOST), null);
  assert.equal(safeTunnelUrl('http://direct-vision-test.trycloudflare.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl('https://example.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl('https://user:pass@direct-vision-test.trycloudflare.com/' + API_KEY), null);
  assert.equal(safeTunnelUrl(TUNNEL_HOST + '/' + API_KEY + '/extra'), null);
  assert.equal(safeTunnelUrl(ENDPOINT + '?other=value'), null);
  assert.equal(safeApiKey(API_KEY), true);
  assert.equal(safeApiKey('short'), false);
});

test('manual endpoint paste connects directly without opening Colab or using the clipboard', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab(ENDPOINT);
  assert.equal(result.connected, true);
  assert.equal(result.manually_entered, true);
  assert.equal(result.connection_registered, true);
  assert.equal(result.status, 'starting');
  assert.equal(result.enabled, true);
  assert.equal(result.vision_activated, true);
  assert.equal(result.model_loaded, false, 'connect returns promptly while model loading continues');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate' && call.method === 'POST'));
  assert.equal(result.endpoint_watch_active, false);
  assert.equal(f.calls.some(call => call.type === 'opened_colab'), false);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'));
});

test('manual endpoint paste accepts the printed PUBLIC_VISION_ENDPOINT line and rejects other hosts', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab('PUBLIC_VISION_ENDPOINT=' + ENDPOINT);
  assert.equal(result.connected, true);
  assert.equal(result.manually_entered, true);
  assert.equal(f.calls.some(call => call.type === 'opened_colab'), false);

  const invalid = fixture();
  t.after(() => invalid.service.dispose());
  const rejected = await invalid.service.connectColab('https://example.com/' + API_KEY);
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.connected, false);
  assert.match(rejected.message, /not a valid Colab endpoint/);
  assert.equal(invalid.calls.some(call => call.type === 'direct_http'), false);
});

test('Connect Colab watches the clipboard and connects when the notebook copies its public endpoint', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const status = await openAndPublishEndpoint(f);
  assert.equal(status.connection_registered, true);
  assert.equal(status.status, 'ready');
  assert.equal(status.enabled, true);
  assert.equal(status.model_loaded, true);
  assert.equal(status.transport, 'direct_https_tunnel');
  assert.equal(f.service.constants.COLAB_NOTEBOOK_URL, 'https://colab.research.google.com/github/hashin9973-ux/idk/blob/main/vision/vision_worker.ipynb');
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health' && call.method === 'GET'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack' && call.method === 'POST'));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.authorization === 'Bearer ' + API_KEY));
  assert.ok(f.calls.filter(call => call.type === 'direct_http').every(call => call.path.startsWith('/' + API_KEY + '/')));
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('the app verifies a valid endpoint already on the clipboard after explicit Connect Colab', async t => {
  const f = fixture({ initialClipboard: 'PUBLIC_VISION_ENDPOINT=' + ENDPOINT });
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab();
  assert.equal(result.endpoint_watch_active, true);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
  assert.equal(connected.runtime_fresh, true);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/health'));
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'));
});

test('the watcher continues after a stale clipboard endpoint fails verification', async t => {
  const stale = 'https://stale-vision-test.trycloudflare.com/' + API_KEY;
  const f = fixture({ initialClipboard: stale, failHost: 'stale-vision-test.trycloudflare.com' });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  await new Promise(resolve => setTimeout(resolve, 30));
  const waiting = await f.service.status();
  assert.equal(waiting.connection_registered, false);
  assert.equal(waiting.status, 'waiting_for_endpoint');
  assert.match(waiting.message, /test endpoint unavailable/);
  f.setClipboard('PUBLIC_VISION_ENDPOINT=' + ENDPOINT);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
});

test('the app refuses a clipboard endpoint that does not contain the secret path key', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(TUNNEL_HOST);
  await new Promise(resolve => setTimeout(resolve, 30));
  const status = await f.service.status();
  assert.equal(status.connection_registered, false);
  assert.equal(f.calls.some(call => call.type === 'direct_http'), false);
});

test('status exposes the endpoint-validation phase while the HTTPS request is in flight', async t => {
  const f = fixture({ healthDelayMs: 100 });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  const deadline = Date.now() + 1000;
  let checking = null;
  while (Date.now() < deadline) {
    const status = await f.service.status();
    if (status.status === 'checking_endpoint') { checking = status; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(checking, 'status should report endpoint validation while it is running');
  assert.equal(checking.endpoint_test_in_progress, true);
  assert.match(checking.message, /Testing the authenticated HTTPS health response/);
  const connected = await waitForConnected(f.service);
  assert.equal(connected.connection_registered, true);
});

test('status reports the real HTTP status when the Colab tunnel returns a non-JSON error page', async t => {
  const f = fixture({ healthStatus: 530 });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  const deadline = Date.now() + 1500;
  let status;
  while (Date.now() < deadline) {
    status = await f.service.status();
    if (status.message && /HTTP 530/.test(status.message)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(status && /HTTP 530/.test(status.message), 'the failed endpoint check should surface HTTP 530');
  assert.equal(status.endpoint_watch_active, true);
  assert.equal(status.runtime_fresh, false);
  assert.match(status.message, /Last detection attempt:.*HTTP 530/);
});

test('the clipboard watcher reports an actionable timeout and stops watching', async t => {
  const f = fixture({ clipboardWatchTimeoutMs: 35, clipboardPollIntervalMs: 5 });
  t.after(() => f.service.dispose());
  const result = await f.service.connectColab();
  assert.equal(result.endpoint_watch_active, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  const status = await f.service.status();
  assert.equal(status.endpoint_watch_active, false);
  assert.equal(status.endpoint_test_in_progress, false);
  assert.match(status.message, /Timed out waiting for the notebook to hand off its public HTTPS endpoint/);
  assert.match(status.message, /Check that Windows Repository Bridge is installed/i);
});

test('connection fails safely when the server-to-server acknowledgement is unsuccessful', async t => {
  const f = fixture({ failRegistrationAck: true });
  t.after(() => f.service.dispose());
  await f.service.connectColab();
  f.setClipboard(ENDPOINT);
  await new Promise(resolve => setTimeout(resolve, 50));
  const status = await f.service.status();
  assert.equal(status.connection_registered, false);
  assert.equal(status.runtime_fresh, false);
  assert.match(status.message, /Could not connect to the detected Colab endpoint/);
});

test('activation and deactivation are explicit and deactivation never shuts down Colab', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  const activated = await f.service.activate({}, 'activation-1');
  assert.equal(activated.status, 'ready');
  assert.equal(activated.enabled, true);
  assert.equal(activated.model_loaded, true);
  const deactivated = await f.service.deactivate({}, 'deactivation-1');
  assert.equal(deactivated.status, 'inactive');
  assert.equal(deactivated.runtime_kept_alive, true);
  assert.equal(deactivated.runtime_shutdown_attempted, undefined);
  assert.equal(f.getState().model_loaded, true);
});

test('screenshot bytes upload directly to the Colab endpoint and its report returns to the app', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.status, 'report_available');
  assert.match(result.report, /A test window is visible/);
  assert.equal(result.input_sha256, result.input_image.sha256);
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.ok(analyzeCall);
  assert.equal(result.input_image.frame_id, analyzeCall.body.frame_id);
  assert.equal(analyzeCall.body.protocol, DIRECT_VISION_PROTOCOL);
  assert.equal(analyzeCall.body.sha256, result.input_sha256);
  assert.ok(typeof analyzeCall.body.image_base64 === 'string');
  assert.match(analyzeCall.body.prompt, /Screenshot frame: 640x360/);
  assert.equal(result.input_image.width, 640);
  assert.equal(result.input_image.height, 360);
  const report = JSON.parse(result.report);
  assert.equal(report.schema_version, 'windows-vision-context/v2');
  assert.equal(report.frame.width_px, 640);
  assert.deepEqual(report.controls[0].center_px, [
    (report.controls[0].bbox_px[0] + report.controls[0].bbox_px[2]) / 2,
    (report.controls[0].bbox_px[1] + report.controls[0].bbox_px[3]) / 2
  ], 'centers must be recalculated from the validated bounding boxes');
  assert.match(analyzeCall.body.prompt, /Screenshot frame: 640x360/);
  assert.equal(analyzeCall.body.frame.coordinate_space, 'screenshot_jpeg_px');
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.accessibility.available, false);
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('passive Smol vision can analyze the exact Observe frame while detailed Qwen is busy', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-passive-analysis');

  const frameId = 'c'.repeat(64);
  const capturedAt = Date.now();
  f.setLatestFrame({
    frame_id: frameId, bytes: Buffer.from('desktop-source-image'),
    width: 640, height: 360, screen_width: 640, screen_height: 360,
    captured_at: capturedAt, display_id: 'primary'
  });
  f.setState({
    status: 'processing', enabled: true, model_loaded: true,
    passive_model_loaded: true, detailed_model_parked: true,
    detailed_model_loaded: true, active_request_id: 'computer-' + 'd'.repeat(24)
  });

  const result = await f.service.analyzeFrame({
    frameId,
    captured: {
      frame_id: frameId, bytes: Buffer.from('desktop-source-image'),
      width: 640, height: 360, screen_width: 640, screen_height: 360,
      captured_at: capturedAt, display_id: 'primary'
    },
    screen: { width: 640, height: 360, frame_width: 640, frame_height: 360, display_id: 'primary' },
    accessibility: { available: false, source: 'windows_uia', reason: 'not_available', controls: [] },
    waitMs: 1000
  });
  assert.equal(result.status, 'report_available');
  assert.equal(result.model_role, 'passive');
  assert.equal(result.model, 'SmolVLM2-2.2B-Instruct');
  assert.equal(result.input_image.frame_id, frameId);
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.equal(analyzeCall.body.model_role, 'passive');
  assert.equal(analyzeCall.body.frame_id, frameId);
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.frame.height_px, 360);
});

test('mouse input accepts a fresh matching passive frame and rejects a mismatched frame ID', async t => {
  const frameId = 'e'.repeat(64);
  const f = fixture({ latestFrame: {
    frame_id: frameId, width: 640, height: 360,
    captured_at: Date.now(), age_ms: 0
  } });
  t.after(() => f.service.dispose());

  const accepted = await f.service.inputAction({
    action: 'click', x: 100, y: 80, frame_id: frameId
  }, 'computer-' + '1'.repeat(24));
  assert.equal(accepted.status, 'input_completed');
  assert.equal(f.inputCalls.length, 1);
  assert.equal(f.inputCalls[0].frame.frame_id, frameId);
  assert.equal(f.inputCalls[0].frame.width, 640);

  const rejected = await f.service.inputAction({
    action: 'click', x: 100, y: 80, frame_id: 'f'.repeat(64)
  }, 'computer-' + '2'.repeat(24));
  assert.equal(rejected.status, 'error');
  assert.match(rejected.error, /does not match a fresh passive Observe frame/i);
  assert.equal(f.inputCalls.length, 1, 'mismatched frame IDs must be rejected before local input');
});

test('a screenshot wait timeout returns pending and the same request ID can be resumed', async t => {
  const f = fixture({ analyzeDelayMs: 80 });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-pending-timeout');

  const pending = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 0 }, 'timeout-case');
  assert.equal(pending.status, 'inference_in_progress');
  assert.equal(pending.pending, true);
  assert.match(pending.request_id, /^computer-[a-f0-9]{24}$/);
  assert.ok(pending.input_image && pending.input_image.sha256);
  const requestId = pending.request_id;

  await new Promise(resolve => setTimeout(resolve, 100));
  const completed = await f.service.wait({ request_id: requestId, waitMs: 1000 });
  assert.equal(completed.status, 'report_available');
  assert.equal(completed.request_id, requestId);
});

test('asynchronous Colab inference is polled by the same ID and returns a validated report', async t => {
  const f = fixture({ asyncAnalyze: true, asyncAnalyzeDelayMs: 40 });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-async-analysis');

  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'async-analysis-case');
  assert.equal(result.status, 'report_available');
  assert.match(result.request_id, /^computer-[a-f0-9]{24}$/);
  assert.equal(result.input_sha256, result.input_image.sha256);
  const requestId = result.request_id;
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/result/' + requestId));
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/analyze').length, 1,
    'the screenshot is submitted exactly once even when polling');
});

test('coordinate input refuses to act without a live desktop screenshot frame', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.inputAction({ action: 'click', x: 100, y: 100 }, 'computer-111111111111111111111111');
  assert.equal(result.status, 'error');
  assert.match(result.error, /fresh live desktop screenshot/i);
  assert.equal(f.inputCalls.length, 0, 'no local input should be sent without a live screenshot frame');
});

test('focused screenshot observation crops only within the screenshot frame and keeps the output frame explicit', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-focused-observation');
  const result = await f.service.analyzeScreenshot({
    source: 'desktop',
    region: [80, 40, 400, 300],
    prompt: 'Inspect the dialog and describe the important controls.'
  }, 'computer-eeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.deepEqual(analyzeCall.body.region_px, [80, 40, 400, 300]);
  assert.match(analyzeCall.body.prompt, /Original screenshot frame: 640x360/);
  assert.match(analyzeCall.body.prompt, /Return normalized boxes relative to the image shown/);
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.frame.height_px, 360);
});

test('focused observation rejects an invalid or too-small crop before uploading', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-invalid-focused-observation');
  const result = await f.service.analyzeScreenshot({
    source: 'desktop', region: [0, 0, 20, 20]
  }, 'computer-ffffffffffffffffffffffff');
  assert.equal(result.status, 'error');
  assert.match(result.error, /at least 48×48 pixels/i);
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/analyze'), false);
});

test('fresh Windows accessibility bounds are sent with the exact screenshot frame', async t => {
  const f = fixture({
    getAccessibleSnapshot: async ({ screen, frame }) => ({
      available: true, source: 'windows_uia',
      active_window: { title: 'Test app', process_id: 42, bbox_px: [0, 0, frame.width, frame.height], bbox_1000: [0, 0, 1000, 1000] },
      focused_control: null,
      controls: [{
        id: 'uia-1', label: 'OK', role: 'Button', enabled: true, focused: false,
        bbox_px: [100, 100, 200, 140], bbox_1000: [156, 278, 313, 389],
        center_px: [150, 120], source: 'windows_uia', grounding: 'windows_accessibility_bounds'
      }],
      truncated: false, node_count: 4,
      received_screen: screen, received_frame: frame
    })
  });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-uia-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-cccccccccccccccccccccccc');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.equal(analyzeCall.body.accessibility.available, true);
  assert.equal(analyzeCall.body.accessibility.controls[0].source, 'windows_uia');
  assert.deepEqual(analyzeCall.body.accessibility.controls[0].bbox_px, [100, 100, 200, 140]);
  assert.equal(analyzeCall.body.frame.width_px, 640);
  assert.equal(analyzeCall.body.frame.height_px, 360);
});

test('stale accessibility snapshots are not attached to a newer screenshot', async t => {
  const f = fixture({
    capturedAt: Date.now() - 6000,
    getAccessibleSnapshot: async ({ frame }) => ({
      available: true, active_window: null, focused_control: null, controls: [],
      truncated: false, node_count: 0, frame
    })
  });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-stale-uia-analysis');
  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-dddddddddddddddddddddddd');
  assert.equal(result.status, 'report_available');
  const analyzeCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/analyze');
  assert.equal(analyzeCall.body.accessibility.available, false);
  assert.equal(analyzeCall.body.accessibility.reason, 'snapshot_too_old_for_frame');
});

test('setup check verifies OneDrive mailbox separately and requires no Colab secret', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  const result = await f.service.setupCheck();
  assert.equal(result.checks.onedrive.status, 'passed');
  assert.equal(result.checks.mailbox.status, 'passed');
  assert.equal(result.checks.colab.status, 'passed');
  assert.equal(result.checks.model.status, 'passed');
  assert.ok(result.next_steps.every(step => !/QDQWG_TOKEN|Colab Secret|fine-grained token/i.test(step)));
});

test('successful Colab connection activates the model automatically and supports batched local input with observation', async t => {
  const f = fixture({ analyzeDelayMs: 50 });
  t.after(() => f.service.dispose());
  const connected = await f.service.connectColab(ENDPOINT);
  assert.equal(connected.connected, true);
  assert.equal(connected.enabled, true);
  assert.equal(connected.vision_activated, true);
  assert.equal(connected.model_loaded, false);
  assert.ok(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'));

  const initialObservation = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 1000 }, 'computer-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(initialObservation.status, 'report_available');

  const started = await f.service.inputAction({ action: 'start_control' }, 'control-1');
  assert.equal(started.status, 'control_ready');
  assert.equal(f.service.isControlSessionActive(), true);
  const sequence = await f.service.inputAction({
    action: 'sequence',
    steps: [
      { type: 'hotkey', keys: ['CTRL', 'S'] },
      { type: 'click', x: 120, y: 80, button: 'right' }
    ],
    observe: true,
    waitMs: 1000
  }, 'computer-bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(sequence.status, 'input_completed');
  assert.equal(sequence.observation.status, 'report_available');
  assert.equal(f.inputCalls[0].frame.width, 640);
  assert.equal(f.inputCalls[0].frame.height, 360);
  assert.equal(f.inputCalls[0].frame.source, 'desktop');
  assert.equal(f.inputCalls[0].steps.length, 2);

  const analysisCallsBeforeFast = f.calls.filter(call => call.type === 'direct_http' && call.route === '/analyze').length;
  const fastSequence = await f.service.inputAction({
    action: 'sequence', mode: 'fast',
    steps: [{ type: 'press', key: 'ENTER' }]
  }, 'computer-fast-sequence');
  assert.equal(fastSequence.status, 'input_completed');
  assert.equal(fastSequence.interaction_mode, 'fast');
  assert.equal(fastSequence.observation, undefined, 'fast mode skips follow-up vision unless explicitly requested');
  assert.equal(f.inputCalls[1].steps.length, 1);
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/analyze').length, analysisCallsBeforeFast,
    'fast mode should not create another Colab inference round trip by default');

  const pendingSequence = await f.service.inputAction({
    action: 'sequence', mode: 'fast', observe: true, waitMs: 0,
    steps: [{ type: 'press', key: 'ESC' }]
  }, 'computer-cccccccccccccccccccccccc');
  assert.equal(pendingSequence.status, 'input_completed');
  assert.equal(pendingSequence.observation.status, 'inference_in_progress');
  assert.ok(pendingSequence.observation.request_id);
  assert.match(pendingSequence.message, /same request_id/);
  assert.match(pendingSequence.message, /do not repeat it/);
  const resumedObservation = await f.service.wait({
    request_id: pendingSequence.observation.request_id, waitMs: 1000
  });
  assert.equal(resumedObservation.status, 'report_available');
  assert.equal(resumedObservation.request_id, pendingSequence.observation.request_id);

  const stopped = await f.service.inputAction({ action: 'stop_control' });
  assert.equal(stopped.status, 'control_stopped');
  assert.equal(f.service.isControlSessionActive(), false);
});

test('notebook output JavaScript attempts direct app handoff with clipboard copy as fallback', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  const marker = 'js = r"""';
  const start = source.indexOf(marker);
  const end = source.indexOf('""".replace("__ENDPOINT__", json.dumps(endpoint_url))', start);
  assert.ok(start >= 0 && end > start, 'endpoint clipboard script template must be extractable');
  const browserSource = source.slice(start + marker.length, end).replaceAll('__ENDPOINT__', JSON.stringify(ENDPOINT));
  assert.doesNotMatch(browserSource, /__ENDPOINT__/);
  assert.doesNotThrow(() => new vm.Script(browserSource), 'browser clipboard script must parse');
  assert.match(browserSource, /navigator\.clipboard\.writeText/);
  assert.ok(browserSource.includes('Copy endpoint (fallback)'));
  assert.ok(browserSource.includes('Connect to Windows Bridge'));
  assert.ok(browserSource.includes('windows-repository-bridge://connect-colab?endpoint='));
  assert.ok(browserSource.includes('http://127.0.0.1:43817/handoff'));
  assert.ok(browserSource.includes('navigator.permissions.query({ name: "loopback-network" })'));
  assert.ok(browserSource.includes('if (loopbackPermission === "granted" && loopbackPolicyAllowed)'));
  assert.ok(browserSource.includes('sendEndpointToBridge(false)'));
  assert.doesNotMatch(browserSource, /sendToWindowsBridge\\(false\\)/);
});

test('notebook scopes its public API to the random URL path token and keeps the model off', () => {
  const notebookPath = path.join(__dirname, '..', 'vision', 'vision_worker.ipynb');
  const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  const source = (notebook.cells || []).filter(cell => cell.cell_type === 'code')
    .map(cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')).join('\n');
  assert.ok(source.includes('PUBLIC_VISION_ENDPOINT generated; the raw URL is kept in the handoff panel, not notebook text output.'));
  assert.equal(source.includes('print("PUBLIC_VISION_ENDPOINT=" + endpoint_url'), false);
  assert.match(source, /def display_public_endpoint/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /def _route_path\(self\)/);
  assert.match(source, /requests\.get\(url, headers=\{"Authorization": "Bearer " \+ API_KEY\}, timeout=2\)/);
  assert.match(source, /DIRECT_PROTOCOL/);
  assert.match(source, /registration\/ack/);
  assert.ok(source.includes('windows-repository-bridge://connect-colab?endpoint='));
  assert.match(source, /Connect to Windows Bridge/);
  assert.doesNotMatch(source, /register_tunnel_with_desktop|display_desktop_pairing_link|wrb_pair_nonce/);
  assert.ok(source.includes('targetAddressSpace: "loopback"'));
  assert.doesNotMatch(source, /QDQWG_TOKEN|userdata\.get|api\.github\.com\/repos\/hashin9973-ux\/qdqwg/);
});

test('native Colab URL handoff is primary and clipboard polling remains a fallback', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'colab-direct-service.js'), 'utf8');
  assert.match(main, /readClipboardText: \(\) => clipboard\.readText\(\)/);
  assert.match(service, /async function watchClipboardForEndpoint/);
  assert.match(service, /if \(text\) \{\s*const endpoint = endpointFromClipboard\(text\)/);
  assert.doesNotMatch(service, /text !== watch\.baseline/);
  assert.match(service, /parseTunnelEndpoint\(match\[0\]\)/);
  assert.ok(main.includes('setAsDefaultProtocolClient(COLAB_HANDOFF_SCHEME)'));
  assert.ok(main.includes("app.on('open-url'"));
  assert.ok(main.includes("parseTunnelEndpoint(uri.searchParams.get('endpoint'))"));
  assert.doesNotMatch(main, /COLAB_PROTOCOL_SCHEME|receiveColabProtocolLink/);
  assert.doesNotMatch(service, /http\.createServer|ensureReceiver|vision\/challenge|vision\/register|wrb_pair_nonce/);
});

test('structured vision context rejects truncated JSON and mismatched frames', () => {
  assert.throws(() => validateVisionContext('{"schema_version":"windows-vision-context/v2"', { width_px: 640, height_px: 360 }), /malformed or truncated JSON/i);
  assert.throws(() => validateVisionContext(JSON.stringify(createVisionReport(320, 180)), { width_px: 640, height_px: 360 }), /does not match the submitted screenshot/i);
});

test('structured vision context rejects invalid control bounds instead of accepting unreliable coordinates', () => {
  const report = createVisionReport(640, 360);
  report.controls[0].bbox_px = [630, 350, 650, 370];
  assert.throws(() => validateVisionContext(JSON.stringify(report), { width_px: 640, height_px: 360 }), /outside the submitted screenshot frame/i);
});


test('runtime without new TTS synthesis metrics is visible but explicitly out of date', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const features = REQUIRED_VISION_FEATURES.filter(feature => feature !== 'tts-server-synthesis-metrics-v1');
  f.setState({
    protocol: DIRECT_VISION_PROTOCOL, status: 'ready', enabled: true, model_loaded: true,
    model: 'qwen3-vl:4b-instruct', vision_worker_api_version: VISION_WORKER_API_VERSION,
    features, passive_model_loaded: true, detailed_model_parked: true, tts_ready: true
  });
  const connected = await f.service.connectColab(ENDPOINT);
  assert.equal(connected.connected, true, 'network connection should remain visible');
  assert.equal(connected.runtime_compatible, false);
  assert.equal(connected.status, 'incompatible_runtime');
  assert.match(connected.message, /out of date/i);
  assert.ok(connected.missing_vision_features.includes('tts-server-synthesis-metrics-v1'));
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'), false);
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'), false);
});

test('old Colab runtimes stay visible but never activate or receive screenshots/TTS', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  f.setState({
    protocol: DIRECT_VISION_PROTOCOL, status: 'ready', enabled: true, model_loaded: true,
    model: 'qwen3-vl:4b-instruct', vision_worker_api_version: undefined, features: undefined,
    passive_model_loaded: false, tts_ready: false
  });
  const connected = await f.service.connectColab(ENDPOINT);
  assert.equal(connected.connected, true, 'a reachable tunnel is still reported as connected');
  assert.equal(connected.status, 'incompatible_runtime');
  assert.equal(connected.runtime_compatible, false);
  assert.equal(connected.vision_activated, false, 'the obsolete runtime must not receive an activation request');
  assert.match(connected.message, /out of date/i);
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/registration/ack'), false, 'the outdated notebook acknowledgement would activate the old runtime');
  assert.equal(f.calls.some(call => call.type === 'direct_http' && call.route === '/activate'), false);

  const result = await f.service.analyzeScreenshot({ source: 'desktop', waitMs: 0 }, 'old-runtime-check');
  assert.equal(result.status, 'incompatible_runtime');
  assert.equal(result.runtime_compatible, false);
  assert.match(result.message, /out of date/i);
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/analyze').length, 0);

  const speech = await f.service.synthesizeSpeech({ text: 'This speech must not go to the old endpoint.' }, 'old-runtime-tts-check');
  assert.equal(speech.status, 'tts_unavailable');
  assert.match(speech.error, /out of date/i);
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && (call.route === '/tts' || call.route === '/tts/stream')).length, 0,
    'the incompatible notebook must never receive single-chunk or streamed TTS requests');
});

test('reconnecting to a live incompatible Colab runtime reports connection without claiming activation', async t => {
  const f = fixture();
  t.after(() => f.service.dispose());
  f.setState({
    protocol: DIRECT_VISION_PROTOCOL, status: 'ready', enabled: true, model_loaded: true,
    model: 'qwen3-vl:4b-instruct', vision_worker_api_version: undefined, features: undefined,
    passive_model_loaded: false, tts_ready: false
  });
  const first = await f.service.connectColab(ENDPOINT);
  assert.equal(first.connected, true);
  assert.equal(first.status, 'incompatible_runtime');
  assert.equal(first.vision_activated, false);
  const activationCallsBefore = f.calls.filter(call => call.type === 'direct_http' && call.route === '/activate').length;
  const retry = await f.service.connectColab();
  assert.equal(retry.connected, true);
  assert.equal(retry.status, 'incompatible_runtime');
  assert.equal(retry.vision_activated, false);
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/activate').length, activationCallsBefore,
    'reconnecting must not activate a runtime that lacks the required API/features');
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/registration/ack').length, 0,
    'an incompatible pre-existing runtime must not be registered through its activation-triggering acknowledgement');
});

test('Piper TTS validates voice and speaker, saves WAV locally, and optionally plays it', async t => {
  const played = [];
  const f = fixture({ playAudio: async filePath => { played.push(filePath); } });
  const madeFiles = [];
  t.after(async () => {
    await f.service.dispose();
    for (const filePath of madeFiles) { try { fs.unlinkSync(filePath); } catch {} }
  });
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts');
  const result = await f.service.synthesizeSpeech({ text: 'Hello from Piper.', play: true }, 'tts-test-call');
  assert.equal(result.status, 'tts_started');
  assert.equal(result.chunks_total, 1);
  assert.equal(result.playback_status, 'playing');
  assert.equal(result.voice, TTS_VOICE);
  assert.equal(result.speaker_id, TTS_SPEAKER_ID);
  assert.equal(result.played, true);
  assert.equal(result.local_file, undefined, 'async playback must not return a path that is removed after the chunk plays');
  assert.equal(played.length, 1);
  for (let i = 0; i < 20 && f.service.speechPlaybackStatus().active_job_id; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.speechPlaybackStatus().jobs.at(-1).status, 'completed');
  const apiCall = f.calls.find(call => call.type === 'direct_http' && call.route === '/tts');
  assert.equal(apiCall.body.protocol, DIRECT_VISION_PROTOCOL);
  assert.equal(apiCall.body.voice, 'en_US-libritts-high');
  assert.equal(apiCall.body.speaker_id, 0);
  assert.equal(apiCall.body.text, 'Hello from Piper.');
  assert.equal(result.audio_base64, undefined, 'audio bytes must not be included in the mailbox tool result');
});

test('Piper TTS supports no-playback mode and reports not-ready runtime state', async t => {
  const f = fixture();
  const madeFiles = [];
  t.after(async () => {
    await f.service.dispose();
    for (const filePath of madeFiles) { try { fs.unlinkSync(filePath); } catch {} }
  });
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts-no-play');
  const spokenText = Array.from({ length: 5 }, () => 'Silent synthesis checks the combined WAV header.').join(' ');
  const result = await f.service.synthesizeSpeech({ text: spokenText, play: false }, 'tts-no-play');
  assert.equal(result.status, 'tts_completed');
  assert.equal(result.played, false);
  assert.equal(result.playback_error, null);
  assert.ok(result.chunks_total > 1, 'test must exercise multi-chunk WAV concatenation');
  assert.equal(result.chunks_completed, result.chunks_total);
  madeFiles.push(result.local_file);
  const combinedWav = fs.readFileSync(result.local_file);
  assert.equal(combinedWav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(combinedWav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(combinedWav.readUInt32LE(4), combinedWav.length - 8, 'RIFF chunk size must equal file size minus its 8-byte header');
  f.setState({ tts_ready: false, tts_error: 'Piper loading.' });
  const notReady = await f.service.synthesizeSpeech({ text: 'Wait.' }, 'tts-not-ready');
  assert.equal(notReady.status, 'tts_unavailable');
  assert.match(notReady.error, /Piper loading/);
});

test('concurrent TTS playback is reserved before runtime health and synthesis I/O', async t => {
  const f = fixture({ playAudio: async () => {} });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts-race');
  const results = await Promise.all([
    f.service.synthesizeSpeech({ text: 'First speech request.' }, 'tts-race-a'),
    f.service.synthesizeSpeech({ text: 'Second speech request.' }, 'tts-race-b')
  ]);
  assert.equal(results.filter(result => result.status === 'tts_started').length, 1);
  assert.equal(results.filter(result => result.status === 'tts_busy').length, 1);
  const deadline = Date.now() + 5000;
  let speechStatus = f.service.speechPlaybackStatus();
  while (Date.now() < deadline && !speechStatus.jobs.some(job => job.status === 'completed')) {
    await new Promise(resolve => setTimeout(resolve, 10));
    speechStatus = f.service.speechPlaybackStatus();
  }
  assert.equal(
    speechStatus.jobs.filter(job => job.status === 'completed').length,
    1,
    'the admitted TTS job must finish; observed playback state: ' + JSON.stringify(speechStatus)
  );
});

test('TTS retries one malformed/truncated request body with the same request ID', async t => {
  const f = fixture({ playAudio: async () => {}, malformedTtsRequestAt: 1 });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts-malformed-body-retry');
  const result = await f.service.synthesizeSpeech({ text: 'One sentence for a bounded HTTP retry.' }, 'tts-malformed-body-retry');
  assert.equal(result.status, 'tts_started');
  const ttsCalls = f.calls.filter(call => call.type === 'direct_http' && call.route === '/tts');
  assert.equal(ttsCalls.length, 2, 'the truncated request is retried once, not indefinitely');
  assert.equal(ttsCalls[0].body.request_id, ttsCalls[1].body.request_id, 'retry must preserve the immutable chunk request ID');
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && f.service.speechPlaybackStatus().active_job_id) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(f.service.speechPlaybackStatus().jobs.at(-1).status, 'completed');
});

test('remaining TTS chunks stream into the playback queue before the first chunk finishes', async t => {
  let finishFirstChunk;
  const firstChunkPlaying = new Promise(resolve => { finishFirstChunk = resolve; });
  const played = [];
  const f = fixture({
    ttsDelayMs: 80,
    playAudio: async filePath => {
      played.push(filePath);
      if (played.length === 1) await firstChunkPlaying;
    }
  });
  t.after(async () => {
    finishFirstChunk();
    await f.service.dispose();
  });
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts-gapless-prefetch');
  const longText = Array.from({ length: 8 }, (_, i) => 'Sentence ' + (i + 1) + ' explains the next visible thing.').join(' ');
  const started = await f.service.synthesizeSpeech({ text: longText, play: true }, 'tts-gapless-prefetch');
  assert.equal(started.status, 'tts_started', started.error || JSON.stringify(started));
  assert.ok(started.chunks_total >= 6, 'test text should create multiple queued chunks');
  assert.ok(Number.isFinite(started.time_to_first_audio_ms) && started.time_to_first_audio_ms >= 0,
    'the first synthesized audio latency must be measured');
  assert.ok(Number.isFinite(started.playback_start_ms) && started.playback_start_ms >= 0,
    'the initial playback startup latency must be measured');

  const deadline = Date.now() + 3000;
  let status = f.service.speechPlaybackStatus();
  let job = status.jobs.find(item => item.job_id === started.speech_job_id);
  while (Date.now() < deadline && job && job.chunks_queued < job.chunks_total) {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = f.service.speechPlaybackStatus();
    job = status.jobs.find(item => item.job_id === started.speech_job_id);
  }
  assert.ok(job, 'the speech job must remain visible while the first chunk plays');
  assert.equal(job.chunks_queued, job.chunks_total, 'the remaining audio should be synthesized and queued ahead of playback');
  assert.equal(job.chunks_completed, 0, 'later chunks must queue without waiting for the first chunk to finish');
  assert.ok(Number.isFinite(job.initial_chunk_ready_ms) && job.initial_chunk_ready_ms >= 0);
  assert.ok(Number.isFinite(job.playback_start_ms) && job.playback_start_ms >= 0);
  assert.ok(Number.isFinite(job.stream_start_latency_ms) && job.stream_start_latency_ms >= 0);
  assert.equal(job.chunk_metrics.length, job.chunks_total,
    'the initial chunk and every streamed continuation must expose timing data');
  const initialMetric = job.chunk_metrics.find(metric => metric.index === 0);
  assert.ok(initialMetric && Number.isFinite(initialMetric.request_round_trip_ms) &&
    Number.isFinite(initialMetric.file_write_ms) && initialMetric.audio_bytes > 0,
    'first-chunk request and local-write latency must be measured');
  const continuationMetrics = job.chunk_metrics.filter(metric => metric.index > 0);
  assert.equal(continuationMetrics.length, job.chunks_total - 1);
  assert.ok(continuationMetrics.every(metric => Number.isFinite(metric.file_write_ms) &&
    Number.isFinite(metric.queue_ack_ms) && Number.isFinite(metric.stream_elapsed_ms) &&
    Number.isFinite(metric.chunk_delivery_interval_ms) && Number.isFinite(metric.record_to_queue_ms) &&
    Number.isFinite(metric.audio_bytes) && metric.audio_bytes > 0));
  assert.equal(typeof job.audio_underrun_count, 'number');
  assert.equal(typeof job.total_audio_gap_ms, 'number');
  assert.equal(f.getMaxActiveTtsRequests(), 1, 'one streamed response should serialize safe Piper access without per-chunk HTTP round trips');
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/tts/stream').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'direct_http' && call.route === '/tts').length, 1, 'only the initial audible chunk should use the single-chunk endpoint');
  assert.equal(played.length, 1, 'the test player must still be inside the first audio chunk');
  finishFirstChunk();

  const completionDeadline = Date.now() + 3000;
  while (Date.now() < completionDeadline && f.service.speechPlaybackStatus().active_job_id) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.service.speechPlaybackStatus().jobs.find(item => item.job_id === started.speech_job_id).status, 'completed');
});

test('gapless WASAPI script invokes the C# type it declares', () => {
  const script = buildGaplessPlaybackScript();
  const declaration = script.match(/public static class\s+([A-Za-z_]\w*)/);
  const invocation = script.match(/\[([A-Za-z_]\w*)\]::Run\(\)/);
  assert.ok(declaration, 'the audio player C# type should be declared');
  assert.ok(invocation, 'the PowerShell script should invoke the audio player type');
  assert.equal(invocation[1], declaration[1],
    'the PowerShell entry point must reference the compiled C# type name exactly');
  assert.doesNotMatch(script, /if \(EndRequested && InputClosed\) continue;/,
    'commands read before END must not be discarded if END arrives before the consumer drains the input queue');
  assert.match(script, /Console\.WriteLine\("GAP\\t"/,
    'the WASAPI player must report measured playback-buffer starvation gaps');
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'colab-direct-service.js'), 'utf8');
  assert.match(source, /audio_underrun_count/);
  assert.match(source, /prefetchPromise = queueRemainingSpeech\(job, first\.playback\);/,
    'next-chunk production should begin before waiting for initial playback startup');
});

test('gapless Windows WASAPI helper compiles without opening an audio device', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bridge-waveout-test-'));
  const scriptPath = path.join(directory, 'compile-gapless.ps1');
  try {
    fs.writeFileSync(scriptPath, buildGaplessPlaybackScript(), 'utf8');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, BRIDGE_GAPLESS_COMPILE_ONLY: '1' }
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /GAPLESS_WASAPI_COMPILED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('background TTS chunk failure remains failed after asynchronous playback start', async t => {
  const f = fixture({ playAudio: async () => {}, failTtsRequestAt: 2, failTtsStatus: 422 });
  t.after(() => f.service.dispose());
  await openAndPublishEndpoint(f);
  await f.service.activate({}, 'activate-for-tts-background-failure');
  const spokenText = Array.from(
    { length: 5 },
    () => 'First phrase ends here. Another sentence follows for background chunk checks.'
  ).join(' ');
  const started = await f.service.synthesizeSpeech({ text: spokenText, play: true }, 'tts-background-failure');
  assert.equal(started.status, 'tts_started', started.error || JSON.stringify(started));
  assert.ok(started.chunks_total > 1, 'test must start a multi-chunk background speech job');

  const deadline = Date.now() + 5000;
  let playback = f.service.speechPlaybackStatus();
  let job = playback.jobs.find(item => item.job_id === started.speech_job_id);
  while (Date.now() < deadline && job && job.status !== 'failed' && job.status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 10));
    playback = f.service.speechPlaybackStatus();
    job = playback.jobs.find(item => item.job_id === started.speech_job_id);
  }
  assert.ok(job, 'the started speech job must remain queryable in computer(action=status)');
  assert.equal(job.status, 'failed', 'a failed background chunk must never be reported as completed');
  assert.match(String(job.error || ''), /(503|background Piper chunk|TTS)/i);
  assert.equal(playback.active_job_id, null, 'failed background playback must release the single-job slot');
  assert.ok(job.chunks_completed < job.chunks_total, 'a failed job must not claim that every chunk completed');

  const computerStatus = await f.service.status();
  const statusJob = computerStatus.speech_playback?.jobs.find(item => item.job_id === started.speech_job_id);
  assert.ok(statusJob, 'computer(action=status) must expose the speech job');
  assert.equal(statusJob.status, 'failed', 'computer(action=status) must preserve the terminal background failure');
  assert.equal(computerStatus.speech_playback.active_job_id, null);
});

test('vision protocol requirements include v4 multimodal capability validation and the fixed Piper voice', () => {
  assert.equal(VISION_WORKER_API_VERSION, 5);
  assert.ok(REQUIRED_VISION_FEATURES.includes('frame-id-validation'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('tts-piper-libritts-high'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('passive-vision-capability-validation'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('coordinate-rich-context-v2'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('ocr-accessibility-fallback'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('tts-chunked-playback'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('unicode-speech-normalization'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('expanded-observe-context-v3'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('passive-latest-frame-scheduling'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('safe-http-request-bodies'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('tts-streamed-prefetch'));
  assert.ok(REQUIRED_VISION_FEATURES.includes('tts-server-synthesis-metrics-v1'));
  assert.equal(TTS_PROTOCOL, 'piper-libritts-tts/v1');
  assert.equal(TTS_VOICE, 'en_US-libritts-high');
  assert.equal(TTS_SPEAKER_ID, 0);
});

test('TTS WAV volume scales 16-bit PCM samples and preserves full-volume buffers', () => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(4, 40);
  wav.writeInt16LE(10000, 44); wav.writeInt16LE(-10000, 46);
  assert.equal(scaleWavVolume(wav, 100), wav);
  const half = scaleWavVolume(wav, 50);
  assert.equal(half.readInt16LE(44), 5000);
  assert.equal(half.readInt16LE(46), -5000);
  const muted = scaleWavVolume(wav, 0);
  assert.equal(muted.readInt16LE(44), 0);
  assert.equal(muted.readInt16LE(46), 0);
});
