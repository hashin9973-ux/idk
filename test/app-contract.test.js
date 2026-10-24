'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('packaging starts the native Windows bridge and includes its mailbox implementation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'desktop/main.js');
  assert.ok(pkg.build.files.includes('desktop/**/*'));
  assert.match(pkg.description, /shared GitHub repository mailbox/i);
  assert.match(pkg.scripts.check, /desktop\/repository-bridge\.js/);
  assert.match(pkg.scripts.check, /test\/repository-bridge\.test\.js/);
});

test('dashboard presents the shared repository mailbox and native worker controls', () => {
  const html = read('desktop', 'index.html');
  const renderer = read('desktop', 'renderer.js');
  for (const id of [
    'accounts', 'collapse', 'quit', 'repo-owner', 'repo-name', 'repo-branch',
    'public-warning', 'bridge-config-form', 'save-config', 'open-accounts',
    'select-workspace', 'start-worker', 'stop-worker', 'poll-now',
    'request-count', 'active-request', 'last-poll', 'last-error'
  ]) {
    assert.ok(html.includes('id="' + id + '"'), 'missing dashboard element: ' + id);
  }
  for (const action of [
    'saveBridgeConfig', 'startBridge', 'stopBridge', 'pollNow',
    'selectWorkspace', 'getState', 'onBridgeState'
  ]) {
    assert.ok(renderer.includes('windowsBridge.' + action), 'renderer does not invoke ' + action);
  }
  assert.match(html, /existing ChatGPT conversation/i);
  assert.match(html, /publicly readable/i);
  assert.match(html, /PowerShell is not sandboxed/i);
  assert.doesNotMatch(html, /Active ChatGPT conversation mirror|Message ChatGPT in this conversation|iframe/i);
});

test('main process connects the GitHub mailbox worker without embedding or automating ChatGPT', () => {
  const main = read('desktop', 'main.js');
  assert.match(main, /require\('\.\/repository-bridge'\)/);
  assert.match(main, /createRepositoryBridge/);
  assert.match(main, /createGitHubAuth/);
  assert.match(main, /toolBridge\.runTool\(tool, args, requestId, \{ deliverToChat: false \}\)/);
  assert.match(main, /'app:start-bridge'/);
  assert.match(main, /'app:stop-bridge'/);
  assert.match(main, /'app:poll-now'/);
  assert.match(main, /repositoryBridge\.stop\(\)/);
  assert.doesNotMatch(main, /WebContentsView|chatgpt\.com|conversation-mirror|installChatToolBridge/);
});

test('preload exposes only named mailbox operations, not general Node access', () => {
  const preload = read('desktop', 'preload.js');
  for (const action of [
    'getState', 'saveBridgeConfig', 'startBridge', 'stopBridge', 'pollNow',
    'selectWorkspace', 'openAccounts', 'getGitHubState', 'setGitHubClientId',
    'startGitHubLogin', 'pollGitHubLogin', 'logoutGitHub', 'onBridgeState'
  ]) {
    assert.match(preload, new RegExp(action));
  }
  assert.doesNotMatch(preload, /node:fs|process\.env|ipcRenderer\.send\(/);
});

test('repository mailbox has explicit request, result, claim and heartbeat paths', () => {
  const bridge = read('desktop', 'repository-bridge.js');
  assert.match(bridge, /chatgpt-local-repo-bridge\/v1/);
  assert.match(bridge, /chatgpt-local-repo-result\/v1/);
  assert.match(bridge, /bridge\/requests\//);
  assert.match(bridge, /bridge\/results\//);
  assert.match(bridge, /bridge\/claims\//);
  assert.match(bridge, /bridge\/state\/windows-app\.json/);
  assert.match(bridge, /DEFAULT_INTERVAL_MS = 15000/);
  assert.match(bridge, /needs_manual_recovery/);
  assert.match(bridge, /publishState/);
  assert.match(bridge, /allowPublicMailbox/);
  assert.match(bridge, /publicly readable/);
});

test('mailbox tool execution is separated from the old ChatGPT page transport', () => {
  const bridge = read('desktop', 'tool-bridge.js');
  const main = read('desktop', 'main.js');
  assert.match(bridge, /async function runTool\(tool, inputArgs, callId = null, runOptions = \{\}\)/);
  assert.match(bridge, /requiresApproval:|askApproval/);
  assert.match(bridge, /The repository mailbox cannot invoke the app GitHub API directly/);
  assert.doesNotMatch(bridge, /document\.querySelector|executeJavaScript|assistant-tool:|language-assistant_tool|returnMessageToChat/);
  assert.doesNotMatch(main, /submitMessageToChat|insertAndSubmitToolMessage|assistant-tool:/);
});

test('account dialog manages app-side GitHub OAuth but not a duplicate ChatGPT account session', () => {
  const main = read('desktop', 'main.js');
  const auth = read('desktop', 'github-auth.js');
  const html = read('desktop', 'accounts.html');
  const js = read('desktop', 'accounts.js');
  assert.match(main, /function assertAccountUi\(event\)/);
  assert.match(main, /safeStorage/);
  assert.match(auth, /safeStorage\.encryptString/);
  assert.match(auth, /safeStorage\.decryptString/);
  assert.match(auth, /runGitOperation/);
  assert.match(html, /github-client-id/);
  assert.match(html, /shared repository/i);
  assert.match(html, /separate from ChatGPT/);
  assert.doesNotMatch(html, /chatgpt-login|ChatGPT sign-in window|conversation mirror/i);
  assert.match(js, /windowsBridge\.startGitHubLogin/);
  assert.doesNotMatch(auth, /localStorage|github_api/);
});

test('collapsing the overlay preserves focus on the previously active Windows app', () => {
  const main = read('desktop', 'main.js');
  const toggle = main.slice(main.indexOf('function toggleOverlay()'), main.indexOf('function getSafeExternalUrl'));
  assert.match(main, /if \(mainWindow\.isFocused\(\)\) mainWindow\.blur\(\)/);
  assert.doesNotMatch(toggle.slice(toggle.indexOf('collapseWindow();')), /mainWindow\.focus\(\)/);
  assert.match(toggle, /mainWindow\.focus\(\)/);
});
