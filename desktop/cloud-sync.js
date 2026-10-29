'use strict';

const fs = require('node:fs');
const path = require('node:path');

const THEME_IDS = new Set(['midnight', 'light', 'ocean', 'forest', 'sunset', 'rose', 'high-contrast', 'aurora', 'cyberpunk', 'dracula', 'nord', 'solarized-light', 'terminal', 'lavender', 'graphite']);
const PREF_KEYS = new Set(['dashboardTheme', 'ttsVolume', 'browserKeepActive', 'browserLowMemory', 'observeFps', 'ttsMode', 'captionsOnAutoplay', 'captionTransparent', 'captionPosition', 'captionX', 'captionY', 'captionTheme']);
const CAPTION_POSITIONS = new Set(['top', 'center', 'bottom', 'custom']);
const CAPTION_THEMES = new Set(['app', 'system', 'light', 'dark']);
const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const DEVICE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function boundedText(value, max = 100) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function safeTimestamp(value, fallback = '1970-01-01T00:00:00.000Z') {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function safeShareUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' ||
        host === '[::1]' || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        host.endsWith('.trycloudflare.com') || host === 'trycloudflare.com') return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|passwd|credential|authorization|auth|session|api[_-]?key|access[_-]?key|device[_-]?code)/i.test(key)) return null;
    }
    if (url.pathname.split('/').some(part => /^[A-Za-z0-9_-]{48,}$/.test(part))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of PREF_KEYS) {
    if (!own(source, key)) continue;
    const raw = source[key];
    if (key === 'dashboardTheme') {
      if (THEME_IDS.has(raw)) result[key] = raw;
    } else if (key === 'ttsVolume') {
      if (Number.isFinite(raw)) result[key] = Math.round(Math.max(0, Math.min(100, raw)));
    } else if (key === 'browserKeepActive' || key === 'browserLowMemory' ||
               key === 'captionsOnAutoplay' || key === 'captionTransparent') {
      if (typeof raw === 'boolean') result[key] = raw;
    } else if (key === 'observeFps') {
      if ([0.5, 1, 2, 4, 8].includes(raw)) result[key] = raw;
    } else if (key === 'ttsMode') {
      if (raw === 'autoplay' || raw === 'notification') result[key] = raw;
    } else if (key === 'captionPosition') {
      if (CAPTION_POSITIONS.has(raw)) result[key] = raw;
    } else if (key === 'captionTheme') {
      if (CAPTION_THEMES.has(raw)) result[key] = raw;
    } else if (key === 'captionX' || key === 'captionY') {
      if (Number.isFinite(raw)) result[key] = Math.round(Math.max(0, Math.min(100, raw)));
    }
  }
  return result;
}

function sanitizeTab(value, allowTombstone = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = boundedText(value.id, 80);
  if (!ID_PATTERN.test(id)) return null;
  const deleted = allowTombstone && value.deleted === true;
  if (deleted) return { id, deleted: true, updatedAt: safeTimestamp(value.updatedAt), deviceId: boundedText(value.deviceId, 36) };
  const kind = value.kind === 'main' || value.kind === 'settings' || value.kind === 'browser' ? value.kind : null;
  if (!kind) return null;
  const result = { id, kind, label: boundedText(value.label || (kind === 'main' ? 'Main' : kind === 'settings' ? 'Settings' : 'Web'), 80),
    order: Number.isFinite(value.order) ? Math.round(Math.max(0, Math.min(10000, value.order))) : 0 };
  if (kind === 'main') {
    result.closable = false;
  } else if (kind === 'settings') {
    result.closable = true;
  } else {
    const browserId = boundedText(value.browserId, 80);
    const url = safeShareUrl(value.url);
    if (!/^web-\d{1,12}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(browserId) || !url) return null;
    result.browserId = browserId;
    result.url = url;
    result.title = boundedText(value.title || result.label, 120);
    result.label = boundedText(value.label || result.title, 80);
    result.closable = true;
  }
  result.updatedAt = safeTimestamp(value.updatedAt);
  result.deviceId = boundedText(value.deviceId, 36);
  return result;
}

