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
  safeStorage,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const { clampRectToWorkArea } = require('./geometry');
const localTools = require('./tool-runner');
const { createGitHubAuth } = require('./github-auth');
const { createToolBridge } = require('./tool-bridge');
const { createRepositoryBridge } = require('./repository-bridge');

const STATUS_SIZE = { width: 318, height: 131 };
const SHORTCUT = 'CommandOrControl+Shift+Space';
const AUTO_CONNECT_INTERVAL_MS = 10000;
const DEFAULT_REPOSITORY_BRIDGE = Object.freeze({
  owner: 'hashin9973-ux',
  repo: 'qdqwg',
  branch: 'bridge-mailbox',
  allowPublicMailbox: false
});

let mainWindow = null;
let tray = null;
let autoConnectTimer = null;
let autoConnectInFlight = false;
let autoConnectionStatus = 'connecting';
let autoConnectionError = '';
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
  // A successful sign-in should bring the mailbox online without a separate
  // Start Worker action.
  void attemptAutoConnect();
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
    width: STATUS_SIZE.width,
    height: STATUS_SIZE.height
  };
  const display = screen.getDisplayMatching(safe);
  return clampRectToWorkArea(safe, display.workArea, 280, 84);
}

function defaultBounds() {
  const work = screen.getPrimaryDisplay().workArea;
  return clampBounds({
    x: work.x + Math.max(0, work.width - STATUS_SIZE.width - 24),
    y: work.y + Math.max(0, work.height - STATUS_SIZE.height - 24),
    ...STATUS_SIZE
  });
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  settings.bounds = { x, y, width: STATUS_SIZE.width, height: STATUS_SIZE.height };
  persistSettings();
}

function saveWindowBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowBounds, 250);
}

function hideToTray() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function minimizeToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) hideToTray();
  else mainWindow.minimize();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
}

function toggleOverlay() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showMainWindow();
    return;
  }
  hideToTray();
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlklEQVR42mNgGAUkgtT7R//jw3SzWERVGwXTzCH4LMWFqeYQUi3G5ZABsZwiR1DLcrIcQW3LSXYELSxHdgTZvieU/wllU6JCAZ/vqeEAvKFAjEZqOQCrIygpbMjRR1HiI9XXREXDqAMGhQMGPBEOaDYc8IJoUBTFA14ZDYrqeMAbJIOiSTYoGqWDolk+KDomg6ZrNmwBAI2DwEFWr0GLAAAAAElFTkSuQmCC', 'base64'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Windows Repository Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open status', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function isNetworkError(message) {
  return /network|offline|internet|fetch failed|failed to fetch|enotfound|eai_again|econn|etimedout|timed out|socket|dns|unable to connect|connection refused/i.test(String(message || ''));
}

function resolveWorkerStatus(state) {
  const current = state || (repositoryBridge ? repositoryBridge.getState() : {});
  if (!current.configured) return 'setup';
  if (current.running) {
    if (current.lastError) return isNetworkError(current.lastError) ? 'offline' : 'attention';
    return 'online';
  }
  return autoConnectionStatus;
}

function enrichedBridgeState(state) {
  return { ...(state || {}), workerStatus: resolveWorkerStatus(state), connectionError: autoConnectionError || (state && state.lastError) || '', autoAcceptAll: settings.autoAcceptAll === true };
}

function broadcastBridgeState(state) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:bridge-state', enrichedBridgeState(state));
  }
}

function setAutoConnectionStatus(status, error = '') {
  autoConnectionStatus = status;
  autoConnectionError = String(error || '');
  if (repositoryBridge) broadcastBridgeState(repositoryBridge.getState());
}

async function attemptAutoConnect() {
  if (!repositoryBridge || !githubAuth || autoConnectInFlight) return;
  const initial = repositoryBridge.getState();
  if (initial.running) {
    setAutoConnectionStatus(initial.lastError
      ? (isNetworkError(initial.lastError) ? 'offline' : 'attention')
      : 'online', initial.lastError || '');
    return;
  }
  if (!initial.configured) {
    setAutoConnectionStatus('setup', 'The shared GitHub mailbox is not configured.');
    return;
  }

  autoConnectInFlight = true;
  try {
    const auth = await githubAuth.getState();
    if (!auth.authenticated) {
      setAutoConnectionStatus(auth.error ? 'offline' : 'github', auth.error || 'Sign in to GitHub to connect the mailbox.');
      return;
    }
    setAutoConnectionStatus('connecting');
    const started = await repositoryBridge.start();
    setAutoConnectionStatus(started.running ? 'online' : 'connecting', started.lastError || '');
  } catch (error) {
    const message = String(error && error.message || error);
    setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
  } finally {
    autoConnectInFlight = false;
  }
}

