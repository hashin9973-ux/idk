'use strict';

const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  globalShortcut,
  shell,
  dialog,
  safeStorage
} = require('electron');
const { clampRectToWorkArea, clampBubbleToWorkArea } = require('./geometry');
const localTools = require('./tool-runner');
const { createGitHubAuth } = require('./github-auth');
const { createToolBridge } = require('./tool-bridge');
const { createRepositoryBridge } = require('./repository-bridge');

const HEADER_HEIGHT = 58;
const COLLAPSED_SIZE = 76;
const EXPANDED_SIZE = { width: 720, height: 780 };
const SHORTCUT = 'CommandOrControl+Shift+Space';

let mainWindow = null;
let collapsed = false;
let settings = {};
let saveTimer = null;
let githubAuth = null;
let toolBridge = null;
let repositoryBridge = null;
let finishingQuit = false;
let pendingGitHubCliLogin = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    const temp = getSettingsPath() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, getSettingsPath());
  } catch (error) {
    console.error('Could not save settings:', error.message);
  }
}

function resolveGitHubCliPath() {
  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, 'gh', 'gh.exe')
    : path.join(__dirname, '..', 'vendor', 'gh', 'gh.exe');
  return fs.existsSync(bundledPath) ? bundledPath : 'gh';
}

function githubCliEnvironment() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // Use the Windows shell's registered URL handler; don't rely on terminal/browser detection.
    GH_BROWSER: path.join(windowsRoot, 'explorer.exe'),
    // Keep this app's sign-in profile separate from the CLI config files.
    GH_CONFIG_DIR: path.join(app.getPath('userData'), 'github-cli')
  };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
    delete env[name];
  }
  return env;
}

function readGitHubCliToken() {
  return execFileAsync(resolveGitHubCliPath(), ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, env: githubCliEnvironment()
  }).then(result => {
    const token = String(result.stdout || '').trim();
    if (!token) throw new Error('GitHub CLI returned an empty token.');
    return token;
  });
}

function cleanLoginOutput(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 500);
}

function captureDeviceCode(login, chunk) {
  login.output = (login.output + String(chunk || '')).slice(-12000);
  const match = login.output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/i);
  if (!match) return;

  login.userCode = match[1].toUpperCase();
  if (!login.openPromptReleased) {
    login.openPromptReleased = true;
    // With piped stdin/stdout, GitHub CLI takes its non-interactive path and
    // prints the device URL instead of opening it. Open the device page here.
    openInBrowserAndYield('https://github.com/login/device').then(() => {
      login.browserOpened = true;
    }).catch(error => {
      login.browserOpenError = cleanLoginOutput(error.message);
      login.message = 'Could not open GitHub authorization automatically. Open https://github.com/login/device in your browser and enter the displayed code.' +
        (login.browserOpenError ? ' Browser error: ' + login.browserOpenError : '');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:github-login-browser-error', login.message);
      }
    });
    try {
      if (login.child.stdin && !login.child.stdin.destroyed) login.child.stdin.end('\\n');
    } catch {}
  }
}

async function completeGitHubCliLogin(login) {
  login.status = 'finishing';
  const token = await readGitHubCliToken();
  const state = await githubAuth.importToken(token);
  // Keep the CLI's own OS-backed credential store untouched; the app keeps its
  // independently encrypted token in Electron safeStorage.
  login.login = state.login;
  login.status = 'authenticated';
}

