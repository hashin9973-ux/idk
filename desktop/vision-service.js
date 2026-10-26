'use strict';

// Compatibility import retained for existing callers. Vision uses the direct,
// authenticated Colab HTTPS transport; screenshots and reports are not queued
// as separate GitHub mailbox artifacts.
module.exports = require('./colab-direct-service');
