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
  const styles = read('desktop', 'styles.css');
  const main = read('desktop', 'main.js');
  for (const id of ['github-row', 'github-signin', 'github-dot', 'github-status', 'worker-dot', 'worker-status', 'workspace-row', 'workspace-dot', 'workspace-status', 'auto-accept-row', 'auto-accept-dot', 'auto-accept-status', 'observe-row', 'observe-dot', 'observe-status', 'observe-fps', 'vision-row', 'vision-dot', 'vision-status', 'vision-signin', 'vision-paste-url', 'vision-manual-panel', 'vision-endpoint-url', 'vision-endpoint-connect', 'vision-endpoint-cancel', 'vision-setup-check', 'vision-setup-detail', 'vision-mailbox-detail', 'vision-colab-detail', 'vision-model-detail', 'vision-message', 'open-dashboard', 'minimize', 'quit']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing status element: ' + id);
  }
  assert.match(html, /title="Observe the desktop at the selected sampling rate/);
  assert.match(html, /value="2" selected>2 fps \(default\)/);
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
  assert.ok(renderer.includes("active > 0 ? 'Worker online · ' + active + ' active'"));
  assert.ok(renderer.includes("pending > 0 ? 'Worker online · ' + pending + ' queued'"));
  assert.ok(renderer.includes(": 'Worker online · idle'"));
  assert.match(renderer, /Worker cannot reach the GitHub mailbox/);
  assert.match(renderer, /Last successful request scan:/);
  assert.match(renderer, /Mailbox transport error:/);
  assert.match(renderer, /Recent tool\/result issue \(worker still reachable\):/);
  assert.match(renderer, /windowsBridge\.minimizeToTray/);
  assert.match(renderer, /windowsBridge\.startGitHubLogin/);
  assert.match(renderer, /windowsBridge\.setAutoAcceptAll/);
  assert.match(renderer, /windowsBridge\.selectWorkspace/);
  assert.match(renderer, /windowsBridge\.getVisionStatus/);
  assert.match(renderer, /windowsBridge\.getObserveStatus/);
  assert.match(renderer, /windowsBridge\.setObserveEnabled/);
  assert.match(renderer, /windowsBridge\.setObserveFps/);
  assert.match(renderer, /recent frame/);
  assert.match(renderer, /Retained changed frames:.*buffer size, not FPS/);
  assert.match(renderer, /Successful captures this session/);
  assert.match(main, /app:observe-fps/);
  assert.match(main, /clearStaleContext\(\)/);
  assert.match(main, /Promise\.allSettled\(disposals\)\.finally\(\(\) => app\.quit\(\)\)/);
  assert.doesNotMatch(main, /void observeService\.dispose\(\)\.catch/);
  assert.match(main, /minHeight: 540/);
  assert.match(main, /createObserveService/);
  assert.match(main, /const screenWidth = Math\.max\(1, Math\.round\(primaryDisplay\.size\.width \* scaleFactor\)\)/);
  assert.match(main, /thumbnailSize: \{ width: screenWidth, height: screenHeight \}/);
  assert.match(main, /size\.width !== screenWidth \|\| size\.height !== screenHeight/);
  assert.match(main, /frame_id: crypto\.createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\)/);
  assert.match(main, /fingerprintDesktopScreenshot/);
  assert.match(renderer, /windowsBridge\.connectColab/);
  assert.match(renderer, /windowsBridge\.setVisionManualPanel/);
  assert.match(renderer, /visionManualPanel\.addEventListener\('submit'/);
  assert.match(renderer, /connectColab\(endpointUrl\)/);
  assert.match(renderer, /windowsBridge\.checkVisionSetup/);
  assert.match(renderer, /runVisionSetupCheck/);
  assert.match(renderer, /Vision: ready/);
  assert.match(renderer, /Colab endpoint received\. Testing the direct HTTPS health response/);
  assert.match(renderer, /HTTP 530 from Cloudflare/);
  assert.match(renderer, /Connection attempt failed; still watching/);
  assert.match(renderer, /incompatible_runtime: 'Colab: update notebook'/);
  assert.match(renderer, /running notebook is out of date/);
  assert.doesNotMatch(html, /Vision stays off until enabled/);
  assert.match(renderer, /21 \* 60 \* 1000/);
  assert.match(renderer, /The Colab connection check timed out/);
  assert.match(renderer, /screenshot analysis is disabled, but the model remains loaded/);
  assert.match(styles, /max-height: 68px;/);
  assert.match(styles, /overflow-y: auto;/);
  assert.doesNotMatch(styles, /\.vision-message\s*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(renderer, /No direct Colab response yet/);
  assert.match(renderer, /Setup check/);
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
  assert.match(main, /ensureWorkspaceDirectory\(root, fs\)/);
  assert.match(main, /getDefaultWorkspaceRoot/);
  assert.ok(main.includes("path.join(app.getPath('userData'), 'ChatGPTWorkspace')"));
  assert.match(main, /openInBrowserAndYield/);
  assert.match(main, /bringMainWindowForward/);
  assert.match(main, /'app:github-start-login'/);
  assert.match(main, /'app:github-poll-login'/);
  assert.match(main, /'app:retry-connection'/);
  assert.ok(main.includes('githubAuth.getState({ force: true }).then(auth =>'));
  assert.ok(main.includes('if (!state.running) void attemptAutoConnect();'),
    'a successful explicit auth retry restarts the mailbox worker immediately');
  assert.match(main, /AUTO_CONNECT_INTERVAL_MS = 5000/);
  assert.match(main, /ready-to-show/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /startup failed/i);
  assert.match(main, /'app:select-workspace'/);
  assert.match(main, /function selectWorkspace\(\)/);
  assert.match(main, /minHeight: 540/);
  assert.match(main, /'app:vision-status'/);
  assert.match(main, /'app:vision-connect-colab'/);
  assert.match(main, /const freshnessWindowMs = Math\.max\(15000, scanInterval \* 3\)/);
  assert.match(main, /if \(pollFresh\) return 'online'/);
  assert.match(main, /current\.lastPollError \|\| current\.lastError/);
  assert.match(main, /const connectionError = workerStatus === 'online' \? '' :/);
  assert.match(main, /'app:vision-manual-panel'/);
  assert.doesNotMatch(main, /STATUS_SIZE|VISION_MANUAL_HEIGHT|function clampBounds\(|function defaultBounds\(/);
  assert.match(main, /'app:vision-setup-check'/);
  const visionStatusHandler = main.slice(
    main.indexOf("ipcMain.handle('app:vision-status'"),
    main.indexOf("ipcMain.handle('app:vision-connect-colab'")
  );
  const connectColabHandler = main.slice(
    main.indexOf("ipcMain.handle('app:vision-connect-colab'"),
    main.indexOf("ipcMain.handle('app:vision-manual-panel'")
  );
  assert.match(visionStatusHandler, /const state = visionService\.status\(\)/);
  assert.match(visionStatusHandler, /automatic_handoff_ready/);
  assert.doesNotMatch(visionStatusHandler, /githubAuth\.getState|githubState\.authenticated/);
  assert.match(connectColabHandler, /return visionService\.connectColab/);
  assert.doesNotMatch(connectColabHandler, /githubAuth\.getState|visionService\.setupCheck|mailboxCheck/);
  assert.match(main, /visionService\.setupCheck\(githubState\)/);
  assert.match(main, /vision_activated: false/);
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
  assert.doesNotMatch(main, /accountsWindow|assertAccountUi|createAccountsWindow|conversation-mirror|installChatToolBridge/);
  assert.match(main, /WebContentsView/);
  assert.match(main, /function createDashboardWindow/);
  assert.match(main, /'app:browser-settings'/);
  assert.match(main, /'app:repository-bridge-config'/);
  assert.match(main, /'app:set-theme'/);
});

test('the separate dashboard implements tabbed widgets, settings, and embedded-browser controls', () => {
  const html = read('desktop', 'dashboard.html');
  const renderer = read('desktop', 'dashboard-renderer.js');
  const styles = read('desktop', 'dashboard.css');
  const main = read('desktop', 'main.js');
  for (const id of ['tab-list', 'add-tab', 'main-page', 'settings-page', 'queues-widget', 'controls-widget',
    'queue-list', 'observe-toggle', 'auto-accept-toggle', 'quick-colab-connect', 'workspace-button',
    'github-connect', 'repo-owner', 'repo-name', 'repo-branch', 'allow-public-mailbox',
    'tts-volume', 'theme-select', 'theme-gallery', 'browser-keep-active', 'browser-low-memory', 'browser-memory']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing dashboard element: ' + id);
  }
  assert.match(renderer, /snap\(/);
  assert.match(renderer, /pointerdown/);
  assert.match(renderer, /setBrowserBounds/);
  assert.match(renderer, /connectColab/);
  assert.match(renderer, /api\.setTheme/);
  assert.match(renderer, /applyTheme/);
  assert.match(renderer, /themeGallery\.addEventListener/);
  assert.match(html, /preview-graph/);
  assert.match(main, /DASHBOARD_THEME_IDS = Object\.freeze/);
  assert.match(main, /settings\.dashboardTheme = DASHBOARD_THEME_IDS\.includes/);
  assert.match(main, /settings\.dashboardTheme = theme;\s*persistSettings\(\)/);
  for (const theme of ['midnight','light','ocean','forest','sunset','rose','high-contrast','aurora','cyberpunk','dracula','nord','solarized-light','terminal','lavender','graphite']) { assert.match(styles, new RegExp('data-theme="' + theme + '"')); assert.ok(html.includes('data-theme-id="' + theme + '"'), 'missing visual theme card: ' + theme); }
  assert.match(styles, /tabbar/);
  assert.match(styles, /\.widget\.dragging/);
  assert.match(html, /100 MB/);
});

test('embedded browser memory telemetry uses supported Electron APIs and cannot crash the main process', () => {
  const main = read('desktop', 'main.js');
  const renderer = read('desktop', 'dashboard-renderer.js');
  const start = main.indexOf('function measureBrowserMemory(tab) {');
  const end = main.indexOf('\nfunction attachBrowserTab(id)', start);
  assert.ok(start >= 0 && end > start, 'embedded browser memory measurement function exists');
  const measure = main.slice(start, end);
  assert.match(measure, /app\.getAppMetrics\(\)/);
  assert.match(measure, /getOSProcessId\(\)/);
  assert.match(measure, /memory\.privateBytes/);
  assert.doesNotMatch(measure, /getProcessMemoryInfo/);
  assert.match(measure, /try\s*\{/);
  assert.match(measure, /catch \(error\)/);
  assert.match(measure, /tab\.id !== activeBrowserTabId/);
  assert.match(renderer, /onBrowserMemory\(v=>/);
  assert.match(renderer, /memory\.textContent='Unavailable'/);
});

test('preload exposes the single-dashboard, caption, persistence, sync and bridge APIs', () => {
  const preload = read('desktop', 'preload.js');
  for (const action of ['getState', 'openDashboard', 'saveDashboardState', 'saveNow', 'getTtsSettings', 'setTtsSettings', 'previewCaptions', 'getCloudSyncStatus', 'chooseCloudFolder', 'configureCloudSync', 'syncCloudNow', 'acknowledgeTrayState', 'onPrepareForTray', 'onDashboardState', 'onPreferences', 'onCloudSyncStatus', 'getBrowserTabs', 'openBrowserTab', 'openColabTab', 'setBrowserTabActive', 'closeBrowserTab', 'setBrowserBounds', 'getBrowserSettings', 'setBrowserSettings', 'setTtsVolume', 'setTheme', 'setRepositoryBridgeConfig', 'onBrowserTabsChanged', 'onBrowserMemory', 'onBrowserBoundsRefresh', 'selectWorkspace', 'setAutoAcceptAll', 'minimizeToTray', 'quit', 'getGitHubState', 'getVisionStatus', 'connectColab', 'checkVisionSetup', 'setVisionManualPanel', 'startGitHubLogin', 'reconnectGitHub', 'pollGitHubLogin', 'retryConnection', 'copyDeviceCode', 'onGitHubDeviceCode', 'onBridgeState', 'onGitHubState', 'onColabHandoffResult']) {
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
  assert.match(bridge, /DEFAULT_INTERVAL_MS = 1000/);
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

test('the single dashboard unloads to the system tray while the worker stays alive', () => {
  const main = read('desktop', 'main.js');
  const html = read('desktop', 'dashboard.html');
  assert.match(main, /new Tray\(/);
  assert.match(main, /tray\.setContextMenu/);
  assert.match(main, /label: 'Open Windows Bridge'/);
  assert.match(main, /label: 'Quit'/);
  assert.match(main, /win\.on\('minimize', event => \{\s*event\.preventDefault\(\);\s*if \(tray\) void destroyDashboardWindowToTray\(\);/);
  assert.match(main, /win\.on\('close', event => \{\s*if \(!finishingQuit\) \{\s*event\.preventDefault\(\);\s*if \(tray\) void destroyDashboardWindowToTray\(\);/);
  assert.match(main, /function startAutoConnectLoop\(\)/);
  assert.match(main, /setInterval\(\(\) => \{ void attemptAutoConnect\(\); \}, AUTO_CONNECT_INTERVAL_MS\)/);
  assert.match(main, /owner: 'hashin9973-ux'/);
  assert.match(main, /repo: 'qdqwg'/);
  assert.match(main, /branch: 'bridge-mailbox'/);
  assert.match(main, /startAutoConnectLoop\(\)/);
  assert.doesNotMatch(main, /app:start-bridge|app:stop-bridge/);
  assert.doesNotMatch(html, /Start worker|worker-toggle|titlebar|open-overlay/);
  assert.match(main, /function destroyDashboardWindowToTray\(\)/);
  assert.match(main, /trayStateResolvers = new Map\(\)/);
  assert.match(main, /loadFile\(path\.join\(__dirname, 'dashboard\.html'\)\)/);
  assert.doesNotMatch(main, /loadFile\(path\.join\(__dirname, 'index\.html'\)\)/);
  assert.doesNotMatch(main, /app:show-overlay/);
  assert.match(main, /startAutoConnectLoop\(\)/);
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



test('whole-drive workspaces require explicit confirmation and use a shallow index', () => {
  const main = read('desktop', 'main.js');
  const workspace = read('desktop', 'workspace-path.js');
  const index = read('desktop', 'filesystem-index.js');
  const runner = read('desktop', 'tool-runner.js');
  const bridge = read('desktop', 'tool-bridge.js');
  const renderer = read('desktop', 'renderer.js');
  assert.ok(main.includes('Use the entire drive as the ChatGPT workspace?'));
  assert.ok(main.includes('isFilesystemRoot(selected)'));
  assert.ok(workspace.includes('explicitly selected filesystem/drive'));
  assert.ok(index.includes("rootMode !== 'drive-root'"));
  assert.ok(index.includes("recursive: this.rootMode !== 'drive-root'"));
  assert.ok(runner.includes('const absolute=path.isAbsolute(value)'));
  assert.ok(bridge.includes("workspace_mode: isFilesystemRoot(root) ? 'drive-root' : 'folder'"));
  assert.ok(renderer.includes('Workspace: entire drive '));
});

test('optional Colab vision uses direct authenticated HTTPS without a Colab GitHub token', () => {
  const main = read('desktop', 'main.js');
  const bridge = read('desktop', 'tool-bridge.js');
  const vision = read('desktop', 'colab-direct-service.js');
  const compatibility = read('desktop', 'vision-service.js');
  const notebook = JSON.parse(read('vision', 'vision_worker.ipynb'));
  const python = notebook.cells.filter(cell => cell.cell_type === 'code').map(cell => cell.source.join('')).join('\n');
  assert.ok(bridge.includes("computer: ['action', 'source', 'path', 'prompt', 'region', 'waitMs', 'request_id', 'frame_id', 'x', 'y', 'fromX', 'fromY', 'button', 'clicks', 'deltaX', 'deltaY', 'durationMs', 'key', 'keys', 'text', 'steps', 'observe', 'frameWidth', 'frameHeight', 'mode']"));
  assert.match(bridge, /Native local computer tool for the real Windows workspace/);
  assert.match(bridge, /returned boxes are mapped back to the original full-frame coordinates/);
  assert.match(bridge, /All click\/move\/drag\/scroll\/key\/mouse inputs execute on local Windows, not in Colab/);
  assert.ok(bridge.includes("enum: ['status', 'connect', 'enable', 'disable', 'screenshot', 'wait', 'start_control', 'stop_control', 'click', 'move', 'drag', 'scroll', 'press', 'type', 'hotkey', 'mouse_down', 'mouse_up', 'key_down', 'key_up', 'sequence']"));
  assert.ok(bridge.includes("requiresApproval: ['connect', 'enable', 'start_control'].includes(args.action)"));
  assert.ok(bridge.includes('service.inputAction(args, requestId)'));
  assert.ok(bridge.includes("Ordered local mouse/keyboard inputs, up to 50 steps"));
  assert.ok(bridge.includes('function computerServiceCall'));
  assert.doesNotMatch(bridge, /name: 'vision_(?:activate|deactivate|status|analyze_screenshot|wait)'/);
  assert.ok(main.includes("require('./colab-direct-service')"));
  assert.ok(main.includes("require('./windows-input')"));
  assert.ok(main.includes('inputControl: windowsInputController'));
  assert.ok(main.includes('captureDesktopScreenshot'));
  assert.ok(main.includes('encodeVisionJpeg'));
  assert.ok(main.includes('colab.research.google.com'));
  assert.ok(main.includes('readClipboardText: () => clipboard.readText()'));
  assert.ok(vision.includes("const DIRECT_VISION_PROTOCOL = 'chatgpt-colab-vision-direct/v1'"));
  assert.ok(vision.includes('runtime_kept_alive: true'));
  assert.ok(vision.includes('MAX_SCREENSHOT_BYTES = 1280 * 1024'));
  assert.ok(vision.includes('input_sha256'));
  assert.ok(vision.includes('VISION_WORKER_API_VERSION = 5'));
  assert.ok(vision.includes("'tts-server-synthesis-metrics-v1'"));
  assert.ok(python.includes('"tts-server-synthesis-metrics-v1"'));
  assert.ok(vision.includes('runtime_compatible'));
  assert.ok(vision.includes('async function synthesizeSpeech'));
  assert.ok(vision.includes('function speechPlaybackStatus()'));
  assert.ok(vision.includes("status: 'tts_started'"));
  assert.ok(vision.includes('splitSpeechIntoChunks'));
  assert.ok(vision.includes('speech_playback: speechPlaybackStatus()'));
  assert.ok(vision.includes("directRequest('/tts'"));
  assert.ok(bridge.includes("tts: ['text', 'play']"));
  assert.ok(bridge.includes('function ttsOutputFailed(args = {}, output)'));
  assert.ok(bridge.includes("output.status === 'tts_started'"));
  assert.ok(vision.includes('async function setupCheck(githubState = {})'));
  assert.ok(vision.includes('async function connectPublicEndpoint'));
  assert.ok(vision.includes("directRequest('/activate'"));
  assert.ok(vision.includes('activate immediately'));
  assert.ok(vision.includes('async function inputAction(args = {}, callId = null)'));
  assert.ok(vision.includes('latestScreenFrame'));
  assert.ok(vision.includes('Screenshot frame: '));
  assert.ok(main.includes("require('./windows-uia')"));
  const uia = read('desktop', 'windows-uia.js');
  assert.ok(uia.includes('GetCursorPos(out WRBPOINT point)'));
  assert.ok(uia.includes('MAX_UIA_NODES = 1200'));
  assert.ok(uia.includes('UIA_TIMEOUT_MS = 4000'));
  assert.ok(uia.includes('maxBuffer: 4 * 1024 * 1024'));
  assert.ok(uia.includes('traversalTimer.ElapsedMilliseconds -lt 2500'));
  assert.ok(read('desktop', 'observe-service.js').includes('MAX_CONTEXT_BYTES = 3500000'));
  assert.ok(read('desktop', 'observe-service.js').includes('reportValue.ocr.text_spans.slice(0, 800)'));
  assert.ok(vision.includes('if (args.play !== false) activeSpeechJobId = jobId;'));
  assert.ok(uia.includes('MAX_UIA_CONTROLS = 800'));
  assert.ok(main.includes("getAccessibleSnapshot: captureWindowsUiAutomationSnapshot"));
  assert.ok(vision.includes("validateVisionContext(data.report"));
  assert.ok(vision.includes("unverified_visual_estimate"));
  assert.ok(vision.includes('async function connectColab(endpointText'));
  assert.ok(vision.includes("connectPublicEndpoint(endpoint.url, 'manual')"));
  assert.ok(vision.includes('async function watchClipboardForEndpoint'));
  assert.ok(vision.includes('parseTunnelEndpoint'));
  assert.ok(vision.includes('safeTunnelUrl'));
  assert.ok(compatibility.includes("require('./colab-direct-service')"));
  assert.ok(python.includes('cloudflared'));
  assert.ok(python.includes('OLLAMA_MODEL = "qwen3-vl:4b-instruct"'));
  assert.ok(python.includes('PASSIVE_MODEL_REPO = "ahmadwaqar/smolvlm2-2.2b-instruct"'));
  assert.ok(python.includes('PASSIVE_MODEL = "ahmadwaqar/smolvlm2-2.2b-instruct:latest"'));
  assert.ok(python.includes('PASSIVE_CONTEXT_TOKENS = 8192'));
  assert.ok(python.includes('MAX_STRUCTURED_REPORT_CHARS = 1000000'));
  assert.ok(python.includes('ocr_hint_limit = 48 if model_role == "passive" else 128'));
  assert.ok(python.includes('accessibility_hint_limit = 64 if model_role == "passive" else 160'));
  assert.ok(python.includes('PASSIVE OBSERVE MODE: produce a dense, high-signal live screen map'));
  assert.ok(python.includes('up to 48 task-relevant visible text spans'));
  assert.ok(python.includes('up to 32 visible controls'));
  assert.ok(python.includes('up to 20 other visible objects'));
  assert.ok(python.includes('DETAILED QWEN MODE: focus on a reliable interpretation'));
  assert.ok(python.includes('at most 8 regions, 24 text spans, 16 controls, and 12 objects'));
  assert.ok(!python.includes('richardyoung/smolvlm2-2.2b-instruct:Q4_K_M'));
  assert.ok(python.includes('VISION_WORKER_API_VERSION = 5'));
  assert.ok(python.includes('PIPER_VOICE_NAME = "en_US-libritts-high"'));
  assert.ok(python.includes('PIPER_SPEAKER_ID = 0'));
  assert.ok(python.includes('def ensure_tts_voice():'));
  assert.ok(python.includes('voice.synthesize_wav(\n            "Ready.", warmup_wav'));
  assert.ok(python.includes('"tts_warmup_ms": round(float(_tts_warmup_ms)'));
  assert.ok(python.includes('_tts_warmup_ms = globals().get("_tts_warmup_ms")'));
  assert.ok(python.includes('warm_tts_voice(_tts_voice)'));
  assert.ok(python.includes('name="piper-tts-warmup"'));
  assert.ok(python.includes('up to 16 distinct screen regions'));
  assert.ok(python.includes('around 900-1300 generated tokens'));
  assert.ok(python.includes('if route == "/tts":'));
  assert.ok(python.includes('PIPER_VOICE_SHA256'));
  assert.ok(python.includes('PARKED_QWEN_MODEL = "bridge-qwen3-vl-4b-parked:latest"'));
  assert.ok(python.includes('num_gpu=0, context_tokens=VISION_CONTEXT_TOKENS'));
  assert.ok(python.includes('OLLAMA_SWAP_BYTES = 4 * 1024**3'));
  assert.ok(python.includes('"think": False'));
  assert.ok(python.includes('"format": "json"'));
  assert.ok(python.includes('VISION_CONTEXT_SCHEMA = "windows-vision-context/v2"'));
  assert.ok(python.includes("def extract_ocr_evidence("));
  assert.ok(python.includes("normalize_model_box"));
  assert.ok(python.includes("Vision output hit its generation limit."));
  assert.ok(python.includes("malformed or truncated JSON; the report was rejected."));
  assert.ok(python.includes('"coordinate_space": "screenshot_jpeg_px"'));
  assert.ok(python.includes('MAX_TTS_TEXT_CHARS = 240'));
  assert.ok(python.includes('"text_spans": spans[:800]'));
  assert.ok(python.includes("PASSIVE_MAX_OUTPUT_TOKENS = 1400"));
  assert.ok(python.includes('model_predict = PASSIVE_MAX_OUTPUT_TOKENS if model_role == "passive" else DETAILED_MAX_OUTPUT_TOKENS'));
  assert.ok(python.includes('https://ollama.com/install.sh'));
  assert.ok(python.includes('OLLAMA_MODELS_DIR = Path("/content/ollama-models")'));
  assert.ok(!python.includes('def run_vision_smoke_test()'));
  assert.ok(!python.includes('vision_smoke_test'));
  assert.ok(python.includes('No startup image inference was run'));
  assert.ok(python.includes('ollama_model_is_downloaded(model_name)'));
  assert.ok(python.includes('def ollama_model_capabilities(model_name):'));
  assert.ok(python.includes('def refresh_and_verify_vision_capability('));
  assert.ok(python.includes('def refresh_passive_model_after_multimodal_error():'));
  assert.ok(python.includes('def build_passive_fallback_report('));
  assert.ok(python.includes('"objects": normalized_objects'));
  assert.ok(python.includes('"ocr-accessibility-fallback"'));
  assert.ok(python.includes('"images": [model_image_b64]'));
  assert.ok(python.includes('OLLAMA_API + "/api/chat"'));
  assert.ok(python.includes('model_loaded=True'));
  assert.ok(python.includes('SETUP_BUDGET_SECONDS = 900'));
  assert.ok(python.includes('_setup_blocked = True'));
  assert.ok(python.includes('_desktop_registration_event.wait(timeout=90)'));
  assert.doesNotMatch(python, /hf_hub_download|--mmproj|cudart-llama|cmake|nvcc|drive\.mount\(|\/v1\/chat\/completions/i);
  assert.ok(python.includes('automatically activates after authenticated desktop registration'));
  const registrationAckStart = python.indexOf('if route == "/registration/ack":');
  const registrationAckEnd = python.indexOf('if route == "/activate":', registrationAckStart);
  const registrationAck = python.slice(registrationAckStart, registrationAckEnd);
  assert.ok(registrationAck.includes('_enabled = True'));
  assert.ok(registrationAck.includes('stage="activation"'));
  assert.ok(registrationAck.includes('"vision_activated": True'));
  assert.ok(registrationAck.indexOf('self._send(200') < registrationAck.indexOf('_desktop_registration_event.set()'));
  assert.ok(main.includes("const DIAGNOSTIC_LOG_NAME = 'startup-crash.log'"));
  assert.ok(main.includes("process.on('uncaughtException'"));
  assert.ok(main.includes("process.on('unhandledRejection'"));
  const unhandledRejectionStart = main.indexOf("process.on('unhandledRejection'");
  const unhandledRejectionEnd = main.indexOf("\n});", unhandledRejectionStart) + 4;
  assert.doesNotMatch(main.slice(unhandledRejectionStart, unhandledRejectionEnd), /app\.exit\(/);
  assert.ok(main.includes("contents.on('render-process-gone'"));
  assert.ok(main.includes("app.on('child-process-gone'"));
  assert.ok(python.includes('class DirectVisionHandler'));
  assert.ok(bridge.includes('latest screenshot pixel frame'));
  assert.match(bridge, /accessibility-grounded bounds are preferred/i);
  assert.ok(bridge.includes('All click/move/drag/scroll/key/mouse inputs execute on local Windows, not in Colab'));
  assert.ok(bridge.includes('Optional focused observation crop'));
  assert.ok(vision.includes('region_px: screenshot.metadata.region_px'));
  assert.ok(python.includes('map_model_boxes_to_original(model_report, width, height, region_px)'));
  assert.ok(python.includes('original_frame_region_px'));
  assert.ok(python.includes('region_px must be an in-frame crop'));
  assert.ok(python.includes('display_public_endpoint'));
  assert.ok(python.includes('PUBLIC_VISION_ENDPOINT generated; the raw URL is kept in the handoff panel, not notebook text output.'));
  assert.ok(python.includes('navigator.clipboard.writeText'));
  assert.ok(python.includes('def _route_path(self)'));
  assert.ok(!python.includes('QDQWG_TOKEN'));
  assert.ok(!python.includes('userdata.get'));
  assert.ok(!python.includes('api.github.com/repos/hashin9973-ux/qdqwg'));
  assert.equal(main.slice(main.indexOf('app.whenReady().then')).includes('visionService.activate('), false);
  assert.equal(/process\.kill|shutdown.*Colab/i.test(vision), false);
});

test('Colab connection hands the discovered public endpoint to Windows without clipboard paste', () => {
  const main = read('desktop', 'main.js');
  const renderer = read('desktop', 'renderer.js');
  const service = read('desktop', 'colab-direct-service.js');
  const notebook = JSON.parse(read('vision', 'vision_worker.ipynb'));
  const python = notebook.cells.filter(cell => cell.cell_type === 'code').map(cell => cell.source.join('\n')).join('\n');
  assert.match(main, /readClipboardText: \(\) => clipboard\.readText\(\)/);
  assert.match(service, /async function watchClipboardForEndpoint/);
  assert.match(service, /if \(text\) \{\s*const endpoint = endpointFromClipboard\(text\)/);
  assert.doesNotMatch(service, /text !== watch\.baseline/);
  assert.match(service, /parseTunnelEndpoint\(match\[0\]\)/);
  assert.ok(python.includes('PUBLIC_VISION_ENDPOINT generated; the raw URL is kept in the handoff panel, not notebook text output.'));
  assert.match(python, /navigator\.clipboard\.writeText/);
  assert.ok(python.includes('Copy endpoint (fallback)'));
  assert.match(python, /Connect to Windows Bridge/);
  assert.ok(python.includes('windows-repository-bridge://connect-colab?endpoint='));
  assert.ok(python.includes('http://127.0.0.1:43817/handoff'));
  assert.ok(python.includes('body: JSON.stringify({ endpoint })'));
  assert.ok(python.includes('navigator.permissions.query({ name: "loopback-network" })'));
  assert.ok(python.includes('targetAddressSpace: "loopback"'));
  assert.ok(python.includes('if (loopbackPermission === "granted" && loopbackPolicyAllowed)'));
  assert.ok(python.includes('The first loopback request is initiated directly by this click'));
  assert.doesNotMatch(python, /sendToWindowsBridge\(false\)/);
  assert.match(python, /document\.createElement\("textarea"\)/);
  assert.match(python, /Clipboard access was blocked\. Use the one-click app handoff/);
  assert.match(python, /copying and pasting is the last resort/);
  assert.match(main, /'app:vision-manual-panel'/);
  assert.ok(main.includes('setAsDefaultProtocolClient(COLAB_HANDOFF_SCHEME)'));
  assert.ok(main.includes('createColabHandoffServer({'));
  assert.ok(main.includes('onEndpoint: queueColabEndpoint'));
  assert.ok(main.includes('automatic_handoff_ready: handoff.ready === true'));
  assert.ok(main.includes('const COLAB_HANDOFF_ARM_TIMEOUT_MS = 20 * 60 * 1000;'));
  assert.ok(main.includes('function armColabHandoff()'));
  assert.ok(main.includes('if (!colabHandoffArmed) return false;'));
  assert.ok(main.includes('automatic_handoff_armed: colabHandoffArmed'));
  assert.ok(main.includes('armColabHandoff();') && main.includes("const result = await visionService.connectColab('')"));
  assert.ok(main.includes('if (manualEndpoint) {') && main.includes('disarmColabHandoff();'));
  assert.ok(renderer.includes('Receiver ready but not armed.'));
  assert.ok(renderer.includes('Connect Colab is armed.'));

  assert.ok(service.includes('once allowed, future endpoint URLs are sent automatically'));
  assert.ok(main.includes("app.on('open-url'"));
  assert.ok(main.includes("parseTunnelEndpoint(uri.searchParams.get('endpoint'))"));
  const receiver = read('desktop', 'colab-handoff-server.js');
  assert.ok(receiver.includes("const DEFAULT_PORT = 43817;"));
  assert.ok(receiver.includes("const HANDOFF_PATH = '/handoff';"));
  assert.ok(receiver.includes('isAllowedColabOrigin(origin)'));
  assert.ok(receiver.includes('parseEndpoint(parsed.endpoint)'));
  assert.ok(receiver.includes('request.resume()'));
  assert.doesNotMatch(main, /COLAB_PROTOCOL_SCHEME|receiveColabProtocolLink/);
  assert.doesNotMatch(service, /registerColabTunnel|wrb_pair_nonce|COLAB_PROTOCOL_SCHEME/);
  assert.doesNotMatch(python, /wrb_pair_nonce/);
  assert.equal(python.includes('print("PUBLIC_VISION_ENDPOINT=" + endpoint_url'), false);
});

test('Colab vision notebook becomes ready after model download without startup image inference', () => {
  const notebook = JSON.parse(read('vision', 'vision_worker.ipynb'));
  const codeCells = notebook.cells.filter(cell => cell.cell_type === 'code');
  assert.equal(codeCells.length, 1, 'the vision notebook has one server code cell');
  const source = codeCells.map(cell => cell.source.join('')).join('\n');
  assert.match(source, /OLLAMA_MODEL = "qwen3-vl:4b-instruct"/);
  assert.match(source, /"think": False/);
  assert.match(source, /no final message\.content; diagnostics=/);
  assert.match(source, /https:\/\/ollama\.com\/install\.sh/);
  assert.match(source, /OLLAMA_API \+ "\/api\/chat"/);
  assert.match(source, /"images": \[model_image_b64\]/);
  assert.doesNotMatch(source, /run_vision_smoke_test|vision_smoke_test|blue-square vision check|generated test image/i);
  assert.match(source, /ollama_model_is_downloaded\(\)/);
  assert.match(source, /No startup image inference was run/);
  assert.match(source, /VISION_WORKER_API_VERSION = 5/);
  assert.match(source, /"input_frame_id": record.get\("input_frame_id"\)/);
  assert.match(source, /"model_role": record.get\("model_role"\)/);
  assert.match(source, /Piper TTS/);
  assert.match(source, /OLLAMA_MODELS_DIR = Path\("\/content\/ollama-models"\)/);
  assert.doesNotMatch(source, /hf_hub_download|--mmproj|cudart-llama|cmake|nvcc|drive\.mount\(|\/v1\/chat\/completions/i);
  const readme = read('README.md');
  assert.match(readme, /prebuilt Ollama runtime/i);
  assert.match(readme, /does not compile llama\.cpp/i);
});


test('dashboard persists layout and exposes complete TTS and cloud folder settings', () => {
  const html = read('desktop', 'dashboard.html');
  const renderer = read('desktop', 'dashboard-renderer.js');
  const main = read('desktop', 'main.js');
  for (const id of ['minimize-to-tray', 'quit-app', 'tts-mode', 'tts-captions-autoplay',
    'tts-transparent-bg', 'tts-caption-position', 'tts-caption-x', 'tts-caption-y',
    'tts-caption-theme', 'tts-caption-preview', 'save-now', 'cloud-folder-choose',
    'cloud-sync-enabled', 'cloud-sync-now', 'cloud-sync-status']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing setting: ' + id);
  }
  assert.match(renderer, /function dashboardSnapshot\(\)/);
  assert.match(renderer, /function applyDashboardState\(value\)/);
  assert.match(renderer, /api\.saveDashboardState\(dashboardSnapshot\(\)\)/);
  assert.match(renderer, /api\.onPrepareForTray/);
  assert.match(renderer, /api\.acknowledgeTrayState/);
  assert.match(main, /function createCaptionWindow\(\)/);
  assert.match(main, /function updateCaptionPlaybackProgress\(/);
  assert.match(main, /nativeTheme\.on\('updated'/);
  assert.match(main, /app:cloud-sync-config/);
  assert.match(main, /safeShareUrl\(tab\.url\)/);
  assert.doesNotMatch(html, /id="open-overlay"/);
});

test('cloud sync implementation and tests are included in package validation', () => {
  const pkg = JSON.parse(read('package.json'));
  const sync = read('desktop', 'cloud-sync.js');
  const caption = read('desktop', 'caption-renderer.js');
  assert.match(sync, /function createCloudSync/);
  assert.match(sync, /function mergeRecords/);
  assert.match(sync, /function sanitizeSharedState/);
  assert.match(sync, /MAX_RECORD_BYTES/);
  assert.match(caption, /textContent/);
  assert.match(caption, /bridge\.play\(\)/);
  for (const file of ['desktop/cloud-sync.js', 'desktop/caption-preload.js', 'desktop/caption-renderer.js', 'test/cloud-sync.test.js']) {
    assert.ok(pkg.scripts.check.includes('node --check ' + file), 'missing syntax validation: ' + file);
  }
});


test('dashboard browser-tab IPC does not feed back into an unbounded renderer event loop', () => {
  const main = read('desktop', 'main.js');
  const activation = main.slice(
    main.indexOf('function setBrowserTabActive(id) {'),
    main.indexOf('async function openBrowserTab', main.indexOf('function setBrowserTabActive(id) {'))
  );
  assert.match(activation, /activeBrowserTabId === idValue[\s\S]*return \{ active: true, unchanged: true \}/);
  assert.match(activation, /if \(changed\) publishBrowserTabs\(\)/);
  assert.match(activation, /unchanged: !changed/);
  assert.match(activation, /hasLiveViews = \[\.\.\.browserTabs\.values\(\)\]\.some\(tab => tab\.view \|\| tab\.memoryTimer\)/);
  assert.match(activation, /Only broadcast an actual activation\/deactivation change/);
});

test('dashboard saves do not rebroadcast unchanged browser tabs into a renderer save loop', () => {
  const main = read('desktop', 'main.js');
  const syncStart = main.indexOf('function syncBrowserRegistryFromDashboardState(value) {');
  const syncEnd = main.indexOf('function collectSharedPreferences', syncStart);
  const sync = main.slice(syncStart, syncEnd);
  assert.match(sync, /const previousSnapshot = JSON\.stringify\(browserTabSnapshot\(\)\)/);
  assert.match(sync, /if \(previousSnapshot !== JSON\.stringify\(browserTabSnapshot\(\)\)\) publishBrowserTabs\(\)/);
  assert.doesNotMatch(sync, /^\s*publishBrowserTabs\(\);\s*$/m);

  const activationStart = main.indexOf('function setBrowserTabActive(id) {');
  const activationEnd = main.indexOf('async function openBrowserTab', activationStart);
  const activation = main.slice(activationStart, activationEnd);
  assert.match(activation, /new Set\([\s\S]*dashboardWindow\.contentView\.children/);
  assert.match(activation, /const attached = attachedViews\.has\(tab\.view\)/);
  assert.match(activation, /if \(attached \|\| wasActive\)/);
});

test('in-app browser defaults off, never leaves an overlay attached when disabled, and is wired to Settings', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'dashboard.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'dashboard-renderer.js'), 'utf8');
  assert.match(main, /settings\.browserEnabled = settings\.browserEnabled === true/);
  assert.match(main, /settings\.browserEnabled = enabled/);
  assert.match(main, /function clampBrowserBounds\(value, size\)/);
  assert.match(main, /browserBounds = clampBrowserBounds\(browserBounds, dashboardWindow\.getContentBounds\(\)\)/);
  assert.match(main, /settings\.browserEnabled !== true\) return \{ applied: false, disabled: true \}/);
  assert.match(main, /tabs: current\.tabs\.filter\(tab => tab\.kind !== 'browser'\)/);
  assert.match(main, /settings\.browserEnabled === true \|\| !tab \|\| tab\.kind !== 'browser'/);
  assert.match(main, /tabs: incoming\.tabs\.filter\(tab => tab\.kind !== 'browser'\)/);
  assert.match(main, /keepActive: enabled && settings\.browserKeepActive === true/);
  assert.match(main, /await shell\.openExternal\(parsed\.href\)/);
  assert.match(main, /dashboardSend\('app:browser-tab-opened', \{ id: tab\.id \}\)/);
  assert.match(preload, /onBrowserTabOpened\(callback\)/);
  assert.match(renderer, /function activateOpenedBrowserTab\(value\)/);
  assert.match(renderer, /api\.onBrowserTabOpened\(activateOpenedBrowserTab\)/);
  assert.match(html, /id="browser-enabled" type="checkbox"/);
  assert.match(renderer, /browserEnabled=\$\('browser-enabled'\)/);
  assert.match(renderer, /browserEnabled\.addEventListener\('change'/);
  assert.match(renderer, /setPage\(\);scheduleSaveDashboardState\(\)/);
});
