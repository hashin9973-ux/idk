'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const VERSION = '2.103.2';
const ARCHIVE_URL = 'https://github.com/cli/cli/releases/download/v' + VERSION + '/gh_' + VERSION + '_windows_amd64.zip';
const ARCHIVE_SHA256 = 'fef9fcdd8fdabd0501ab8b3d99eac976f504ab55d01bef9e8ef428a5d900ddda';

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function fetchBytes(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok) throw new Error('Download failed with HTTP ' + response.status + '.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('The GitHub CLI download has an unexpected size.');
  return bytes;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The bundled GitHub CLI preparation step is for Windows builds only.');
  }

  const root = path.resolve(__dirname, '..');
  const vendorDir = path.join(root, 'vendor', 'gh');
  const ghExe = path.join(vendorDir, 'gh.exe');
  const licensePath = path.join(vendorDir, 'LICENSE');
  if (fs.existsSync(ghExe) && fs.existsSync(licensePath)) {
    process.stdout.write('GitHub CLI helper already prepared.\n');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-repository-bridge-gh-'));
  const archivePath = path.join(workDir, 'gh.zip');
  const extractedDir = path.join(workDir, 'extracted');
  try {
    const bytes = await fetchBytes(ARCHIVE_URL, 32 * 1024 * 1024);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== ARCHIVE_SHA256) {
      throw new Error('GitHub CLI archive SHA-256 did not match the pinned release hash.');
    }
    fs.writeFileSync(archivePath, bytes, { mode: 0o600 });
    fs.mkdirSync(extractedDir, { recursive: true });
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + psQuote(archivePath) + ' -DestinationPath ' + psQuote(extractedDir) + ' -Force'
    ], { windowsHide: true, timeout: 120000 });

    const extractedExe = path.join(extractedDir, 'bin', 'gh.exe');
    if (!fs.existsSync(extractedExe)) throw new Error('The verified GitHub CLI archive did not contain bin/gh.exe.');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.copyFileSync(extractedExe, ghExe);

    const bundledLicense = path.join(extractedDir, 'LICENSE');
    if (fs.existsSync(bundledLicense)) {
      fs.copyFileSync(bundledLicense, licensePath);
    } else {
      const licenseBytes = await fetchBytes('https://raw.githubusercontent.com/cli/cli/v' + VERSION + '/LICENSE', 256 * 1024);
      fs.writeFileSync(licensePath, licenseBytes, { mode: 0o600 });
    }
    process.stdout.write('Prepared GitHub CLI ' + VERSION + ' with the verified SHA-256 archive.\n');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write('Could not prepare the bundled GitHub CLI: ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});
