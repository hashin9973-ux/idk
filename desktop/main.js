'use strict';

const path = require('node:path');
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
let accountsWindow = null;
let collapsed = false;
let settings = {};
let saveTimer = null;
let githubAuth = null;
let toolBridge = null;
let repositoryBridge = null;
let finishingQuit = false;

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
    title: 'Choose the local workspace ChatGPT can work with',
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
    if (!['github.com', 'docs.github.com'].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
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

function assertAccountUi(event) {
  if (!accountsWindow || accountsWindow.isDestroyed() || event.sender !== accountsWindow.webContents) {
    throw new Error('Only the local Accounts window may invoke this action.');
  }
  const url = event.senderFrame && event.senderFrame.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/accounts.html')) {
    throw new Error('Unexpected IPC sender for Accounts.');
  }
}

function createAccountsWindow() {
  if (accountsWindow && !accountsWindow.isDestroyed()) {
    accountsWindow.show();
    accountsWindow.focus();
    return;
  }
  accountsWindow = new BrowserWindow({
    width: 560,
    height: 630,
    minWidth: 480,
    minHeight: 520,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    title: 'Windows Bridge · GitHub account',
    autoHideMenuBar: true,
    backgroundColor: '#10151d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  const reference = accountsWindow;
  reference.once('ready-to-show', () => {
    if (!reference.isDestroyed()) reference.show();
  });
  reference.on('closed', () => {
    if (accountsWindow === reference) accountsWindow = null;
  });
  reference.webContents.setWindowOpenHandler(({ url }) => {
    const safe = getSafeExternalUrl(url);
    if (safe) shell.openExternal(safe.href).catch(() => {});
    return { action: 'deny' };
  });
  reference.loadFile(path.join(__dirname, 'accounts.html'));
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
  ipcMain.handle('app:poll-now', async event => {
    assertLocalUi(event, 'index.html');
    await repositoryBridge.pollOnce();
    return repositoryBridge.getState();
  });
  ipcMain.handle('app:select-workspace', async event => {
    assertLocalUi(event, 'index.html');
    return selectWorkspace();
  });
  ipcMain.handle('app:open-accounts', event => {
    assertLocalUi(event, 'index.html');
    createAccountsWindow();
    return { opened: true };
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

  ipcMain.handle('app:github-state', async event => {
    assertAccountUi(event);
    return githubAuth.getState();
  });
  ipcMain.handle('app:github-set-client-id', (event, clientId) => {
    assertAccountUi(event);
    return githubAuth.setClientId(clientId);
  });
  ipcMain.handle('app:github-start-login', async event => {
    assertAccountUi(event);
    const result = await githubAuth.startLogin();
    const safe = getSafeExternalUrl(result.verificationUrl);
    if (safe) shell.openExternal(safe.href).catch(() => {});
    return result;
  });
  ipcMain.handle('app:github-poll-login', async event => {
    assertAccountUi(event);
    return githubAuth.pollLogin();
  });
  ipcMain.handle('app:github-logout', event => {
    assertAccountUi(event);
    const result = githubAuth.logout();
    if (repositoryBridge) repositoryBridge.stop().catch(() => {});
    return result;
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
      onState: broadcastBridgeState
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
  if (repositoryBridge && !finishingQuit) {
    event.preventDefault();
    finishingQuit = true;
    repositoryBridge.stop().catch(() => {}).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
