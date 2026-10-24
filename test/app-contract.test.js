'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('packaging includes the native Windows worker and mailbox implementation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'desktop/main.js');
  assert.ok(pkg.build.files.includes('desktop/**/*'));
  assert.ok(pkg.build.extraResources.some(resource => resource.from === 'vendor/gh' && resource.to === 'gh'));
  assert.ok(pkg.scripts['dist:win'].startsWith('node desktop/prepare-gh-cli.js && electron-builder'));
  assert.ok(pkg.scripts['dist:win:dir'].startsWith('node desktop/prepare-gh-cli.js && electron-builder'));
  assert.ok(pkg.scripts.prestart.includes('desktop/prepare-gh-cli.js'));
  assert.match(pkg.description, /shared GitHub repository mailbox/i);
  assert.match(pkg.scripts.check, /desktop\/repository-bridge\.js/);
  assert.match(pkg.scripts.check, /test\/repository-bridge\.test\.js/);
  assert.doesNotMatch(pkg.scripts.check, /accounts\.js/);
});

test('dashboard consolidates GitHub, workspace, worker and settings into one window', () => {
  const html = read('desktop', 'index.html');
  const renderer = read('desktop', 'renderer.js');
  for (const id of [
    'collapse', 'quit', 'github-status', 'github-login', 'github-logout',
    'repo-owner', 'repo-name', 'repo-branch', 'public-warning', 'bridge-config-form',
    'save-config', 'select-workspace', 'worker-toggle', 'open-chatgpt',
    'request-count', 'active-request', 'last-poll', 'last-error'
  ]) assert.ok(html.includes('id="' + id + '"'), 'missing dashboard element: ' + id);
  for (const action of ['saveBridgeConfig', 'startBridge', 'stopBridge', 'selectWorkspace', 'getState', 'getGitHubState', 'startGitHubLogin', 'pollGitHubLogin', 'openChatGPT', 'onBridgeState']) {
    assert.ok(renderer.includes('windowsBridge.' + action), 'renderer does not invoke ' + action);
  }
  assert.doesNotMatch(html, /open-accounts|poll-now|accounts\.html/);
  assert.match(html, /existing ChatGPT conversation/i);
  assert.match(html, /publicly readable/i);
  assert.match(html, /PowerShell.*not sandboxed/i);
  assert.match(html, /default browser/i);
  assert.match(html, /official GitHub CLI browser authorization flow/i);
  assert.doesNotMatch(html, /github-client-id|open-github-oauth-settings|Create an OAuth App/);
  assert.match(html, /sign in to ChatGPT/i);
  assert.doesNotMatch(renderer, /githubLogin\.disabled = authBusy \|\| busy \|\| !githubState\.configured/);
});

