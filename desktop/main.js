'use strict';

const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  WebContentsView,
  screen,
  ipcMain,
  globalShortcut,
  shell,
  dialog,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  desktopCapturer,
  nativeTheme
} = require('electron');
const { clampRectToWorkArea } = require('./geometry');
const { resolveWorkspaceRoot, isFilesystemRoot, ensureWorkspaceDirectory } = require('./workspace-path');
const localTools = require('./tool-runner');
const { createGitHubAuth } = require('./github-auth');
const { createToolBridge } = require('./tool-bridge');
const { createRepositoryBridge } = require('./repository-bridge');
const { createVisionService, MAX_SCREENSHOT_BYTES, COLAB_NOTEBOOK_URL, parseTunnelEndpoint } = require('./colab-direct-service');
const { createColabHandoffServer } = require('./colab-handoff-server');
const { createWindowsInputController } = require('./windows-input');
const { captureWindowsUiAutomationSnapshot } = require('./windows-uia');
const { FilesystemIndexMonitor } = require('./filesystem-index');
const { createObserveService, DEFAULT_SAMPLE_FPS } = require('./observe-service');
const { createCloudSync } = require('./cloud-sync');

const DIAGNOSTIC_LOG_NAME = 'startup-crash.log';

function appendDiagnosticLog(kind, detail) {
  let userData;
  try {
    userData = app.getPath('userData');
  } catch {
    userData = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
  }
  const filename = path.join(userData, 'logs', DIAGNOSTIC_LOG_NAME);
  let message;
  try {
    message = detail instanceof Error
      ? String(detail.stack || detail.message || detail)
      : typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    message = String(detail);
  }
  message = String(message || '').replace(
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[A-Za-z0-9_-]{40,100}/gi,
    '[REDACTED_COLAB_ENDPOINT]'
  ).slice(0, 12000);
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.appendFileSync(filename, '[' + new Date().toISOString() + '] ' + String(kind) + ': ' + message + '\n', 'utf8');
  } catch {
    // Diagnostics must never become a second startup failure.
  }
}

process.on('uncaughtException', error => {
  appendDiagnosticLog('uncaughtException', error);
  console.error('Fatal Windows Repository Bridge main-process exception:', error);
  setImmediate(() => app.exit(1));
});

process.on('unhandledRejection', reason => {
  appendDiagnosticLog('unhandledRejection', reason);
  console.error('Unhandled Windows Repository Bridge rejection:', reason);
  // An asynchronous background failure is not automatically fatal to the whole desktop app.
  // Keep the worker alive so the error can be diagnosed and the app can report other status.
  if (repositoryBridge) {
    setAutoConnectionStatus('attention', 'A background operation failed unexpectedly. Details were saved to logs/startup-crash.log.');
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => {
    appendDiagnosticLog('render-process-gone', details);
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) appendDiagnosticLog('main-frame-load-failed', {
      errorCode, errorDescription, validatedURL, isMainFrame
    });
  });
});

app.on('child-process-gone', (_event, details) => {
  appendDiagnosticLog('child-process-gone', details);
});
appendDiagnosticLog('startup', 'Main process loaded; pid=' + process.pid);

const STATUS_SIZE = { width: 360, height: 402 };
const VISION_MANUAL_HEIGHT = 500;
const SHORTCUT = 'CommandOrControl+Shift+Space';
const AUTO_CONNECT_INTERVAL_MS = 5000;
const COLAB_HANDOFF_SCHEME = 'windows-repository-bridge';
const COLAB_HANDOFF_ARM_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_REPOSITORY_BRIDGE = Object.freeze({
  owner: 'hashin9973-ux',
  repo: 'qdqwg',
  branch: 'bridge-mailbox',
  allowPublicMailbox: false
});
const DASHBOARD_THEME_IDS = Object.freeze(['midnight', 'light', 'ocean', 'forest', 'sunset', 'rose', 'high-contrast', 'aurora', 'cyberpunk', 'dracula', 'nord', 'solarized-light', 'terminal', 'lavender', 'graphite']);

let mainWindow = null;
let dashboardWindow = null;
let tray = null;
let cloudSync = null;
let cloudSyncStatus = { enabled: false, configured: false, state: 'disabled', lastSyncedAt: '', error: '' };
let captionWindow = null;
let captionWindowLoaded = false;
let activeCaptionPayload = null;
let captionCloseTimer = null;
let captionPlaybackInFlight = false;
const browserTabs = new Map();
let activeBrowserTabId = null;
let browserBounds = { x: 0, y: 0, width: 1, height: 1 };
let nextBrowserTabId = 0;
let autoConnectTimer = null;
let autoConnectInFlight = false;
let autoConnectionStatus = 'connecting';
let autoConnectionError = '';
let settings = {};
let saveTimer = null;
let githubAuth = null;
let toolBridge = null;
let visionService = null;
let colabHandoffServer = null;
let observeService = null;
let windowsInputController = null;
let repositoryBridge = null;
let filesystemIndexMonitor = null;
let latestFilesystemIndexSnapshot = null;
let filesystemIndexSyncError = '';
let finishingQuit = false;
let finishingVisionDispose = false;
let finishingHandoffServerStop = false;
let pendingGitHubCliLogin = null;
let pendingColabHandoffUrl = '';
let colabHandoffInFlight = false;
let colabHandoffArmed = false;
let colabHandoffArmTimer = null;
let lastColabHandoffFingerprint = '';
let lastColabHandoffAt = 0;
const startupColabHandoffUri = process.argv.find(value => typeof value === 'string' && value.startsWith(COLAB_HANDOFF_SCHEME + '://')) || '';
let ipcRegistered = false;
let appInitializationError = '';
let workspaceInitializationError = '';
let trayInitializationError = '';

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
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:github-device-code', login.userCode);
  }
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
      if (login.child.stdin && !login.child.stdin.destroyed) login.child.stdin.end('\n');
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
  broadcastGitHubState({ configured: true, ...state });
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

function getDefaultWorkspaceRoot() {
  return path.join(app.getPath('documents'), 'ChatGPTWorkspace');
}

function getWorkspaceRoot() {
  // An explicitly selected drive root is a valid workspace. Path-based tools
  // remain confined to this root and reject symlink escapes.
  const root = resolveWorkspaceRoot(settings.workspaceRoot, getDefaultWorkspaceRoot());
  if (settings.workspaceRoot !== root) {
    settings.workspaceRoot = root;
    persistSettings();
  }
  return root;
}

function ensureWorkspaceRoot() {
  const fallbackRoot = path.join(app.getPath('userData'), 'ChatGPTWorkspace');
  const candidates = [...new Set([
    getWorkspaceRoot(),
    getDefaultWorkspaceRoot(),
    fallbackRoot
  ].map(candidate => path.resolve(candidate)))];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const root = resolveWorkspaceRoot(candidate, fallbackRoot);
      ensureWorkspaceDirectory(root, fs);
      settings.workspaceRoot = root;
      persistSettings();
      return root;
    } catch (error) {
      lastError = error;
      console.warn('Could not use workspace folder "' + candidate + '":', error.message);
    }
  }

  throw new Error(
    'Could not create a writable workspace folder in Documents or app data. ' +
    String(lastError && lastError.message || 'No suitable fallback directory was available.')
  );
}

async function restartFilesystemIndexMonitor() {
  if (filesystemIndexMonitor) {
    await filesystemIndexMonitor.stop().catch(() => {});
  }
  latestFilesystemIndexSnapshot = null;
  filesystemIndexSyncError = '';
  filesystemIndexMonitor = new FilesystemIndexMonitor({
    root: getWorkspaceRoot(),
    outputPath: path.join(app.getPath('userData'), 'filesystem-index.md'),
    onUpdate: async snapshot => {
      latestFilesystemIndexSnapshot = snapshot;
      if (!repositoryBridge || !repositoryBridge.getState().running) return false;
      try {
        await repositoryBridge.publishFilesystemIndex(snapshot);
        filesystemIndexSyncError = '';
      } catch (error) {
        filesystemIndexSyncError = String(error && error.message || error).slice(0, 500);
        throw error;
      }
    },
    onError: message => {
      filesystemIndexSyncError = String(message || '').slice(0, 500);
      console.warn('Filesystem index:', filesystemIndexSyncError);
    }
  });
  await filesystemIndexMonitor.start();
}

function selectWorkspace() {
  return dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    title: 'Choose the folder or entire drive ChatGPT may access',
    defaultPath: fs.existsSync(getWorkspaceRoot()) ? getWorkspaceRoot() : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  }).then(async result => {
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { canceled: true, workspaceRoot: getWorkspaceRoot() };
    }
    const selected = path.resolve(result.filePaths[0]);
    if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
      throw new Error('Selected workspace is not a directory.');
    }
    if (isFilesystemRoot(selected)) {
      const warning = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
        type: 'warning',
        title: 'Use the entire drive as the ChatGPT workspace?',
        message: 'ChatGPT will be able to read, create, edit, move, and delete files anywhere on this drive using workspace file tools.',
        detail: 'This is not an operating-system sandbox. File tools remain confined to the selected drive and reject symlink escapes, but ordinary edits/deletions inside it can run automatically. PowerShell runs with your Windows-user permissions and is not restricted to this drive. The background index scans only the drive root; deeper folders are explored on demand.',
        buttons: ['Use entire drive', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      });
      if (warning.response !== 0) {
        return { canceled: true, workspaceRoot: getWorkspaceRoot(), message: 'Whole-drive workspace selection was cancelled.' };
      }
    }
    settings.workspaceRoot = selected;
    persistSettings();
    void restartFilesystemIndexMonitor().catch(error => {
      filesystemIndexSyncError = String(error && error.message || error).slice(0, 500);
      console.warn('Could not restart filesystem index:', filesystemIndexSyncError);
    });
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

function hideToTray() { destroyDashboardWindowToTray(); }


function safeBrowserUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
        url.hostname === '127.0.0.1' || url.hostname === '[::1]' ||
        /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function dashboardSend(channel, value) {
  if (dashboardWindow && !dashboardWindow.isDestroyed() && !dashboardWindow.webContents.isDestroyed()) {
    dashboardWindow.webContents.send(channel, value);
  }
}

function browserTabSnapshot() {
  return [...browserTabs.values()].map(tab => ({
    id: tab.id, url: tab.url, title: tab.title, active: tab.id === activeBrowserTabId,
    loaded: Boolean(tab.view && !tab.view.webContents.isDestroyed())
  }));
}
function publishBrowserTabs() { dashboardSend('app:browser-tabs-changed', browserTabSnapshot()); }

