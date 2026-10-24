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
  for (const id of ['collapse', 'reload-chat', 'accounts', 'open-browser', 'quit', 'assistant-ball', 'threads', 'new-conversation', 'message-list', 'message-input', 'send-message', 'load-earlier', 'load-newer']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing UI control: ' + id);
    assert.ok(renderer.includes("'" + id + "'"), 'renderer does not bind UI control: ' + id);
  }
});

test('the visible surface is a bounded native mirror, not the embedded ChatGPT page', () => {
  const main = read('desktop', 'main.js');
  const html = read('desktop', 'index.html');
  const renderer = read('desktop', 'renderer.js');
  const mirror = read('desktop', 'conversation-mirror.js');
  assert.ok(html.includes('ChatGPT Mirror'));
  assert.ok(html.includes('Active ChatGPT conversation mirror'));
  assert.ok(html.includes('Message ChatGPT in this conversation'));
  assert.ok(main.includes('require(\'./conversation-mirror\')'));
  assert.ok(main.includes('x: -viewportWidth - 100'));
  assert.ok(main.includes('overlay:mirror-snapshot'));
  assert.ok(main.includes('overlay:mirror-send-message'));
  assert.ok(main.includes('settings.lastConversationUrl'));
  assert.ok(mirror.includes('const maxMessages = 16'));
  assert.ok(mirror.includes('rect.bottom > 0 && rect.top < window.innerHeight'));
  assert.ok(mirror.includes('scrollConversationViewport'));
  assert.ok(renderer.includes('onMirrorSnapshot'));
  assert.ok(renderer.includes('listMirrorConversations'));
  assert.ok(renderer.includes('sendMirrorMessage'));
  assert.ok(!html.includes('iframe'));
});

test('remote ChatGPT content uses a separate isolated WebContentsView', () => {
  const main = read('desktop', 'main.js');
  assert.ok(main.includes("new WebContentsView("));
  assert.ok(main.includes("windowRef.loadURL(getActiveConversationUrl() || 'https://chatgpt.com/auth/login')"));
  assert.ok(main.includes('function createChatGPTSessionWindow()'));
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
  for (const action of ['collapse', 'expand', 'reloadChat', 'openAccounts', 'openInBrowser', 'getGitHubState', 'quit', 'onCollapsedChanged']) {
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

test('desktop app runs local assistant_tool requests inside the same ChatGPT conversation', () => {
  const main = read('desktop', 'main.js');
  const bridge = read('desktop', 'tool-bridge.js');
  const protocol = read('desktop', 'command-protocol.js');
  const runner = read('desktop', 'tool-runner.js');
  assert.ok(main.includes("require('./tool-runner')"));
  assert.ok(main.includes("require('./tool-bridge')"));
  assert.ok(main.includes("String(targetUrl).startsWith('assistant-tool:')"));
  assert.ok(main.includes('toolBridge.installChatToolBridge()'));
  assert.ok(bridge.includes('language-assistant_tool'));
  assert.ok(bridge.includes('parseToolCall(raw)'));
  assert.ok(bridge.includes('await runTool(request.tool, request.args, request.callId)'));
  assert.ok(bridge.includes('submitMessageToChat'));
  assert.ok(bridge.includes('initializeCurrentConversation'));
  assert.ok(bridge.includes('buildBridgeContextMessage'));
  assert.ok(bridge.includes('bootstrapSignaled'));
  assert.ok(main.includes('hasBridgeBootstrap'));
  assert.ok(main.includes('recordBridgeBootstrap'));
  assert.ok(runner.includes('function executeTool'));
  assert.ok(protocol.includes('assistant_tool'));
  assert.ok(!main.includes("require('./repository-bridge')"));
  assert.ok(bridge.includes('runGitOperation(call)'));
  assert.ok(!bridge.includes('.chatgpt-bridge/requests/'));
});
test('collapsing releases focus so the previous app can remain active', () => {
  const main = read('desktop', 'main.js');
  const toggle = main.slice(main.indexOf('function toggleOverlay()'), main.indexOf('function assertLocalUi'));
  const collapsedBranch = toggle.slice(toggle.indexOf('collapseWindow();'));
  assert.ok(main.includes('if (mainWindow.isFocused()) mainWindow.blur()'));
  assert.ok(!collapsedBranch.includes('mainWindow.focus()'));
  assert.ok(toggle.includes('mainWindow.focus()'));
});


test('local tool catalogue is exposed without duplicating ChatGPT GitHub access', () => {
  const runner = read('desktop', 'tool-runner.js');
  const bridge = read('desktop', 'tool-bridge.js');
  const protocol = read('desktop', 'command-protocol.js');
  for (const tool of [
    'environment_info', 'directory_tree', 'file_info', 'git_log', 'git_show',
    'git_branches', 'git_changed_files', 'discover_instructions', 'create_directory',
    'move_path', 'delete_path', 'git_create_branch', 'git_switch_branch', 'git_commit',
    'git_fetch', 'git_pull', 'git_push', 'git_clone'
  ]) {
    assert.ok(runner.includes(tool) || bridge.includes(tool), 'missing tool implementation: ' + tool);
    assert.ok(protocol.includes(tool), 'tool protocol does not accept: ' + tool);
  }
  assert.ok(!bridge.includes("githubAuth.requestApi(args)"));
  assert.ok(!protocol.includes("'github_api'"));
  assert.ok(protocol.includes("case 'github': return { special: 'github_status' }"));
});

test('account login is isolated from the remote page and protects the GitHub token', () => {
  const main = read('desktop', 'main.js');
  const auth = read('desktop', 'github-auth.js');
  const accountsHtml = read('desktop', 'accounts.html');
  const accountsJs = read('desktop', 'accounts.js');
  assert.ok(main.includes('function assertAccountUi(event)'));
  assert.ok(main.includes("accountsWindow.loadFile(path.join(__dirname, 'accounts.html'))"));
  assert.ok(main.includes("safeStorage"));
  assert.ok(auth.includes('safeStorage.encryptString'));
  assert.ok(auth.includes('safeStorage.decryptString'));
  assert.ok(auth.includes('runGitOperation'));
  assert.ok(auth.includes('GIT_CONFIG_VALUE_0'));
  assert.ok(!auth.includes('requestApi(args)'));
  assert.ok(accountsHtml.includes('github-client-id'));
  assert.ok(accountsHtml.includes('local repository operations'));
  assert.ok(accountsHtml.includes('separate from ChatGPT\'s existing GitHub integration'));
  assert.ok(!accountsHtml.includes('github-repository'));
  assert.ok(accountsHtml.includes('chatgpt-login'));
  assert.ok(accountsJs.includes('startGitHubLogin'));
  assert.ok(!auth.includes('localStorage'));
  assert.ok(auth.includes('GIT_TERMINAL_PROMPT'));
  assert.ok(!auth.includes('github_api'));
});
