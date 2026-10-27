'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWindowsInputController,
  toLowLevel,
  normalizeKey,
  HOLD_FAILSAFE_MS
} = require('../desktop/windows-input');

test('coordinate normalization and right/middle/left mouse gestures use the screenshot pixel frame', () => {
  const result = toLowLevel([
    { type: 'click', x: 50, y: 25, button: 'right' },
    { type: 'drag', fromX: 10, fromY: 10, x: 90, y: 80, button: 'middle', durationMs: 0 },
    { type: 'mouse_down', button: 'left' },
    { type: 'mouse_up', button: 'left' }
  ], { width: 101, height: 101 });
  assert.equal(result.frame.width, 101);
  assert.equal(result.frame.height, 101);
  assert.equal(result.requestedActions, 4);
  assert.ok(result.operations.some(op => op.type === 'move' && op.x === 32768 && op.y === 16384));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0008));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0010));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0020));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0040));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0002));
  assert.ok(result.operations.some(op => op.type === 'mouse_event' && op.flags === 0x0004));
});

test('keyboard press, hotkey combinations, held keys, and Unicode typing normalize into Windows input events', () => {
  const result = toLowLevel([
    { type: 'press', key: 'W' },
    { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'S'] },
    { type: 'key_down', key: 'SPACE' },
    { type: 'key_up', key: 'SPACE' },
    { type: 'type', text: 'Hi ✓' }
  ], { width: 1920, height: 1080 });
  assert.equal(normalizeKey('W'), 0x57);
  assert.equal(normalizeKey('F1'), 0x70);
  assert.equal(result.requestedActions, 5);
  assert.ok(result.operations.some(op => op.type === 'key_event' && op.vk === 0x57 && op.up === false));
  assert.ok(result.operations.some(op => op.type === 'key_event' && op.vk === 0x11 && op.up === false));
  assert.ok(result.operations.some(op => op.type === 'key_event' && op.vk === 0x11 && op.up === true));
  assert.ok(result.operations.some(op => op.type === 'unicode' && op.text === 'Hi ✓'));
});

test('input validation rejects off-screen coordinates, unsupported keys/buttons, and oversized sequences', () => {
  assert.throws(() => toLowLevel([{ type: 'click', x: 101, y: 10 }], { width: 101, height: 101 }), /inside the latest desktop screenshot/);
  assert.throws(() => toLowLevel([{ type: 'click', x: 10, y: 10, button: 'side' }], { width: 101, height: 101 }), /button must be left, right, or middle/);
  assert.throws(() => toLowLevel([{ type: 'press', key: 'NOT_A_KEY' }], { width: 101, height: 101 }), /Unsupported key/);
  assert.throws(() => toLowLevel(Array.from({ length: 51 }, () => ({ type: 'wait', durationMs: 0 })), { width: 100, height: 100 }), /between 1 and 50/);
  assert.throws(() => toLowLevel([{ type: 'type', text: 'x'.repeat(2001) }], { width: 100, height: 100 }), /character limit/);
  assert.equal(HOLD_FAILSAFE_MS, 10000);
});

test('the controller sends one encoded PowerShell batch and safely releases held keys on dispose', async () => {
  const calls = [];
  const controller = createWindowsInputController({
    platform: 'win32',
    getFrame: () => ({ width: 100, height: 100 }),
    executePowerShell: async (script, timeoutMs) => {
      const match = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
      assert.ok(match, 'payload should be passed as base64, not interpolated into PowerShell');
      calls.push({ operations: JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')), timeoutMs });
    }
  });
  const result = await controller.run([
    { type: 'click', x: 50, y: 50, button: 'right' },
    { type: 'hotkey', keys: ['CTRL', 'S'] },
    { type: 'key_down', key: 'W' }
  ], { width: 100, height: 100 });
  assert.equal(result.status, 'input_completed');
  assert.equal(result.actions_executed, 3);
  assert.equal(calls.length, 1, 'many input actions must be sent in one process call');
  assert.ok(calls[0].operations.length >= 8);
  await controller.dispose();
  assert.equal(calls.length, 2, 'dispose must release a held key');
  assert.ok(calls[1].operations.some(op => op.type === 'key_event' && op.vk === 0x57 && op.up === true));
});

test('control controller rejects non-Windows execution instead of silently pretending input succeeded', async () => {
  const controller = createWindowsInputController({
    platform: 'linux',
    executePowerShell: async () => { throw new Error('should not run'); }
  });
  await assert.rejects(controller.run([{ type: 'press', key: 'ENTER' }]), /only on Windows/);
  await controller.dispose();
});