function applyPageFocusCompatibility(tab, enabled = settings.browserKeepActive === true && tab.id === activeBrowserTabId) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  const script = `((enabled) => {
    const key = Symbol.for('windows-repository-bridge.focus-descriptors');
    if (!window[key]) Object.defineProperty(window, key, { configurable: false, value: {
      visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
      hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
      hasFocus: Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus')
    }});
    const saved = window[key];
    const toggle = (name, descriptor) => { try {
      if (enabled) Object.defineProperty(Document.prototype, name, descriptor);
      else if (saved[name]) Object.defineProperty(Document.prototype, name, saved[name]);
      else delete Document.prototype[name];
    } catch {} };
    toggle('visibilityState', { configurable: true, get: () => 'visible' });
    toggle('hidden', { configurable: true, get: () => false });
    toggle('hasFocus', { configurable: true, value: () => true });
    if (!enabled) {
      for (const name of ['visibilityState', 'hidden', 'hasFocus']) {
        try { if (saved[name]) Object.defineProperty(Document.prototype, name, saved[name]); else delete Document.prototype[name]; } catch {}
      }
    } else {
      try { document.dispatchEvent(new Event('visibilitychange')); } catch {}
    }
  })(${JSON.stringify(enabled)});`;
  void tab.view.webContents.executeJavaScript(script).catch(() => {});
}

function createBrowserView(tab) {
  const view = new WebContentsView({ webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    partition: 'persist:windows-bridge-browser', backgroundThrottling: !settings.browserKeepActive
  }});
  tab.view = view;
  view.webContents.setBackgroundThrottling(!settings.browserKeepActive);
  view.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeBrowserUrl(url);
    if (safe) void openBrowserTab(safe.href).catch(error => console.warn('Embedded popup failed:', error.message));
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => { if (!safeBrowserUrl(url)) event.preventDefault(); });
  view.webContents.on('will-redirect', (event, url) => { if (!safeBrowserUrl(url)) event.preventDefault(); });
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = String(title || tab.url).slice(0, 120); publishBrowserTabs(); });
  view.webContents.on('did-navigate', (_event, url) => {
    const safe = safeBrowserUrl(url); if (safe) tab.url = safe.href;
    const active = settings.browserKeepActive === true && tab.id === activeBrowserTabId;
    view.webContents.setBackgroundThrottling(!active);
    applyPageFocusCompatibility(tab, active);
    publishBrowserTabs(); measureBrowserMemory(tab);
  });
  view.webContents.on('dom-ready', () => {
    const active = settings.browserKeepActive === true && tab.id === activeBrowserTabId;
    view.webContents.setBackgroundThrottling(!active);
    applyPageFocusCompatibility(tab, active); measureBrowserMemory(tab);
  });
  view.webContents.on('render-process-gone', (_event, details) => appendDiagnosticLog('embedded-browser-renderer-gone', { tabId: tab.id, details }));
  tab.memoryTimer = setInterval(() => measureBrowserMemory(tab), 10000);
  view.webContents.loadURL(tab.url).catch(error => { tab.error = String(error && error.message || error).slice(0, 400); publishBrowserTabs(); });
  return view;
}
function measureBrowserMemory(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  void tab.view.webContents.getProcessMemoryInfo().then(info => dashboardSend('app:browser-memory', {
    id: tab.id, privateMb: Math.round((Number(info.private) || 0) / 1024 * 10) / 10
  })).catch(() => {});
}

function attachBrowserTab(id) {
  const tab = browserTabs.get(id);
  if (!dashboardWindow || dashboardWindow.isDestroyed() || !tab) return false;
  for (const other of browserTabs.values()) if (other.view) {
    try { dashboardWindow.contentView.removeChildView(other.view); } catch {}
    if (other.id !== id) {
      other.view.webContents.setBackgroundThrottling(true);
      applyPageFocusCompatibility(other, false);
    }
  }
  if (!tab.view || tab.view.webContents.isDestroyed()) createBrowserView(tab);
  tab.view.setBounds(browserBounds);
  dashboardWindow.contentView.addChildView(tab.view);
  activeBrowserTabId = id;
  tab.view.webContents.setBackgroundThrottling(!settings.browserKeepActive);
  applyPageFocusCompatibility(tab, settings.browserKeepActive === true);
  if (settings.browserLowMemory) for (const other of browserTabs.values()) {
    if (other.id !== id && other.view) {
      if (other.memoryTimer) clearInterval(other.memoryTimer);
      other.memoryTimer = null;
      try { other.view.webContents.close(); } catch {}
      other.view = null;
    }
  }
  publishBrowserTabs(); measureBrowserMemory(tab); return true;
}
function setBrowserTabActive(id) {
  const idValue = typeof id === 'string' && browserTabs.has(id) ? id : null;
  if (idValue) return attachBrowserTab(idValue);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) for (const tab of browserTabs.values()) {
    if (tab.view) {
      try { dashboardWindow.contentView.removeChildView(tab.view); } catch {}
      tab.view.webContents.setBackgroundThrottling(true);
      applyPageFocusCompatibility(tab, false);
    }
  }
  activeBrowserTabId = null;
  if (settings.browserLowMemory) for (const tab of browserTabs.values()) {
    if (tab.view) {
      if (tab.memoryTimer) clearInterval(tab.memoryTimer);
      tab.memoryTimer = null;
      try { tab.view.webContents.close(); } catch {}
      tab.view = null;
    }
  }
  publishBrowserTabs(); return { active: false };
}
async function openBrowserTab(raw) {
  const parsed = safeBrowserUrl(raw);
  if (!parsed) throw new Error('The embedded browser only accepts public HTTPS URLs.');
  if (!dashboardWindow || dashboardWindow.isDestroyed()) createDashboardWindow();
  showDashboardWindow();
  let tab = [...browserTabs.values()].find(item => item.url === parsed.href);
  if (tab) { attachBrowserTab(tab.id); return { id: tab.id, url: tab.url, title: tab.title, reused: true }; }
  tab = { id: 'web-' + (++nextBrowserTabId), url: parsed.href, title: parsed.hostname, view: null, error: '' };
  browserTabs.set(tab.id, tab); attachBrowserTab(tab.id); publishBrowserTabs();
  return { id: tab.id, url: tab.url, title: tab.title, reused: false };
}
function openColabBrowserTab(raw = COLAB_NOTEBOOK_URL) {
  const parsed = safeBrowserUrl(raw);
  if (!parsed || parsed.hostname !== 'colab.research.google.com') throw new Error('The Colab action can only open Google Colab notebook URLs.');
  return openBrowserTab(parsed.href);
}
function closeBrowserTab(id) {
  const tab = browserTabs.get(String(id || '')); if (!tab) return { closed: false };
  if (dashboardWindow && !dashboardWindow.isDestroyed() && tab.view) { try { dashboardWindow.contentView.removeChildView(tab.view); } catch {} }
  if (tab.memoryTimer) clearInterval(tab.memoryTimer);
  tab.memoryTimer = null;
  if (tab.view && !tab.view.webContents.isDestroyed()) { try { tab.view.webContents.close(); } catch {} }
  browserTabs.delete(tab.id); if (activeBrowserTabId === tab.id) activeBrowserTabId = null;
  publishBrowserTabs(); return { closed: true };
}
function showDashboardWindow() {
  showMainWindow();
  return { opened: true };
}

function destroyEmbeddedBrowserViews() {
  saveBrowserTabMetadata();
  for (const tab of browserTabs.values()) {
    if (tab.memoryTimer) clearInterval(tab.memoryTimer);
    tab.memoryTimer = null;
    if (dashboardWindow && !dashboardWindow.isDestroyed() && tab.view) { try { dashboardWindow.contentView.removeChildView(tab.view); } catch {} }
    if (tab.view && !tab.view.webContents.isDestroyed()) { try { tab.view.webContents.close(); } catch {} }
    tab.view = null;
  }
}

function destroyDashboardWindowToTray() {
  const win = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
  if (!win) return { hidden: true, destroyed: false };
  try { settings.dashboardBounds = win.getBounds(); } catch {}
  saveBrowserTabMetadata();
  persistSettings();
  destroyEmbeddedBrowserViews();
  if (mainWindow === win) mainWindow = null;
  if (dashboardWindow === win) dashboardWindow = null;
  try { win.destroy(); } catch (error) { appendDiagnosticLog('dashboard-destroy-to-tray-failed', error); }
  return { hidden: true, destroyed: true };
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
  const saved = settings.dashboardBounds && typeof settings.dashboardBounds === 'object' ? settings.dashboardBounds : {};
  const win = new BrowserWindow({
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    width: Number.isFinite(saved.width) ? Math.max(760, saved.width) : 1060,
    height: Number.isFinite(saved.height) ? Math.max(540, saved.height) : 760,
    minWidth: 760, minHeight: 540, show: false, backgroundColor: '#11161d', skipTaskbar: Boolean(tray),
    title: 'Windows Repository Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  dashboardWindow = win;
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.on('resize', () => {
    if (dashboardWindow !== win || win.isDestroyed()) return;
    settings.dashboardBounds = win.getBounds(); persistSettings(); publishSharedState();
    dashboardSend('app:browser-bounds-refresh', {});
  });
  win.on('move', () => {
    if (dashboardWindow !== win || win.isDestroyed()) return;
    settings.dashboardBounds = win.getBounds(); persistSettings();
  });
  win.on('minimize', event => { event.preventDefault(); destroyDashboardWindowToTray(); });
  win.on('close', event => {
    if (!finishingQuit) { event.preventDefault(); destroyDashboardWindowToTray(); return; }
    try { settings.dashboardBounds = win.getBounds(); } catch {}
    persistSettings();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) appendDiagnosticLog('dashboard-load-failed', { code, description, url });
  });
  win.on('closed', () => {
    for (const tab of browserTabs.values()) {
      if (tab.memoryTimer) clearInterval(tab.memoryTimer);
      tab.memoryTimer = null;
      if (tab.view && !tab.view.webContents.isDestroyed()) { try { tab.view.webContents.close(); } catch {} }
      tab.view = null;
    }
    if (dashboardWindow === win) dashboardWindow = null;
    if (mainWindow === win) mainWindow = null;
  });
  const reveal = () => {
    if (dashboardWindow !== win || win.isDestroyed()) return;
    win.show(); win.focus(); publishBrowserTabs();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  win.loadFile(path.join(__dirname, 'dashboard.html')).catch(error => {
    appendDiagnosticLog('dashboard-load-failed', error);
    if (!win.isDestroyed()) win.show();
  });
  return win;
}

function setBrowserBounds(value) {
  const size = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow.getContentBounds() : { width: 0, height: 0 };
  const v = value && typeof value === 'object' ? value : {};
  const x = Number(v.x), y = Number(v.y), width = Number(v.width), height = Number(v.height);
  if (![x,y,width,height].every(Number.isFinite) || width < 1 || height < 1) return { applied: false };
  const left = Math.max(0, Math.min(size.width - 1, x)), top = Math.max(0, Math.min(size.height - 1, y));
  browserBounds = { x: left, y: top, width: Math.max(1, Math.min(size.width-left,width)), height: Math.max(1, Math.min(size.height-top,height)) };
  const tab = browserTabs.get(activeBrowserTabId); if (tab && tab.view) tab.view.setBounds(browserBounds);
  return { applied: true, bounds: browserBounds };
}
function getBrowserSettings() {
  return { keepActive: settings.browserKeepActive === true, lowMemory: settings.browserLowMemory === true, volume: Number.isFinite(settings.ttsVolume) ? settings.ttsVolume : 100 };
}
function setBrowserSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const keepActive = v.keepActive === true, lowMemory = v.lowMemory === true;
  settings.browserKeepActive = keepActive; settings.browserLowMemory = lowMemory; persistSettings(); publishSharedState();
  for (const tab of browserTabs.values()) if (tab.view && !tab.view.webContents.isDestroyed()) {
    const enabled = keepActive && tab.id === activeBrowserTabId;
    tab.view.webContents.setBackgroundThrottling(!enabled);
    applyPageFocusCompatibility(tab, enabled);
  }
  if (lowMemory) for (const tab of browserTabs.values()) {
    if (tab.id === activeBrowserTabId || !tab.view) continue;
    if (tab.memoryTimer) clearInterval(tab.memoryTimer);
    tab.memoryTimer = null;
    try { tab.view.webContents.close(); } catch {}
    tab.view = null;
  }
  return getBrowserSettings();
}

function hideToTray() { destroyDashboardWindowToTray(); }


function minimizeToTray() { return destroyDashboardWindowToTray(); }

function showMainWindow() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) createDashboardWindow();
  const win = dashboardWindow;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus(); publishBrowserTabs();
  return { opened: true };
}

