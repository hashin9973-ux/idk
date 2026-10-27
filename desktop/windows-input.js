'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const BUTTONS = Object.freeze({
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 }
});

const KEY_CODES = {
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, CONTROL: 0x11,
  ALT: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b, ESCAPE: 0x1b, SPACE: 0x20,
  PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26,
  RIGHT: 0x27, DOWN: 0x28, PRINTSCREEN: 0x2c, INSERT: 0x2d, DELETE: 0x2e,
  META: 0x5b, WIN: 0x5b, CONTEXTMENU: 0x5d, NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  BACKTICK: 0xc0, MINUS: 0xbd, EQUAL: 0xbb, LEFTBRACKET: 0xdb, RIGHTBRACKET: 0xdd,
  BACKSLASH: 0xdc, SEMICOLON: 0xba, QUOTE: 0xde, COMMA: 0xbc, PERIOD: 0xbe, SLASH: 0xbf
};
for (let i = 0; i < 26; i++) KEY_CODES[String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) KEY_CODES[String(i)] = 0x30 + i;
for (let i = 1; i <= 24; i++) KEY_CODES['F' + i] = 0x6f + i;
for (let i = 0; i <= 9; i++) KEY_CODES['NUMPAD' + i] = 0x60 + i;
Object.freeze(KEY_CODES);

const HIGH_LEVEL_TYPES = new Set([
  'click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey',
  'mouse_down', 'mouse_up', 'key_down', 'key_up', 'wait'
]);
const MAX_SEQUENCE_STEPS = 50;
const MAX_TEXT_LENGTH = 2000;
const HOLD_FAILSAFE_MS = 10000;

function normalizeKey(value) {
  if (typeof value !== 'string') throw new Error('key must be a named key such as W, ENTER, CTRL, SPACE, or F1.');
  const key = value.trim().toUpperCase();
  if (Object.hasOwn(KEY_CODES, key)) return KEY_CODES[key];
  throw new Error('Unsupported key "' + value + '". Use letters, digits, F1–F24, arrows, modifiers, or common named keys.');
}

function finiteCoordinate(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + ' must be a finite screen coordinate in pixels.');
  return value;
}

function normalizeButton(value) {
  const button = String(value || 'left').toLowerCase();
  if (!Object.hasOwn(BUTTONS, button)) throw new Error('button must be left, right, or middle.');
  return button;
}

function boundedInteger(value, label, min, max, fallback = 0) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + ' must be an integer from ' + min + ' to ' + max + '.');
  return value;
}

function coordinateToAbsolute(value, size, label) {
  const coordinate = finiteCoordinate(value, label);
  if (coordinate < 0 || coordinate >= size) throw new Error(label + ' must fall inside the latest desktop screenshot (0–' + (size - 1) + ').');
  return Math.max(0, Math.min(65535, Math.round((coordinate / Math.max(1, size - 1)) * 65535)));
}

