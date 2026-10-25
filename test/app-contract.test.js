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

test('dashboard is a minimal GitHub and worker status window', () => {
  const html = read('desktop', 'index.html');
  const renderer = read('desktop', 'renderer.js');
  for (const id of ['github-row', 'github-signin', 'github-dot', 'github-status', 'worker-dot', 'worker-status', 'workspace-row', 'workspace-dot', 'workspace-status', 'auto-accept-row', 'auto-accept-dot', 'auto-accept-status', 'minimize', 'quit']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing status element: ' + id);
  }
  assert.match(renderer, /GitHub connected/);
  assert.match(renderer, /Sign in to GitHub/);
  assert.match(renderer, /githubButton\.textContent = loginCode/);
  assert.match(renderer, /Enter code at GitHub/);
  assert.match(renderer, /copyGitHubDeviceCode/);
  assert.match(renderer, /onGitHubDeviceCode/);
  assert.match(renderer, /githubButton\.addEventListener\('click', \(\) => \{/);
  assert.match(renderer, /void connectGitHub\(\)/);
  assert.match(renderer, /windowsBridge\.reconnectGitHub/);
  assert.match(renderer, /windowsBridge\.retryConnection/);
  assert.match(renderer, /Worker online/);
  assert.match(renderer, /windowsBridge\.minimizeToTray/);
  assert.match(renderer, /windowsBridge\.startGitHubLogin/);
  assert.match(renderer, /windowsBridge\.setAutoAcceptAll/);
  assert.match(renderer, /windowsBridge\.selectWorkspace/);
  assert.match(renderer, /Workspace: /);
  assert.match(renderer, /Current folder: /);
  assert.match(renderer, /Auto-accept everything: ON/);
  assert.doesNotMatch(html, /titlebar|brand-copy|settings-panel|worker-toggle|Start worker|open-chatgpt|workspace-heading|details-panel/);
  assert.match(html, /auto-accept-row/);
  assert.doesNotMatch(renderer, /windowsBridge\.(startBridge|stopBridge|saveBridgeConfig|openChatGPT)/);
});

test('main process opens login in the system browser and returns focus after GitHub approval', () => {
  const main = read('desktop', 'main.js');
  assert.match(main, /require\('\.\/repository-bridge'\)/);
  assert.match(main, /createRepositoryBridge/);
  assert.match(main, /createGitHubAuth/);
  assert.match(main, /resolveWorkspaceRoot/);
  assert.match(main, /getDefaultWorkspaceRoot/);
  assert.ok(main.includes("path.join(app.getPath('userData'), 'ChatGPTWorkspace')"));
  assert.match(main, /openInBrowserAndYield/);
  assert.match(main, /bringMainWindowForward/);
  assert.match(main, /'app:github-start-login'/);
  assert.match(main, /'app:github-poll-login'/);
  assert.match(main, /'app:retry-connection'/);
  assert.match(main, /AUTO_CONNECT_INTERVAL_MS = 5000/);
  assert.match(main, /ready-to-show/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /startup failed/i);
  assert.match(main, /'app:select-workspace'/);
  assert.match(main, /function selectWorkspace\(\)/);
  assert.match(main, /height: 164/);
  assert.match(main, /startGitHubCliLogin/);
  assert.match(main, /githubAuth\.importToken/);
  assert.match(main, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(main, /login\.child\.stdin\.end/);
  assert.match(main, /openPromptReleased = true/);
  assert.match(main, /webContents\.send\('app:github-device-code', login\.userCode\)/);
  assert.match(main, /app:copy-device-code/);
  assert.match(main, /clipboard\.writeText\(code\)/);
  assert.ok(main.includes("login.child.stdin.end('\\n')"));
  assert.match(main, /GH_CONFIG_DIR: path\.join\(app\.getPath\('userData'\), 'github-cli'\)/);
  assert.ok(main.includes("GH_BROWSER: path.join(windowsRoot, 'explorer.exe')"));
  assert.doesNotMatch(main, /clearGitHubCliCredentials|auth', 'logout/);
  assert.doesNotMatch(main, /const connected = await githubAuth\.importToken\(token\)/);
  assert.match(main, /repositoryBridge\.stop\(\)/);
  assert.doesNotMatch(main, /accountsWindow|assertAccountUi|createAccountsWindow|WebContentsView|conversation-mirror|installChatToolBridge/);
});

test('preload exposes only the minimal status, tray, and GitHub login actions', () => {
  const preload = read('desktop', 'preload.js');
  for (const action of ['getState', 'selectWorkspace', 'setAutoAcceptAll', 'minimizeToTray', 'quit', 'getGitHubState', 'startGitHubLogin', 'reconnectGitHub', 'pollGitHubLogin', 'retryConnection', 'copyDeviceCode', 'onGitHubDeviceCode', 'onBridgeState']) {
    assert.match(preload, new RegExp(action));
  }
  assert.doesNotMatch(preload, /startBridge|stopBridge|saveBridgeConfig|openChatGPT|logoutGitHub|node:fs|process\.env|ipcRenderer\.send\(/);
});

test('desktop shell, tray, and IPC controls initialize before workspace services', () => {
  const main = read('desktop', 'main.js');
  const startup = main.slice(main.indexOf('app.whenReady().then'));
  assert.ok(startup.indexOf('registerIpc();') >= 0);
  assert.ok(startup.indexOf('createTray();') >= 0);
  assert.ok(startup.indexOf('createMainWindow();') >= 0);
  assert.ok(startup.indexOf('registerIpc();') < startup.indexOf('ensureWorkspaceRoot();'));
  assert.ok(startup.indexOf('createTray();') < startup.indexOf('ensureWorkspaceRoot();'));
  assert.ok(startup.indexOf('createMainWindow();') < startup.indexOf('ensureWorkspaceRoot();'));
  assert.match(main, /if \(icon\.isEmpty\(\)\)/);
  assert.match(main, /trayInitializationError/);
  assert.match(main, /skipTaskbar: Boolean\(tray\)/);
  assert.match(main, /function createTray\(\)[\s\S]*?return false;/);
  assert.match(main, /if \(!githubAuth\) throw new Error/);
  assert.match(main, /ipcRegistered = true/);
});

test('repository mailbox has explicit request, result, claim and heartbeat paths', () => {
  const bridge = read('desktop', 'repository-bridge.js');
  assert.match(bridge, /chatgpt-local-repo-bridge\/v1/);
  assert.match(bridge, /chatgpt-local-repo-result\/v1/);
  assert.match(bridge, /bridge\/requests\//);
  assert.match(bridge, /bridge\/results\//);
  assert.match(bridge, /bridge\/claims\//);
  assert.match(bridge, /bridge\/state\/windows-app\.json/);
  assert.match(bridge, /DEFAULT_INTERVAL_MS = 2000/);
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
  assert.match(html, /github-row/);
  assert.match(js, /windowsBridge\.startGitHubLogin/);
  assert.match(js, /scheduleAuthPoll/);
  assert.match(main, /setAlwaysOnTop\(false\)/);
  assert.doesNotMatch(auth, /localStorage|github_api/);
});

test('the status window minimizes to the system tray and the worker starts automatically', () => {
  const main = read('desktop', 'main.js');
  const html = read('desktop', 'index.html');
  assert.match(main, /new Tray\(/);
  assert.match(main, /tray\.setContextMenu/);
  assert.match(main, /label: 'Open status'/);
  assert.match(main, /label: 'Quit'/);
  assert.match(main, /mainWindow\.on\('minimize', event => \{\s*event\.preventDefault\(\);\s*hideToTray\(\);/);
  assert.match(main, /mainWindow\.on\('close', event => \{\s*if \(!finishingQuit\) \{\s*event\.preventDefault\(\);\s*hideToTray\(\);/);
  assert.match(main, /function startAutoConnectLoop\(\)/);
  assert.match(main, /setInterval\(\(\) => \{ void attemptAutoConnect\(\); \}, AUTO_CONNECT_INTERVAL_MS\)/);
  assert.match(main, /owner: 'hashin9973-ux'/);
  assert.match(main, /repo: 'qdqwg'/);
  assert.match(main, /branch: 'bridge-mailbox'/);
  assert.match(main, /startAutoConnectLoop\(\)/);
  assert.doesNotMatch(main, /app:start-bridge|app:stop-bridge/);
  assert.doesNotMatch(html, /Start worker|worker-toggle|titlebar|settings-panel/);
  assert.match(main, /Keep the worker and tray icon alive while the status window is hidden/);
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
  assert.match(readme, /only input placed into ChatGPT is what you type yourself/i);
  assert.match(readme, /Read the result through the GitHub integration/i);
  assert.doesNotMatch(toolBridge, /submitMessageToChat|insertAndSubmitToolMessage|returnMessageToChat/);
});

test('manual smoke-test documentation covers local execution, truncated-output recovery, and artifact retrieval', () => {
  const guide = read('docs', 'manual-smoke-test.md');
  assert.match(guide, /private repo and dedicated branch/i);
  assert.match(guide, /read-only request produces a result/i);
  assert.match(guide, /large output is marked incomplete honestly/i);
  assert.match(guide, /stable-sorted pages of 50 entries/i);
  assert.match(guide, /not a safety denial/i);
  assert.match(guide, /workspace file edits run automatically without escaping the selected folder/i);
  assert.match(guide, /declined shell command remains unexecuted/i);
  assert.match(guide, /file upload requires a local approval/i);
  assert.match(guide, /no output is inserted into the ChatGPT conversation/i);
});


test('optional Colab vision bridge is wired to the existing mailbox without autostart or runtime shutdown', () => {
  const main = read('desktop', 'main.js');
  const bridge = read('desktop', 'tool-bridge.js');
  const vision = read('desktop', 'vision-service.js');
  const auth = read('desktop', 'github-auth.js');
  const notebook = JSON.parse(read('vision', 'vision_worker.ipynb'));
  const python = notebook.cells.filter(cell => cell.cell_type === 'code').map(cell => cell.source.join('')).join('\n');
  for (const name of ['vision_activate', 'vision_deactivate', 'vision_status', 'vision_analyze_screenshot', 'vision_wait']) {
    assert.ok(bridge.includes(name), 'missing vision tool ' + name);
  }
  assert.ok(main.includes('createVisionService'));
  assert.ok(main.includes('captureDesktopScreenshot'));
  assert.ok(main.includes('encodeVisionJpeg'));
  assert.ok(main.includes('colab.research.google.com'));
  assert.ok(vision.includes('runtime_kept_alive: true'));
  assert.ok(vision.includes('MAX_SCREENSHOT_BYTES = 600 * 1024'));
  assert.ok(vision.includes('input_sha256'));
  assert.ok(vision.includes('VISION_RESULT_PROTOCOL'));
  assert.ok(auth.includes('bridge/vision/runtime.json'));
  assert.ok(auth.includes('chatgpt-colab-vision-control/v1'));
  assert.ok(python.includes('userdata.get("QDQWG_TOKEN")'));
  assert.ok(python.includes('Qwen3VL-8B-Instruct-Q4_K_M.gguf'));
  assert.ok(python.includes('mmproj-Qwen3VL-8B-Instruct-F16.gguf'));
  assert.ok(python.includes('llama-server'));
  assert.ok(python.includes('bridge/vision/control.json'));
  assert.ok(python.includes('bridge/vision/results/'));
  assert.ok(python.includes('def cleanup_screenshot'));
  assert.equal(main.slice(main.indexOf('app.whenReady().then')).includes('visionService.activate('), false);
  assert.equal(/process\.kill|kill\(\)|shutdown.*Colab/i.test(vision), false);
});