function toggleDashboardWindow() {
  if (!dashboardWindow || dashboardWindow.isDestroyed() || !dashboardWindow.isVisible()) showMainWindow();
  else destroyDashboardWindowToTray();
}

function createTray() {
  if (tray) return true;
  try {
    const icon = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlklEQVR42mNgGAUkgtT7R//jw3SzWERVGwXTzCH4LMWFqeYQUi3G5ZABsZwiR1DLcrIcQW3LSXYELSxHdgTZvieU/wllU6JCAZ/vqeEAvKFAjEZqOQCrIygpbMjRR1HiI9XXREXDqAMGhQMGPBEOaDYc8IJoUBTFA14ZDYrqeMAbJIOiSTYoGqWDolk+KDomg6ZrNmwBAI2DwEFWr0GLAAAAAElFTkSuQmCC',
      'base64'
    ));
    if (icon.isEmpty()) throw new Error('The built-in tray icon image could not be decoded.');
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Windows Repository Bridge');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Windows Bridge', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    trayInitializationError = '';
    console.info('System tray icon initialized.');
    return true;
  } catch (error) {
    trayInitializationError = String(error && error.message || error);
    console.error('Could not initialize system tray:', trayInitializationError);
    try { if (tray) tray.destroy(); } catch {}
    tray = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSkipTaskbar(false);
    return false;
  }
}


// Capture the primary display at its physical pixel dimensions. The 64x36 image below is
// only a fingerprint; it is never used as the visual/model input or coordinate frame.
async function captureDesktopScreenshot() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scaleFactor = Number(primaryDisplay.scaleFactor) || 1;
  const screenWidth = Math.max(1, Math.round(primaryDisplay.size.width * scaleFactor));
  const screenHeight = Math.max(1, Math.round(primaryDisplay.size.height * scaleFactor));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: screenWidth, height: screenHeight },
    fetchWindowIcons: false
  });
  const source = sources.find(item => String(item.display_id) === String(primaryDisplay.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Windows did not provide a usable desktop screenshot. Check desktop capture permissions and retry.');
  }
  const size = source.thumbnail.getSize();
  if (size.width !== screenWidth || size.height !== screenHeight) {
    throw new Error('Windows returned a ' + size.width + 'x' + size.height +
      ' capture for a ' + screenWidth + 'x' + screenHeight + ' display. Full-resolution capture is required; input coordinates were not authorized from a downscaled frame.');
  }
  const bytes = source.thumbnail.toPNG();
  return {
    bytes,
    filename: 'desktop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png',
    width: size.width,
    height: size.height,
    screen_width: screenWidth,
    screen_height: screenHeight,
    display_id: source.display_id || null,
    captured_at: Date.now(),
    frame_id: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function fingerprintDesktopScreenshot(captured) {
  if (!captured || !Buffer.isBuffer(captured.bytes) || !captured.bytes.length) {
    throw new Error('Observe received an empty screenshot.');
  }
  const image = nativeImage.createFromBuffer(captured.bytes);
  if (!image || image.isEmpty()) throw new Error('Observe could not decode the captured screenshot.');
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error('Observe screenshot has invalid dimensions.');
  // Downsample the full image before hashing. This catches small UI changes better than
  // sparse point sampling while keeping per-frame CPU and memory work bounded.
  const thumbnail = image.resize({ width: 64, height: 36, quality: 'good' });
  const bitmap = thumbnail.toBitmap();
  if (!bitmap || bitmap.length < 64 * 36 * 4) throw new Error('Observe screenshot thumbnail is invalid.');
  return crypto.createHash('sha256').update(bitmap.subarray(0, 64 * 36 * 4)).digest('hex');
}

function encodeVisionJpeg(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new Error('Image conversion requires non-empty bytes.');
  const original = nativeImage.createFromBuffer(input);
  if (!original || original.isEmpty()) throw new Error('The selected file is not a supported readable image.');
  const originalSize = original.getSize();
  if (!originalSize.width || !originalSize.height) throw new Error('Image has invalid dimensions.');
  // Preserve the pixel dimensions used for mouse coordinates. Reduce JPEG quality, never
  // spatial resolution; if the transfer budget cannot hold the frame, fail explicitly.
  let smallest = null;
  for (const quality of [88, 82, 76, 70, 64, 58, 52, 46, 40, 34, 28]) {
    const bytes = original.toJPEG(quality);
    if (!smallest || bytes.length < smallest.bytes.length) smallest = { bytes, quality };
    if (bytes.length <= MAX_SCREENSHOT_BYTES) {
      return { bytes, width: originalSize.width, height: originalSize.height, quality };
    }
  }
  throw new Error('Full-resolution ' + originalSize.width + 'x' + originalSize.height +
    ' screenshot exceeds the ' + Math.round(MAX_SCREENSHOT_BYTES / 1024) +
    ' KiB transfer budget even at JPEG quality ' + smallest.quality +
    ' (' + smallest.bytes.length + ' bytes). The image was not downscaled; use a larger supported transfer budget or a smaller display resolution.');
}

function isNetworkError(message) {
  return /network|offline|internet|fetch failed|failed to fetch|enotfound|eai_again|econn|etimedout|timed out|socket|dns|unable to connect|connection refused/i.test(String(message || ''));
}

function resolveWorkerStatus(state) {
  const current = state || (repositoryBridge ? repositoryBridge.getState() : {});
  if (!current.configured) return 'setup';
  if (!current.running) return autoConnectionStatus;

  // Only the mailbox request-tree poll proves the worker can currently reach
  // its configured transport. A generic lastError can be an ordinary tool or
  // result-publication error and must not mark a healthy worker as offline.
  const lastPollAt = Date.parse(String(current.lastPollAt || ''));
  const scanInterval = Math.max(1000, Number(current.requestPolling && current.requestPolling.requestTreeScanIntervalMs) || 5000);
  const freshnessWindowMs = Math.max(15000, scanInterval * 3);
  const pollFresh = Number.isFinite(lastPollAt) && Date.now() - lastPollAt <= freshnessWindowMs;
  if (pollFresh) return 'online';

  const connectionError = String(current.lastPollError || current.lastError || '');
  if (connectionError) return isNetworkError(connectionError) ? 'offline' : 'attention';
  return 'connecting';
}

function enrichedBridgeState(state) {
  const workerStatus = resolveWorkerStatus(state);
  const current = state || {};
  // Once the last successful mailbox scan is fresh, ignore any stale connection error
  // from an earlier failed startup/poll. Task errors remain separately visible in the tooltip.
  const connectionError = workerStatus === 'online' ? '' : (
    autoConnectionError ||
    (workerStatus === 'offline' || workerStatus === 'attention'
      ? (current.lastPollError || current.lastError || '')
      : '')
  );
  return { ...current, workerStatus, connectionError, autoAcceptAll: settings.autoAcceptAll === true };
}

function broadcastBridgeState(state) {
  const payload = enrichedBridgeState(state);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:bridge-state', payload);
  if (dashboardWindow && !dashboardWindow.isDestroyed() && !dashboardWindow.webContents.isDestroyed()) dashboardWindow.webContents.send('app:bridge-state', payload);
}

function broadcastGitHubState(state) {
  const safe = state && typeof state === 'object' ? { ...state } : { authenticated: false };
  delete safe.token;
  delete safe.accessToken;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:github-state', safe);
  if (dashboardWindow && !dashboardWindow.isDestroyed() && !dashboardWindow.webContents.isDestroyed()) dashboardWindow.webContents.send('app:github-state', safe);
}

function parseColabHandoffUri(raw) {
  if (typeof raw !== 'string' || raw.length > 1200) return null;
  try {
    const uri = new URL(raw);
    if (uri.protocol !== COLAB_HANDOFF_SCHEME + ':' || uri.hostname !== 'connect-colab' ||
        (uri.pathname && uri.pathname !== '/') || uri.username || uri.password || uri.port || uri.hash) return null;
    const keys = [...uri.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'endpoint' || uri.searchParams.getAll('endpoint').length !== 1) return null;
    const endpoint = parseTunnelEndpoint(uri.searchParams.get('endpoint'));
    return endpoint ? endpoint.url : null;
  } catch {
    return null;
  }
}

function publishColabHandoffResult(result) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const message = String(result && (result.message || result.error) || '')
    .replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[A-Za-z0-9_-]{40,100}/gi, '[redacted temporary Colab endpoint]')
    .slice(0, 500);
  const payload = {
    connected: Boolean(result && result.connected === true),
    status: String(result && result.status || (result && result.connected ? 'connected' : 'error')),
    message
  };
  mainWindow.webContents.send('app:colab-handoff-result', payload);
  if (dashboardWindow && !dashboardWindow.isDestroyed() && !dashboardWindow.webContents.isDestroyed()) dashboardWindow.webContents.send('app:colab-handoff-result', payload);
}

function disarmColabHandoff() {
  colabHandoffArmed = false;
  if (colabHandoffArmTimer) clearTimeout(colabHandoffArmTimer);
  colabHandoffArmTimer = null;
  pendingColabHandoffUrl = '';
}

function armColabHandoff() {
  if (colabHandoffArmTimer) clearTimeout(colabHandoffArmTimer);
  colabHandoffArmed = true;
  colabHandoffArmTimer = setTimeout(() => {
    colabHandoffArmed = false;
    colabHandoffArmTimer = null;
    pendingColabHandoffUrl = '';
    publishColabHandoffResult({
      connected: false,
      status: 'handoff_window_expired',
      message: 'Colab did not send an endpoint within 20 minutes. Click Connect Colab again to arm a new handoff.'
    });
  }, COLAB_HANDOFF_ARM_TIMEOUT_MS);
  colabHandoffArmTimer.unref?.();
}

