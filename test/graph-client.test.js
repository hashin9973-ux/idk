'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGraphClient, GraphError, GRAPH_ROOT, validateGraphUrl } = require('../desktop/graph-client');

function response(value, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'HTTP ' + status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    text: async () => typeof value === 'string' ? value : JSON.stringify(value)
  };
}

test('Graph client refreshes a rejected access token exactly once', async () => {
  const tokenRequests = [];
  const calls = [];
  const client = createGraphClient({
    getAccessToken: async options => { tokenRequests.push(options); return options.forceRefresh ? 'fresh' : 'stale'; },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return calls.length === 1 ? response({}, 401) : response({ id: 'drive-item' });
    }
  });
  assert.deepEqual(await client.request(GRAPH_ROOT + '/me/drive'), { id: 'drive-item' });
  assert.deepEqual(tokenRequests, [{ forceRefresh: false }, { forceRefresh: true }]);
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer stale', 'Bearer fresh']);
});

test('Graph client preserves long Retry-After values without retrying early', async () => {
  let calls = 0;
  const client = createGraphClient({
    getAccessToken: async () => 'token',
    fetchImpl: async () => { calls++; return response({ error: { message: 'Slow down' } }, 429, { 'retry-after': '180' }); }
  });
  await assert.rejects(client.request(GRAPH_ROOT + '/me/drive'), error => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 180000);
    return true;
  });
  assert.equal(calls, 1);
});

test('Graph client handles empty throttling responses and preserves Retry-After', async () => {
  let calls = 0;
  const client = createGraphClient({
    getAccessToken: async () => 'token',
    fetchImpl: async () => {
      calls++;
      return response('', 429, { 'retry-after': '180' });
    }
  });
  await assert.rejects(client.request(GRAPH_ROOT + '/me/drive'), error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 180000);
    return true;
  });
  assert.equal(calls, 1);
});

test('Graph URL validation rejects non-Graph and non-v1.0 destinations', () => {
  assert.throws(() => validateGraphUrl('https://example.com/v1.0/me'));
  assert.throws(() => validateGraphUrl('https://graph.microsoft.com/beta/me'));
  assert.throws(() => validateGraphUrl('https://graph.microsoft.com/v1.0/me#fragment'));
});

test('delta follows Graph nextLink and returns the opaque deltaLink unchanged', async () => {
  const calls = [];
  const deltaLink = GRAPH_ROOT + '/drives/delta-token';
  const client = createGraphClient({
    getAccessToken: async () => 'token',
    fetchImpl: async url => {
      calls.push(url);
      return calls.length === 1
        ? response({ value: [{ id: 'one' }], '@odata.nextLink': GRAPH_ROOT + '/next-page' })
        : response({ value: [{ id: 'two' }], '@odata.deltaLink': deltaLink });
    }
  });
  const result = await client.readDelta('drive-id', 'folder-id');
  assert.deepEqual(result.items.map(item => item.id), ['one', 'two']);
  assert.equal(result.deltaLink, deltaLink);
  assert.equal(calls.length, 2);
});
