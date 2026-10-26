'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const compatibility = require('../desktop/vision-service');
const direct = require('../desktop/colab-direct-service');

test('legacy vision-service import resolves to the direct Colab HTTPS implementation', () => {
  assert.equal(compatibility.createVisionService, direct.createVisionService);
  assert.equal(compatibility.DIRECT_VISION_PROTOCOL, direct.DIRECT_VISION_PROTOCOL);
  assert.equal(typeof compatibility.createVisionService, 'function');
});