function processPendingColabHandoff() {
  if (colabHandoffInFlight || !visionService || !pendingColabHandoffUrl) return;
  const endpoint = pendingColabHandoffUrl;
  pendingColabHandoffUrl = '';
  const fingerprint = crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
  const now = Date.now();
  if (fingerprint === lastColabHandoffFingerprint && now - lastColabHandoffAt < 5000) return;
  colabHandoffInFlight = true;
  void visionService.connectColab(endpoint)
    .then(result => {
      if (result && result.connected === true) {
        // Suppress only duplicate deliveries after a successful handshake. A
        // failed health/registration attempt must remain immediately retryable.
        lastColabHandoffFingerprint = fingerprint;
        lastColabHandoffAt = Date.now();
        if (!pendingColabHandoffUrl) disarmColabHandoff();
      } else if (lastColabHandoffFingerprint === fingerprint) {
        lastColabHandoffFingerprint = '';
        lastColabHandoffAt = 0;
      }
      publishColabHandoffResult(result);
    })
    .catch(error => {
      if (lastColabHandoffFingerprint === fingerprint) {
        lastColabHandoffFingerprint = '';
        lastColabHandoffAt = 0;
      }
      publishColabHandoffResult({
        connected: false,
        status: 'error',
        message: String(error && error.message || error)
      });
    })
    .finally(() => {
      colabHandoffInFlight = false;
      if (pendingColabHandoffUrl) processPendingColabHandoff();
    });
}

function queueColabHandoff(raw) {
  const endpoint = parseColabHandoffUri(raw);
  if (!endpoint) return false;
  pendingColabHandoffUrl = endpoint;
  if (visionService) processPendingColabHandoff();
  return true;
}

function queueColabEndpoint(raw) {
  // The loopback receiver is always listening, but a valid endpoint is accepted
  // only during a user-initiated Connect Colab window. This prevents unrelated
  // Colab output frames from causing unsolicited tunnel registration/activation.
  if (!colabHandoffArmed) return false;
  const endpoint = parseTunnelEndpoint(raw);
  if (!endpoint || typeof endpoint.url !== 'string') return false;
  pendingColabHandoffUrl = endpoint.url;
  if (visionService) processPendingColabHandoff();
  return true;
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
    const status = resolveWorkerStatus(initial);
    const connectionError = status === 'offline' || status === 'attention'
      ? String(initial.lastPollError || initial.lastError || '')
      : '';
    setAutoConnectionStatus(status, connectionError);
    // Force a poll after startup/reconnect. A task-level lastError does not make
    // the worker offline; resolveWorkerStatus uses the last successful mailbox scan.
    void repositoryBridge.pollOnce().catch(error => {
      const message = String(error && error.message || error);
      setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
    });
    return;
  }
  if (!initial.configured) {
    setAutoConnectionStatus('setup', 'The shared GitHub mailbox is not configured.');
    return;
  }

  autoConnectInFlight = true;
  try {
    const auth = await githubAuth.getState();
    broadcastGitHubState(auth);
    if (!auth.authenticated || auth.verificationPending === true) {
      const waiting = auth.verificationPending === true;
      setAutoConnectionStatus(waiting ? 'connecting' : (auth.error ? 'offline' : 'github'),
        auth.verificationError || auth.error || (waiting ? 'GitHub authorization was saved; checking API access.' : 'Sign in to GitHub to connect the mailbox.'));
      return;
    }
    setAutoConnectionStatus('connecting');
    const started = await repositoryBridge.start();
    setAutoConnectionStatus(resolveWorkerStatus(started), started.lastPollError || started.lastError || '');
    if (started.running && latestFilesystemIndexSnapshot) {
      // Initial index creation is asynchronous and may finish while the worker is offline.
      // Publish the latest snapshot after reconnect without blocking the online status update.
      void repositoryBridge.publishFilesystemIndex(latestFilesystemIndexSnapshot).then(() => {
        filesystemIndexSyncError = '';
      }).catch(error => {
        filesystemIndexSyncError = String(error && error.message || error).slice(0, 500);
        console.warn('Could not publish filesystem index:', filesystemIndexSyncError);
      });
    }
  } catch (error) {
    const message = String(error && error.message || error);
    setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
  } finally {
    autoConnectInFlight = false;
  }
}

function retryConnectionNow() {
  if (!repositoryBridge || !githubAuth) return { scheduled: false };
  const state = repositoryBridge.getState();

  // A user-requested retry must bypass the short pending-auth cache so the app
  // does a fresh GitHub /user probe. This runs alongside the mailbox poll when
  // the worker is already up, and restarts the worker immediately on recovery.
  void githubAuth.getState({ force: true }).then(auth => {
    broadcastGitHubState(auth);
    if (!auth.authenticated || auth.verificationPending === true) {
      const waiting = auth.verificationPending === true;
      setAutoConnectionStatus(waiting ? 'connecting' : (auth.error ? 'offline' : 'github'),
        auth.verificationError || auth.error || (waiting ? 'GitHub authorization was saved; checking API access.' : 'Sign in to GitHub to connect the mailbox.'));
      return;
    }
    if (!state.running) void attemptAutoConnect();
  }).catch(error => {
    const message = String(error && error.message || error);
    setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
  });

  if (state.running) {
    void repositoryBridge.pollOnce().catch(error => {
      const message = String(error && error.message || error);
      setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
    });
  }
  return { scheduled: true };
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
    if (!['github.com', 'docs.github.com', 'chatgpt.com', 'colab.research.google.com'].includes(url.hostname)) return null;
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
  const trusted = dashboardWindow && !dashboardWindow.isDestroyed() && dashboardWindow.webContents === event.sender ? { file: 'dashboard.html' } : null;
  if (!trusted) throw new Error('Only the trusted local dashboard may invoke this action.');
  const url = event.senderFrame && event.senderFrame.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/dashboard.html') ||
      (filename !== trusted.file && !(filename === 'index.html' && trusted.file === 'dashboard.html'))) throw new Error('Unexpected IPC sender.');
}


  const trusted = [
    { window: mainWindow, file: 'index.html' },
    { window: dashboardWindow, file: 'dashboard.html' }
  ].find(item => item.window && !item.window.isDestroyed() && item.window.webContents === event.sender);
  if (!trusted) throw new Error('Only a trusted local desktop window may invoke this action.');
  const url = event.senderFrame && event.senderFrame.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/' + trusted.file) ||
      (filename !== trusted.file && !(filename === 'index.html' && trusted.file === 'dashboard.html'))) {
    throw new Error('Unexpected IPC sender.');
  }
}


function getTtsSettings() {
  const source = settings.ttsSettings && typeof settings.ttsSettings === 'object' ? settings.ttsSettings : {};
  return {
    mode: source.mode === 'notification' ? 'notification' : 'autoplay',
    captionsOnAutoplay: source.captionsOnAutoplay !== false,
    captionTransparent: source.captionTransparent === true,
    captionPosition: ['top', 'center', 'bottom', 'custom'].includes(source.captionPosition) ? source.captionPosition : 'bottom',
    captionX: Number.isFinite(source.captionX) ? Math.round(Math.max(0, Math.min(100, source.captionX))) : 50,
    captionY: Number.isFinite(source.captionY) ? Math.round(Math.max(0, Math.min(100, source.captionY))) : 85,
    captionTheme: ['app', 'system', 'light', 'dark'].includes(source.captionTheme) ? source.captionTheme : 'app'
  };
}

function normalizeTtsSettings(value) {
  const current = getTtsSettings();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: source.mode === 'notification' || source.mode === 'autoplay' ? source.mode : current.mode,
    captionsOnAutoplay: typeof source.captionsOnAutoplay === 'boolean' ? source.captionsOnAutoplay : current.captionsOnAutoplay,
    captionTransparent: typeof source.captionTransparent === 'boolean' ? source.captionTransparent : current.captionTransparent,
    captionPosition: ['top', 'center', 'bottom', 'custom'].includes(source.captionPosition) ? source.captionPosition : current.captionPosition,
    captionX: Number.isFinite(source.captionX) ? Math.round(Math.max(0, Math.min(100, source.captionX))) : current.captionX,
    captionY: Number.isFinite(source.captionY) ? Math.round(Math.max(0, Math.min(100, source.captionY))) : current.captionY,
    captionTheme: ['app', 'system', 'light', 'dark'].includes(source.captionTheme) ? source.captionTheme : current.captionTheme
  };
}

function normalizeDashboardState(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const seen = new Set();
  const tabs = [];
  for (const raw of (Array.isArray(source.tabs) ? source.tabs : []).slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').slice(0, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(id) || seen.has(id)) continue;
    const kind = ['main', 'settings', 'browser'].includes(raw.kind) ? raw.kind : null;
    if (!kind) continue;
    const order = Number.isFinite(raw.order) ? Math.round(Math.max(0, Math.min(10000, raw.order))) : tabs.length;
    const tab = { id, kind, label: String(raw.label || (kind === 'main' ? 'Main' : kind === 'settings' ? 'Settings' : 'Web')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80), order, closable: kind !== 'main' };
    if (kind === 'browser') {
      const url = safeBrowserUrl(raw.url);
      const browserId = String(raw.browserId || '').slice(0, 80);
      if (!url || !/^web-\d{1,12}$/.test(browserId)) continue;
      tab.browserId = browserId;
      tab.url = url.href;
      tab.title = String(raw.title || tab.label).slice(0, 120);
    } else if (kind === 'main') {
      tab.closable = false;
    }
    seen.add(id);
    tabs.push(tab);
  }
  if (!seen.has('main')) tabs.unshift({ id: 'main', kind: 'main', label: 'Main', order: 0, closable: false });
  const widgetSource = source.widgets && typeof source.widgets === 'object' && !Array.isArray(source.widgets) ? source.widgets : {};
  const widgets = {};
  for (const id of ['queues', 'controls']) {
    const widget = widgetSource[id];
    if (!widget || typeof widget !== 'object') continue;
    const n = (key, fallback, min, max) => Number.isFinite(widget[key]) ? Math.round(Math.max(min, Math.min(max, widget[key]))) : fallback;
    widgets[id] = {
      x: n('x', 24, 0, 10000), y: n('y', 24, 0, 10000),
      width: n('width', id === 'queues' ? 600 : 420, 180, 4000),
      height: n('height', 160, 80, 3000)
    };
  }
  const activeTabId = String(source.activeTabId || 'main').slice(0, 80);
  tabs.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { tabs, activeTabId: tabs.some(tab => tab.id === activeTabId) ? activeTabId : 'main', widgets };
}

function defaultDashboardState() {
  const tabs = [
    { id: 'main', kind: 'main', label: 'Main', closable: false, order: 0 },
    { id: 'settings', kind: 'settings', label: 'Settings', closable: true, order: 1 }
  ];
  for (const tab of browserTabs.values()) {
    if (safeBrowserUrl(tab.url)) tabs.push({
      id: 'tab-' + tab.id, kind: 'browser', browserId: tab.id, url: tab.url,
      title: tab.title || tab.url, label: tab.title || 'Web', closable: true, order: tabs.length
    });
  }
  return normalizeDashboardState({ tabs, activeTabId: 'main', widgets: {} });
}