function toLowLevel(steps, frame) {
  const width = Number.isInteger(frame && frame.width) && frame.width > 0 ? frame.width : 1920;
  const height = Number.isInteger(frame && frame.height) && frame.height > 0 ? frame.height : 1080;
  const operations = [];
  const heldUpdates = [];
  let requestedActions = 0;

  function moveTo(x, y) {
    operations.push({ type: 'move', x: coordinateToAbsolute(x, width, 'x'), y: coordinateToAbsolute(y, height, 'y') });
  }
  function button(buttonValue, down) {
    const name = normalizeButton(buttonValue);
    operations.push({ type: 'mouse_event', flags: BUTTONS[name][down ? 'down' : 'up'], data: 0 });
    heldUpdates.push({ kind: 'button', id: name, down: Boolean(down) });
  }
  function key(keyValue, down) {
    const vk = normalizeKey(keyValue);
    operations.push({ type: 'key_event', vk, up: !down });
    heldUpdates.push({ kind: 'key', id: String(vk), vk, down: Boolean(down) });
  }
  function wheel(value, horizontal = false) {
    if (!Number.isInteger(value) || value < -12000 || value > 12000) throw new Error('scroll delta must be an integer between -12000 and 12000.');
    if (value) operations.push({ type: 'mouse_event', flags: horizontal ? 0x1000 : 0x0800, data: value >>> 0 });
  }
  function addOne(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Every input step must be an object.');
    const type = step.type || step.action;
    if (!HIGH_LEVEL_TYPES.has(type)) throw new Error('Unsupported input step type: ' + String(type) + '.');
    requestedActions++;
    switch (type) {
      case 'move': {
        const x = finiteCoordinate(step.x, 'x');
        const y = finiteCoordinate(step.y, 'y');
        const duration = boundedInteger(step.durationMs, 'durationMs', 0, 3000, 0);
        const start = step.fromX !== undefined && step.fromY !== undefined
          ? { x: finiteCoordinate(step.fromX, 'fromX'), y: finiteCoordinate(step.fromY, 'fromY') } : null;
        if (start) moveTo(start.x, start.y);
        if (duration > 0 && start) {
          const frames = Math.max(1, Math.min(60, Math.ceil(duration / 16)));
          for (let i = 1; i <= frames; i++) {
            const ratio = i / frames;
            moveTo(start.x + (x - start.x) * ratio, start.y + (y - start.y) * ratio);
            operations.push({ type: 'wait', ms: Math.max(1, Math.floor(duration / frames)) });
          }
        } else moveTo(x, y);
        break;
      }
      case 'click': {
        moveTo(step.x, step.y);
        const buttonName = normalizeButton(step.button);
        const clicks = boundedInteger(step.clicks, 'clicks', 1, 3, 1);
        for (let i = 0; i < clicks; i++) {
          button(buttonName, true); button(buttonName, false);
          if (i + 1 < clicks) operations.push({ type: 'wait', ms: 35 });
        }
        break;
      }
      case 'drag': {
        moveTo(step.fromX, step.fromY);
        const buttonName = normalizeButton(step.button);
        button(buttonName, true);
        const toX = finiteCoordinate(step.x, 'x');
        const toY = finiteCoordinate(step.y, 'y');
        const fromX = finiteCoordinate(step.fromX, 'fromX');
        const fromY = finiteCoordinate(step.fromY, 'fromY');
        const duration = boundedInteger(step.durationMs, 'durationMs', 0, 3000, 120);
        const frames = duration > 0 ? Math.max(1, Math.min(60, Math.ceil(duration / 16))) : 1;
        for (let i = 1; i <= frames; i++) {
          const ratio = i / frames;
          moveTo(fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio);
          if (duration > 0) operations.push({ type: 'wait', ms: Math.max(1, Math.floor(duration / frames)) });
        }
        button(buttonName, false);
        break;
      }
      case 'scroll':
        if (step.x !== undefined || step.y !== undefined) moveTo(step.x, step.y);
        wheel(boundedInteger(step.deltaY, 'deltaY', -12000, 12000, 0));
        wheel(boundedInteger(step.deltaX, 'deltaX', -12000, 12000, 0), true);
        break;
      case 'press':
        key(step.key, true); key(step.key, false);
        break;
      case 'key_down': key(step.key, true); break;
      case 'key_up': key(step.key, false); break;
      case 'hotkey': {
        if (!Array.isArray(step.keys) || step.keys.length < 1 || step.keys.length > 8) throw new Error('keys must contain 1–8 named keys for hotkey.');
        const keys = step.keys.map(normalizeKey);
        for (const vk of keys) {
          operations.push({ type: 'key_event', vk, up: false });
          heldUpdates.push({ kind: 'key', id: String(vk), vk, down: true });
        }
        for (const vk of keys.slice().reverse()) {
          operations.push({ type: 'key_event', vk, up: true });
          heldUpdates.push({ kind: 'key', id: String(vk), vk, down: false });
        }
        break;
      }
      case 'type':
        if (typeof step.text !== 'string') throw new Error('text must be a string.');
        if (step.text.length > MAX_TEXT_LENGTH) throw new Error('text exceeds the ' + MAX_TEXT_LENGTH + ' character limit.');
        if (step.text) operations.push({ type: 'unicode', text: step.text });
        break;
      case 'mouse_down':
      case 'mouse_up':
        if (step.x !== undefined || step.y !== undefined) moveTo(step.x, step.y);
        button(step.button, type === 'mouse_down');
        break;
      case 'wait':
        operations.push({ type: 'wait', ms: boundedInteger(step.durationMs, 'durationMs', 0, 5000, 100) });
        break;
    }
  }

  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_SEQUENCE_STEPS) {
    throw new Error('steps must contain between 1 and ' + MAX_SEQUENCE_STEPS + ' input actions.');
  }
  for (const step of steps) addOne(step);
  if (!operations.length) throw new Error('No input events were generated.');
  return { operations, heldUpdates, requestedActions, frame: { width, height } };
}

