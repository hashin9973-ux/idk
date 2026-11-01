'use strict';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_ROOT = GRAPH_ORIGIN + '/v1.0';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_AUTOMATIC_RETRY_WAIT_MS = 30000;

class GraphError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = Number.isInteger(options.status) ? options.status : 0;
    this.code = String(options.code || '');
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
    this.requestId = String(options.requestId || '');
  }
}

function validateGraphUrl(value) {
  const url = new URL(String(value || ''));
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/')) {
    throw new TypeError('Microsoft Graph URL is outside the allowed v1.0 endpoint.');
  }
  if (url.username || url.password || url.hash) throw new TypeError('Invalid Microsoft Graph URL.');
  return url;
}

function encodeSegment(value, label) {
  const text = String(value || '');
  if (!text || text === '.' || text === '..' || /[\/\\]/.test(text)) {
    throw new TypeError(label + ' must be a non-empty identifier segment.');
  }
  return encodeURIComponent(text);
}

function retryDelay(response) {
  const raw = response && response.headers && response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function readResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    throw new GraphError('Microsoft Graph response exceeded the 8 MiB limit.', { status: response.status });
  }
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); } catch {
    throw new GraphError('Microsoft Graph returned invalid JSON.', { status: response.status });
  }
  if (!response.ok) {
    const error = value && value.error || {};
    throw new GraphError(String(error.message || response.statusText || 'Microsoft Graph request failed.').slice(0, 1000), {
      status: response.status,
      code: error.code,
      requestId: response.headers && response.headers.get('request-id'),
      retryAfterMs: retryDelay(response)
    });
  }
  return value;
}

function createGraphClient({ getAccessToken, fetchImpl = globalThis.fetch, maxRetries = 4, maxAutomaticWaitMs = MAX_AUTOMATIC_RETRY_WAIT_MS } = {}) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken must be a function.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  const retries = Math.max(0, Math.min(8, Math.floor(Number(maxRetries) || 0)));

  async function request(input, options = {}) {
    const url = validateGraphUrl(input);
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError('Unsupported Graph HTTP method.');
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    let refreshed = false;
    let attempt = 0;
    while (true) {
      const token = await getAccessToken({ forceRefresh: refreshed });
      if (typeof token !== 'string' || !token) throw new GraphError('Microsoft sign-in did not provide an access token.');
      const response = await fetchImpl(url.href, {
        method,
        headers: { ...headers, Authorization: 'Bearer ' + token },
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.signal ? { signal: options.signal } : {})
      });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      try {
        return await readResponse(response);
      } catch (error) {
        const retryable = error instanceof GraphError && [429, 503, 504].includes(error.status);
        if (!retryable || attempt >= retries) throw error;
        const delay = error.retryAfterMs === null ? Math.min(1000 * (2 ** attempt), 10000) : error.retryAfterMs;
        if (delay > maxAutomaticWaitMs) throw error;
        attempt++;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          if (options.signal) {
            if (options.signal.aborted) {
              clearTimeout(timer);
              reject(options.signal.reason || new Error('The operation was aborted.'));
            } else {
              options.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(options.signal.reason || new Error('The operation was aborted.'));
              }, { once: true });
            }
          }
        });
      }
    }
  }

  async function listChildren(driveId, folderId, options = {}) {
    const drive = encodeSegment(driveId, 'driveId');
    const folder = encodeSegment(folderId, 'folderId');
    const limit = Math.max(1, Math.min(10000, Number(options.maxItems) || 10000));
    let next = GRAPH_ROOT + '/drives/' + drive + '/items/' + folder + '/children?$top=200';
    const items = [];
    while (next) {
      const page = await request(next, { signal: options.signal });
      if (!Array.isArray(page.value)) throw new GraphError('Microsoft Graph returned an invalid children page.');
      for (const item of page.value) {
        items.push(item);
        if (items.length > limit) throw new GraphError('OneDrive folder listing exceeded its configured item limit.');
      }
      next = page['@odata.nextLink'] ? validateGraphUrl(page['@odata.nextLink']).href : null;
    }
    return items;
  }

  async function readDelta(driveId, folderId, deltaLink, options = {}) {
    const drive = encodeSegment(driveId, 'driveId');
    const folder = encodeSegment(folderId, 'folderId');
    let next = deltaLink
      ? validateGraphUrl(deltaLink).href
      : GRAPH_ROOT + '/drives/' + drive + '/items/' + folder + '/delta';
    const items = new Map();
    let pages = 0;
    const maxPages = Math.max(1, Math.min(1000, Number(options.maxPages) || 100));
    while (next) {
      if (++pages > maxPages) throw new GraphError('OneDrive delta paging exceeded its configured page limit.');
      const page = await request(next, { signal: options.signal });
      if (!Array.isArray(page.value)) throw new GraphError('Microsoft Graph returned an invalid delta page.');
      for (const item of page.value) if (item && typeof item.id === 'string') items.set(item.id, item);
      if (page['@odata.nextLink']) next = validateGraphUrl(page['@odata.nextLink']).href;
      else return { items: [...items.values()], deltaLink: page['@odata.deltaLink'] ? validateGraphUrl(page['@odata.deltaLink']).href : null, pages };
    }
    return { items: [...items.values()], deltaLink: null, pages };
  }

  return Object.freeze({ request, listChildren, readDelta });
}

module.exports = {
  GRAPH_ORIGIN,
  GRAPH_ROOT,
  MAX_AUTOMATIC_RETRY_WAIT_MS,
  GraphError,
  createGraphClient,
  validateGraphUrl
};