function sanitizeWidget(value, allowTombstone = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = boundedText(value.id, 30);
  if (!['queues', 'controls'].includes(id)) return null;
  if (allowTombstone && value.deleted === true) {
    return { id, deleted: true, updatedAt: safeTimestamp(value.updatedAt), deviceId: boundedText(value.deviceId, 36) };
  }
  const number = (key, fallback, minimum, maximum) => Number.isFinite(value[key])
    ? Math.round(Math.max(minimum, Math.min(maximum, value[key]))) : fallback;
  return {
    id,
    x: number('x', 24, 0, 10000),
    y: number('y', 24, 0, 10000),
    width: number('width', id === 'queues' ? 600 : 420, 180, 4000),
    height: number('height', 160, 80, 3000),
    updatedAt: safeTimestamp(value.updatedAt),
    deviceId: boundedText(value.deviceId, 36)
  };
}

function sanitizeSharedState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let tabs = Array.isArray(source.tabs) ? source.tabs.map(item => sanitizeTab(item, false)).filter(Boolean) : [];
  if (!tabs.some(tab => tab.id === 'main' && tab.kind === 'main')) {
    tabs.unshift({ id: 'main', kind: 'main', label: 'Main', order: 0, closable: false });
  }
  const ids = new Set();
  tabs = tabs.filter(tab => !ids.has(tab.id) && ids.add(tab.id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).slice(0, 100);
  let widgets = [];
  if (Array.isArray(source.widgets)) widgets = source.widgets;
  else if (source.widgets && typeof source.widgets === 'object') widgets = Object.entries(source.widgets).map(([id, widget]) => ({ id, ...widget }));
  widgets = widgets.map(item => sanitizeWidget(item, false)).filter(Boolean);
  const widgetIds = new Set();
  widgets = widgets.filter(item => !widgetIds.has(item.id) && widgetIds.add(item.id));
  const requestedActive = boundedText(source.activeTabId, 80);
  const activeTabId = tabs.some(tab => tab.id === requestedActive) ? requestedActive : 'main';
  return {
    preferences: sanitizePreferences(source.preferences),
    tabs,
    widgets: widgets.sort((a, b) => a.id.localeCompare(b.id)),
    activeTabId
  };
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 ||
      !DEVICE_PATTERN.test(String(value.deviceId || ''))) return null;
  const deviceId = String(value.deviceId);
  const updatedAt = safeTimestamp(value.updatedAt);
  const preferences = sanitizePreferences(value.preferences);
  const preferenceStamps = {};
  for (const key of PREF_KEYS) {
    if (own(preferences, key)) preferenceStamps[key] = safeTimestamp(value.preferenceStamps && value.preferenceStamps[key], updatedAt);
  }
  const tabs = Array.isArray(value.tabs) ? value.tabs.map(item => {
    const tab = sanitizeTab(item, true);
    return tab ? { ...tab, updatedAt: safeTimestamp(item.updatedAt, updatedAt), deviceId } : null;
  }).filter(Boolean) : [];
  const widgets = Array.isArray(value.widgets) ? value.widgets.map(item => {
    const widget = sanitizeWidget(item, true);
    return widget ? { ...widget, updatedAt: safeTimestamp(item.updatedAt, updatedAt), deviceId } : null;
  }).filter(Boolean) : [];
  return {
    schemaVersion: 1, deviceId, updatedAt, preferences, preferenceStamps, tabs, widgets,
    activeTabId: boundedText(value.activeTabId, 80) || 'main',
    activeTabUpdatedAt: safeTimestamp(value.activeTabUpdatedAt, updatedAt)
  };
}

