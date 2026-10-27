'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshotForFrame, rectForFrame } = require('../desktop/windows-uia');

test('UI Automation bounds are mapped to the screenshot frame and their centers are derived by code', () => {
  const result = normalizeSnapshotForFrame({
    available: true,
    active_window: { title: 'Settings', process_id: 24, bbox_screen_px: [0, 0, 1920, 1080] },
    focused_control: { name: 'Apply', role: 'Button', enabled: true, bbox_screen_px: [1600, 900, 1800, 960] },
    controls: [
      { name: 'Apply', role: 'Button', enabled: true, bbox_screen_px: [1600, 900, 1800, 960] },
      { name: 'private query text', role: 'Edit', enabled: true, bbox_screen_px: [100, 100, 500, 140] },
      { name: 'offscreen', role: 'Button', enabled: true, bbox_screen_px: [2000, 100, 2100, 150] }
    ],
    node_count: 9
  }, { width: 1920, height: 1080 }, { width: 960, height: 540 });

  assert.equal(result.available, true);
  assert.equal(result.active_window.title, 'Settings');
  assert.deepEqual(result.active_window.bbox_px, [0, 0, 960, 540]);
  assert.deepEqual(result.controls[0].bbox_px, [800, 450, 900, 480]);
  assert.deepEqual(result.controls[0].center_px, [850, 465]);
  assert.equal(result.controls.some(control => control.label === 'private query text'), false);
  assert.equal(result.controls.some(control => control.label === 'offscreen'), false);
});

test('UI Automation fails closed for malformed and off-screen rectangles', () => {
  assert.equal(rectForFrame([20, 20, 10, 30], { width: 100, height: 100 }, { width: 50, height: 50 }), null);
  assert.equal(rectForFrame([120, 20, 130, 30], { width: 100, height: 100 }, { width: 50, height: 50 }), null);
  assert.equal(normalizeSnapshotForFrame({ available: false, reason: 'uia_timeout' }, { width: 100, height: 100 }, { width: 50, height: 50 }).reason, 'uia_timeout');
  assert.equal(normalizeSnapshotForFrame({ available: true }, { width: 0, height: 100 }, { width: 50, height: 50 }).reason, 'invalid_frame_dimensions');
});

test('text inputs never expose their accessible name or contents in the UIA context', () => {
  const result = normalizeSnapshotForFrame({
    available: true,
    controls: [
      { name: 'token value must not leak', role: 'Edit', enabled: true, bbox_screen_px: [10, 10, 80, 30], automation_id: 'input-1' }
    ]
  }, { width: 100, height: 100 }, { width: 100, height: 100 });
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].label, 'Text input (value not read)');
  assert.equal(result.controls[0].label.includes('token value'), false);
});
