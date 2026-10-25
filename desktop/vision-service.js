'use strict';

// Compatibility import retained for older callers. Vision now uses the direct,
// authenticated Colab HTTPS transport; screenshots and reports are not queued
// as separate bridge/vision GitHub artifacts.
module.exports = require('./colab-direct-service');