function saveBrowserTabMetadata() {
  settings.browserTabs = [...browserTabs.values()].filter(tab => safeBrowserUrl(tab.url)).map(tab => ({
    id: tab.id, url: tab.url, title: String(tab.title || tab.url).slice(0, 120)
  })).slice(0, 100);
  settings.activeBrowserTabId = browserTabs.has(activeBrowserTabId) ? activeBrowserTabId : null;
}

function restoreBrowserTabsFromSettings() {
  browserTabs.clear();
  const saved = Array.isArray(settings.browserTabs) ? settings.browserTabs : [];
  for (const item of saved.slice(0, 100)) {
    const id = String(item && item.id || '');
    const url = safeBrowserUrl(item && item.url);
    if (!/^web-\d{1,12}$/.test(id) || !url || browserTabs.has(id)) continue;
    browserTabs.set(id, { id, url: url.href, title: String(item.title || url.href).slice(0, 120), view: null, error: '' });
    nextBrowserTabId = Math.max(nextBrowserTabId, Number(id.slice(4)) || 0);
  }
  activeBrowserTabId = browserTabs.has(settings.activeBrowserTabId) ? settings.activeBrowserTabId : null;
}

function syncBrowserRegistryFromDashboardState(value) {
  const normalized = normalizeDashboardState(value);
  const wanted = new Map(normalized.tabs.filter(tab => tab.kind === 'browser').map(tab => [tab.browserId, tab]));
  for (const [id, tab] of browserTabs) {
    if (wanted.has(id)) continue;
    if (tab.memoryTimer) clearInterval(tab.memoryTimer);
    tab.memoryTimer = null;
    if (dashboardWindow && !dashboardWindow.isDestroyed() && tab.view) {
      try { dashboardWindow.contentView.removeChildView(tab.view); } catch {}
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) { try { tab.view.webContents.close(); } catch {} }
    browserTabs.delete(id);
    if (activeBrowserTabId === id) activeBrowserTabId = null;
  }
  for (const [id, item] of wanted) {
    const previous = browserTabs.get(id);
    if (previous && previous.url !== item.url && previous.view) {
      if (previous.memoryTimer) clearInterval(previous.memoryTimer);
      try { previous.view.webContents.close(); } catch {}
      previous.view = null;
      previous.memoryTimer = null;
    }
    browserTabs.set(id, {
      ...(previous || {}), id, url: item.url,
      title: item.title || item.label || item.url,
      view: previous && previous.url === item.url ? previous.view : null,
      error: previous && previous.error || ''
    });
    nextBrowserTabId = Math.max(nextBrowserTabId, Number(id.slice(4)) || 0);
  }
  settings.dashboardState = normalized;
  saveBrowserTabMetadata();
}

function collectSharedPreferences() {
  const tts = getTtsSettings();
  return {
    dashboardTheme: DASHBOARD_THEME_IDS.includes(settings.dashboardTheme) ? settings.dashboardTheme : 'midnight',
    ttsVolume: Number.isFinite(settings.ttsVolume) ? Math.max(0, Math.min(100, settings.ttsVolume)) : 100,
    browserKeepActive: settings.browserKeepActive === true,
    browserLowMemory: settings.browserLowMemory === true,
    observeFps: [0.5, 1, 2, 4, 8].includes(settings.observeFps) ? settings.observeFps : DEFAULT_SAMPLE_FPS,
    ttsMode: tts.mode, captionsOnAutoplay: tts.captionsOnAutoplay,
    captionTransparent: tts.captionTransparent, captionPosition: tts.captionPosition,
    captionX: tts.captionX, captionY: tts.captionY, captionTheme: tts.captionTheme
  };
}

function getCloudSyncLocalState() {
  const state = normalizeDashboardState(settings.dashboardState || defaultDashboardState());
  return {
    preferences: collectSharedPreferences(),
    tabs: state.tabs,
    widgets: Object.entries(state.widgets).map(([id, widget]) => ({ id, ...widget })),
    activeTabId: state.activeTabId
  };
}

function publishSharedState() {
  if (!cloudSync || !settings.cloudSync || settings.cloudSync.enabled !== true) return;
  void cloudSync.publishLocal().then(status => {
    cloudSyncStatus = status;
    dashboardSend('app:cloud-sync-status', status);
  }).catch(error => appendDiagnosticLog('cloud-sync-publish-failed', error));
}

function applyCloudRemoteState(shared) {
  const source = shared && typeof shared === 'object' ? shared : {};
  const preferences = source.preferences && typeof source.preferences === 'object' ? source.preferences : {};
  if (DASHBOARD_THEME_IDS.includes(preferences.dashboardTheme)) settings.dashboardTheme = preferences.dashboardTheme;
  if (Number.isFinite(preferences.ttsVolume)) settings.ttsVolume = Math.round(Math.max(0, Math.min(100, preferences.ttsVolume)));
  if (typeof preferences.browserKeepActive === 'boolean') settings.browserKeepActive = preferences.browserKeepActive;
  if (typeof preferences.browserLowMemory === 'boolean') settings.browserLowMemory = preferences.browserLowMemory;
  if ([0.5, 1, 2, 4, 8].includes(preferences.observeFps)) settings.observeFps = preferences.observeFps;
  settings.ttsSettings = normalizeTtsSettings({
    ...getTtsSettings(),
    ...(typeof preferences.ttsMode === 'string' ? { mode: preferences.ttsMode } : {}),
    ...(typeof preferences.captionsOnAutoplay === 'boolean' ? { captionsOnAutoplay: preferences.captionsOnAutoplay } : {}),
    ...(typeof preferences.captionTransparent === 'boolean' ? { captionTransparent: preferences.captionTransparent } : {}),
    ...(typeof preferences.captionPosition === 'string' ? { captionPosition: preferences.captionPosition } : {}),
    ...(Number.isFinite(preferences.captionX) ? { captionX: preferences.captionX } : {}),
    ...(Number.isFinite(preferences.captionY) ? { captionY: preferences.captionY } : {}),
    ...(typeof preferences.captionTheme === 'string' ? { captionTheme: preferences.captionTheme } : {})
  });
  settings.dashboardState = normalizeDashboardState({
    tabs: source.tabs,
    activeTabId: source.activeTabId,
    widgets: Object.fromEntries((Array.isArray(source.widgets) ? source.widgets : []).map(widget => [widget.id, widget]))
  });
  syncBrowserRegistryFromDashboardState(settings.dashboardState);
  for (const tab of browserTabs.values()) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    const active = settings.browserKeepActive === true && tab.id === activeBrowserTabId;
    tab.view.webContents.setBackgroundThrottling(!active);
  }
  persistSettings();
  dashboardSend('app:dashboard-state', settings.dashboardState);
  dashboardSend('app:preferences', getUiState().settings);
  if (activeCaptionPayload) updateCaptionWindowPayload();
}

function initializeCloudSync() {
  settings.cloudSync = settings.cloudSync && typeof settings.cloudSync === 'object' ? settings.cloudSync : {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(settings.cloudSync.deviceId || ''))) settings.cloudSync.deviceId = crypto.randomUUID();
  cloudSync = createCloudSync({
    deviceId: settings.cloudSync.deviceId,
    getLocalState: getCloudSyncLocalState,
    applyRemoteState: applyCloudRemoteState,
    onStatus: value => {
      cloudSyncStatus = value;
      dashboardSend('app:cloud-sync-status', value);
    }
  });
  void cloudSync.configure({ folder: settings.cloudSync.folder || '', enabled: settings.cloudSync.enabled === true });
}

function captionThemeId() {
  const tts = getTtsSettings();
  if (tts.captionTheme === 'light') return 'light';
  if (tts.captionTheme === 'dark') return 'midnight';
  if (tts.captionTheme === 'system') return nativeTheme.shouldUseDarkColors ? 'light' : 'midnight';
  return DASHBOARD_THEME_IDS.includes(settings.dashboardTheme) ? settings.dashboardTheme : 'midnight';
}