const POWERSHELL_RUNNER = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class WrbNativeInput {',
  '    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION U; }',
  '    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '    private static void Send(INPUT item) { INPUT[] items = new INPUT[] { item }; if (SendInput(1, items, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput failed with Win32 error " + Marshal.GetLastWin32Error()); }',
  '    public static void Move(int x, int y) { INPUT i = new INPUT(); i.type = 0; i.U.mi.dx = x; i.U.mi.dy = y; i.U.mi.dwFlags = 0x8000 | 0x0001; Send(i); }',
  '    public static void Mouse(uint flags, uint data) { INPUT i = new INPUT(); i.type = 0; i.U.mi.mouseData = data; i.U.mi.dwFlags = flags; Send(i); }',
  '    public static void Key(ushort vk, bool up) { INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.dwFlags = up ? 0x0002u : 0u; Send(i); }',
  '    public static void Unicode(ushort ch, bool up) { INPUT i = new INPUT(); i.type = 1; i.U.ki.wScan = ch; i.U.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u); Send(i); }',
  '}',
  "'@",
  "$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PAYLOAD__'))",
  '$operations = ConvertFrom-Json -InputObject $payload',
  'foreach ($op in $operations) {',
  '  switch ([string]$op.type) {',
  "    'move' { [WrbNativeInput]::Move([int]$op.x, [int]$op.y) }",
  "    'mouse_event' { [WrbNativeInput]::Mouse([uint32]$op.flags, [uint32]$op.data) }",
  "    'key_event' { [WrbNativeInput]::Key([uint16]$op.vk, [bool]$op.up) }",
  "    'unicode' { foreach ($character in ([string]$op.text).ToCharArray()) { [WrbNativeInput]::Unicode([uint16][char]$character, $false); [WrbNativeInput]::Unicode([uint16][char]$character, $true) } }",
  "    'wait' { Start-Sleep -Milliseconds ([Math]::Min(5000, [Math]::Max(0, [int]$op.ms))) }",
  "    default { throw ('Unsupported low-level input type: ' + [string]$op.type) }",
  '  }',
  '}',
  "[Console]::Out.WriteLine('{""ok"":true}')",
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
].join('\n');

function createWindowsInputController(options = {}) {
  const platform = options.platform || process.platform;
  const executePowerShell = options.executePowerShell || defaultExecutePowerShell;
  const getFrame = options.getFrame || (() => ({ width: 1920, height: 1080 }));
  const held = new Map();
  let disposed = false;

  async function runLowLevel(operations, timeoutMs = 8000) {
    if (disposed) throw new Error('Computer input is shutting down.');
    if (platform !== 'win32') throw new Error('Mouse and keyboard input is available only on Windows.');
    const payload = Buffer.from(JSON.stringify(operations), 'utf8').toString('base64');
    await executePowerShell(POWERSHELL_RUNNER.replace('__PAYLOAD__', payload), timeoutMs);
  }

  function cancelHeld(kind, id) {
    const k = kind + ':' + id;
    const prior = held.get(k);
    if (prior) clearTimeout(prior.timer);
    held.delete(k);
  }

  function scheduleHeld(update) {
    const k = update.kind + ':' + update.id;
    if (!update.down) {
      cancelHeld(update.kind, update.id);
      return;
    }
    cancelHeld(update.kind, update.id);
    const timer = setTimeout(() => {
      held.delete(k);
      const op = update.kind === 'key'
        ? { type: 'key_event', vk: update.vk, up: true }
        : { type: 'mouse_event', flags: BUTTONS[update.id].up, data: 0 };
      void runLowLevel([op]).catch(() => {});
    }, HOLD_FAILSAFE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    held.set(k, { ...update, timer });
  }

  async function releaseAll() {
    const entries = [...held.values()];
    for (const item of entries) clearTimeout(item.timer);
    held.clear();
    const operations = entries.map(item => item.kind === 'key'
      ? { type: 'key_event', vk: item.vk, up: true }
      : { type: 'mouse_event', flags: BUTTONS[item.id].up, data: 0 });
    if (operations.length) await runLowLevel(operations);
    return { released: operations.length };
  }

  async function run(steps, frameOverride) {
    const { operations, heldUpdates, requestedActions, frame } = toLowLevel(steps, frameOverride || getFrame());
    const startedAt = Date.now();
    try {
      const requestedWait = operations.reduce((total, op) => total + (op.type === 'wait' ? op.ms : 0), 0);
      await runLowLevel(operations, Math.max(8000, Math.min(30000, requestedWait + 5000)));
      for (const update of heldUpdates) scheduleHeld(update);
      return {
        status: 'input_completed', actions_executed: requestedActions,
        input_events: operations.length, duration_ms: Date.now() - startedAt,
        coordinate_frame: frame, held_input_failsafe_ms: HOLD_FAILSAFE_MS
      };
    } catch (error) {
      try { await releaseAll(); } catch {}
      // The PowerShell process can fail after sending a key/button down but before its
      // matching up event. Release every input that this batch may have left held.
      const emergency = heldUpdates.filter(update => update.down).map(update => update.kind === 'key'
        ? { type: 'key_event', vk: update.vk, up: true }
        : { type: 'mouse_event', flags: BUTTONS[update.id].up, data: 0 });
      try { if (emergency.length) await runLowLevel(emergency); } catch {}
      throw new Error('Windows input failed: ' + String(error && error.message || error));
    }
  }

  async function dispose() {
    try { await releaseAll(); } finally { disposed = true; }
  }

  return Object.freeze({ run, releaseAll, dispose, getFrame: () => ({ ...(getFrame() || {}) }) });
}

async function defaultExecutePowerShell(script, timeoutMs) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = systemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execFileAsync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' });
}

module.exports = { createWindowsInputController, toLowLevel, normalizeKey, KEY_CODES, BUTTONS, HOLD_FAILSAFE_MS };
