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
  nativeImage,
  clipboard,
  desktopCapturer
} = require('electron');
const { clampRectToWorkArea } = require('./geometry');
const { resolveWorkspaceRoot, isFilesystemRoot, ensureWorkspaceDirectory } = require('./workspace-path');
const localTools = require('./tool-runner');
const { createGitHubAuth } = require('./github-auth');
const { createToolBridge } = require('./tool-bridge');
const { createRepositoryBridge } = require('./repository-bridge');
const { createVisionService, MAX_SCREENSHOT_BYTES, COLAB_NOTEBOOK_URL } = require('./colab-direct-service');
const { createWindowsInputController } = require('./windows-input');
const { FilesystemIndexMonitor } = require('./filesystem-index');

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
  // Preserve Node's fatal-unhandled-rejection behavior, but persist the cause first.
  setImmediate(() => app.exit(1));
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

const STATUS_SIZE = { width: 360, height: 348 };
const VISION_MANUAL_HEIGHT = 500;
const SHORTCUT = 'CommandOrControl+Shift+Space';
const AUTO_CONNECT_INTERVAL_MS = 5000;
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
let visionService = null;
let windowsInputController = null;
let repositoryBridge = null;
let filesystemIndexMonitor = null;
let latestFilesystemIndexSnapshot = null;
let filesystemIndexSyncError = '';
let finishingQuit = false;
let finishingVisionDispose = false;
let pendingGitHubCliLogin = null;
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
      { label: 'Open status', click: showMainWindow },
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


async function captureDesktopScreenshot() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false
  });
  const source = sources.find(item => String(item.display_id) === String(primaryDisplay.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Windows did not provide a usable desktop screenshot. Check desktop capture permissions and retry.');
  }
  const size = source.thumbnail.getSize();
  const scaleFactor = Number(primaryDisplay.scaleFactor) || 1;
  return {
    bytes: source.thumbnail.toPNG(),
    filename: 'desktop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png',
    width: size.width,
    height: size.height,
    screen_width: Math.max(1, Math.round(primaryDisplay.size.width * scaleFactor)),
    screen_height: Math.max(1, Math.round(primaryDisplay.size.height * scaleFactor)),
    display_id: source.display_id || null
  };
}

