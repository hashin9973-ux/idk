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