function startAutoConnectLoop() {
  if (autoConnectTimer) clearInterval(autoConnectTimer);
  void attemptAutoConnect();
  autoConnectTimer = setInterval(() => { void attemptAutoConnect(); }, AUTO_CONNECT_INTERVAL_MS);
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
  showMainWindow();
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
    bridge: enrichedBridgeState(repositoryBridge ? repositoryBridge.getState() : { running: false, configured: false })
  };
}

function registerIpc() {
  ipcMain.handle('app:get-state', event => {
    assertLocalUi(event, 'index.html');
    return getUiState();
  });
  ipcMain.handle('app:set-auto-accept-all', async (event, enabled) => {
    assertLocalUi(event, 'index.html');
    if (typeof enabled !== 'boolean') throw new Error('auto-accept setting must be a boolean.');
    if (enabled && settings.autoAcceptAll !== true) {
      const options = {
        type: 'warning',
        title: 'Enable Auto-accept Everything?',
        message: 'Allow the worker to run all requested local operations without per-operation approval?',
        detail: 'This includes PowerShell commands, tests, Git operations, uploads, and access to secret-like files. PowerShell runs as your Windows user and is not confined to the workspace. Use this only with a trusted ChatGPT conversation and your private mailbox repository.',
        buttons: ['Enable auto-accept', 'Keep disabled'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return { autoAcceptAll: settings.autoAcceptAll === true, cancelled: true };
    }
    settings.autoAcceptAll = enabled;
    persistSettings();
    if (repositoryBridge) broadcastBridgeState(repositoryBridge.getState());
    return { autoAcceptAll: settings.autoAcceptAll };
  });
  ipcMain.handle('app:minimize-to-tray', event => {
    assertLocalUi(event, 'index.html');
    minimizeToTray();
    return { hidden: true };
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
      void attemptAutoConnect();
      return result;
    }
    pendingGitHubCliLogin = null;
    const current = await githubAuth.getState();
    if (current.authenticated) {
      void attemptAutoConnect();
      return { status: 'authenticated', login: current.login, mode: 'github-cli' };
    }
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
        return {
          status: 'pending',
          intervalSeconds: 3,
          ...(login.userCode ? { userCode: login.userCode } : {}),
          ...(login.browserOpenError ? { message: login.message, browserOpenError: login.browserOpenError } : {})
        };
      }
      pendingGitHubCliLogin = null;
      if (login.status === 'authenticated') {
        bringMainWindowForward();
        void attemptAutoConnect();
        return { status: 'authenticated', login: login.login };
      }
      bringMainWindowForward();
      return { status: 'error', message: login.message || 'GitHub sign-in failed. Try again.' };
    }
    const state = await githubAuth.getState();
    if (state.authenticated) void attemptAutoConnect();
    return state.authenticated
      ? { status: 'authenticated', login: state.login }
      : { status: 'error', message: state.error || 'No GitHub sign-in is in progress. Click GitHub status to try again.' };
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }
  const bounds = clampBounds(settings.bounds || defaultBounds());
  mainWindow = new BrowserWindow({
    ...bounds,
    width: STATUS_SIZE.width,
    height: STATUS_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  mainWindow.on('move', saveWindowBoundsSoon);
  mainWindow.on('minimize', event => {
    event.preventDefault();
    hideToTray();
  });
  mainWindow.on('close', event => {
    if (!finishingQuit) {
      event.preventDefault();
      hideToTray();
      return;
    }
    saveWindowBounds();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
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
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hashin997ux.windowsrepositorybridge');
    settings = loadSettings();
    const savedBridge = settings.repositoryBridge && typeof settings.repositoryBridge === 'object'
      ? settings.repositoryBridge : {};
    settings.repositoryBridge = {
      ...DEFAULT_REPOSITORY_BRIDGE,
      ...savedBridge,
      owner: String(savedBridge.owner || DEFAULT_REPOSITORY_BRIDGE.owner),
      repo: String(savedBridge.repo || DEFAULT_REPOSITORY_BRIDGE.repo),
      branch: String(savedBridge.branch || DEFAULT_REPOSITORY_BRIDGE.branch),
      allowPublicMailbox: savedBridge.allowPublicMailbox === true
    };
    ensureWorkspaceRoot();
    persistSettings();

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
      uploadWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file),
      getAutoAcceptAll: () => settings.autoAcceptAll === true
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
    createTray();
    createMainWindow();
    registerHotkey();
    startAutoConnectLoop();

    app.on('activate', showMainWindow);
  });
}

app.on('before-quit', event => {
  clearTimeout(saveTimer);
  if (autoConnectTimer) clearInterval(autoConnectTimer);
  autoConnectTimer = null;
  globalShortcut.unregisterAll();
  if (pendingGitHubCliLogin && pendingGitHubCliLogin.child) pendingGitHubCliLogin.child.kill();
  if (repositoryBridge && !finishingQuit) {
    event.preventDefault();
    finishingQuit = true;
    repositoryBridge.stop().catch(() => {}).finally(() => app.quit());
    return;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  // Keep the worker and tray icon alive while the status window is hidden.
});
