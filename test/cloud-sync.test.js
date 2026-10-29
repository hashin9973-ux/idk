'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCloudSync, sanitizeSharedState, safeShareUrl, mergeRecords } = require('../desktop/cloud-sync');

test('shared state is allow-listed and rejects credentials, local paths, and tunnel secrets', () => {
  const state = sanitizeSharedState({
    preferences: {
      dashboardTheme: 'ocean', ttsVolume: 71, ttsMode: 'notification',
      githubToken: 'should-not-sync', workspaceRoot: 'C:\\Users\\someone', autoAcceptAll: true
    },
    tabs: [
      { id: 'main', kind: 'main', label: 'Main', order: 0 },
      { id: 'tab-web-1', kind: 'browser', browserId: 'web-1', url: 'https://example.com/docs', label: 'Docs', order: 1 },
      { id: 'tab-web-2', kind: 'browser', browserId: 'web-2', url: 'https://example.com/?access_token=private', label: 'Secret', order: 2 },
      { id: 'tab-web-3', kind: 'browser', browserId: 'web-3', url: 'https://secret.trycloudflare.com/long-token', label: 'Tunnel', order: 3 }
    ],
    widgets: [{ id: 'queues', x: 40, y: 50, width: 600, height: 200 }]
  });
  assert.deepEqual(state.preferences, { dashboardTheme: 'ocean', ttsVolume: 71, ttsMode: 'notification' });
  assert.deepEqual(state.tabs.map(tab => tab.id), ['main', 'tab-web-1']);
  assert.equal(state.widgets[0].x, 40);
  assert.equal(safeShareUrl('file:///C:/private.txt'), null);
  assert.equal(safeShareUrl('https://example.com/?api_key=abc'), null);
});

test('state merge combines independently edited preferences, tabs, and widgets deterministically', () => {
  const deviceA = '11111111-1111-4111-8111-111111111111';
  const deviceB = '22222222-2222-4222-8222-222222222222';
  const base = {
    schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', preferenceStamps: {},
    tabs: [{ id: 'main', kind: 'main', label: 'Main', order: 0, updatedAt: '2026-01-01T00:00:00.000Z', deviceId: deviceA }],
    widgets: [{ id: 'queues', x: 10, y: 10, width: 600, height: 200, updatedAt: '2026-01-01T00:00:00.000Z', deviceId: deviceA }],
    activeTabId: 'main', activeTabUpdatedAt: '2026-01-01T00:00:00.000Z'
  };
  const a = { ...base, deviceId: deviceA, preferences: { dashboardTheme: 'ocean' }, preferenceStamps: { dashboardTheme: '2026-01-02T00:00:00.000Z' } };
  const b = { ...base, deviceId: deviceB, preferences: { ttsMode: 'notification' }, preferenceStamps: { ttsMode: '2026-01-03T00:00:00.000Z' },
    tabs: [...base.tabs, { id: 'tab-web-2', kind: 'browser', browserId: 'web-2', url: 'https://example.org/', label: 'Example', order: 1, updatedAt: '2026-01-03T00:00:00.000Z', deviceId: deviceB }],
    widgets: [...base.widgets, { id: 'controls', x: 100, y: 220, width: 420, height: 260, updatedAt: '2026-01-03T00:00:00.000Z', deviceId: deviceB }]
  };
  const result = mergeRecords([a, b]);
  assert.equal(result.state.preferences.dashboardTheme, 'ocean');
  assert.equal(result.state.preferences.ttsMode, 'notification');
  assert.ok(result.state.tabs.some(tab => tab.id === 'tab-web-2'));
  assert.ok(result.state.widgets.some(widget => widget.id === 'controls'));
});

test('folder synchronization replicates local state and does not need a cloud API credential', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wrb-sync-'));
  t.after(async () => fs.rm(folder, { recursive: true, force: true }));
  const deviceA = crypto.randomUUID();
  const deviceB = crypto.randomUUID();
  let aState = { preferences: { dashboardTheme: 'forest' }, tabs: [{ id: 'main', kind: 'main', order: 0, label: 'Main' }], widgets: [], activeTabId: 'main' };
  let bState = { preferences: { dashboardTheme: 'midnight' }, tabs: [{ id: 'main', kind: 'main', order: 0, label: 'Main' }], widgets: [], activeTabId: 'main' };
  const a = createCloudSync({ deviceId: deviceA, getLocalState: () => aState, applyRemoteState: v => { aState = v; } });
  const b = createCloudSync({ deviceId: deviceB, getLocalState: () => bState, applyRemoteState: v => { bState = v; } });
  t.after(() => { a.dispose(); b.dispose(); });
  await a.configure({ folder, enabled: true });
  await a.syncNow();
  await b.configure({ folder, enabled: true });
  assert.equal(bState.preferences.dashboardTheme, 'forest');
  bState = { ...bState, preferences: { ...bState.preferences, ttsMode: 'notification' } };
  await b.publishLocal();
  await a.syncNow();
  assert.equal(aState.preferences.ttsMode, 'notification');
  const syncDir = path.join(folder, '.windows-repository-bridge');
  const records = (await fs.readdir(syncDir)).filter(file => file.endsWith('.json'));
  assert.equal(records.length, 2);
});