function startGitHubCliLogin() {
  let child;
  try {
    child = spawn(resolveGitHubCliPath(), [
      'auth', 'login', '--web', '--hostname', 'github.com',
      '--git-protocol', 'https', '--clipboard'
    ], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: githubCliEnvironment()
    });
  } catch (error) {
    throw new Error('Could not start GitHub sign-in: ' + cleanLoginOutput(error.message));
  }

  const login = { child, status: 'pending', output: '', userCode: '', login: '', message: '' };
  pendingGitHubCliLogin = login;
  child.stdout.on('data', chunk => captureDeviceCode(login, chunk));
  child.stderr.on('data', chunk => captureDeviceCode(login, chunk));
  child.once('error', error => {
    login.status = 'error';
    login.message = 'Could not start GitHub sign-in. Reinstall the app and try again. ' + cleanLoginOutput(error.message);
  });
  child.once('close', (code, signal) => {
    if (login.status === 'error') return;
    if (code !== 0) {
      login.status = 'error';
      login.message = cleanLoginOutput(login.output) ||
        ('GitHub sign-in did not complete' + (signal ? ' (' + signal + ')' : '') + '. Try again.');
      return;
    }
    completeGitHubCliLogin(login).catch(error => {
      login.status = 'error';
      login.message = cleanLoginOutput(error.message) || 'Could not finish GitHub sign-in. Try again.';
    });
  });
  return { mode: 'github-cli', userCode: '', verificationUrl: 'https://github.com/login/device', intervalSeconds: 3 };
}

function getWorkspaceRoot() {
  if (!settings.workspaceRoot || typeof settings.workspaceRoot !== 'string') {
    settings.workspaceRoot = path.join(app.getPath('documents'), 'ChatGPTWorkspace');
  }
  return path.resolve(settings.workspaceRoot);
}

function ensureWorkspaceRoot() {
  const root = getWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  settings.workspaceRoot = root;
  persistSettings();
  return root;
}

function selectWorkspace() {
  return dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Choose the sandbox folder ChatGPT may modify and delete files inside',
    defaultPath: fs.existsSync(getWorkspaceRoot()) ? getWorkspaceRoot() : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  }).then(result => {
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { canceled: true, workspaceRoot: getWorkspaceRoot() };
    }
    const selected = path.resolve(result.filePaths[0]);
    if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
      throw new Error('Selected workspace is not a directory.');
    }
    settings.workspaceRoot = selected;
    persistSettings();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:workspace-changed', selected);
    }
    return { canceled: false, workspaceRoot: selected };
  });
}

function clampBounds(bounds) {
  const safe = {
    x: Number.isFinite(Number(bounds && bounds.x)) ? Number(bounds.x) : 0,
    y: Number.isFinite(Number(bounds && bounds.y)) ? Number(bounds.y) : 0,
    width: Number.isFinite(Number(bounds && bounds.width)) && Number(bounds.width) > 0 ? Number(bounds.width) : EXPANDED_SIZE.width,
    height: Number.isFinite(Number(bounds && bounds.height)) && Number(bounds.height) > 0 ? Number(bounds.height) : EXPANDED_SIZE.height
  };
  const display = screen.getDisplayMatching(safe);
  return clampRectToWorkArea(safe, display.workArea, 560, 600);
}

function defaultBounds() {
  const work = screen.getPrimaryDisplay().workArea;
  return clampBounds({
    x: work.x + Math.max(0, work.width - EXPANDED_SIZE.width - 30),
    y: work.y + Math.max(0, work.height - EXPANDED_SIZE.height - 30),
    ...EXPANDED_SIZE
  });
}

function clampBubble(bounds) {
  const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE });
  return clampBubbleToWorkArea(bounds, display.workArea, COLLAPSED_SIZE);
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || collapsed) return;
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  settings.bounds = { x, y, width, height };
  persistSettings();
}

function saveWindowBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed() || collapsed) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowBounds, 250);
}

function collapseWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || collapsed) return;
  saveWindowBounds();
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  collapsed = true;
  mainWindow.setMinimumSize(1, 1);
  mainWindow.setResizable(false);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setSize(COLLAPSED_SIZE, COLLAPSED_SIZE, true);
  const bounds = clampBubble({ x: x + width - COLLAPSED_SIZE, y: y + height - COLLAPSED_SIZE });
  mainWindow.setPosition(bounds.x, bounds.y, true);
  mainWindow.webContents.send('app:collapsed-changed', true);
  if (mainWindow.isFocused()) mainWindow.blur();
}

function expandWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !collapsed) return;
  const bubble = mainWindow.getBounds();
  const preferred = settings.bounds || defaultBounds();
  const target = clampBounds({
    x: bubble.x + COLLAPSED_SIZE - (preferred.width || EXPANDED_SIZE.width),
    y: bubble.y + COLLAPSED_SIZE - (preferred.height || EXPANDED_SIZE.height),
    width: preferred.width || EXPANDED_SIZE.width,
    height: preferred.height || EXPANDED_SIZE.height
  });
  collapsed = false;
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setMinimumSize(560, 600);
  mainWindow.setResizable(true);
  mainWindow.setBounds(target, true);
  mainWindow.webContents.send('app:collapsed-changed', false);
}

function toggleOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (collapsed) {
    expandWindow();
    mainWindow.show();
    mainWindow.focus();
  } else {
    collapseWindow();
    mainWindow.show();
  }
}

function getSafeExternalUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!['github.com', 'docs.github.com', 'chatgpt.com'].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function openInBrowserAndYield(raw) {
  const safe = getSafeExternalUrl(raw);
  if (!safe) throw new Error('Blocked external authentication URL.');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.blur();
  }
  try {
    await shell.openExternal(safe.href);
    return { opened: true };
  } catch (error) {
    bringMainWindowForward();
    throw error;
  }
}

function bringMainWindowForward() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (collapsed) expandWindow();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
}

function assertLocalUi(event, filename) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Only the local desktop UI may invoke this action.');
  }
  const url = event.senderFrame && event.senderFrame.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/' + filename)) {
    throw new Error('Unexpected IPC sender.');
  }
}

function getUiState() {
  return {
    workspaceRoot: getWorkspaceRoot(),
    bridge: repositoryBridge ? repositoryBridge.getState() : { running: false, configured: false },
    github: githubAuth ? null : null
  };
}

function broadcastBridgeState(state) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:bridge-state', state);
  }
}