function encodeVisionJpeg(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new Error('Image conversion requires non-empty bytes.');
  const original = nativeImage.createFromBuffer(input);
  if (!original || original.isEmpty()) throw new Error('The selected file is not a supported readable image.');
  const originalSize = original.getSize();
  if (!originalSize.width || !originalSize.height) throw new Error('Image has invalid dimensions.');
  let best = null;
  for (const scale of [1, 0.85, 0.7, 0.58, 0.46, 0.36, 0.28, 0.2]) {
    const width = Math.max(1, Math.round(originalSize.width * scale));
    const height = Math.max(1, Math.round(originalSize.height * scale));
    const image = scale === 1 ? original : original.resize({ width, height, quality: 'good' });
    for (const quality of [82, 72, 62, 52, 42, 34]) {
      const bytes = image.toJPEG(quality);
      if (!best || bytes.length < best.bytes.length) best = { bytes, width, height, quality };
      if (bytes.length <= MAX_SCREENSHOT_BYTES) return { bytes, width, height, quality };
    }
  }
  if (!best) throw new Error('Could not convert the image to JPEG.');
  throw new Error('Screenshot compression could not meet the 600 KiB mailbox transfer limit (smallest attempt: ' +
    best.bytes.length + ' bytes). Use a smaller screenshot.');
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
    // Force a retry as the connection returns, even if the worker was already
    // running when the network disappeared. pollOnce prevents overlapping polls.
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
    if (!auth.authenticated) {
      setAutoConnectionStatus(auth.error ? 'offline' : 'github', auth.error || 'Sign in to GitHub to connect the mailbox.');
      return;
    }
    setAutoConnectionStatus('connecting');
    const started = await repositoryBridge.start();
    setAutoConnectionStatus(started.running ? 'online' : 'connecting', started.lastError || '');
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
  if (state.running) {
    void repositoryBridge.pollOnce().catch(error => {
      const message = String(error && error.message || error);
      setAutoConnectionStatus(isNetworkError(message) ? 'offline' : 'attention', message);
    });
  } else {
    // Do not gate on a connectivity probe. Attempts continue during outages and
    // the periodic loop retries until GitHub becomes reachable.
    void attemptAutoConnect();
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
  ipcMain.handle('app:github-state', event => {
    assertLocalUi(event, 'index.html');
    return githubAuth
      ? githubAuth.getState()
      : { authenticated: false, error: appInitializationError || 'GitHub authentication service is not available.' };
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
    const githubState = githubAuth ? await githubAuth.getState() : { authenticated: false };
    if (!githubState.authenticated) {
      return {
        status: 'inactive',
        enabled: false,
        runtime_fresh: false,
        runtime_alive: false,
        runtime_status: null,
        model_loaded: false,
        message: githubState.error
          ? 'Vision status is unavailable until GitHub connectivity is restored: ' + String(githubState.error).slice(0, 500)
          : 'Sign in to GitHub before the app can read Colab vision status.'
      };
    }
    return visionService.status();
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
    const githubState = githubAuth
      ? await githubAuth.getState()
      : { authenticated: false, error: appInitializationError || 'GitHub authentication service is not available.' };
    if (!githubState.authenticated) {
      return {
        status: 'action_required',
        connected: false,
        opened: false,
        vision_activated: false,
        message: 'The app must be signed in to GitHub before it can read the shared mailbox and verify a Colab connection. Use Sign in to GitHub first.'
      };
    }
    const mailboxCheck = await visionService.setupCheck(githubState);
    if (!mailboxCheck.checks || !mailboxCheck.checks.mailbox || mailboxCheck.checks.mailbox.status !== 'passed') {
      const detail = mailboxCheck.checks && mailboxCheck.checks.mailbox && mailboxCheck.checks.mailbox.message;
      return {
        status: 'error',
        connected: false,
        opened: false,
        vision_activated: false,
        message: 'The app could not verify access to hashin9973-ux/qdqwg on branch bridge-mailbox, so it did not open Colab. ' +
          String(detail || 'Run Setup check and resolve the mailbox access error first.')
      };
    }
    return visionService.connectColab(typeof endpointUrl === 'string' ? endpointUrl : '');
  });
  ipcMain.handle('app:vision-manual-panel', (event, visible) => {
    assertLocalUi(event, 'index.html');
    const expanded = visible === true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSize(STATUS_SIZE.width, expanded ? VISION_MANUAL_HEIGHT : STATUS_SIZE.height);
    }
    return { expanded };
  });
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
    // A visible taskbar entry is the fallback if Windows cannot create a tray icon.
    skipTaskbar: Boolean(tray),
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
  let loadErrorReported = false;
  let showFallbackTimer = null;
  const revealWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (showFallbackTimer) clearTimeout(showFallbackTimer);
    showFallbackTimer = null;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
  };
  const reportLoadFailure = error => {
    const message = String(error && error.message || error || 'Unknown window loading error').slice(0, 1200);
    console.error('Could not load the status window:', message);
    revealWindow();
    if (!loadErrorReported) {
      loadErrorReported = true;
      dialog.showErrorBox(
        'Windows Repository Bridge could not load its window',
        message + '\n\nThe app process is still running. Reinstall the latest Windows build if this keeps happening.'
      );
    }
  };
  mainWindow.on('closed', () => {
    if (showFallbackTimer) clearTimeout(showFallbackTimer);
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', revealWindow);
  mainWindow.webContents.once('did-finish-load', revealWindow);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    reportLoadFailure(errorDescription + ' (' + errorCode + ') while loading ' + validatedURL);
  });
  showFallbackTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('Status window did not report ready-to-show before the fallback timeout.');
      revealWindow();
    }
  }, 5000);
  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(reportLoadFailure);
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
    appendDiagnosticLog('startup', 'Electron app ready; version=' + app.getVersion() + '; packaged=' + app.isPackaged);
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
    persistSettings();

    // Build the desktop shell first: a workspace or mailbox problem must not
    // prevent the window controls, IPC endpoints, or system tray from existing.
    registerIpc();
    createTray();
    createMainWindow();
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
          encodeJpeg: encodeVisionJpeg,
          openColabNotebook: url => openInBrowserAndYield(url),
          readClipboardText: () => clipboard.readText(),
          publishWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file)
        });
        toolBridge = createToolBridge({
          dialog,
          getMainWindow: () => mainWindow,
          getWorkspaceRoot,
          localTools,
          githubAuth,
          uploadWorkspaceFile: (requestId, file) => repositoryBridge.publishWorkspaceFile(requestId, file),
          getAutoAcceptAll: () => settings.autoAcceptAll === true,
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
  if (!finishingVisionDispose && (visionService || windowsInputController)) {
    event.preventDefault();
    finishingVisionDispose = true;
    const dispose = visionService && typeof visionService.dispose === 'function'
      ? visionService.dispose()
      : windowsInputController && typeof windowsInputController.dispose === 'function'
        ? windowsInputController.dispose()
        : Promise.resolve();
    Promise.resolve(dispose).catch(() => {}).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  // Keep the worker and tray icon alive while the status window is hidden.
});
