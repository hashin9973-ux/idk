'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const direct = require('../desktop/colab-direct-service');
const legacy = require('../desktop/vision-service');

test('legacy module path now exports the direct Colab transport', () => {
  assert.equal(legacy.createVisionService, direct.createVisionService);
  assert.equal(legacy.DIRECT_VISION_PROTOCOL, direct.DIRECT_VISION_PROTOCOL);
  assert.equal(legacy.COLAB_NOTEBOOK_URL, direct.COLAB_NOTEBOOK_URL);
});
