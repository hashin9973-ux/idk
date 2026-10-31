'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'bin', 'obj', '.bridge-worktrees']);

function readDirectory(directory, fsApi) {
  return fsApi.readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
}

function detectProjectTypes(entries) {
  const names = new Set(entries.map(entry => entry.name.toLowerCase()));
  const types = [];
  if (entries.some(entry => entry.isFile && entry.name.toLowerCase().endsWith('.uproject'))) types.push('Unreal Engine');
  if (names.has('assets') && names.has('projectsettings')) types.push('Unity');
  if (names.has('project.godot')) types.push('Godot');
  if (names.has('package.json')) types.push('Node.js');
  if (names.has('cargo.toml')) types.push('Rust');
  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py')) types.push('Python');
  if (names.has('go.mod')) types.push('Go');
  if (entries.some(entry => entry.isFile && /\.(sln|csproj)$/i.test(entry.name))) types.push('.NET');
  if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts')) types.push('Java');
  if (names.has('cmakelists.txt') || names.has('meson.build')) types.push('C/C++');
  return [...new Set(types)];
}

/**
 * Produces a bounded, read-only workspace summary. It inspects the selected
 * directory and at most one level of child directories; it never recursively
 * walks a drive or project tree. Git is invoked with argv (no shell).
 */
async function inspectWorkspace(workspacePath, options = {}) {
  const fsApi = options.fsApi || fs;
  const execFileAsync = options.execFileAsync || promisify(execFile);
  if (typeof workspacePath !== 'string' || !workspacePath.trim() || workspacePath.length > 2048) {
    throw new Error('A valid workspace directory is required.');
  }
  const root = path.resolve(workspacePath);
  const stat = fsApi.statSync(root);
  if (!stat.isDirectory()) throw new Error('The selected workspace is not a directory.');

  const rootEntries = readDirectory(root, fsApi).slice(0, 500);
  const rootProjectTypes = detectProjectTypes(rootEntries);
  const nestedProjectCandidates = [];
  if (!rootProjectTypes.length) {
    for (const entry of rootEntries) {
      if (!entry.isDirectory || ignoredDirectories.has(entry.name.toLowerCase()) ||
          nestedProjectCandidates.length >= 20) continue;
      const nestedRoot = path.join(root, entry.name);
      try {
        const types = detectProjectTypes(readDirectory(nestedRoot, fsApi).slice(0, 500));
        if (types.length) nestedProjectCandidates.push({ path: nestedRoot, projectTypes: types });
      } catch {}
    }
  }
  const detectedProjectRoot = rootProjectTypes.length ? root
    : nestedProjectCandidates.length === 1 ? nestedProjectCandidates[0].path : null;
  const projectTypes = rootProjectTypes.length ? rootProjectTypes
    : [...new Set(nestedProjectCandidates.flatMap(item => item.projectTypes))];

  let git = { repository: false, root: null, branch: null, dirty: null };
  try {
    const gitOptions = { encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true, shell: false };
    const top = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], gitOptions);
    const gitRoot = path.resolve(String(top.stdout || '').trim());
    if (gitRoot) {
      const [branchResult, statusResult] = await Promise.all([
        execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], gitOptions),
        execFileAsync('git', ['-C', gitRoot, 'status', '--porcelain', '--untracked-files=no'], gitOptions)
      ]);
      git = {
        repository: true,
        root: gitRoot,
        branch: String(branchResult.stdout || '').trim() || null,
        dirty: Boolean(String(statusResult.stdout || '').trim())
      };
    }
  } catch {
    // A missing Git executable or a directory outside a repository is normal.
  }

  return {
    workspaceRoot: root,
    rootProjectTypes,
    projectTypes,
    detectedProjectRoot,
    nestedProjectCandidates: nestedProjectCandidates.slice(0, 20),
    git
  };
}

module.exports = { inspectWorkspace, detectProjectTypes };