test('main process opens login in the system browser and returns focus after GitHub approval', () => {
  const main = read('desktop', 'main.js');
  assert.match(main, /require\('\.\/repository-bridge'\)/);
  assert.match(main, /createRepositoryBridge/);
  assert.match(main, /createGitHubAuth/);
  assert.match(main, /openInBrowserAndYield/);
  assert.match(main, /bringMainWindowForward/);
  assert.match(main, /'app:github-start-login'/);
  assert.match(main, /'app:github-poll-login'/);
  assert.match(main, /'app:open-chatgpt'/);
  assert.match(main, /chatgpt\.com\/auth\/login\//);
  assert.match(main, /startGitHubCliLogin/);
  assert.match(main, /githubAuth\.importToken/);
  assert.match(main, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(main, /login\.child\.stdin\.end/);
  assert.match(main, /openPromptReleased = true/);
  assert.match(main, /GH_CONFIG_DIR: path\.join\(app\.getPath\('userData'\), 'github-cli'\)/);
  assert.ok(main.includes("GH_BROWSER: path.join(windowsRoot, 'explorer.exe')"));
  assert.doesNotMatch(main, /clearGitHubCliCredentials|auth', 'logout/);
  assert.doesNotMatch(main, /const connected = await githubAuth\.importToken\(token\)/);
  assert.match(main, /repositoryBridge\.stop\(\)/);
  assert.doesNotMatch(main, /accountsWindow|assertAccountUi|createAccountsWindow|WebContentsView|conversation-mirror|installChatToolBridge/);
});

test('preload exposes specific mailbox and login actions without generic Node access', () => {
  const preload = read('desktop', 'preload.js');
  for (const action of ['getState', 'saveBridgeConfig', 'startBridge', 'stopBridge', 'selectWorkspace', 'openChatGPT', 'getGitHubState', 'startGitHubLogin', 'pollGitHubLogin', 'logoutGitHub', 'onBridgeState']) {
    assert.match(preload, new RegExp(action));
  }
  assert.doesNotMatch(preload, /openAccounts|pollNow|node:fs|process\.env|ipcRenderer\.send\(/);
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
  assert.match(bridge, /public-mailbox warning checkbox/i);
});

test('mailbox execution stays separate from ChatGPT messaging transport', () => {
  const bridge = read('desktop', 'tool-bridge.js');
  const main = read('desktop', 'main.js');
  assert.match(bridge, /async function runTool\(tool, inputArgs, callId = null\)/);
  assert.match(bridge, /requiresApproval:|askApproval/);
  assert.match(bridge, /The repository mailbox cannot invoke the app GitHub API directly/);
  assert.doesNotMatch(bridge, /document\.querySelector|executeJavaScript|assistant-tool:|language-assistant_tool|returnMessageToChat/);
  assert.doesNotMatch(main, /submitMessageToChat|insertAndSubmitToolMessage|assistant-tool:/);
});

test('inline GitHub auth stores an encrypted app-side credential and does not require ChatGPT login', () => {
  const main = read('desktop', 'main.js');
  const auth = read('desktop', 'github-auth.js');
  const html = read('desktop', 'index.html');
  const js = read('desktop', 'renderer.js');
  assert.match(main, /safeStorage/);
  assert.match(auth, /safeStorage\.encryptString/);
  assert.match(auth, /safeStorage\.decryptString/);
  assert.match(auth, /runGitOperation/);
  assert.doesNotMatch(html, /github-client-id/);
  assert.match(html, /separate login inside this app/i);
  assert.match(html, /open-chatgpt/);
  assert.match(js, /windowsBridge\.startGitHubLogin/);
  assert.match(js, /scheduleAuthPoll/);
  assert.match(main, /setAlwaysOnTop\(false\)/);
  assert.doesNotMatch(auth, /localStorage|github_api/);
});

test('collapsing the overlay preserves focus on the previously active Windows app', () => {
  const main = read('desktop', 'main.js');
  const toggle = main.slice(main.indexOf('function toggleOverlay()'), main.indexOf('function getSafeExternalUrl'));
  assert.match(main, /if \(mainWindow\.isFocused\(\)\) mainWindow\.blur\(\)/);
  assert.doesNotMatch(toggle.slice(toggle.indexOf('collapseWindow();')), /mainWindow\.focus\(\)/);
  assert.match(toggle, /mainWindow\.focus\(\)/);
});

test('environment snapshots and result artifacts stay in the repository channel', () => {
  const bridge = read('desktop', 'repository-bridge.js');
  const auth = read('desktop', 'github-auth.js');
  const toolBridge = read('desktop', 'tool-bridge.js');
  const html = read('desktop', 'index.html');
  const readme = read('README.md');
  assert.ok(bridge.includes('chatgpt-local-environment-context/v1'));
  assert.ok(bridge.includes('bridge/context/latest.json'));
  assert.ok(bridge.includes('refresh_environment_context'));
  assert.ok(bridge.includes('externalizeLargeText'));
  assert.ok(bridge.includes('bridge/artifacts/'));
  assert.ok(auth.includes('bridge/context'));
  assert.ok(auth.includes('bridge/artifacts'));
  assert.ok(toolBridge.includes('upload_workspace_file'));
  assert.ok(toolBridge.includes('requiresApproval: true'));
  assert.match(html, /never injects tool output into that conversation/i);
  assert.match(readme, /only input placed into ChatGPT is what you type yourself/i);
  assert.match(readme, /Read the result through the GitHub integration/i);
  assert.doesNotMatch(toolBridge, /submitMessageToChat|insertAndSubmitToolMessage|returnMessageToChat/);
});

test('manual smoke-test documentation covers local execution and artifact retrieval', () => {
  const guide = read('docs', 'manual-smoke-test.md');
  assert.match(guide, /private repo and dedicated branch/i);
  assert.match(guide, /read-only request produces a result/i);
  assert.match(guide, /large text is externalized and retrievable/i);
  assert.match(guide, /declined write remains unexecuted/i);
  assert.match(guide, /file upload requires a local approval/i);
  assert.match(guide, /no output is inserted into the ChatGPT conversation/i);
});
