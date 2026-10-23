const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  WebContentsView,
  screen,
  session,
  ipcMain,
  globalShortcut,
  shell
} = require('electron');

const CHATGPT_URL = 'https://chatgpt.com/';
const SESSION_PARTITION = 'persist:chatgpt-assistant';
const HEADER_HEIGHT = 58;
const VIEW_INSET = 8;
const BOTTOM_INSET = 8;
const COLLAPSED_SIZE = 76;
const EXPANDED_SIZE = { width: 460, height: 720 };
const SHORTCUT = 'CommandOrControl+Shift+Space';

const EMBEDDED_HOSTS = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
]);

let mainWindow = null;
let chatView = null;
let chatSession = null;
let collapsed = false;
let quitting = false;
let settings = {};
let saveTimer = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    return {};
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('Could not save overlay settings:', error.message);
  }
}

function saveSettingsSoon() {
  if (!mainWindow || collapsed || mainWindow.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || collapsed) return;
    try {
      const [width, height] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      settings.bounds = { x, y, width, height };
      persistSettings();
    } catch (error) {
      console.error('Could not save overlay position:', error.message);
    }
  }, 250);
}

function clampBounds(bounds) {
  const display = screen.getDisplayMatching({
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Number(bounds.width) || EXPANDED_SIZE.width,
    height: Number(bounds.height) || EXPANDED_SIZE.height
  });
  const work = display.workArea;
  const width = Math.min(Math.max(Number(bounds.width) || EXPANDED_SIZE.width, 360), work.width);
  const height = Math.min(Math.max(Number(bounds.height) || EXPANDED_SIZE.height, 480), work.height);
  const x = Math.min(Math.max(Number(bounds.x) || 0, work.x), work.x + work.width - width);
  const y = Math.min(Math.max(Number(bounds.y) || 0, work.y), work.y + work.height - height);
  return { x, y, width, height };
}

function defaultBounds() {
  const work = screen.getPrimaryDisplay().workArea;
  return clampBounds({
    x: work.x + work.width - EXPANDED_SIZE.width - 22,
    y: work.y + work.height - EXPANDED_SIZE.height - 22,
    ...EXPANDED_SIZE
  });
}

function getSafeUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function isEmbeddedHost(hostname) {
  const host = hostname.toLowerCase();
  return EMBEDDED_HOSTS.has(host) ||
    host.endsWith('.openai.com') ||
    host.endsWith('.chatgpt.com');
}

function openExternalHttps(raw) {
  const url = getSafeUrl(raw);
  if (!url) return;
  shell.openExternal(url.href).catch((error) => {
    console.error('Could not open external URL:', error.message);
  });
}

function attachNavigationPolicy(contents) {
  contents.on('will-navigate', (event, targetUrl) => {
    const url = getSafeUrl(targetUrl);
    if (url && isEmbeddedHost(url.hostname)) return;

    event.preventDefault();
    if (url) openExternalHttps(url.href);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const parsed = getSafeUrl(url);
    if (parsed && isEmbeddedHost(parsed.hostname)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 460,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            partition: SESSION_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
          }
        }
      };
    }

    if (parsed) openExternalHttps(parsed.href);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => {
    attachNavigationPolicy(childWindow.webContents);
  });
}

function updateChatBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !chatView || collapsed) return;
  const [width, height] = mainWindow.getContentSize();
  chatView.setBounds({
    x: VIEW_INSET,
    y: HEADER_HEIGHT,
    width: Math.max(1, width - VIEW_INSET * 2),
    height: Math.max(1, height - HEADER_HEIGHT - BOTTOM_INSET)
  });
}

function sendCollapsedState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('overlay:collapsed-changed', collapsed);
  }
}

function collapseWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || collapsed) return;
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  settings.bounds = { x, y, width, height };
  clearTimeout(saveTimer);
  persistSettings();

  const bubbleX = x + width - COLLAPSED_SIZE;
  const bubbleY = y + height - COLLAPSED_SIZE;
  collapsed = true;
  if (chatView) {
    try {
      mainWindow.contentView.removeChildView(chatView);
    } catch (error) {
      console.error('Could not detach ChatGPT view:', error.message);
    }
  }
  mainWindow.setResizable(false);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setSize(COLLAPSED_SIZE, COLLAPSED_SIZE, true);
  const bounds = clampBubble({ x: bubbleX, y: bubbleY });
  mainWindow.setPosition(bounds.x, bounds.y, true);
  sendCollapsedState();
}

function clampBubble(bounds) {
  const display = screen.getDisplayMatching({
    x: bounds.x, y: bounds.y, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE
  });
  const work = display.workArea;
  return {
    x: Math.min(Math.max(bounds.x, work.x), work.x + work.width - COLLAPSED_SIZE),
    y: Math.min(Math.max(bounds.y, work.y), work.y + work.height - COLLAPSED_SIZE)
  };
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
  mainWindow.setResizable(true);
  mainWindow.setBounds(target, true);
  if (chatView) {
    mainWindow.contentView.addChildView(chatView);
    updateChatBounds();
  }
  sendCollapsedState();
  saveSettingsSoon();
}

function toggleOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (collapsed) expandWindow();
  else collapseWindow();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function assertLocalUi(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Only the local overlay UI may invoke this action.');
  }
  const url = event.senderFrame?.url || '';
  if (!url.startsWith('file://') || !url.endsWith('/desktop/index.html')) {
    throw new Error('Unexpected IPC sender.');
  }
}

function registerIpc() {
  ipcMain.handle('overlay:collapse', (event) => {
    assertLocalUi(event);
    collapseWindow();
    return { collapsed };
  });
  ipcMain.handle('overlay:expand', (event) => {
    assertLocalUi(event);
    expandWindow();
    return { collapsed };
  });
  ipcMain.handle('overlay:reload-chat', (event) => {
    assertLocalUi(event);
    if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.reload();
    return true;
  });
  ipcMain.handle('overlay:open-in-browser', (event) => {
    assertLocalUi(event);
    openExternalHttps(CHATGPT_URL);
    return true;
  });
  ipcMain.handle('overlay:quit', (event) => {
    assertLocalUi(event);
    quitting = true;
    app.quit();
    return true;
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
    minWidth: 360,
    minHeight: 480,
    minimizable: true,
    maximizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: 'ChatGPT Assistant',
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
  mainWindow.on('resize', updateChatBounds);
  mainWindow.on('move', saveSettingsSoon);
  mainWindow.on('closed', () => {
    mainWindow = null;
    chatView = null;
  });

  chatView = new WebContentsView({
    webPreferences: {
      partition: SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });
  mainWindow.contentView.addChildView(chatView);
  updateChatBounds();
  attachNavigationPolicy(chatView.webContents);

  const defaultAgent = chatView.webContents.getUserAgent();
  chatView.webContents.setUserAgent(defaultAgent.replace(/\\sElectron\\/[\\d.]+/g, ''));
  chatView.webContents.on('did-create-window', (childWindow) => {
    childWindow.setAlwaysOnTop(false);
  });
  chatView.webContents.on('render-process-gone', (_event, details) => {
    console.error('ChatGPT view render process exited:', details.reason);
  });
  chatView.webContents.loadURL(CHATGPT_URL).catch((error) => {
    console.error('Could not load ChatGPT:', error.message);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    updateChatBounds();
    mainWindow.show();
    mainWindow.focus();
  });
}

function configureRemoteSession() {
  chatSession = session.fromPartition(SESSION_PARTITION);
  chatSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function registerHotkey() {
  const registered = globalShortcut.register(SHORTCUT, toggleOverlay);
  if (!registered) {
    console.warn('Global shortcut could not be registered:', SHORTCUT);
  }
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    else {
      if (collapsed) expandWindow();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hashin997ux.chatgptassistant');
    settings = loadSettings();
    configureRemoteSession();
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

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(saveTimer);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
