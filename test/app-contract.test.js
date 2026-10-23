const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('package starts the local desktop shell and packages desktop assets', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'desktop/main.js');
  assert.ok(pkg.build.files.includes('desktop/**/*'));
  assert.equal(pkg.build.productName, 'ChatGPT Assistant');
});

test('expanded and collapsed UI control IDs match the renderer', () => {
  const html = read('desktop', 'index.html');
  const renderer = read('desktop', 'renderer.js');
  for (const id of ['collapse', 'reload-chat', 'open-browser', 'quit', 'assistant-ball']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing UI control: ' + id);
    assert.ok(renderer.includes("'" + id + "'"), 'renderer does not bind UI control: ' + id);
  }
});

test('remote ChatGPT content uses a separate isolated WebContentsView', () => {
  const main = read('desktop', 'main.js');
  assert.ok(main.includes("new WebContentsView("));
  assert.ok(main.includes("partition: SESSION_PARTITION"));
  assert.ok(main.includes("contents.setWindowOpenHandler("));
  assert.ok(main.includes("contents.on('will-navigate'"));
  assert.ok(main.includes("contents.setUserAgent(defaultAgent.replace"));
  assert.ok((main.match(/nodeIntegration: false/g) || []).length >= 2);
  assert.ok((main.match(/contextIsolation: true/g) || []).length >= 2);
  assert.ok((main.match(/sandbox: true/g) || []).length >= 2);
  assert.ok((main.match(/webSecurity: true/g) || []).length >= 2);
});

test('preload exposes only named overlay actions, not general Node access', () => {
  const preload = read('desktop', 'preload.js');
  for (const action of ['collapse', 'expand', 'reloadChat', 'openInBrowser', 'quit', 'onCollapsedChanged']) {
    assert.ok(preload.includes(action), 'missing preload action: ' + action);
  }
  assert.ok(!preload.includes('node:fs'));
  assert.ok(!preload.includes('process.env'));
  assert.ok(!preload.includes('ipcRenderer.send('));
});

test('collapsed resizing relaxes and then restores the minimum window size', () => {
  const main = read('desktop', 'main.js');
  assert.ok(main.includes('mainWindow.setMinimumSize(1, 1)'));
  assert.ok(main.includes('function minimumSizeForBounds(bounds)'));
  assert.ok(main.includes('mainWindow.setMinimumSize(minimum.width, minimum.height)'));
  assert.ok(main.includes("mainWindow.contentView.removeChildView(chatView)"));
  assert.ok(main.includes("mainWindow.contentView.addChildView(chatView)"));
});

test('ChatGPT downloads use a user-confirmed Save dialog and sanitized filename', () => {
  const main = read('desktop', 'main.js');
  assert.ok(main.includes("chatSession.on('will-download'"));
  assert.ok(main.includes('item.setSaveDialogOptions('));
  assert.ok(main.includes("buttonLabel: 'Save'"));
  assert.ok(main.includes("replace(/[<>:\"|?*]/g, '_')"));
  assert.ok(main.includes("if (!source || !isEmbeddedHost(source.hostname))"));
  assert.ok(main.includes('item.cancel()'));
});

test('remote session allows sanitized clipboard write only', () => {
  const main = read('desktop', 'main.js');
  assert.ok(main.includes("new Set(['clipboard-sanitized-write'])"));
  assert.ok(main.includes('callback(allowedPermissions.has(permission))'));
  assert.ok(main.includes('return allowedPermissions.has(permission)'));
});

test('desktop app wires the local tool bridge into the ChatGPT view', () => {
  const main = read('desktop', 'main.js');
  const bridge = read('desktop', 'tool-bridge.js');
  assert.ok(main.includes("require('./tool-runner')"));
  assert.ok(main.includes("require('./tool-bridge')"));
  assert.ok(main.includes("String(targetUrl).startsWith('assistant-tool:')"));
  assert.ok(main.includes("toolBridge.installChatToolBridge()"));
  assert.ok(bridge.includes("language-assistant_tool"));
  assert.ok(bridge.includes("toolCallArmed = false"));
  assert.ok(bridge.includes("button[data-testid=\"stop-button\"]"));
  assert.ok(bridge.includes("const latestUser = users.length ? users[users.length - 1] : null"));
  assert.ok(bridge.includes("break; // One app tool call per assistant response"));
});

test('collapsing releases focus so the previous app can remain active', () => {
  const main = read('desktop', 'main.js');
  const toggle = main.slice(main.indexOf('function toggleOverlay()'), main.indexOf('function assertLocalUi'));
  const collapsedBranch = toggle.slice(toggle.indexOf('collapseWindow();'));
  assert.ok(main.includes('if (mainWindow.isFocused()) mainWindow.blur()'));
  assert.ok(!collapsedBranch.includes('mainWindow.focus()'));
  assert.ok(toggle.includes('mainWindow.focus()'));
});