function registerIpc() {
  ipcMain.handle('app:get-state', event => {
    assertLocalUi(event, 'index.html');
    return getUiState();
  });
  ipcMain.handle('app:save-bridge-config', (event, config) => {
    assertLocalUi(event, 'index.html');
    return repositoryBridge.setConfig(config);
  });
  ipcMain.handle('app:start-bridge', async event => {
    assertLocalUi(event, 'index.html');
    const state = await repositoryBridge.start();
    broadcastBridgeState(state);
    return state;
  });
  ipcMain.handle('app:stop-bridge', async event => {
    assertLocalUi(event, 'index.html');
    const state = await repositoryBridge.stop();
    broadcastBridgeState(state);
    return state;
  });
  ipcMain.handle('app:select-workspace', async event => {
    assertLocalUi(event, 'index.html');
    return selectWorkspace();
  });
  ipcMain.handle('app:collapse', event => {
    assertLocalUi(event, 'index.html');
    collapseWindow();
    return { collapsed };
  });
  ipcMain.handle('app:expand', event => {
    assertLocalUi(event, 'index.html');
    expandWindow();
    return { collapsed };
  });
  ipcMain.handle('app:quit', event => {
    assertLocalUi(event, 'index.html');
    app.quit();
    return true;
  });

  ipcMain.handle('app:github-state', event => {
    assertLocalUi(event, 'index.html');
    return githubAuth.getState();
  });
  ipcMain.handle('app:github-start-login', async event => {
    assertLocalUi(event, 'index.html');
    if (pendingGitHubCliLogin && ['pending', 'finishing'].includes(pendingGitHubCliLogin.status)) {
      return { mode: 'github-cli', userCode: pendingGitHubCliLogin.userCode, intervalSeconds: 3 };
    }
    if (pendingGitHubCliLogin && pendingGitHubCliLogin.status === 'authenticated') {
      const result = { status: 'authenticated', login: pendingGitHubCliLogin.login, mode: 'github-cli' };
      pendingGitHubCliLogin = null;
      bringMainWindowForward();
      return result;
    }
    pendingGitHubCliLogin = null;
    const current = await githubAuth.getState();
    if (current.authenticated) return { status: 'authenticated', login: current.login, mode: 'github-cli' };
    // Explicitly launch the browser flow instead of silently adopting a CLI login.
    const flow = startGitHubCliLogin();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.blur();
    }
    return flow;
  });
  ipcMain.handle('app:github-poll-login', async event => {
    assertLocalUi(event, 'index.html');
    const login = pendingGitHubCliLogin;
    if (login) {
      if (login.status === 'pending' || login.status === 'finishing') {
        return { status: 'pending', intervalSeconds: 3, ...(login.userCode ? { userCode: login.userCode } : {}), ...(login.browserOpenError ? { message: login.message, browserOpenError: login.browserOpenError } : {}) };
      }
      pendingGitHubCliLogin = null;
      if (login.status === 'authenticated') {
        bringMainWindowForward();
        return { status: 'authenticated', login: login.login };
      }
      bringMainWindowForward();
      return { status: 'error', message: login.message || 'GitHub sign-in failed. Try again.' };
    }
    const state = await githubAuth.getState();
    return state.authenticated
      ? { status: 'authenticated', login: state.login }
      : { status: 'error', message: state.error || 'No GitHub sign-in is in progress. Click Sign in with GitHub to try again.' };
  });
  ipcMain.handle('app:github-logout', event => {
    assertLocalUi(event, 'index.html');
    const result = githubAuth.logout();
    if (pendingGitHubCliLogin && pendingGitHubCliLogin.child) pendingGitHubCliLogin.child.kill();
    pendingGitHubCliLogin = null;
    if (repositoryBridge) repositoryBridge.stop().catch(() => {});
    return result;
  });
  ipcMain.handle('app:open-chatgpt', async event => {
    assertLocalUi(event, 'index.html');
    return openInBrowserAndYield('https://chatgpt.com/auth/login/');
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const bounds = clampBounds(settings.bounds || defaultBounds());
  mainWindow = new BrowserWindow({
    ...bounds,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    minWidth: 560,
    minHeight: 600,
    minimizable: true,
    maximizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: 'Windows Repository Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAlwaysOnTop(true);
  mainWindow.on('resize', saveWindowBoundsSoon);
  mainWindow.on('move', saveWindowBoundsSoon);
  mainWindow.on('close', saveWindowBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('app:collapsed-changed', collapsed);
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerHotkey() {
  if (!globalShortcut.register(SHORTCUT, toggleOverlay)) {
    console.warn('Global shortcut could not be registered:', SHORTCUT);
  }
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (collapsed) expandWindow();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hashin997ux.windowsrepositorybridge');
    settings = loadSettings();
    ensureWorkspaceRoot();

    githubAuth = createGitHubAuth({
      safeStorage,
      getSettings: () => settings,
      persistSettings
    });

    toolBridge = createToolBridge({
      dialog,
      getMainWindow: () => mainWindow,
      getWorkspaceRoot,
      localTools,
      githubAuth,
      uploadWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file)
    });

    repositoryBridge = createRepositoryBridge({
      githubAuth,
      getSettings: () => settings,
      persistSettings,
      getWorkspaceRoot,
      executeTool: (tool, args, requestId) => toolBridge.runTool(tool, args, requestId),
      onState: broadcastBridgeState,
      publishContextOnStart: true
    });

    registerIpc();
    createMainWindow();
    registerHotkey();

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      else {
        if (collapsed) expandWindow();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

app.on('before-quit', event => {
  clearTimeout(saveTimer);
  globalShortcut.unregisterAll();
  if (pendingGitHubCliLogin && pendingGitHubCliLogin.child) pendingGitHubCliLogin.child.kill();
  if (repositoryBridge && !finishingQuit) {
    event.preventDefault();
    finishingQuit = true;
    repositoryBridge.stop().catch(() => {}).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
