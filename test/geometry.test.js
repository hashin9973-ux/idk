const test = require('node:test');
const assert = require('node:assert/strict');
const { clampRectToWorkArea, clampBubbleToWorkArea } = require('../desktop/geometry');

test('keeps normal overlay bounds unchanged inside the work area', () => {
  assert.deepEqual(
    clampRectToWorkArea(
      { x: 900, y: 100, width: 460, height: 720 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    ),
    { x: 900, y: 100, width: 460, height: 720 }
  );
});

test('moves an overlay back onto the screen and caps large dimensions', () => {
  assert.deepEqual(
    clampRectToWorkArea(
      { x: -500, y: 2000, width: 4000, height: 4000 },
      { x: 100, y: 50, width: 1200, height: 800 }
    ),
    { x: 100, y: 50, width: 1200, height: 800 }
  );
});

test('does not force a minimum size larger than a small work area', () => {
  assert.deepEqual(
    clampRectToWorkArea(
      { x: 0, y: 0, width: 460, height: 720 },
      { x: 40, y: 60, width: 300, height: 200 }
    ),
    { x: 40, y: 60, width: 300, height: 200 }
  );
});

test('clamps the collapsed orb on all edges of a secondary display', () => {
  assert.deepEqual(
    clampBubbleToWorkArea(
      { x: 4000, y: -50 },
      { x: 1920, y: 0, width: 1280, height: 900 },
      76
    ),
    { x: 3124, y: 0 }
  );
});

test('sanitizes invalid geometry values', () => {
  const bounds = clampRectToWorkArea(
    { x: Number.NaN, y: Infinity, width: -1, height: Number.NaN },
    { x: 0, y: 0, width: 800, height: 600 }
  );
  assert.deepEqual(bounds, { x: 0, y: 0, width: 460, height: 600 });
});
