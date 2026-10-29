'use strict';

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HANDOFF_PATH,
  MAX_BODY_BYTES,
  COLAB_PAGE_ORIGIN,
  isAllowedColabOrigin,
  createColabHandoffServer
} = require('../desktop/colab-handoff-server');

const ENDPOINT = 'https://bridge-test.trycloudflare.com/' + 'a'.repeat(48);
const OUTPUT_ORIGIN = 'https://kernel-1234-0-colab.googleusercontent.com';

function makeServer(options = {}) {
  const deliveries = [];
  const server = createColabHandoffServer({
    host: DEFAULT_HOST,
    port: 0,
    parseEndpoint: value => value === ENDPOINT ? { url: value, apiKey: 'do-not-return-this' } : null,
    onEndpoint: endpoint => { deliveries.push(endpoint); return true; },
    ...options
  });
  return { server, deliveries };
}

async function start(t, fixture) {
  const status = await fixture.server.start();
  t.after(() => fixture.server.stop());
  return 'http://127.0.0.1:' + status.port + HANDOFF_PATH;
}

test('Colab origin allowlist accepts only the main page and known generated Colab output origins', () => {
  assert.equal(isAllowedColabOrigin(COLAB_PAGE_ORIGIN), true);
  assert.equal(isAllowedColabOrigin('https://colab.research.googleusercontent.com'), true);
  assert.equal(isAllowedColabOrigin(OUTPUT_ORIGIN), true);
  assert.equal(isAllowedColabOrigin('https://evil-colab.googleusercontent.com.attacker.test'), false);
  assert.equal(isAllowedColabOrigin('https://example.com'), false);
  assert.equal(isAllowedColabOrigin('http://colab.research.google.com'), false);
  assert.equal(isAllowedColabOrigin('null'), false);
  assert.equal(isAllowedColabOrigin('https://colab.research.google.com.attacker.test'), false);
});

test('loopback endpoint and payload limits are fixed and bounded', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 43817);
  assert.equal(MAX_BODY_BYTES, 2048);
  assert.throws(() => createColabHandoffServer({
    host: '0.0.0.0',
    parseEndpoint: () => null,
    onEndpoint: () => {}
  }), /127\.0\.0\.1 only/);
});

test('allowed Colab output can hand off a validated endpoint with a quick 202 acknowledgement', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Origin: OUTPUT_ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: ENDPOINT })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, status: 'verification_pending' });
  assert.equal(response.headers.get('access-control-allow-origin'), OUTPUT_ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.deliveries, [ENDPOINT]);
});

test('valid endpoint is rejected when the desktop does not authorize an active handoff', async t => {
  const f = makeServer({ onEndpoint: () => false });
  const url = await start(t, f);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Origin: OUTPUT_ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: ENDPOINT })
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { accepted: false, error: 'handoff_not_accepted' });
  assert.deepEqual(f.deliveries, []);
});

test('preflight permits only the bounded POST JSON contract', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: COLAB_PAGE_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Sec-Fetch-Site': 'cross-site'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), COLAB_PAGE_ORIGIN);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.equal(response.headers.get('access-control-allow-private-network'), null);
});

test('untrusted origins and unexpected content types cannot send endpoint data', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const blocked = await fetch(url, {
    method: 'POST',
    headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: ENDPOINT })
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);

  const typeBlocked = await fetch(url, {
    method: 'POST',
    headers: { Origin: COLAB_PAGE_ORIGIN, 'Content-Type': 'text/plain' },
    body: ENDPOINT
  });
  assert.equal(typeBlocked.status, 415);
  assert.deepEqual(f.deliveries, []);
});

test('invalid JSON, unexpected properties, and invalid endpoint URLs are rejected without echoing secrets', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const badJson = await fetch(url, {
    method: 'POST',
    headers: { Origin: COLAB_PAGE_ORIGIN, 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(badJson.status, 400);

  const extraField = await fetch(url, {
    method: 'POST',
    headers: { Origin: COLAB_PAGE_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: ENDPOINT, unexpected: 'private' })
  });
  assert.equal(extraField.status, 400);

  const badEndpoint = await fetch(url, {
    method: 'POST',
    headers: { Origin: COLAB_PAGE_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://example.com/private-token' })
  });
  assert.equal(badEndpoint.status, 400);
  const responseBody = await badEndpoint.text();
  assert.equal(responseBody.includes('private-token'), false);
  assert.deepEqual(f.deliveries, []);
});

test('oversized bodies are rejected before endpoint parsing or dispatch', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Origin: COLAB_PAGE_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: ENDPOINT, padding: 'x'.repeat(MAX_BODY_BYTES + 100) })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(f.deliveries, []);
});

test('non-POST methods and unexpected Host headers are rejected', async t => {
  const f = makeServer();
  const url = await start(t, f);
  const get = await fetch(url, { headers: { Origin: COLAB_PAGE_ORIGIN } });
  assert.equal(get.status, 405);

  const address = new URL(url);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: Number(address.port),
      path: HANDOFF_PATH,
      method: 'POST',
      headers: {
        Host: 'attacker.test',
        Origin: COLAB_PAGE_ORIGIN,
        'Content-Type': 'application/json'
      }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(JSON.stringify({ endpoint: ENDPOINT }));
  });
  assert.equal(badHost, 421);
  assert.deepEqual(f.deliveries, []);
});