function captionBounds() {
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(760, Math.max(360, work.width - 24));
  const height = 168;
  const tts = getTtsSettings();
  let x = work.x + Math.round((work.width - width) / 2);
  let y = work.y + work.height - height - 24;
  if (tts.captionPosition === 'top') y = work.y + 24;
  else if (tts.captionPosition === 'center') y = work.y + Math.round((work.height - height) / 2);
  else if (tts.captionPosition === 'custom') {
    x = work.x + Math.round(Math.max(0, work.width - width) * tts.captionX / 100);
    y = work.y + Math.round(Math.max(0, work.height - height) * tts.captionY / 100);
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function currentCaptionPayload() {
  if (!activeCaptionPayload) return null;
  return { ...activeCaptionPayload, theme: captionThemeId(), transparent: getTtsSettings().captionTransparent };
}

function updateCaptionWindowPayload() {
  if (!captionWindow || captionWindow.isDestroyed() || captionWindow.webContents.isDestroyed() || !activeCaptionPayload) return;
  if (captionWindow.isVisible()) captionWindow.setBounds(captionBounds());
  if (captionWindowLoaded) captionWindow.webContents.send('caption:update', currentCaptionPayload());
}

function createCaptionWindow() {
  if (captionWindow && !captionWindow.isDestroyed()) return captionWindow;
  if (!activeCaptionPayload) return null;
  captionWindowLoaded = false;
  const current = new BrowserWindow({
    ...captionBounds(), frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, resizable: false, minimizable: false, maximizable: false,
    closable: true, focusable: activeCaptionPayload.mode === 'notification',
    skipTaskbar: true, show: false, alwaysOnTop: true, title: 'Windows Bridge Speech',
    webPreferences: { preload: path.join(__dirname, 'caption-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  captionWindow = current;
  current.setMenuBarVisibility(false);
  current.setAlwaysOnTop(true);
  try { current.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.once('did-finish-load', () => {
    if (captionWindow !== current || current.isDestroyed()) return;
    captionWindowLoaded = true;
    current.webContents.send('caption:update', currentCaptionPayload());
  });
  current.once('ready-to-show', () => {
    if (captionWindow !== current || current.isDestroyed()) return;
    if (activeCaptionPayload && activeCaptionPayload.mode === 'notification') current.show();
    else current.showInactive();
  });
  current.on('closed', () => {
    if (captionWindow === current) {
      captionWindow = null;
      captionWindowLoaded = false;
      activeCaptionPayload = null;
    }
    if (captionCloseTimer) clearTimeout(captionCloseTimer);
    captionCloseTimer = null;
  });
  current.loadFile(path.join(__dirname, 'caption.html')).catch(error => appendDiagnosticLog('caption-window-load-failed', error));
  return current;
}

function showSpeechCaption(request) {
  if (!request || typeof request.text !== 'string') return null;
  const text = request.text.trim().slice(0, 240);
  if (!text) return null;
  const mode = request.mode === 'notification' ? 'notification' : 'autoplay';
  if (mode === 'autoplay' && !getTtsSettings().captionsOnAutoplay) return null;
  if (captionCloseTimer) clearTimeout(captionCloseTimer);
  captionCloseTimer = null;
  const payload = {
    id: String(request.id || crypto.randomUUID()), text, mode,
    showPlayButton: mode === 'notification', status: mode === 'notification' ? 'Ready to play' : 'Preparing speech…', error: ''
  };
  const previousMode = activeCaptionPayload && activeCaptionPayload.mode;
  activeCaptionPayload = payload;
  if (captionWindow && !captionWindow.isDestroyed() && previousMode !== mode) {
    const old = captionWindow;
    old.close();
    if (!captionWindow || captionWindow.isDestroyed()) createCaptionWindow();
  } else if (!captionWindow || captionWindow.isDestroyed()) {
    createCaptionWindow();
  } else {
    captionWindow.setBounds(captionBounds());
    if (!captionWindow.isVisible()) mode === 'notification' ? captionWindow.show() : captionWindow.showInactive();
    updateCaptionWindowPayload();
  }
  return payload.id;
}

function estimateSpeechDurationMs(text) {
  return Math.max(3500, Math.min(90000, Math.ceil(String(text || '').length / 13 * 1000 + 3500)));
}

function scheduleCaptionClose(milliseconds) {
  if (captionCloseTimer) clearTimeout(captionCloseTimer);
  captionCloseTimer = setTimeout(() => {
    captionCloseTimer = null;
    if (captionWindow && !captionWindow.isDestroyed()) captionWindow.close();
  }, Math.max(1000, Math.min(120000, milliseconds)));
  if (typeof captionCloseTimer.unref === 'function') captionCloseTimer.unref();
}

function finishSpeechCaption(request, output) {
  if (!request || !activeCaptionPayload || request.id !== activeCaptionPayload.id) return;
  if (request.mode === 'notification') {
    activeCaptionPayload.status = output && output.status === 'tts_completed' ? 'Speech ready · press Play' : 'Speech prepared';
    activeCaptionPayload.error = output && output.status === 'tts_failed' ? String(output.error || 'Speech preparation failed.') : '';
    updateCaptionWindowPayload();
    return;
  }
  if (output && output.status === 'tts_started') {
    activeCaptionPayload.status = 'Speaking…';
    activeCaptionPayload.error = '';
    updateCaptionWindowPayload();
    scheduleCaptionClose(estimateSpeechDurationMs(request.text));
  } else {
    activeCaptionPayload.status = 'Speech could not start';
    activeCaptionPayload.error = String(output && (output.error || output.message) || 'TTS did not start.').slice(0, 220);
    updateCaptionWindowPayload();
    scheduleCaptionClose(6500);
  }
}

async function playActiveCaption() {
  if (!activeCaptionPayload || activeCaptionPayload.mode !== 'notification') throw new Error('There is no pending speech notification.');
  if (captionPlaybackInFlight) return { started: false, busy: true };
  if (!visionService || typeof visionService.synthesizeSpeech !== 'function') throw new Error('The Colab TTS service is unavailable.');
  captionPlaybackInFlight = true;
  const request = { ...activeCaptionPayload };
  activeCaptionPayload.status = 'Preparing speech…';
  activeCaptionPayload.error = '';
  updateCaptionWindowPayload();
  try {
    const output = await visionService.synthesizeSpeech({ text: request.text, play: true }, crypto.randomUUID());
    if (activeCaptionPayload && activeCaptionPayload.id === request.id && output && output.status === 'tts_started') {
      activeCaptionPayload.status = 'Speaking…';
      activeCaptionPayload.showPlayButton = false;
      updateCaptionWindowPayload();
      scheduleCaptionClose(estimateSpeechDurationMs(request.text));
      return { started: true, speech_job_id: output.speech_job_id };
    }
    if (activeCaptionPayload && activeCaptionPayload.id === request.id) {
      activeCaptionPayload.status = 'Playback failed';
      activeCaptionPayload.error = String(output && (output.error || output.message) || 'TTS playback failed.').slice(0, 220);
      activeCaptionPayload.showPlayButton = true;
      updateCaptionWindowPayload();
    }
    throw new Error(String(output && (output.error || output.message) || 'TTS playback failed.'));
  } finally {
    captionPlaybackInFlight = false;
  }
}

function assertCaptionUi(event) {
  if (!captionWindow || captionWindow.isDestroyed() || captionWindow.webContents !== event.sender) throw new Error('Only the local speech window may invoke this action.');
  const url = event.senderFrame && event.senderFrame.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/caption.html')) throw new Error('Unexpected speech-window IPC sender.');
}
function getUiState() {
  const cloud = settings.cloudSync && typeof settings.cloudSync === 'object' ? settings.cloudSync : {};
  return {
    settings: {
      repositoryBridge: settings.repositoryBridge || DEFAULT_REPOSITORY_BRIDGE,
      dashboardTheme: DASHBOARD_THEME_IDS.includes(settings.dashboardTheme) ? settings.dashboardTheme : 'midnight',
      ttsVolume: Number.isFinite(settings.ttsVolume) ? settings.ttsVolume : 100,
      ttsSettings: getTtsSettings(),
      browserKeepActive: settings.browserKeepActive === true,
      browserLowMemory: settings.browserLowMemory === true,
      observeFps: [0.5, 1, 2, 4, 8].includes(settings.observeFps) ? settings.observeFps : DEFAULT_SAMPLE_FPS
    },
    dashboardState: normalizeDashboardState(settings.dashboardState || defaultDashboardState()),
    browserTabs: browserTabSnapshot(),
    cloudSync: { ...cloudSyncStatus, enabled: cloud.enabled === true, configured: Boolean(cloud.folder), folder: String(cloud.folder || '') },
    bridge: enrichedBridgeState(repositoryBridge ? repositoryBridge.getState() : { running: false, configured: false }),
    workspace: {
      root: getWorkspaceRoot(),
      index: filesystemIndexMonitor ? filesystemIndexMonitor.getState() : null,
      syncError: workspaceInitializationError || filesystemIndexSyncError || ''
    },
    initialization: {
      error: appInitializationError || workspaceInitializationError || '',
      trayAvailable: Boolean(tray),
      trayError: trayInitializationError
    }
  };
}

function saveDashboardState(value) {
  const normalized = normalizeDashboardState(value);
  settings.dashboardState = normalized;
  syncBrowserRegistryFromDashboardState(normalized);
  saveBrowserTabMetadata();
  persistSettings();
  publishSharedState();
  dashboardSend('app:dashboard-state', normalized);
  return normalized;
}

async function chooseCloudFolder() {
  const options = { title: 'Choose your synchronized Windows Bridge folder', properties: ['openDirectory', 'createDirectory'] };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true, status: cloudSyncStatus };
  settings.cloudSync = { ...(settings.cloudSync || {}), folder: path.resolve(result.filePaths[0]) };
  persistSettings();
  if (cloudSync) cloudSyncStatus = await cloudSync.configure({ folder: settings.cloudSync.folder, enabled: settings.cloudSync.enabled === true });
  dashboardSend('app:cloud-sync-status', cloudSyncStatus);
  return { canceled: false, folder: settings.cloudSync.folder, status: cloudSyncStatus };
}


  return {
    settings: {
      repositoryBridge: settings.repositoryBridge || DEFAULT_REPOSITORY_BRIDGE,
      dashboardTheme: DASHBOARD_THEME_IDS.includes(settings.dashboardTheme) ? settings.dashboardTheme : 'midnight',
      ttsVolume: Number.isFinite(settings.ttsVolume) ? settings.ttsVolume : 100,
      browserKeepActive: settings.browserKeepActive === true,
      browserLowMemory: settings.browserLowMemory === true
    },
    bridge: enrichedBridgeState(repositoryBridge ? repositoryBridge.getState() : { running: false, configured: false }),
    // This state is returned only to the local desktop UI. Absolute local paths
    // are not added to the GitHub mailbox context or shared worker state.
    workspace: {
      root: getWorkspaceRoot(),
      index: filesystemIndexMonitor ? filesystemIndexMonitor.getState() : null,
      syncError: workspaceInitializationError || filesystemIndexSyncError || ''
    },
    initialization: {
      error: appInitializationError || workspaceInitializationError || '',
      trayAvailable: Boolean(tray),
      trayError: trayInitializationError
    }
  };
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcMain.handle('app:get-state', event => {
    assertLocalUi(event, 'index.html');
    return getUiState();
  });
  ipcMain.handle('app:open-dashboard', event => { assertLocalUi(event, 'index.html'); return showDashboardWindow(); });
  ipcMain.handle('app:save-dashboard-state', (event, value) => { assertLocalUi(event, 'index.html'); return saveDashboardState(value); });
  ipcMain.handle('app:save-now', event => { assertLocalUi(event, 'index.html'); persistSettings(); return { saved: true, savedAt: new Date().toISOString() }; });
  ipcMain.handle('app:cloud-sync-status', event => { assertLocalUi(event, 'index.html'); return getUiState().cloudSync; });
  ipcMain.handle('app:cloud-sync-choose-folder', async event => { assertLocalUi(event, 'index.html'); return chooseCloudFolder(); });
  ipcMain.handle('app:cloud-sync-config', async (event, value) => {
    assertLocalUi(event, 'index.html');
    if (!value || typeof value.enabled !== 'boolean') throw new Error('Cloud sync enabled must be a boolean.');
    const folder = String(settings.cloudSync && settings.cloudSync.folder || '');
    if (value.enabled && !folder) throw new Error('Choose a synchronized cloud folder before enabling live sync.');
    settings.cloudSync = { ...(settings.cloudSync || {}), enabled: value.enabled };
    persistSettings();
    cloudSyncStatus = cloudSync ? await cloudSync.configure({ folder, enabled: value.enabled }) : { enabled: false, configured: Boolean(folder), state: 'unavailable', error: 'Cloud sync service is not initialized.' };
    dashboardSend('app:cloud-sync-status', cloudSyncStatus);
    return cloudSyncStatus;
  });
  ipcMain.handle('app:cloud-sync-now', async event => {
    assertLocalUi(event, 'index.html');
    if (!cloudSync || !settings.cloudSync || settings.cloudSync.enabled !== true) throw new Error('Enable cloud sync and choose a folder first.');
    cloudSyncStatus = await cloudSync.syncNow();
    dashboardSend('app:cloud-sync-status', cloudSyncStatus);
    return cloudSyncStatus;
  });
  ipcMain.handle('app:tts-settings', (event, value) => {
    assertLocalUi(event, 'index.html');
    if (value === undefined) return getTtsSettings();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TTS settings must be an object.');
    settings.ttsSettings = normalizeTtsSettings({ ...getTtsSettings(), ...value });
    persistSettings(); publishSharedState();
    if (activeCaptionPayload) updateCaptionWindowPayload();
    dashboardSend('app:preferences', getUiState().settings);
    return getTtsSettings();
  });
  ipcMain.handle('app:caption-preview', event => {
    assertLocalUi(event, 'index.html');
    showSpeechCaption({ id: crypto.randomUUID(), mode: getTtsSettings().mode, text: 'This is a preview of your speech captions.' });
    return { shown: Boolean(captionWindow) };
  });
  ipcMain.handle('caption:play', event => { assertCaptionUi(event); return playActiveCaption(); });
  ipcMain.handle('caption:dismiss', event => {
    assertCaptionUi(event);
    if (captionWindow && !captionWindow.isDestroyed()) captionWindow.close();
    return { dismissed: true };
  });
  ipcMain.handle('app:browser-tabs', event => { assertLocalUi(event, 'index.html'); return browserTabSnapshot(); });
  ipcMain.handle('app:browser-open-tab', (event, url) => { assertLocalUi(event, 'index.html'); return openBrowserTab(url); });
  ipcMain.handle('app:colab-open-tab', event => { assertLocalUi(event, 'index.html'); return openColabBrowserTab(); });
  ipcMain.handle('app:browser-tab-active', (event, id) => { assertLocalUi(event, 'index.html'); return setBrowserTabActive(id); });
  ipcMain.handle('app:browser-tab-close', (event, id) => { assertLocalUi(event, 'index.html'); return closeBrowserTab(id); });
  ipcMain.handle('app:browser-bounds', (event, bounds) => { assertLocalUi(event, 'index.html'); return setBrowserBounds(bounds); });
  ipcMain.handle('app:browser-settings', (event, value) => { assertLocalUi(event, 'index.html'); return value === undefined ? getBrowserSettings() : setBrowserSettings(value); });
  ipcMain.handle('app:tts-volume', (event, raw) => {
    assertLocalUi(event, 'index.html'); const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('TTS volume must be between 0 and 100.');
    settings.ttsVolume = Math.round(value); persistSettings(); publishSharedState(); return { volume: settings.ttsVolume };
  });
  ipcMain.handle('app:set-theme', (event, raw) => {
    assertLocalUi(event, 'index.html');
    const theme = String(raw || '');
    if (!DASHBOARD_THEME_IDS.includes(theme)) throw new Error('Choose one of the available dashboard themes.');
    settings.dashboardTheme = theme;
    persistSettings(); publishSharedState();
    dashboardSend('app:preferences', getUiState().settings);
    return { theme };
  });
  ipcMain.handle('app:repository-bridge-config', async (event, input) => {
    assertLocalUi(event, 'index.html');
    if (!input || typeof input !== 'object') throw new Error('Repository settings are required.');
    const owner=String(input.owner||'').trim(), repo=String(input.repo||'').trim(), branch=String(input.branch||'').trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || owner==='.' || owner==='..' ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo==='.' || repo==='..' ||
        !branch || branch.length>120 || branch.startsWith('/') || branch.endsWith('/') ||
        branch.includes('..') || branch.includes('//') || !/^[A-Za-z0-9_.\/-]+$/.test(branch)) throw new Error('Enter a valid repository owner, name, and branch.');
    const existingRetention=settings.repositoryBridge&&settings.repositoryBridge.retentionDays;
    const next={owner,repo,branch,allowPublicMailbox:input.allowPublicMailbox===true,
      retentionDays:Number.isInteger(input.retentionDays)?input.retentionDays:(Number.isInteger(existingRetention)?existingRetention:30)};
    const before={...(settings.repositoryBridge||DEFAULT_REPOSITORY_BRIDGE)};
    const current=repositoryBridge?repositoryBridge.getState():{};
    if(Number(current.activeCount)>0 || Number(current.pendingCount)>0) throw new Error('Cannot switch the bridge repository while requests are active or queued.');
    if(repositoryBridge) await repositoryBridge.stop();
    try {
      if(repositoryBridge) repositoryBridge.setConfig(next); else {settings.repositoryBridge=next;persistSettings();}
      if(repositoryBridge && githubAuth) await repositoryBridge.start();
    } catch(error) {
      if(repositoryBridge) {
        try{repositoryBridge.setConfig(before);}catch{settings.repositoryBridge=before;persistSettings();}
        try{if(githubAuth)await repositoryBridge.start();}catch{}
      } else {settings.repositoryBridge=before;persistSettings();}
      throw new Error('Repository change failed; the previous configuration was restored. '+String(error&&error.message||error));
    }
    return { repositoryBridge: settings.repositoryBridge, bridge: repositoryBridge ? repositoryBridge.getState() : null };
  });
  ipcMain.handle('app:select-workspace', async event => {
    assertLocalUi(event, 'index.html');
    const result = await selectWorkspace();
    return { ...result, workspace: getUiState().workspace };
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
  ipcMain.handle('app:github-state', async event => {
    assertLocalUi(event, 'index.html');
    const state = githubAuth
      ? await githubAuth.getState()
      : { authenticated: false, error: appInitializationError || 'GitHub authentication service is not available.' };
    broadcastGitHubState(state);
    return state;
  });
  ipcMain.handle('app:observe-status', event => {
    assertLocalUi(event, 'index.html');
    return observeService ? observeService.status() : { enabled: false, status: 'unavailable', error: 'Observe service is unavailable.' };
  });
  ipcMain.handle('app:observe-toggle', async (event, enabled) => {
    assertLocalUi(event, 'index.html');
    if (typeof enabled !== 'boolean') throw new Error('Observe toggle must be a boolean.');
    if (!observeService) throw new Error('Observe service is unavailable.');
    const githubState = githubAuth ? await githubAuth.getState() : { authenticated: false };
    if (enabled && !githubState.authenticated) throw new Error('Sign in to GitHub before enabling Observe mode.');
    return observeService.setEnabled(enabled);
  });
  ipcMain.handle('app:observe-fps', async (event, fps) => {
    assertLocalUi(event, 'index.html');
    if (!observeService) throw new Error('Observe service is unavailable.');
    try {
      const state = await observeService.setFps(fps);
      settings.observeFps = state.fps ?? DEFAULT_SAMPLE_FPS;
      persistSettings(); publishSharedState();
      return state;
    } catch (error) {
      // setFps can apply the local timer before its mailbox status update fails.
      // Persist the actual running value so the selector and next startup agree.
      const state = observeService.status();
      if (Number.isFinite(state.fps)) {
        settings.observeFps = state.fps;
        persistSettings(); publishSharedState();
      }
      throw error;
    }
  });
  ipcMain.handle('app:vision-status', async event => {
    assertLocalUi(event, 'index.html');
    if (!visionService) {
      return {
        status: 'unavailable',
        enabled: false,
        runtime_fresh: false,
        model_loaded: false,
        message: appInitializationError || 'Vision service is not available in this app session.'
      };
    }
    // Colab's direct HTTPS health endpoint is independent of the GitHub mailbox.
    // Do not hide a live Colab runtime because a separate GitHub /user probe timed out.
    const state = visionService.status();
    const handoff = colabHandoffServer ? colabHandoffServer.status() : { ready: false, lastError: 'not_initialized' };
    return { ...state, automatic_handoff_ready: handoff.ready === true, automatic_handoff_armed: colabHandoffArmed, automatic_handoff_error: handoff.lastError || '' };
  });
  ipcMain.handle('app:vision-connect-colab', async (event, endpointUrl) => {
    assertLocalUi(event, 'index.html');
    if (!visionService) {
      return {
        status: 'error',
        connected: false,
        opened: false,
        vision_activated: false,
        message: appInitializationError || 'Colab vision service is unavailable in this app session.'
      };
    }
    const manualEndpoint = typeof endpointUrl === 'string' && endpointUrl.trim().length > 0;
    if (manualEndpoint) {
      disarmColabHandoff();
      return visionService.connectColab(endpointUrl);
    }

    // Arm only after a local user action invokes Connect Colab. The loopback
    // receiver can remain bound at startup, but must not accept unsolicited
    // endpoint posts from unrelated Colab tabs.
    if (colabHandoffServer && !colabHandoffServer.status().ready) {
      try { await colabHandoffServer.start(); }
      catch (error) {
        appendDiagnosticLog('colab-loopback-handoff-start-failed', {
          code: String(error && error.code || ''),
          message: String(error && error.message || error).slice(0, 240)
        });
      }
    }
    armColabHandoff();
    const result = await visionService.connectColab('');
    if (!(result && result.endpoint_watch_active === true) &&
        !(result && result.status === 'waiting_for_runtime' && result.opened === true)) {
      disarmColabHandoff();
    }
    return { ...result, automatic_handoff_ready: Boolean(colabHandoffServer && colabHandoffServer.status().ready), automatic_handoff_armed: colabHandoffArmed };
  });
  ipcMain.handle('app:vision-manual-panel', (event, visible) => { assertLocalUi(event, 'index.html'); return { expanded: visible === true }; });
  ipcMain.handle('app:vision-setup-check', async event => {
    assertLocalUi(event, 'index.html');
    const githubState = githubAuth
      ? await githubAuth.getState()
      : { authenticated: false, error: appInitializationError || 'GitHub authentication service is not available.' };
    if (!visionService) {
      return {
        status: 'failed',
        checked_at: new Date().toISOString(),
        checks: {
          github: { status: githubState.authenticated ? 'passed' : 'action_required', message: githubState.authenticated ? 'Signed in.' : 'GitHub sign-in is not verified.' },
          mailbox: { status: 'not_verified', message: 'Vision/mailbox service is unavailable in this app session.' },
          colab: { status: 'not_verified', message: 'Colab runtime status is unavailable.' },
          model: { status: 'not_verified', message: 'Model readiness is unavailable.' },
          vision: { status: 'disabled', message: 'No activation was attempted.' }
        },
        next_steps: [appInitializationError || 'Restart the app after resolving its initialization error.'],
        note: 'Setup check does not enable vision or trigger model downloads.'
      };
    }
    return visionService.setupCheck(githubState);
  });
  ipcMain.handle('app:copy-device-code', (event, rawCode) => {
    assertLocalUi(event, 'index.html');
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
      throw new Error('Invalid GitHub device code.');
    }
    clipboard.writeText(code);
    return { copied: true };
  });
  ipcMain.handle('app:retry-connection', event => {
    assertLocalUi(event, 'index.html');
    return retryConnectionNow();
  });
  ipcMain.handle('app:github-reconnect', async event => {
    assertLocalUi(event, 'index.html');
    if (!githubAuth) throw new Error(appInitializationError || 'GitHub authentication service is not available.');
    const current = await githubAuth.getState();
    if (current.authenticated) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Reconnect GitHub',
        message: 'Sign in to GitHub again?',
        detail: 'This disconnects the saved GitHub account from this app and starts a fresh sign-in. Your GitHub account and repositories are not changed.',
        buttons: ['Cancel', 'Sign in again'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });
      if (choice.response !== 1) return { cancelled: true };
    }
    if (pendingGitHubCliLogin && pendingGitHubCliLogin.child) {
      try { pendingGitHubCliLogin.child.kill(); } catch {}
    }
    pendingGitHubCliLogin = null;
    githubAuth.logout();
    const flow = startGitHubCliLogin();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.blur();
    }
    return flow;
  });
  ipcMain.handle('app:github-start-login', async event => {
    assertLocalUi(event, 'index.html');
    if (!githubAuth) throw new Error(appInitializationError || 'GitHub authentication service is not available.');
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
    if (!githubAuth) return { status: 'error', message: appInitializationError || 'GitHub authentication service is not available.' };
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
  ipcRegistered = true;
}

function createMainWindow() {
  return createDashboardWindow();
}

function registerHotkey() {
  if (!globalShortcut.register(SHORTCUT, toggleDashboardWindow)) {
    console.warn('Global shortcut could not be registered:', SHORTCUT);
  }
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = Array.isArray(commandLine)
      ? commandLine.find(value => typeof value === 'string' && value.startsWith(COLAB_HANDOFF_SCHEME + '://'))
      : '';
    if (deepLink) queueColabHandoff(deepLink);
    showMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueColabHandoff(url);
  });

  app.whenReady().then(() => {
    appendDiagnosticLog('startup', 'Electron app ready; version=' + app.getVersion() + '; packaged=' + app.isPackaged);
    app.setAppUserModelId('com.hashin997ux.windowsrepositorybridge');
    try {
      const registered = app.isPackaged
        ? app.setAsDefaultProtocolClient(COLAB_HANDOFF_SCHEME)
        : app.setAsDefaultProtocolClient(COLAB_HANDOFF_SCHEME, process.execPath, [path.resolve(process.argv[1] || '.')]);
      if (!registered) appendDiagnosticLog('colab-handoff-protocol', 'Native URL protocol registration did not succeed; the notebook output fallback stays available.');
    } catch (error) {
      appendDiagnosticLog('colab-handoff-protocol-registration-failed', String(error && error.message || error));
    }
    settings = loadSettings();
    const savedBridge = settings.repositoryBridge && typeof settings.repositoryBridge === 'object'
      ? settings.repositoryBridge : {};
    settings.dashboardTheme = DASHBOARD_THEME_IDS.includes(settings.dashboardTheme) ? settings.dashboardTheme : 'midnight';
    settings.ttsVolume = Number.isFinite(settings.ttsVolume) ? Math.max(0, Math.min(100, Math.round(settings.ttsVolume))) : 100;
    settings.ttsSettings = normalizeTtsSettings(settings.ttsSettings);
    settings.cloudSync = settings.cloudSync && typeof settings.cloudSync === 'object' ? settings.cloudSync : {};
    settings.cloudSync.folder = typeof settings.cloudSync.folder === 'string' ? settings.cloudSync.folder : '';
    settings.cloudSync.enabled = settings.cloudSync.enabled === true;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(settings.cloudSync.deviceId || ''))) settings.cloudSync.deviceId = crypto.randomUUID();
    settings.observeFps = [0.5, 1, 2, 4, 8].includes(settings.observeFps) ? settings.observeFps : DEFAULT_SAMPLE_FPS;
    restoreBrowserTabsFromSettings();
    settings.dashboardState = normalizeDashboardState(settings.dashboardState || defaultDashboardState());
    syncBrowserRegistryFromDashboardState(settings.dashboardState);
    settings.browserKeepActive = settings.browserKeepActive === true;
    settings.browserLowMemory = settings.browserLowMemory === true;
    settings.repositoryBridge = {
      ...DEFAULT_REPOSITORY_BRIDGE,
      ...savedBridge,
      owner: String(savedBridge.owner || DEFAULT_REPOSITORY_BRIDGE.owner),
      repo: String(savedBridge.repo || DEFAULT_REPOSITORY_BRIDGE.repo),
      branch: String(savedBridge.branch || DEFAULT_REPOSITORY_BRIDGE.branch),
      allowPublicMailbox: savedBridge.allowPublicMailbox === true
    };
    persistSettings();

    // Build the desktop shell first: a workspace or mailbox problem must not
    // prevent the window controls, IPC endpoints, or system tray from existing.
    registerIpc();
    createTray();
    createMainWindow();
    initializeCloudSync();
    registerHotkey();
    app.on('activate', showMainWindow);

    try {
      ensureWorkspaceRoot();
    } catch (error) {
      workspaceInitializationError = String(error && error.message || error).slice(0, 1000);
      filesystemIndexSyncError = workspaceInitializationError;
      console.error('Could not initialize workspace folder:', workspaceInitializationError);
    }

    try {
      githubAuth = createGitHubAuth({
        safeStorage,
        getSettings: () => settings,
        persistSettings
      });
    } catch (error) {
      appInitializationError = 'GitHub authentication could not initialize: ' + String(error && error.message || error);
      console.error(appInitializationError);
    }

    if (githubAuth) {
      try {
        windowsInputController = createWindowsInputController({
          platform: process.platform,
          getFrame: () => {
            const display = screen.getPrimaryDisplay();
            const scale = Number(display.scaleFactor) || 1;
            return {
              width: Math.max(1, Math.round(display.size.width * scale)),
              height: Math.max(1, Math.round(display.size.height * scale))
            };
          }
        });
        visionService = createVisionService({
          githubAuth,
          getSettings: () => settings,
          getWorkspaceRoot,
          inputControl: windowsInputController,
          captureScreenshot: captureDesktopScreenshot,
          getAccessibleSnapshot: captureWindowsUiAutomationSnapshot,
          getLatestFrame: maxAgeMs => observeService ? observeService.getLatestFrame(maxAgeMs) : null,
          encodeJpeg: encodeVisionJpeg,
          openColabNotebook: url => openColabBrowserTab(url),
          getTtsVolume: () => Number.isFinite(settings.ttsVolume) ? settings.ttsVolume : 100,
          readClipboardText: () => clipboard.readText(),
          publishWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file)
        });
        colabHandoffServer = createColabHandoffServer({
          parseEndpoint: parseTunnelEndpoint,
          onEndpoint: queueColabEndpoint
        });
        void colabHandoffServer.start().catch(error => {
          appendDiagnosticLog('colab-loopback-handoff-listen-failed', {
            code: String(error && error.code || ''),
            message: String(error && error.message || error).slice(0, 240)
          });
        });
        observeService = createObserveService({
          githubAuth,
          getSampleFps: () => settings.observeFps ?? DEFAULT_SAMPLE_FPS,
          captureScreenshot: captureDesktopScreenshot,
          fingerprintScreenshot: fingerprintDesktopScreenshot,
          getAccessibleSnapshot: captureWindowsUiAutomationSnapshot,
          analyzeFrame: frame => visionService ? visionService.analyzeFrame(frame) : Promise.resolve({ status: 'error', error: 'Colab vision service is unavailable.' })
        });
        void observeService.clearStaleContext().catch(error => {
          appendDiagnosticLog('observe-stale-context-clear-failed', error);
        });
        toolBridge = createToolBridge({
          dialog,
          getMainWindow: () => mainWindow,
          getWorkspaceRoot,
          localTools,
          githubAuth,
          uploadWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file),
          getAutoAcceptAll: () => settings.autoAcceptAll === true,
          getTtsSettings,
          onTtsRequest: showSpeechCaption,
          onTtsResult: finishSpeechCaption,
          visionService
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
      } catch (error) {
        appInitializationError = 'Local worker services could not initialize: ' + String(error && error.message || error);
        appendDiagnosticLog('worker-services-initialization-failed', error);
        console.error(appInitializationError);
      }
    }

    if (repositoryBridge) {
      void restartFilesystemIndexMonitor().catch(error => {
        filesystemIndexSyncError = String(error && error.message || error).slice(0, 500);
        console.warn('Could not start filesystem index:', filesystemIndexSyncError);
      });
      startAutoConnectLoop();
      if (startupColabHandoffUri) queueColabHandoff(startupColabHandoffUri);
      else if (pendingColabHandoffUrl) processPendingColabHandoff();
    } else if (appInitializationError) {
      setAutoConnectionStatus('attention', appInitializationError);
    }

    if (!tray) {
      // Avoid a completely hidden process if Windows refuses to register the tray icon.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSkipTaskbar(false);
      dialog.showErrorBox(
        'Windows Repository Bridge tray unavailable',
        'The system tray icon could not be created: ' + (trayInitializationError || 'unknown error') +
        '\n\nThe status window remains available in the taskbar.'
      );
    }
  }).catch(error => {
    const message = String(error && error.stack || error && error.message || error || 'Unknown startup error');
    appendDiagnosticLog('startup-failed', message);
    console.error('Windows Repository Bridge startup failed:', message);
    if (!settings || typeof settings !== 'object') settings = {};
    try { if (!ipcRegistered) registerIpc(); } catch (ipcError) { console.error('Could not register desktop actions:', ipcError); }
    try { if (!tray) createTray(); } catch (trayError) { console.error('Could not create system tray:', trayError); }
    try {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      else showMainWindow();
      if (!tray && mainWindow && !mainWindow.isDestroyed()) mainWindow.setSkipTaskbar(false);
    } catch (windowError) {
      console.error('Could not create the status window after startup failure:', windowError);
    }
    dialog.showErrorBox(
      'Windows Repository Bridge startup failed',
      message.slice(0, 1600) + '\n\nThe app shell remains available where possible, even if a workspace or service failed to initialize.'
    );
  });
}