function timestampOf(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function newer(a, b, aDevice = '', bDevice = '') {
  const ta = timestampOf(a);
  const tb = timestampOf(b);
  if (ta !== tb) return ta > tb;
  return String(aDevice).localeCompare(String(bDevice)) > 0;
}

function mergeRecords(rawRecords) {
  const records = (Array.isArray(rawRecords) ? rawRecords : []).map(sanitizeRecord).filter(Boolean);
  const preferenceWinners = new Map();
  const tabWinners = new Map();
  const widgetWinners = new Map();
  let activeWinner = null;
  for (const record of records) {
    for (const [key, value] of Object.entries(record.preferences)) {
      const stamp = record.preferenceStamps[key] || record.updatedAt;
      const previous = preferenceWinners.get(key);
      if (!previous || newer(stamp, previous.updatedAt, record.deviceId, previous.deviceId)) {
        preferenceWinners.set(key, { value, updatedAt: stamp, deviceId: record.deviceId });
      }
    }
    for (const tab of record.tabs) {
      const previous = tabWinners.get(tab.id);
      if (!previous || newer(tab.updatedAt, previous.updatedAt, tab.deviceId, previous.deviceId) ||
          (tab.updatedAt === previous.updatedAt && tab.deleted && !previous.deleted)) {
        tabWinners.set(tab.id, tab);
      }
    }
    for (const widget of record.widgets) {
      const previous = widgetWinners.get(widget.id);
      if (!previous || newer(widget.updatedAt, previous.updatedAt, widget.deviceId, previous.deviceId) ||
          (widget.updatedAt === previous.updatedAt && widget.deleted && !previous.deleted)) {
        widgetWinners.set(widget.id, widget);
      }
    }
    const candidate = { value: record.activeTabId, updatedAt: record.activeTabUpdatedAt, deviceId: record.deviceId };
    if (!activeWinner || newer(candidate.updatedAt, activeWinner.updatedAt, candidate.deviceId, activeWinner.deviceId)) activeWinner = candidate;
  }
  const preferences = {};
  const preferenceStamps = {};
  for (const [key, winner] of preferenceWinners) {
    preferences[key] = winner.value;
    preferenceStamps[key] = winner.updatedAt;
  }
  const allTabs = [...tabWinners.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const tabs = allTabs.filter(item => !item.deleted).map(({ updatedAt, deviceId, ...item }) => item);
  if (!tabs.some(tab => tab.id === 'main' && tab.kind === 'main')) {
    tabs.unshift({ id: 'main', kind: 'main', label: 'Main', order: 0, closable: false });
  }
  const allWidgets = [...widgetWinners.values()].sort((a, b) => a.id.localeCompare(b.id));
  const widgets = allWidgets.filter(item => !item.deleted).map(({ updatedAt, deviceId, ...item }) => item);
  const activeTabId = tabs.some(tab => tab.id === (activeWinner && activeWinner.value)) ? activeWinner.value : 'main';
  const state = sanitizeSharedState({ preferences, tabs, widgets, activeTabId });
  return {
    state,
    record: {
      schemaVersion: 1,
      deviceId: records.map(item => item.deviceId).sort().at(-1) || '',
      updatedAt: records.map(item => item.updatedAt).sort((a, b) => timestampOf(a) - timestampOf(b)).at(-1) || new Date(0).toISOString(),
      preferences,
      preferenceStamps,
      tabs: allTabs,
      widgets: allWidgets,
      activeTabId: activeWinner ? activeWinner.value : 'main',
      activeTabUpdatedAt: activeWinner ? activeWinner.updatedAt : new Date(0).toISOString()
    }
  };
}

function stateEquivalent(a, b) {
  return stableJson(sanitizeSharedState(a)) === stableJson(sanitizeSharedState(b));
}

function createCloudSync(options = {}) {
  const { getLocalState, applyRemoteState, onStatus } = options;
  if (typeof getLocalState !== 'function' || typeof applyRemoteState !== 'function') {
    throw new TypeError('getLocalState and applyRemoteState callbacks are required.');
  }
  const deviceId = DEVICE_PATTERN.test(String(options.deviceId || '')) ? String(options.deviceId) : require('node:crypto').randomUUID();
  let folder = '';
  let enabled = false;
  let directory = '';
  let watcher = null;
  let pollTimer = null;
  let debounceTimer = null;
  let serial = Promise.resolve();
  let disposed = false;
  let lastMergedState = null;
  let lastMergedRecord = null;
  let lastSyncedAt = '';
  let lastError = '';
  let busy = false;

  function status() {
    return { deviceId, folder, enabled, configured: Boolean(folder), running: enabled && Boolean(directory),
      state: !enabled ? 'disabled' : !folder ? 'folder_required' : lastError ? 'error' : busy ? 'syncing' : 'ready',
      lastSyncedAt, error: lastError };
  }

  function emit() {
    if (typeof onStatus === 'function') {
      try { onStatus(status()); } catch {}
    }
  }

  function closeWatcher() {
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    directory = '';
  }

  async function ensureDirectory() {
    if (!folder) throw new Error('Choose a synchronized cloud folder first.');
    const resolved = path.resolve(folder);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) throw new Error('The configured cloud sync path is not a directory.');
    directory = path.join(resolved, '.windows-repository-bridge');
    await fs.promises.mkdir(directory, { recursive: true });
    return directory;
  }

  async function readRecords() {
    let names = [];
    try { names = await fs.promises.readdir(directory); } catch { return []; }
    names = names.filter(name => /^device-[0-9a-f-]{36}\.json$/i.test(name)).sort((a, b) => a.localeCompare(b)).slice(0, MAX_RECORDS);
    const records = [];
    for (const name of names) {
      try {
        const filename = path.join(directory, name);
        const info = await fs.promises.lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) continue;
        const record = sanitizeRecord(JSON.parse(await fs.promises.readFile(filename, 'utf8')));
        if (record) records.push(record);
      } catch {
        // A cloud provider may temporarily expose an incomplete or locked file.
      }
    }
    return records;
  }

  function recordFromState(rawState) {
    const state = sanitizeSharedState(rawState);
    const previousState = lastMergedState;
    const previousRecord = lastMergedRecord;
    const now = new Date().toISOString();
    const preferenceStamps = {};
    for (const [key, value] of Object.entries(state.preferences)) {
      const unchanged = previousState && own(previousState.preferences, key) &&
        stableJson(previousState.preferences[key]) === stableJson(value);
      preferenceStamps[key] = unchanged && previousRecord && previousRecord.preferenceStamps[key]
        ? previousRecord.preferenceStamps[key] : now;
    }
    const previousTabState = new Map((previousState && previousState.tabs || []).map(tab => [tab.id, tab]));
    const previousTabMeta = new Map((previousRecord && previousRecord.tabs || []).map(tab => [tab.id, tab]));
    const currentTabIds = new Set(state.tabs.map(tab => tab.id));
    const tabs = state.tabs.map(tab => {
      const oldState = previousTabState.get(tab.id);
      const oldMeta = previousTabMeta.get(tab.id);
      const unchanged = oldState && stableJson({ ...oldState, updatedAt: undefined, deviceId: undefined }) ===
        stableJson({ ...tab, updatedAt: undefined, deviceId: undefined });
      return { ...tab, updatedAt: unchanged && oldMeta && !oldMeta.deleted ? oldMeta.updatedAt : now, deviceId };
    });
    for (const oldMeta of previousRecord && previousRecord.tabs || []) {
      if (!currentTabIds.has(oldMeta.id)) {
        if (oldMeta.deleted) tabs.push({ id: oldMeta.id, deleted: true, updatedAt: oldMeta.updatedAt, deviceId });
        else if (previousTabState.has(oldMeta.id)) tabs.push({ id: oldMeta.id, deleted: true, updatedAt: now, deviceId });
      }
    }
    const previousWidgetState = new Map((previousState && previousState.widgets || []).map(widget => [widget.id, widget]));
    const previousWidgetMeta = new Map((previousRecord && previousRecord.widgets || []).map(widget => [widget.id, widget]));
    const currentWidgetIds = new Set(state.widgets.map(widget => widget.id));
    const widgets = state.widgets.map(widget => {
      const oldState = previousWidgetState.get(widget.id);
      const oldMeta = previousWidgetMeta.get(widget.id);
      const unchanged = oldState && stableJson(oldState) === stableJson(widget);
      return { ...widget, updatedAt: unchanged && oldMeta && !oldMeta.deleted ? oldMeta.updatedAt : now, deviceId };
    });
    for (const oldMeta of previousRecord && previousRecord.widgets || []) {
      if (!currentWidgetIds.has(oldMeta.id)) {
        if (oldMeta.deleted) widgets.push({ id: oldMeta.id, deleted: true, updatedAt: oldMeta.updatedAt, deviceId });
        else if (previousWidgetState.has(oldMeta.id)) widgets.push({ id: oldMeta.id, deleted: true, updatedAt: now, deviceId });
      }
    }
    const sameActive = previousState && state.activeTabId === previousState.activeTabId;
    return {
      schemaVersion: 1,
      deviceId,
      updatedAt: now,
      preferences: state.preferences,
      preferenceStamps,
      tabs,
      widgets,
      activeTabId: state.activeTabId,
      activeTabUpdatedAt: sameActive && previousRecord ? previousRecord.activeTabUpdatedAt : now
    };
  }

  async function writeRecord(record) {
    const filename = path.join(directory, 'device-' + deviceId + '.json');
    const temp = filename + '.' + process.pid + '.tmp';
    const content = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_RECORD_BYTES) throw new Error('Shared state exceeds the 1 MiB safety limit.');
    await fs.promises.writeFile(temp, content, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    try { await fs.promises.rename(temp, filename); }
    catch (error) {
      // Keep the last valid snapshot if replacement fails.
      try { await fs.promises.unlink(temp); } catch {}
      throw error;
    }
  }

  async function reconcileInner(publishCurrent) {
    if (disposed || !enabled) {
      emit();
      return status();
    }
    busy = true;
    lastError = '';
    emit();
    try {
      await ensureDirectory();
      let records = await readRecords();
      let ownRecord = records.find(record => record.deviceId === deviceId);
      if (publishCurrent || records.length === 0) {
        const record = recordFromState(getLocalState());
        await writeRecord(record);
        ownRecord = record;
        records = (await readRecords()).filter(Boolean);
      }
      if (records.length === 0 && ownRecord) records = [ownRecord];
      if (records.length === 0) throw new Error('No valid state records are available in the cloud folder.');
      const merged = mergeRecords(records);
      const current = sanitizeSharedState(getLocalState());
      if (!stateEquivalent(current, merged.state)) await applyRemoteState(merged.state);
      lastMergedState = sanitizeSharedState(merged.state);
      lastMergedRecord = merged.record;
      lastSyncedAt = new Date().toISOString();
      lastError = '';
      if (!records.some(record => record.deviceId === deviceId)) {
        // Seed this device's file without refreshing the timestamps of imported fields.
        await writeRecord(recordFromState(lastMergedState));
      } else if (!stateEquivalent(current, merged.state)) {
        // Replicate the merged state while preserving field timestamps: remote changes do not echo endlessly.
        await writeRecord(recordFromState(lastMergedState));
      }
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 500);
    } finally {
      busy = false;
      emit();
    }
    return status();
  }

  function scheduleReconcile() {
    if (disposed || !enabled || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSync(false);
    }, 350);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  function runSync(publishCurrent = false) {
    const task = serial.then(() => reconcileInner(publishCurrent));
    serial = task.catch(() => {});
    return task;
  }

  async function configure(value = {}) {
    closeWatcher();
    folder = typeof value.folder === 'string' ? value.folder.trim() : folder;
    enabled = value.enabled === true;
    lastError = '';
    if (!enabled) {
      emit();
      return status();
    }
    if (!folder) {
      lastError = 'Choose a cloud folder before enabling synchronization.';
      emit();
      return status();
    }
    try {
      await ensureDirectory();
      try {
        watcher = fs.watch(directory, { persistent: false }, scheduleReconcile);
        if (typeof watcher.unref === 'function') watcher.unref();
      } catch {
        watcher = null;
      }
      pollTimer = setInterval(() => void runSync(false), 2500);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      await runSync(false);
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 500);
      emit();
    }
    return status();
  }

  function publishLocal() {
    return runSync(true);
  }

  function syncNow() {
    return runSync(true);
  }

  function dispose() {
    disposed = true;
    closeWatcher();
    enabled = false;
    emit();
  }

  return Object.freeze({ configure, publishLocal, syncNow, status, dispose });
}

module.exports = { createCloudSync, sanitizeSharedState, safeShareUrl, mergeRecords };
