'use strict';

const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43817;
const HANDOFF_PATH = '/handoff';
const MAX_BODY_BYTES = 2048;
const MAX_ENDPOINT_CHARS = 400;
const COLAB_PAGE_ORIGIN = 'https://colab.research.google.com';
const COLAB_OUTPUT_ORIGIN = 'https://colab.research.googleusercontent.com';

function isAllowedColabOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string' || rawOrigin.length > 400) return false;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== rawOrigin ||
        parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' ||
        parsed.search || parsed.hash) return false;
    if (parsed.origin === COLAB_PAGE_ORIGIN || parsed.origin === COLAB_OUTPUT_ORIGIN) return true;
    // Colab serves output frames on generated *-colab.googleusercontent.com origins.
    // Do not trust arbitrary googleusercontent.com pages.
    return /^[a-z0-9-]+-colab\.googleusercontent\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackPeer(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function setCorsHeaders(response, origin) {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, statusCode, payload, origin = '') {
  if (origin && isAllowedColabOrigin(origin)) setCorsHeaders(response, origin);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function readBoundedBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        reject(Object.assign(new Error('Request body exceeds the allowed size.'), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
    request.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function createColabHandoffServer(options = {}) {
  const {
    onEndpoint,
    parseEndpoint,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    maxBodyBytes = MAX_BODY_BYTES
  } = options;
  if (typeof onEndpoint !== 'function') throw new TypeError('onEndpoint must be a function.');
  if (typeof parseEndpoint !== 'function') throw new TypeError('parseEndpoint must be a function.');
  if (host !== DEFAULT_HOST) throw new TypeError('The Colab handoff server must bind to 127.0.0.1 only.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535.');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 16384) {
    throw new RangeError('maxBodyBytes must be an integer from 256 to 16384.');
  }

  let server = null;
  let startPromise = null;
  let stopPromise = null;
  let listeningPort = port;
  let lastError = '';

  function status() {
    return {
      ready: Boolean(server && server.listening),
      host,
      port: listeningPort,
      path: HANDOFF_PATH,
      lastError: lastError || ''
    };
  }

  async function handleRequest(request, response) {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (!isLoopbackPeer(request.socket && request.socket.remoteAddress)) {
      sendJson(response, 403, { accepted: false, error: 'loopback_only' });
      return;
    }
    if (!isAllowedColabOrigin(origin)) {
      sendJson(response, 403, { accepted: false, error: 'origin_not_allowed' });
      return;
    }
    const expectedHost = '127.0.0.1:' + String(listeningPort);
    if (String(request.headers.host || '').toLowerCase() !== expectedHost) {
      sendJson(response, 421, { accepted: false, error: 'host_not_allowed' }, origin);
      return;
    }
    if (request.url !== HANDOFF_PATH) {
      sendJson(response, 404, { accepted: false, error: 'not_found' }, origin);
      return;
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = String(request.headers['access-control-request-method'] || '').toUpperCase();
      const requestedHeaders = String(request.headers['access-control-request-headers'] || '')
        .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (requestedMethod !== 'POST' || requestedHeaders.some(value => value !== 'content-type')) {
        sendJson(response, 403, { accepted: false, error: 'preflight_not_allowed' }, origin);
        return;
      }
      setCorsHeaders(response, origin);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, OPTIONS');
      sendJson(response, 405, { accepted: false, error: 'method_not_allowed' }, origin);
      return;
    }

    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(response, 415, { accepted: false, error: 'content_type_not_allowed' }, origin);
      request.resume();
      return;
    }
    const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && fetchSite !== 'cross-site') {
      sendJson(response, 403, { accepted: false, error: 'fetch_site_not_allowed' }, origin);
      request.resume();
      return;
    }
    const declaredLength = request.headers['content-length'];
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(String(declaredLength))) {
        sendJson(response, 400, { accepted: false, error: 'invalid_content_length' }, origin);
        request.resume();
        return;
      }
      if (Number(declaredLength) > maxBodyBytes) {
        sendJson(response, 413, { accepted: false, error: 'body_too_large' }, origin);
        request.resume();
        return;
      }
    }

    let parsed;
    try {
      const raw = await readBoundedBody(request, maxBodyBytes);
      parsed = JSON.parse(raw);
    } catch (error) {
      const statusCode = Number.isInteger(error && error.statusCode) ? error.statusCode : 400;
      sendJson(response, statusCode, { accepted: false, error: statusCode === 413 ? 'body_too_large' : 'invalid_json' }, origin);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 || Object.keys(parsed)[0] !== 'endpoint' ||
        typeof parsed.endpoint !== 'string' || parsed.endpoint.length > MAX_ENDPOINT_CHARS) {
      sendJson(response, 400, { accepted: false, error: 'invalid_payload' }, origin);
      return;
    }

    let endpoint;
    try { endpoint = parseEndpoint(parsed.endpoint); } catch { endpoint = null; }
    if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.length > MAX_ENDPOINT_CHARS) {
      sendJson(response, 400, { accepted: false, error: 'endpoint_not_allowed' }, origin);
      return;
    }

    // The app callback must synchronously confirm that it accepted this validated
    // endpoint for processing. The connection handshake runs asynchronously; never
    // echo the secret endpoint in this HTTP response.
    let accepted = false;
    try { accepted = onEndpoint(endpoint.url) === true; } catch {}
    if (!accepted) {
      sendJson(response, 409, { accepted: false, error: 'handoff_not_accepted' }, origin);
      return;
    }
    sendJson(response, 202, { accepted: true, status: 'verification_pending' }, origin);
  }

  function start() {
    if (server && server.listening) return Promise.resolve(status());
    if (startPromise) return startPromise;
    lastError = '';
    const candidate = http.createServer((request, response) => {
      void handleRequest(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { accepted: false, error: 'internal_error' });
        else if (!response.writableEnded) response.end();
      });
    });
    candidate.requestTimeout = 5000;
    candidate.headersTimeout = 5000;
    candidate.keepAliveTimeout = 1000;
    server = candidate;
    startPromise = new Promise((resolve, reject) => {
      const onError = error => {
        lastError = String(error && error.code || error && error.message || 'listen_failed').slice(0, 120);
        candidate.removeListener('listening', onListening);
        server = null;
        startPromise = null;
        reject(error);
      };
      const onListening = () => {
        candidate.removeListener('error', onError);
        const address = candidate.address();
        if (address && typeof address === 'object') listeningPort = address.port;
        startPromise = null;
        resolve(status());
      };
      candidate.once('error', onError);
      candidate.once('listening', onListening);
      candidate.listen(listeningPort, host);
    });
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    const pendingStart = startPromise;
    if (pendingStart) {
      try { await pendingStart; } catch {}
    }
    if (!server || !server.listening) {
      server = null;
      return status();
    }
    const current = server;
    stopPromise = new Promise(resolve => {
      current.close(() => {
        if (server === current) server = null;
        stopPromise = null;
        resolve(status());
      });
      current.closeAllConnections?.();
    });
    return stopPromise;
  }

  return { start, stop, status };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HANDOFF_PATH,
  MAX_BODY_BYTES,
  COLAB_PAGE_ORIGIN,
  COLAB_OUTPUT_ORIGIN,
  isAllowedColabOrigin,
  isLoopbackPeer,
  createColabHandoffServer
};