app.on('before-quit', event => {
  clearTimeout(saveTimer);
  disarmColabHandoff();
  if (autoConnectTimer) clearInterval(autoConnectTimer);
  autoConnectTimer = null;
  globalShortcut.unregisterAll();
  if (pendingGitHubCliLogin && pendingGitHubCliLogin.child) pendingGitHubCliLogin.child.kill();
  if (repositoryBridge && !finishingQuit) {
    event.preventDefault();
    finishingQuit = true;
    const stopIndex = filesystemIndexMonitor
      ? filesystemIndexMonitor.stop().catch(() => {})
      : Promise.resolve();
    stopIndex.finally(() => {
      repositoryBridge.stop().catch(() => {}).finally(() => app.quit());
    });
    return;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (!finishingVisionDispose && (observeService || visionService || windowsInputController)) {
    event.preventDefault();
    finishingVisionDispose = true;
    const disposals = [];
    if (observeService && typeof observeService.dispose === 'function') {
      disposals.push(observeService.dispose());
      observeService = null;
    }
    if (visionService && typeof visionService.dispose === 'function') disposals.push(visionService.dispose());
    else if (windowsInputController && typeof windowsInputController.dispose === 'function') disposals.push(windowsInputController.dispose());
    Promise.allSettled(disposals).finally(() => app.quit());
    return;
  }
  if (colabHandoffServer && !finishingHandoffServerStop) {
    event.preventDefault();
    finishingHandoffServerStop = true;
    const server = colabHandoffServer;
    void server.stop().catch(error => {
      appendDiagnosticLog('colab-loopback-handoff-stop-failed', String(error && error.message || error));
    }).finally(() => {
      colabHandoffServer = null;
      app.quit();
    });
    return;
  }
});

app.on('window-all-closed', () => {
  // Keep the worker and tray icon alive while the status window is hidden.
});
