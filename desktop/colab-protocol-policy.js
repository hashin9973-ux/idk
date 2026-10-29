'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const AUTO_LAUNCH_POLICY = 'AutoLaunchProtocolsFromOrigins';
const HANDOFF_PROTOCOL = 'windows-repository-bridge';
const HANDOFF_ORIGIN = 'https://colab.research.google.com';
const DEFAULT_BROWSER_ASSOCIATION_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

const BROWSER_POLICY_TARGETS = [
  {
    name: 'Brave',
    progId: /^BraveHTML(?:\\.|$)/i,
    userKey: 'HKCU\\Software\\Policies\\BraveSoftware\\Brave',
    machineKey: 'HKLM\\Software\\Policies\\BraveSoftware\\Brave'
  },
  {
    name: 'Google Chrome',
    progId: /^ChromeHTML(?:\\.|$)/i,
    userKey: 'HKCU\\Software\\Policies\\Google\\Chrome',
    machineKey: 'HKLM\\Software\\Policies\\Google\\Chrome'
  },
  {
    name: 'Microsoft Edge',
    progId: /^MSEdgeHTM(?:\\.|$)/i,
    userKey: 'HKCU\\Software\\Policies\\Microsoft\\Edge',
    machineKey: 'HKLM\\Software\\Policies\\Microsoft\\Edge'
  }
];

function parseRegistryValue(stdout, valueName) {
  const linePattern = new RegExp('^\\s*' + valueName + '\\s+(REG_[A-Z0-9_]+)\\s+(.*?)\\s*$', 'im');
  const match = String(stdout || '').match(linePattern);
  return match ? { found: true, type: match[1].toUpperCase(), value: match[2] } : { found: false, type: null, value: null };
}

function parseAutoLaunchPolicy(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new TypeError('AutoLaunchProtocolsFromOrigins must be a JSON array.');
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.protocol !== 'string' || !Array.isArray(entry.allowed_origins) ||
        !entry.allowed_origins.every(origin => typeof origin === 'string')) {
      throw new TypeError('AutoLaunchProtocolsFromOrigins contains an invalid entry; existing policy was left unchanged.');
    }
  }
  return parsed.map(entry => ({ ...entry, allowed_origins: [...entry.allowed_origins] }));
}

function hasProtocolOrigin(entries, protocol = HANDOFF_PROTOCOL, origin = HANDOFF_ORIGIN) {
  return entries.some(entry => entry.protocol === protocol && entry.allowed_origins.includes(origin));
}

function addProtocolOrigin(entries, protocol = HANDOFF_PROTOCOL, origin = HANDOFF_ORIGIN) {
  const next = entries.map(entry => ({ ...entry, allowed_origins: [...entry.allowed_origins] }));
  if (hasProtocolOrigin(next, protocol, origin)) return { entries: next, changed: false };
  const existing = next.find(entry => entry.protocol === protocol);
  if (existing) existing.allowed_origins.push(origin);
  else next.push({ protocol, allowed_origins: [origin] });
  return { entries: next, changed: true };
}

function removeProtocolOrigin(entries, protocol = HANDOFF_PROTOCOL, origin = HANDOFF_ORIGIN) {
  let changed = false;
  const next = [];
  for (const entry of entries) {
    if (entry.protocol !== protocol || !entry.allowed_origins.includes(origin)) {
      next.push({ ...entry, allowed_origins: [...entry.allowed_origins] });
      continue;
    }
    changed = true;
    const allowed_origins = entry.allowed_origins.filter(value => value !== origin);
    if (allowed_origins.length) next.push({ ...entry, allowed_origins });
  }
  return { entries: next, changed };
}

function resolveBrowserPolicyTarget(progId) {
  return BROWSER_POLICY_TARGETS.find(target => target.progId.test(String(progId || ''))) || null;
}

