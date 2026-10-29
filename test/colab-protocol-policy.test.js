'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTO_LAUNCH_POLICY,
  HANDOFF_PROTOCOL,
  HANDOFF_ORIGIN,
  DEFAULT_BROWSER_ASSOCIATION_KEY,
  parseRegistryValue,
  parseAutoLaunchPolicy,
  addProtocolOrigin,
  removeProtocolOrigin,
  resolveBrowserPolicyTarget,
  ensureAutomaticColabProtocolPolicy,
  restoreAutomaticColabProtocolPolicy
} = require('../desktop/colab-protocol-policy');

function missingRegistryValue() {
  const error = new Error('The system was unable to find the specified registry key or value.');
  error.code = 1;
  error.stdout = 'ERROR: The system was unable to find the specified registry key or value.';
  error.stderr = '';
  return error;
}

function registryFixture({ progId = 'BraveHTML', machinePolicy = null, userPolicy = null } = {}) {
  const values = new Map();
  const calls = [];
  const valueKey = (key, name) => key.toLowerCase() + '|' + name.toLowerCase();
  values.set(valueKey(DEFAULT_BROWSER_ASSOCIATION_KEY, 'ProgId'), { type: 'REG_SZ', value: progId });
  const target = resolveBrowserPolicyTarget(progId);
  if (machinePolicy !== null) values.set(valueKey(target.machineKey, AUTO_LAUNCH_POLICY), { type: 'REG_SZ', value: machinePolicy });
  if (userPolicy !== null) values.set(valueKey(target.userKey, AUTO_LAUNCH_POLICY), { type: 'REG_SZ', value: userPolicy });

  async function execFile(file, args) {
    assert.equal(file, 'reg.exe');
    calls.push([...args]);
    const verb = args[0];
    if (verb === 'query') {
      const key = valueKey(args[1], args[3]);
      const record = values.get(key);
      if (!record) throw missingRegistryValue();
      return { stdout: 'HKEY_CURRENT_USER\\Example\r\n    ' + args[3] + '    ' + record.type + '    ' + record.value + '\r\n', stderr: '' };
    }
    if (verb === 'add') {
      const key = valueKey(args[1], args[3]);
      values.set(key, { type: args[5], value: args[7] });
      return { stdout: 'The operation completed successfully.\r\n', stderr: '' };
    }
    if (verb === 'delete') {
      const key = valueKey(args[1], args[3]);
      if (!values.delete(key)) throw missingRegistryValue();
      return { stdout: 'The operation completed successfully.\r\n', stderr: '' };
    }
    throw new Error('Unexpected registry command: ' + verb);
  }

  return { values, calls, execFile, valueKey, target };
}

test('registry output parser returns only the named value and registry type', () => {
  const output = 'HKEY_CURRENT_USER\\Example\r\n    AutoLaunchProtocolsFromOrigins    REG_SZ    [{"protocol":"other","allowed_origins":["https://example.com"]}]\r\n';
  assert.deepEqual(parseRegistryValue(output, 'AutoLaunchProtocolsFromOrigins'), {
    found: true,
    type: 'REG_SZ',
    value: '[{"protocol":"other","allowed_origins":["https://example.com"]}]'
  });
  assert.equal(parseRegistryValue(output, 'MissingValue').found, false);
});

test('policy parser rejects invalid top-level shapes and malformed entries', () => {
  assert.throws(() => parseAutoLaunchPolicy('{"protocol":"bad"}'), /JSON array/);
  assert.throws(() => parseAutoLaunchPolicy('[{"protocol":"bad","allowed_origins":"not-array"}]'), /invalid entry/);
});

test('only the default Chromium browser target is selected', () => {
  assert.equal(resolveBrowserPolicyTarget('BraveHTML').name, 'Brave');
  assert.equal(resolveBrowserPolicyTarget('ChromeHTML').name, 'Google Chrome');
  assert.equal(resolveBrowserPolicyTarget('MSEdgeHTM').name, 'Microsoft Edge');
  assert.equal(resolveBrowserPolicyTarget('FirefoxURL'), null);
});

test('automatic handoff policy adds only the Colab origin and preserves unrelated entries', async () => {
  const unrelated = { protocol: 'other-protocol', allowed_origins: ['https://example.com'] };
  const f = registryFixture({ userPolicy: JSON.stringify([unrelated]) });
  const result = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  assert.equal(result.configured, true);
  assert.equal(result.changed, true);
  assert.equal(result.browser, 'Brave');
  assert.equal(result.key, f.target.userKey);
  const stored = JSON.parse(f.values.get(f.valueKey(f.target.userKey, AUTO_LAUNCH_POLICY)).value);
  assert.deepEqual(stored[0], unrelated);
  assert.deepEqual(stored[1], { protocol: HANDOFF_PROTOCOL, allowed_origins: [HANDOFF_ORIGIN] });

  const again = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  assert.equal(again.configured, true);
  assert.equal(again.changed, false);
  assert.equal(stored.filter(entry => entry.protocol === HANDOFF_PROTOCOL).length, 1);
});