async function runRegistry(exec, args) {
  return exec('reg.exe', args, { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
}

async function readRegistryValue(exec, key, valueName) {
  try {
    const result = await runRegistry(exec, ['query', key, '/v', valueName]);
    return { ...parseRegistryValue(result.stdout, valueName), key };
  } catch (error) {
    const combined = String((error && error.stderr) || '') + '\n' + String((error && error.stdout) || '') + '\n' + String((error && error.message) || '');
    if ((error && error.code === 1) || /unable to find the specified registry key or value|cannot find the specified registry key or value/i.test(combined)) {
      return { found: false, type: null, value: null, key };
    }
    throw error;
  }
}

async function writeRegistryValue(exec, key, valueName, value) {
  await runRegistry(exec, ['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f']);
}

async function deleteRegistryValue(exec, key, valueName) {
  try {
    await runRegistry(exec, ['delete', key, '/v', valueName, '/f']);
    return true;
  } catch (error) {
    const combined = String((error && error.stderr) || '') + '\n' + String((error && error.stdout) || '') + '\n' + String((error && error.message) || '');
    if ((error && error.code === 1) || /unable to find the specified registry key or value|cannot find the specified registry key or value/i.test(combined)) return false;
    throw error;
  }
}

/**
 * On the user's explicit Connect Colab action, configure only this app's
 * protocol from the exact Colab origin. Existing Chromium policy entries are
 * preserved, and machine-managed policy is never overridden by a user value.
 */
async function ensureAutomaticColabProtocolPolicy(options = {}) {
  const platform = options.platform || process.platform;
  const exec = options.execFileAsync || execFileAsync;
  if (platform !== 'win32') return { configured: false, changed: false, reason: 'unsupported_platform' };

  let association;
  try {
    association = await readRegistryValue(exec, DEFAULT_BROWSER_ASSOCIATION_KEY, 'ProgId');
  } catch (error) {
    return { configured: false, changed: false, reason: 'browser_association_unavailable', message: String(error && error.message || error).slice(0, 240) };
  }
  const target = association.found ? resolveBrowserPolicyTarget(association.value) : null;
  if (!target) return { configured: false, changed: false, reason: 'unsupported_default_browser' };

  let machineValue;
  try {
    machineValue = await readRegistryValue(exec, target.machineKey, AUTO_LAUNCH_POLICY);
  } catch (error) {
    return { configured: false, changed: false, reason: 'machine_policy_read_failed', browser: target.name, message: String(error && error.message || error).slice(0, 240) };
  }
  if (machineValue.found) {
    if (machineValue.type !== 'REG_SZ') return { configured: false, changed: false, reason: 'machine_policy_managed', browser: target.name };
    try {
      const entries = parseAutoLaunchPolicy(machineValue.value);
      if (hasProtocolOrigin(entries)) return { configured: true, changed: false, browser: target.name, scope: 'machine_policy' };
    } catch {}
    return { configured: false, changed: false, reason: 'machine_policy_managed', browser: target.name };
  }

  let current;
  try {
    current = await readRegistryValue(exec, target.userKey, AUTO_LAUNCH_POLICY);
  } catch (error) {
    return { configured: false, changed: false, reason: 'user_policy_read_failed', browser: target.name, message: String(error && error.message || error).slice(0, 240) };
  }
  if (current.found && current.type !== 'REG_SZ') {
    return { configured: false, changed: false, reason: 'unsupported_policy_value_type', browser: target.name };
  }

  let previousEntries;
  try {
    previousEntries = current.found ? parseAutoLaunchPolicy(current.value) : [];
  } catch (error) {
    return { configured: false, changed: false, reason: 'invalid_existing_policy', browser: target.name, message: String(error && error.message || error).slice(0, 240) };
  }
  const update = addProtocolOrigin(previousEntries);
  if (!update.changed) {
    return { configured: true, changed: false, browser: target.name, scope: 'user_policy', key: target.userKey, previousFound: current.found, previousValue: current.value };
  }

  const writtenValue = JSON.stringify(update.entries);
  try {
    await writeRegistryValue(exec, target.userKey, AUTO_LAUNCH_POLICY, writtenValue);
    const verify = await readRegistryValue(exec, target.userKey, AUTO_LAUNCH_POLICY);
    if (!verify.found || verify.type !== 'REG_SZ') throw new Error('Browser policy could not be read back after writing.');
    const verifiedEntries = parseAutoLaunchPolicy(verify.value);
    if (!hasProtocolOrigin(verifiedEntries) || JSON.stringify(verifiedEntries) !== writtenValue) {
      throw new Error('Browser policy verification did not match the intended Colab handoff entry.');
    }
  } catch (error) {
    return { configured: false, changed: false, reason: 'policy_write_or_verification_failed', browser: target.name, message: String(error && error.message || error).slice(0, 240) };
  }

  return {
    configured: true,
    changed: true,
    browser: target.name,
    scope: 'user_policy',
    key: target.userKey,
    previousFound: current.found,
    previousValue: current.value,
    writtenValue
  };
}

/**
 * Remove only the origin entry this app added. Other protocols and origins
 * added while the app was running are preserved.
 */
async function restoreAutomaticColabProtocolPolicy(lease, options = {}) {
  if (!lease || lease.changed !== true || typeof lease.key !== 'string') return { restored: false, reason: 'no_owned_policy_change' };
  const exec = options.execFileAsync || execFileAsync;
  let current;
  try {
    current = await readRegistryValue(exec, lease.key, AUTO_LAUNCH_POLICY);
  } catch (error) {
    return { restored: false, reason: 'policy_read_failed', message: String(error && error.message || error).slice(0, 240) };
  }
  if (!current.found || current.type !== 'REG_SZ') return { restored: false, reason: 'policy_no_longer_present' };
  let entries;
  try {
    entries = parseAutoLaunchPolicy(current.value);
  } catch {
    return { restored: false, reason: 'policy_changed_to_invalid_value' };
  }
  const removal = removeProtocolOrigin(entries);
  if (!removal.changed) return { restored: false, reason: 'owned_entry_already_absent' };
  try {
    if (removal.entries.length === 0 && lease.previousFound !== true) await deleteRegistryValue(exec, lease.key, AUTO_LAUNCH_POLICY);
    else await writeRegistryValue(exec, lease.key, AUTO_LAUNCH_POLICY, JSON.stringify(removal.entries));
    return { restored: true };
  } catch (error) {
    return { restored: false, reason: 'policy_restore_failed', message: String(error && error.message || error).slice(0, 240) };
  }
}

module.exports = {
  AUTO_LAUNCH_POLICY,
  HANDOFF_PROTOCOL,
  HANDOFF_ORIGIN,
  DEFAULT_BROWSER_ASSOCIATION_KEY,
  BROWSER_POLICY_TARGETS,
  parseRegistryValue,
  parseAutoLaunchPolicy,
  hasProtocolOrigin,
  addProtocolOrigin,
  removeProtocolOrigin,
  resolveBrowserPolicyTarget,
  ensureAutomaticColabProtocolPolicy,
  restoreAutomaticColabProtocolPolicy
};