test('existing entry for the same protocol gains only the exact Colab origin', () => {
  const current = [
    { protocol: HANDOFF_PROTOCOL, allowed_origins: ['https://example.com'] },
    { protocol: 'another', allowed_origins: ['https://example.net'] }
  ];
  const result = addProtocolOrigin(current);
  assert.equal(result.changed, true);
  assert.deepEqual(result.entries, [
    { protocol: HANDOFF_PROTOCOL, allowed_origins: ['https://example.com', HANDOFF_ORIGIN] },
    { protocol: 'another', allowed_origins: ['https://example.net'] }
  ]);
  assert.equal(current[0].allowed_origins.includes(HANDOFF_ORIGIN), false, 'the caller-owned input must not be mutated');
  assert.equal(addProtocolOrigin(result.entries).changed, false);
});

test('machine-managed policy is not overwritten when it excludes Colab', async () => {
  const f = registryFixture({ machinePolicy: JSON.stringify([{ protocol: 'other', allowed_origins: ['https://example.com'] }]) });
  const result = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  assert.deepEqual({ configured: result.configured, changed: result.changed, reason: result.reason }, {
    configured: false, changed: false, reason: 'machine_policy_managed'
  });
  assert.equal(f.calls.some(args => args[0] === 'add'), false);
});

test('malformed existing user policy remains unchanged and is not replaced', async () => {
  const f = registryFixture({ userPolicy: 'not valid JSON' });
  const result = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  assert.equal(result.configured, false);
  assert.equal(result.reason, 'invalid_existing_policy');
  assert.equal(f.values.get(f.valueKey(f.target.userKey, AUTO_LAUNCH_POLICY)).value, 'not valid JSON');
  assert.equal(f.calls.some(args => args[0] === 'add'), false);
});

test('unsupported browser and non-Windows platforms do not write registry values', async () => {
  const unsupported = registryFixture({ progId: 'FirefoxURL' });
  const browserResult = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: unsupported.execFile });
  assert.equal(browserResult.reason, 'unsupported_default_browser');
  assert.equal(unsupported.calls.some(args => args[0] === 'add'), false);

  let called = false;
  const platformResult = await ensureAutomaticColabProtocolPolicy({ platform: 'linux', execFileAsync: async () => { called = true; } });
  assert.equal(platformResult.reason, 'unsupported_platform');
  assert.equal(called, false);
});

test('policy cleanup removes only the Colab origin it added and preserves later entries', async () => {
  const f = registryFixture({ userPolicy: JSON.stringify([{ protocol: 'other', allowed_origins: ['https://example.com'] }]) });
  const lease = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  const target = lease.key;
  const valueKey = f.valueKey(target, AUTO_LAUNCH_POLICY);
  const entriesAfterOurWrite = JSON.parse(f.values.get(valueKey).value);
  entriesAfterOurWrite.push({ protocol: 'later-protocol', allowed_origins: ['https://later.example'] });
  f.values.set(valueKey, { type: 'REG_SZ', value: JSON.stringify(entriesAfterOurWrite) });

  const restored = await restoreAutomaticColabProtocolPolicy(lease, { execFileAsync: f.execFile });
  assert.equal(restored.restored, true);
  const remaining = JSON.parse(f.values.get(valueKey).value);
  assert.deepEqual(remaining, [
    { protocol: 'other', allowed_origins: ['https://example.com'] },
    { protocol: 'later-protocol', allowed_origins: ['https://later.example'] }
  ]);
});

test('cleanup does not mutate policy when this app did not add the origin', async () => {
  const f = registryFixture({ userPolicy: JSON.stringify([{ protocol: HANDOFF_PROTOCOL, allowed_origins: [HANDOFF_ORIGIN] }]) });
  const result = await ensureAutomaticColabProtocolPolicy({ platform: 'win32', execFileAsync: f.execFile });
  assert.equal(result.configured, true);
  assert.equal(result.changed, false);
  const restored = await restoreAutomaticColabProtocolPolicy(result, { execFileAsync: f.execFile });
  assert.equal(restored.restored, false);
  assert.equal(JSON.parse(f.values.get(f.valueKey(f.target.userKey, AUTO_LAUNCH_POLICY)).value)[0].allowed_origins.includes(HANDOFF_ORIGIN), true);
});
