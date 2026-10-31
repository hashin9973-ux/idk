'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 5, maxEntries: 4000, maxProjects: 200, maxManifestBytes: 128 * 1024 });
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.idea', '.vs', '.vscode', '.bridge-worktrees',
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', '.turbo', 'target', 'bin', 'obj',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.gradle', '.terraform', 'pods', '.dart_tool'
]);
const SOURCE_LANGUAGES = Object.freeze({
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.cs': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'vb',
  '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.sc': 'scala',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.php': 'php', '.rb': 'ruby', '.swift': 'swift', '.m': 'objective-c', '.mm': 'objective-c++',
  '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang',
  '.r': 'r', '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.zig': 'zig', '.vue': 'vue', '.svelte': 'svelte'
});
const TOOLCHAINS_BY_LANGUAGE = Object.freeze({
  c: ['cmake', 'ctest', 'make', 'clang', 'gcc'],
  cpp: ['cmake', 'ctest', 'ninja', 'msbuild', 'cl', 'clang', 'g++', 'make', 'meson'],
  csharp: ['dotnet', 'msbuild'], fsharp: ['dotnet', 'msbuild'], vb: ['dotnet', 'msbuild'],
  rust: ['rustc', 'cargo', 'rustfmt', 'clippy'], java: ['java', 'javac', 'mvn', 'gradle'],
  kotlin: ['java', 'kotlinc', 'gradle'], scala: ['java', 'scalac', 'sbt'],
  python: ['python', 'py', 'pip', 'uv', 'poetry', 'pytest'], go: ['go'],
  javascript: ['node', 'npm', 'pnpm', 'yarn'], typescript: ['node', 'npm', 'pnpm', 'yarn', 'tsc'],
  php: ['php', 'composer'], ruby: ['ruby', 'bundle'], swift: ['swift', 'xcodebuild'],
  'objective-c': ['clang', 'xcodebuild'], 'objective-c++': ['clang', 'xcodebuild'], dart: ['dart', 'flutter'],
  elixir: ['elixir', 'mix'], erlang: ['erl', 'rebar3'], r: ['Rscript'], lua: ['lua', 'luarocks'],
  perl: ['perl', 'cpanm'], zig: ['zig']
});
const TOOL_DEFINITIONS = Object.freeze({
  cmake: { executable: 'cmake', args: ['--version'] }, ctest: { executable: 'ctest', args: ['--version'] }, ninja: { executable: 'ninja', args: ['--version'] },
  msbuild: { executable: 'msbuild', args: ['-version', '-nologo'] }, cl: { executable: 'cl', args: ['/Bv'] },
  clang: { executable: 'clang', args: ['--version'] }, gcc: { executable: 'gcc', args: ['--version'] },
  'g++': { executable: 'g++', args: ['--version'] }, make: { executable: 'make', args: ['--version'] },
  meson: { executable: 'meson', args: ['--version'] }, dotnet: { executable: 'dotnet', args: ['--version'] },
  rustc: { executable: 'rustc', args: ['--version'] }, cargo: { executable: 'cargo', args: ['--version'] },
  rustfmt: { executable: 'rustfmt', args: ['--version'] }, clippy: { executable: 'cargo', args: ['clippy', '--version'] },
  java: { executable: 'java', args: ['-version'] }, javac: { executable: 'javac', args: ['-version'] },
  mvn: { executable: 'mvn', args: ['-version'] }, gradle: { executable: 'gradle', args: ['--version'] },
  kotlinc: { executable: 'kotlinc', args: ['-version'] }, scalac: { executable: 'scalac', args: ['-version'] },
  sbt: { executable: 'sbt', args: ['--version'] }, python: { executable: 'python', args: ['--version'] },
  py: { executable: 'py', args: ['--version'] }, pip: { executable: 'pip', args: ['--version'] },
  uv: { executable: 'uv', args: ['--version'] }, poetry: { executable: 'poetry', args: ['--version'] },
  pytest: { executable: 'pytest', args: ['--version'] }, go: { executable: 'go', args: ['version'] },
  node: { executable: 'node', args: ['--version'] }, npm: { executable: 'npm', args: ['--version'] },
  pnpm: { executable: 'pnpm', args: ['--version'] }, yarn: { executable: 'yarn', args: ['--version'] },
  tsc: { executable: 'tsc', args: ['--version'] }, php: { executable: 'php', args: ['--version'] },
  composer: { executable: 'composer', args: ['--version'] }, ruby: { executable: 'ruby', args: ['--version'] },
  bundle: { executable: 'bundle', args: ['--version'] }, swift: { executable: 'swift', args: ['--version'] },
  xcodebuild: { executable: 'xcodebuild', args: ['-version'] }, dart: { executable: 'dart', args: ['--version'] },
  flutter: { executable: 'flutter', args: ['--version'] }, elixir: { executable: 'elixir', args: ['--version'] },
  mix: { executable: 'mix', args: ['--version'] }, erl: { executable: 'erl', args: ['-version'] },
  rebar3: { executable: 'rebar3', args: ['--version'] }, Rscript: { executable: 'Rscript', args: ['--version'] },
  lua: { executable: 'lua', args: ['-v'] }, luarocks: { executable: 'luarocks', args: ['--version'] },
  perl: { executable: 'perl', args: ['--version'] }, cpanm: { executable: 'cpanm', args: ['--version'] },
  zig: { executable: 'zig', args: ['version'] }
});
const TOOLCHAIN_TTL_MS = 30000;
const PROJECT_PROFILE_TTL_MS = 15000;
const toolchainCache = new Map();
const projectProfileCache = new Map();

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/$/, '');
}
function isFilesystemRoot(root) {
  const resolved = path.resolve(root);
  return resolved.toLowerCase() === path.parse(resolved).root.toLowerCase();
}
function safeName(name) {
  const value = String(name || '').toLowerCase();
  return !/^\.env(?:\.|$)/.test(value) &&
    !/(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|private[-_]?keys?)(?:[._-]|$)/.test(value) &&
    !/^(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/.test(value) &&
    !/\.(?:pem|key|p12|pfx|jks|keystore|p8|mobileprovision)$/.test(value);
}
function parseJson(text) {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
function detectProjectTypes(entries, sourceFiles = []) {
  const files = entries.filter(entry => entry.isFile).map(entry => entry.name.toLowerCase());
  const directories = new Set(entries.filter(entry => entry.isDirectory).map(entry => entry.name.toLowerCase()));
  const types = [];
  if (files.some(name => name.endsWith('.uproject') || name.endsWith('.uplugin'))) types.push('Unreal Engine');
  if (directories.has('assets') && directories.has('projectsettings')) types.push('Unity');
  if (files.includes('project.godot')) types.push('Godot');
  if (files.includes('cmakelists.txt')) types.push('C/C++ (CMake)');
  if (files.includes('meson.build')) types.push('C/C++ (Meson)');
  if ((files.includes('makefile') || files.includes('gnumakefile')) &&
      (sourceFiles.length ? sourceFiles.some(file => ['c', 'cpp'].includes(file.language)) : entries.some(entry => /\.(?:c|cc|cpp|cxx|h|hpp)$/i.test(entry.name)))) types.push('C/C++ (Make)');
  if (files.some(name => name.endsWith('.vcxproj'))) types.push('C++ (MSBuild)');
  if (files.some(name => name.endsWith('.csproj')) || files.includes('global.json')) types.push('.NET / C#');
  if (files.some(name => /\.(?:sln|slnx)$/.test(name))) types.push('Visual Studio solution');
  if (files.includes('cargo.toml')) types.push('Rust (Cargo)');
  if (files.includes('pom.xml')) types.push('Java (Maven)');
  if (files.some(name => ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(name))) {
    types.push('Gradle');
    if (sourceFiles.some(file => file.language === 'kotlin')) types.push('Kotlin (Gradle)');
    if (sourceFiles.some(file => file.language === 'java')) types.push('Java (Gradle)');
  }
  if (files.includes('pyproject.toml') || files.some(name => /^requirements(?:[-_.].*)?\.txt$/.test(name)) || files.includes('setup.py')) types.push('Python');
  if (files.includes('go.mod') || files.includes('go.work')) types.push('Go');
  if (files.includes('package.json')) types.push('Node.js');
  if (files.includes('composer.json')) types.push('PHP / Composer');
  if (files.includes('gemfile') || files.some(name => name.endsWith('.gemspec'))) types.push('Ruby');
  if (files.includes('package.swift') || entries.some(entry => entry.isDirectory && /\.(?:xcodeproj|xcworkspace)$/.test(entry.name.toLowerCase()))) types.push('Swift / Xcode');
  if (files.includes('pubspec.yaml')) types.push('Dart / Flutter');
  if (files.includes('build.sbt')) types.push('Scala (sbt)');
  if (files.includes('mix.exs')) types.push('Elixir (Mix)');
  if (files.includes('rebar.config')) types.push('Erlang (Rebar3)');
  return [...new Set(types)];
}

function scanWorkspace(root, fsApi, limits) {
  const driveRoot = isFilesystemRoot(root);
  const maxDepth = driveRoot ? 1 : limits.maxDepth;
  const stack = [{ absolute: root, relative: '', depth: 0 }];
  const directories = new Map();
  const files = [];
  let entriesVisited = 0;
  let truncated = false;
  const skippedDirectories = [];
  while (stack.length) {
    const current = stack.pop();
    let children;
    try { children = fsApi.readdirSync(current.absolute, { withFileTypes: true }); }
    catch { skippedDirectories.push(current.relative || '.'); continue; }
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name));
    const remaining = Math.max(0, limits.maxEntries - entriesVisited);
    const considered = children.slice(0, remaining);
    if (considered.length < children.length) truncated = true;
    const entries = considered.map(child => ({
      name: child.name, isFile: child.isFile(), isDirectory: child.isDirectory(), isSymbolicLink: child.isSymbolicLink()
    }));
    directories.set(current.relative, entries);
    entriesVisited += entries.length;
    const descend = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink || !safeName(entry.name)) continue;
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? current.relative + '/' + entry.name : entry.name;
      if (entry.isFile) {
        const extension = path.extname(entry.name).toLowerCase();
        const language = SOURCE_LANGUAGES[extension];
        if (language) files.push({ path: relative, language, extension });
      } else if (entry.isDirectory && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase()) && current.depth < maxDepth) {
        descend.push({ absolute, relative, depth: current.depth + 1 });
      }
    }
    if (truncated) break;
    if (entriesVisited >= limits.maxEntries) {
      if (descend.length || stack.length) truncated = true;
      break;
    }
    for (let index = descend.length - 1; index >= 0; index--) stack.push(descend[index]);
  }
  return { directories, files, entriesVisited, truncated, skippedDirectories, driveRootShallow: driveRoot };
}

function readManifest(root, relative, fsApi, maxBytes) {
  try {
    const target = path.join(root, ...relative.split('/'));
    const stat = fsApi.statSync(target);
    if (!stat.isFile() || stat.size > maxBytes) return { content: null, error: stat.size > maxBytes ? 'manifest_too_large' : 'not_a_file' };
    const content = fsApi.readFileSync(target, 'utf8');
    return { content: typeof content === 'string' ? content : content.toString('utf8'), error: null };
  } catch (error) { return { content: null, error: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}
function parseManifestMetadata(root, project, fsApi, maxBytes) {
  const metadata = { packageScripts: [], packageManager: null, entryPoints: [], workspaceMembers: [], configErrors: [], makeTargets: [], cmakeHasTests: false, mesonHasTests: false, rakeHasTestTarget: false };
  for (const manifestPath of project.manifests) {
    const name = path.posix.basename(manifestPath).toLowerCase();
    const loaded = readManifest(root, manifestPath, fsApi, maxBytes);
    if (!loaded.content) {
      if (loaded.error && loaded.error !== 'missing') metadata.configErrors.push({ path: manifestPath, reason: loaded.error });
      continue;
    }
    const source = loaded.content;
    if (name === 'package.json' || name === 'composer.json') {
      const parsed = parseJson(source);
      if (!parsed) { metadata.configErrors.push({ path: manifestPath, reason: 'malformed_json' }); continue; }
      const scripts = parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts) ? parsed.scripts : {};
      metadata.packageScripts = Object.keys(scripts).filter(key => /^[a-zA-Z0-9:_-]{1,60}$/.test(key) && typeof scripts[key] === 'string').slice(0, 40);
      if (typeof parsed.packageManager === 'string') metadata.packageManager = parsed.packageManager.slice(0, 100);
      if (Array.isArray(parsed.workspaces)) metadata.workspaceMembers.push(...parsed.workspaces.filter(value => typeof value === 'string').slice(0, 100));
      else if (parsed.workspaces && Array.isArray(parsed.workspaces.packages)) metadata.workspaceMembers.push(...parsed.workspaces.packages.filter(value => typeof value === 'string').slice(0, 100));
    } else if (name === 'cargo.toml') {
      const members = source.match(/^\s*members\s*=\s*\[([\s\S]*?)\]/m);
      if (members) metadata.workspaceMembers.push(...[...members[1].matchAll(/["']([^"']+)["']/g)].map(match => match[1]).slice(0, 100));
    } else if (name === 'go.work') {
      for (const block of source.matchAll(/^\s*use\s*\(([\s\S]*?)^\s*\)/gm)) {
        for (const line of block[1].split(/\r?\n/)) { const value = line.replace(/\s*\/\/.*$/, '').trim(); if (value) metadata.workspaceMembers.push(value.replace(/^["']|["']$/g, '')); }
      }
      for (const match of source.matchAll(/^\s*use\s+([^\s()]+)\s*$/gm)) metadata.workspaceMembers.push(match[1]);
    } else if (name.startsWith('settings.gradle')) {
      for (const block of source.matchAll(/include\s*\(?\s*([^\n)]*)\)?/g)) {
        for (const match of block[1].matchAll(/["']([^"']+)["']/g)) metadata.workspaceMembers.push(match[1].replace(/^:/, '').replace(/:/g, '/'));
      }
    } else if (name === 'pom.xml') {
      for (const match of source.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)) metadata.workspaceMembers.push(match[1]);
    } else if (name === 'pyproject.toml') {
      const projectName = source.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (projectName) metadata.packageName = projectName[1].slice(0, 120);
    } else if (name === 'pubspec.yaml') {
      const projectName = source.match(/^name:\s*([A-Za-z0-9_-]+)/m);
      if (projectName) metadata.packageName = projectName[1];
    } else if (name === 'makefile' || name === 'gnumakefile') {
      for (const match of source.matchAll(/^([A-Za-z0-9_.-]+)\s*(?::=|:)/gm)) metadata.makeTargets.push(match[1]);
    } else if (name === 'cmakelists.txt') {
      metadata.cmakeHasTests = /(?:enable_testing\s*\(|include\s*\(\s*CTest|add_test\s*\()/i.test(source);
    } else if (name === 'meson.build') {
      metadata.mesonHasTests = /\btest\s*\(/i.test(source);
    } else if (name === 'rakefile') {
      metadata.rakeHasTestTarget = /Rake::TestTask|\btask\s+[:\"']test\b/i.test(source);
    } else if (name.endsWith('.uproject')) {
      const parsed = parseJson(source);
      if (!parsed) metadata.configErrors.push({ path: manifestPath, reason: 'malformed_json' });
      else if (Array.isArray(parsed.Modules)) metadata.unrealModules = parsed.Modules.slice(0, 100).filter(module => module && typeof module.Name === 'string').map(module => module.Name.slice(0, 120));
    }
  }
  metadata.workspaceMembers = [...new Set(metadata.workspaceMembers.map(value => String(value).replace(/\\/g, '/')).filter(value => value && value.length <= 512))].slice(0, 100);
  return metadata;
}

function projectKinds(entries, sourceFiles) {
  const kinds = detectProjectTypes(entries, sourceFiles);
  return kinds;
}
function manifestPaths(entries, relativeRoot) {
  const paths = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink || !safeName(entry.name)) continue;
    const lower = entry.name.toLowerCase();
    if (!entry.isFile && !entry.isDirectory) continue;
    const recognized = lower === 'cmakelists.txt' || lower === 'meson.build' || lower === 'makefile' || lower === 'gnumakefile' ||
      lower === 'cargo.toml' || lower === 'go.mod' || lower === 'go.work' || lower === 'package.json' || lower === 'pyproject.toml' ||
      lower === 'setup.py' || lower === 'setup.cfg' || lower === 'pipfile' || lower === 'pom.xml' || lower === 'build.gradle' ||
      lower === 'build.gradle.kts' || lower === 'settings.gradle' || lower === 'settings.gradle.kts' || lower === 'composer.json' ||
      lower === 'gemfile' || lower === 'package.swift' || lower === 'pubspec.yaml' || lower === 'global.json' ||
      lower === 'build.sbt' || lower === 'mix.exs' || lower === 'rebar.config' ||
      lower === 'pytest.ini' || lower === 'tox.ini' || lower === 'rakefile' || lower === 'makefile' ||
      /^requirements(?:[-_.].*)?\.txt$/.test(lower) || /\.(?:uproject|uplugin|sln|slnx|vcxproj|csproj|gemspec)$/.test(lower) ||
      /\.(?:xcodeproj|xcworkspace)$/.test(lower);
    if (recognized && (entry.isFile || !/\.(?:xcodeproj|xcworkspace)$/.test(lower))) paths.push(relativeRoot ? relativeRoot + '/' + entry.name : entry.name);
  }
  return paths;
}

function projectToolNames(project) {
  const names = new Set(project.languages.flatMap(item => TOOLCHAINS_BY_LANGUAGE[item.language] || []));
  for (const kind of project.projectTypes) {
    if (/C\+\+|C\/C\+\+|Unreal Engine/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.cpp) names.add(name);
    if (/\.NET|C#|Visual Studio|Unity/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.csharp) names.add(name);
    if (/Rust/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.rust) names.add(name);
    if (/Java|Gradle/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.java) names.add(name);
    if (/Python/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.python) names.add(name);
    if (/Go/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.go) names.add(name);
    if (/Node/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.javascript) names.add(name);
    if (/PHP/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.php) names.add(name);
    if (/Ruby/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.ruby) names.add(name);
    if (/Swift/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.swift) names.add(name);
    if (/Dart/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.dart) names.add(name);
    if (/Unity/.test(kind)) names.add('unity');
    if (/Scala/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.scala) names.add(name);
    if (/Elixir/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.elixir) names.add(name);
    if (/Erlang/.test(kind)) for (const name of TOOLCHAINS_BY_LANGUAGE.erlang) names.add(name);
  }
  return [...names];
}

function projectRequiredTools(project) {
  const kinds = new Set(project.projectTypes);
  const languages = new Set(project.languages.map(item => item.language));
  const required = [];
  const add = (anyOf, reason) => {
    if (!required.some(item => item.reason === reason)) required.push({ anyOf, reason });
  };
  if (languages.has('c')) add(['cl', 'clang', 'gcc'], 'C compiler');
  if (languages.has('cpp')) add(['cl', 'clang', 'g++', 'gcc'], 'C++ compiler');
  if ((languages.has('csharp') || languages.has('fsharp') || languages.has('vb')) && !kinds.has('Unity')) add(['dotnet', 'msbuild'], '.NET SDK or MSBuild');
  if (languages.has('rust')) add(['rustc'], 'Rust compiler');
  if (languages.has('java')) add(['javac'], 'Java compiler (JDK)');
  if (languages.has('kotlin') && !kinds.has('Gradle')) add(['kotlinc'], 'Kotlin compiler');
  if (languages.has('scala')) add(['scalac', 'sbt'], 'Scala compiler or sbt');
  if (languages.has('python')) add(['python', 'py'], 'Python interpreter');
  if (languages.has('go')) add(['go'], 'Go toolchain');
  if (languages.has('javascript') || languages.has('typescript')) add(['node'], 'Node.js runtime');
  if (languages.has('typescript')) add(['tsc', 'npm', 'pnpm', 'yarn'], 'TypeScript compiler or package-script runner');
  if (languages.has('php')) add(['php'], 'PHP runtime');
  if (languages.has('ruby')) add(['ruby'], 'Ruby runtime');
  if (languages.has('swift')) add(['swift', 'xcodebuild'], 'Swift toolchain or Xcode');
  if (languages.has('dart')) add(['dart'], 'Dart SDK');
  if (languages.has('elixir')) add(['elixir'], 'Elixir runtime');
  if (languages.has('erlang')) add(['erl'], 'Erlang runtime');
  if (languages.has('zig')) add(['zig'], 'Zig compiler');
  if (kinds.has('C/C++ (CMake)')) {
    add(['cmake'], 'CMake build system');
    if (!languages.has('cpp') && !languages.has('c')) add(['cl', 'clang', 'g++', 'gcc'], 'C/C++ compiler');
  }
  if (kinds.has('C/C++ (Meson)')) {
    add(['meson'], 'Meson build system');
    if (!languages.has('cpp') && !languages.has('c')) add(['cl', 'clang', 'g++', 'gcc'], 'C/C++ compiler');
  }
  if (kinds.has('C/C++ (Make)')) {
    add(['make'], 'Make build system');
    if (!languages.has('cpp') && !languages.has('c')) add(['cl', 'clang', 'g++', 'gcc'], 'C/C++ compiler');
  }
  if (kinds.has('C++ (MSBuild)')) add(['msbuild'], 'Visual Studio MSBuild');
  if (kinds.has('.NET / C#')) add(['dotnet', 'msbuild'], '.NET SDK or MSBuild');
  if (kinds.has('Rust (Cargo)')) add(['cargo'], 'Rust Cargo package/build tool');
  if (kinds.has('Java (standard)') || kinds.has('Java (standard source-only)')) add(['javac'], 'Java compiler (JDK)');
  if (kinds.has('Java (Maven)')) {
    add(['java'], 'Java runtime');
    add(['javac'], 'Java compiler (JDK)');
    if (!project.paths.some(item => item.isFile && /(?:^|\/)mvnw(?:\.cmd)?$/i.test(item.path) && path.posix.dirname(item.path) === (project.root === '.' ? '.' : project.root))) add(['mvn'], 'Maven or the project Maven wrapper');
  }
  if (kinds.has('Gradle')) {
    add(['java'], 'Java runtime required by Gradle');
    if (!project.paths.some(item => item.isFile && /(?:^|\/)gradlew(?:\.bat)?$/i.test(item.path) && path.posix.dirname(item.path) === (project.root === '.' ? '.' : project.root))) add(['gradle'], 'Gradle or the project Gradle wrapper');
  }
  if (kinds.has('Python')) add(['python', 'py'], 'Python interpreter');
  if (kinds.has('Go')) add(['go'], 'Go toolchain');
  if (kinds.has('Node.js')) add(['node'], 'Node.js runtime');
  if (kinds.has('PHP / Composer')) { add(['php'], 'PHP runtime'); add(['composer'], 'Composer'); }
  if (kinds.has('Ruby')) { add(['ruby'], 'Ruby runtime'); add(['bundle'], 'Bundler'); }
  if (kinds.has('Swift / Xcode')) add(['swift', 'xcodebuild'], 'Swift toolchain or Xcode');
  if (kinds.has('Dart / Flutter')) {
    add(['dart'], 'Dart SDK');
    if (project.metadata.flutter === true) add(['flutter'], 'Flutter SDK for the detected Flutter application');
  }
  if (kinds.has('Scala (sbt)')) add(['sbt', 'scalac'], 'Scala compiler or sbt');
  if (kinds.has('Elixir (Mix)')) add(['elixir', 'mix'], 'Elixir runtime and Mix');
  if (kinds.has('Erlang (Rebar3)')) add(['erl', 'rebar3'], 'Erlang runtime and Rebar3');
  if (kinds.has('Unreal Engine')) add(['msbuild', 'cl'], 'Unreal C++ build toolchain');
  if (kinds.has('Unity')) add(['unity'], 'Unity Editor executable (the editor is required for authoritative Unity builds/tests)');
  if (kinds.has('Visual Studio solution')) add(['msbuild', 'dotnet'], 'Visual Studio MSBuild or .NET SDK for the solution');
  return required;
}

function buildCommandPlans(project, toolchains, fsApi, workspaceRoot) {
  const available = new Set(toolchains.filter(tool => tool.usable).map(tool => tool.name));
  const plans = [];
  const hasManifest = name => project.manifests.some(item => path.posix.basename(item).toLowerCase() === name.toLowerCase());
  const projectDirectory = project.root === '.' ? '.' : project.root;
  const hasRootFile = name => project.paths.some(item => item.isFile && path.posix.dirname(item.path) === projectDirectory && path.posix.basename(item.path).toLowerCase() === name.toLowerCase());
  const hasFile = name => project.paths.some(item => item.isFile && path.posix.basename(item.path).toLowerCase() === name.toLowerCase());
  const hasDirectory = name => project.paths.some(item => item.isDirectory && path.posix.basename(item.path).toLowerCase() === name.toLowerCase());
  const root = project.root;
  const projectRelativePath = value => {
    const prefix = project.root === '.' ? '' : project.root + '/';
    return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  };
  const add = (kind, command, executable, source, requireTool = true) => {
    if (requireTool && !available.has(executable)) return;
    plans.push({ kind, command, executable, source, available: true, executed: false });
  };
  const scripts = Array.isArray(project.metadata.packageScripts) ? project.metadata.packageScripts : [];
  if (hasManifest('package.json') || hasManifest('composer.json')) {
    const isComposer = hasManifest('composer.json') && !hasManifest('package.json');
    const manager = isComposer ? 'composer' :
      String(project.metadata.packageManager || '').split('@')[0] ||
      (hasFile('pnpm-lock.yaml') ? 'pnpm' : hasFile('yarn.lock') ? 'yarn' : 'npm');
    if (manager === 'pnpm' || manager === 'yarn' || manager === 'npm') {
      const executable = manager;
      const aliases = { test: 'test', build: 'build', lint: 'lint', format: 'format', check: 'check' };
      for (const [kind, script] of Object.entries(aliases)) if (scripts.includes(script)) {
        const command = manager === 'npm' ? 'npm run ' + script : manager + ' ' + script;
        add(kind, command, executable, 'package.json scripts.' + script);
      }
    } else if (manager === 'composer' && scripts.includes('test')) add('test', 'composer test', 'composer', 'composer.json scripts.test');
  }
  if (project.projectTypes.includes('Python') && (hasManifest('pytest.ini') || hasManifest('pyproject.toml') || hasDirectory('tests') || hasDirectory('test'))) {
    const python = available.has('python') ? 'python' : available.has('py') ? 'py' : null;
    if (python && available.has('pytest-module')) add('test', python + ' -m pytest', python, 'Python test configuration and verified pytest module');
    else if (available.has('pytest')) add('test', 'pytest', 'pytest', 'Python test configuration and pytest executable');
  }
  if (project.projectTypes.includes('Rust (Cargo)')) {
    add('build', 'cargo build --workspace', 'cargo', 'Cargo.toml');
    add('test', 'cargo test --workspace', 'cargo', 'Cargo.toml');
    if (available.has('rustfmt')) add('format_check', 'cargo fmt --all -- --check', 'cargo', 'rustfmt');
    if (available.has('clippy')) add('lint', 'cargo clippy --workspace --all-targets --all-features -- -D warnings', 'cargo', 'cargo-clippy');
  }
  if (project.projectTypes.includes('Go') && hasManifest('go.mod')) {
    add('build', 'go build ./...', 'go', 'go.mod');
    add('test', 'go test ./...', 'go', 'go.mod');
  }
  if (project.projectTypes.includes('Java (Maven)')) {
    const wrapper = hasRootFile('mvnw.cmd') ? (process.platform === 'win32' ? '.\\mvnw.cmd' : './mvnw.cmd') : hasRootFile('mvnw') ? './mvnw' : null;
    if (available.has('java') && available.has('javac') && (wrapper || available.has('mvn'))) {
      const command = wrapper || 'mvn';
      add('build', command + ' -DskipTests package', 'mvn', 'pom.xml' + (wrapper ? ' and Maven wrapper' : ''), !wrapper);
      add('test', command + ' test', 'mvn', 'pom.xml' + (wrapper ? ' and Maven wrapper' : ''), !wrapper);
    }
  }
  if (project.projectTypes.includes('Gradle')) {
    const wrapper = hasRootFile('gradlew.bat') ? (process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew.bat') : hasRootFile('gradlew') ? './gradlew' : null;
    if (available.has('java') && (wrapper || available.has('gradle'))) {
      const command = wrapper || 'gradle';
      add('build', command + ' build', 'gradle', 'Gradle build file' + (wrapper ? ' and Gradle wrapper' : ''), !wrapper);
      add('test', command + ' test', 'gradle', 'Gradle build file' + (wrapper ? ' and Gradle wrapper' : ''), !wrapper);
    }
  }
  if (project.projectTypes.some(kind => kind.includes('.NET / C#'))) {
    const target = project.manifests.find(item => /\.(?:sln|slnx|csproj)$/i.test(item));
    if (target && available.has('dotnet')) {
      const relative = projectRelativePath(target);
      add('build', 'dotnet build ' + JSON.stringify(relative), 'dotnet', 'solution/project manifest');
      add('test', 'dotnet test ' + JSON.stringify(relative), 'dotnet', 'solution/project manifest');
    } else if (target && available.has('msbuild')) {
      const relative = projectRelativePath(target);
      add('build', 'msbuild ' + JSON.stringify(relative) + ' /restore', 'msbuild', relative);
    }
  }
  const hasCppCompiler = ['cl', 'clang', 'g++', 'gcc'].some(name => available.has(name));
  if (project.projectTypes.includes('Visual Studio solution')) {
    const solution = project.manifests.find(item => /\.(?:sln|slnx)$/i.test(item));
    if (solution) {
      const relative = projectRelativePath(solution);
      const needsCpp = project.languages.some(item => ['c', 'cpp'].includes(item.language));
      if (available.has('msbuild') && (!needsCpp || hasCppCompiler)) add('build', 'msbuild ' + JSON.stringify(relative) + ' /restore', 'msbuild', relative);
      else if (!needsCpp && available.has('dotnet')) add('build', 'dotnet build ' + JSON.stringify(relative), 'dotnet', relative);
    }
  }
  if (project.projectTypes.includes('C++ (MSBuild)') && available.has('msbuild') && hasCppCompiler) {
    const vcxproj = project.manifests.find(item => item.toLowerCase().endsWith('.vcxproj'));
    if (vcxproj) { const relative = projectRelativePath(vcxproj); add('build', 'msbuild ' + JSON.stringify(relative) + ' /m', 'msbuild', relative); }
  }
  if (project.projectTypes.includes('C/C++ (CMake)') && available.has('cmake') && hasCppCompiler) {
    const buildDirectories = ['build', 'cmake-build-debug', 'cmake-build-release', path.join('out', 'build')];
    const absoluteProjectRoot = path.join(workspaceRoot, ...(root === '.' ? [] : root.split('/')));
    const configuredBuild = buildDirectories.find(directory => { try { return fsApi.existsSync(path.join(absoluteProjectRoot, directory, 'CMakeCache.txt')); } catch { return false; } });
    if (configuredBuild) add('build', 'cmake --build ' + JSON.stringify(configuredBuild), 'cmake', 'CMakeCache.txt');
    else plans.push({ kind: 'configure', command: 'cmake -S . -B build', executable: 'cmake', source: 'CMakeLists.txt', available: true, executed: false, note: 'Configure before building; inspect the selected generator and project options first.' });
    if (configuredBuild && project.metadata.cmakeHasTests && available.has('ctest')) add('test', 'ctest --test-dir ' + JSON.stringify(configuredBuild) + ' --output-on-failure', 'ctest', 'CMakeCache.txt and CMake test registration');
  }
  if (project.projectTypes.includes('C/C++ (Meson)') && available.has('meson') && hasCppCompiler) {
    const configured = project.paths.some(item => item.isFile && item.path.replace(/\\/g, '/').toLowerCase() === (projectDirectory === '.' ? 'build/meson-private/coredata.dat' : projectDirectory + '/build/meson-private/coredata.dat').toLowerCase());
    if (configured) {
      add('build', 'meson compile -C build', 'meson', 'Meson build directory');
      if (project.metadata.mesonHasTests) add('test', 'meson test -C build', 'meson', 'Meson test() declarations');
    } else {
      plans.push({ kind: 'configure', command: 'meson setup build', executable: 'meson', source: 'meson.build', available: true, executed: false, note: 'Configure before compiling; inspect project options first.' });
    }
  }
  if (project.projectTypes.includes('C/C++ (Make)') && available.has('make') && hasCppCompiler) {
    if (hasCppCompiler) add('build', 'make', 'make', 'Makefile');
    if (hasCppCompiler && project.metadata.makeTargets.includes('test')) add('test', 'make test', 'make', 'Makefile test target');
  }
  if (project.projectTypes.includes('Swift / Xcode') && hasManifest('package.swift')) {
    add('build', 'swift build', 'swift', 'Package.swift');
    add('test', 'swift test', 'swift', 'Package.swift');
  }
  if (project.projectTypes.includes('Ruby') && available.has('bundle') && project.metadata.rakeHasTestTarget === true) {
    add('test', 'bundle exec rake test', 'bundle', 'Gemfile and declared Rake test task');
  }
  if (project.projectTypes.includes('Scala (sbt)')) {
    add('build', 'sbt compile', 'sbt', 'build.sbt');
    if (hasDirectory('src')) add('test', 'sbt test', 'sbt', 'build.sbt');
  }
  if (project.projectTypes.includes('Elixir (Mix)')) {
    add('build', 'mix compile', 'mix', 'mix.exs');
    add('test', 'mix test', 'mix', 'mix.exs');
  }
  if (project.projectTypes.includes('Erlang (Rebar3)')) {
    add('build', 'rebar3 compile', 'rebar3', 'rebar.config');
    add('test', 'rebar3 eunit', 'rebar3', 'rebar.config');
  }
  if (project.projectTypes.includes('Unity')) {
    // No generic Unity build command is emitted without a verified editor path and target configuration.
  }
  if (project.projectTypes.includes('Dart / Flutter')) {
    if (project.metadata.flutter === true && available.has('flutter')) {
      add('build', 'flutter analyze', 'flutter', 'Flutter dependency in pubspec.yaml');
      if (hasDirectory('test') || hasDirectory('tests')) add('test', 'flutter test', 'flutter', 'Flutter test directory');
    } else {
      add('build', 'dart analyze', 'dart', 'pubspec.yaml');
      if (hasDirectory('test') || hasDirectory('tests')) add('test', 'dart test', 'dart', 'pubspec.yaml and test directory');
    }
  }
  const seen = new Set();
  return plans.filter(plan => {
    if (!plan.available) return false;
    const key = plan.kind + '|' + plan.command;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 30);
}

async function discoverToolchain(name, options) {
  const definition = TOOL_DEFINITIONS[name];
  if (!definition) return { name, available: false, path: null, version: null, usable: false, error: 'unsupported_probe' };
  const execFileAsync = options.toolExecFileAsync || options.execFileAsync || promisify(execFile);
  const platform = options.platform || process.platform;
  const finder = platform === 'win32' ? 'where.exe' : 'which';
  const execOptions = { encoding: 'utf8', timeout: options.toolTimeoutMs || 2000, maxBuffer: 32 * 1024, windowsHide: true, shell: false };
  let executablePath;
  try {
    const located = await execFileAsync(finder, [definition.executable], execOptions);
    executablePath = String(located.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || null;
  } catch { /* MSVC/MSBuild commonly are not exported in a normal user PATH. */ }
  executablePath = executablePath || options.executablePaths?.[name] || null;
  if (!executablePath) return { name, available: false, path: null, version: null, usable: false, error: 'not_found' };
  try {
    const checked = await execFileAsync(executablePath, definition.args, execOptions);
    const text = String(checked.stdout || '') + '\n' + String(checked.stderr || '');
    const version = text.split(/\r?\n/).map(value => value.trim()).find(value => value && /\d/.test(value)) || null;
    return { name, available: true, path: executablePath, version: version ? version.slice(0, 180) : null, usable: Boolean(version), error: version ? null : 'version_unavailable' };
  } catch (error) {
    const text = String(error.stdout || '') + '\n' + String(error.stderr || '');
    const version = text.split(/\r?\n/).map(value => value.trim()).find(value => value && /\d/.test(value)) || null;
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
    return { name, available: true, path: executablePath, version: version ? version.slice(0, 180) : null, usable: Boolean(version) && !timedOut, error: timedOut ? 'version_timeout' : version ? 'version_probe_nonzero_with_version' : 'version_check_failed' };
  }
}

async function discoverVisualStudioExecutablePaths(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return {};
  const fsApi = options.fsApi || fs;
  const environment = options.environment || process.env;
  const roots = [];
  const programFilesX86 = environment['ProgramFiles(x86)'];
  const programFiles = environment.ProgramFiles;
  if (programFilesX86) roots.push(path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  if (programFiles) roots.push(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  const vswhere = roots.find(candidate => { try { return fsApi.statSync(candidate).isFile(); } catch { return false; } });
  if (!vswhere) return {};
  const execFileAsync = options.toolExecFileAsync || options.execFileAsync || promisify(execFile);
  const execOptions = { encoding: 'utf8', timeout: options.toolTimeoutMs || 2000, maxBuffer: 32 * 1024, windowsHide: true, shell: false };
  let installations = [];
  try {
    const result = await execFileAsync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], execOptions);
    installations = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 20);
  } catch { return {}; }
  const found = {};
  for (const installation of installations) {
    const msbuild = path.join(installation, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    try { if (!found.msbuild && fsApi.statSync(msbuild).isFile()) found.msbuild = msbuild; } catch {}
    const msvcRoot = path.join(installation, 'VC', 'Tools', 'MSVC');
    let versions = [];
    try { versions = fsApi.readdirSync(msvcRoot).filter(name => /^[0-9.]+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 10); } catch {}
    for (const version of versions) {
      const candidates = [
        path.join(msvcRoot, version, 'bin', 'Hostx64', 'x64', 'cl.exe'),
        path.join(msvcRoot, version, 'bin', 'Hostx86', 'x86', 'cl.exe')
      ];
      for (const candidate of candidates) {
        try { if (!found.cl && fsApi.statSync(candidate).isFile()) found.cl = candidate; } catch {}
      }
      if (found.cl) break;
    }
    if (found.msbuild && found.cl) break;
  }
  return found;
}

function discoverUnityEditorPath(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const fsApi = options.fsApi || fs;
  const environment = options.environment || process.env;
  const roots = [
    environment.ProgramFiles && path.join(environment.ProgramFiles, 'Unity', 'Hub', 'Editor'),
    environment['ProgramFiles(x86)'] && path.join(environment['ProgramFiles(x86)'], 'Unity', 'Hub', 'Editor'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs', 'Unity Hub', 'Editor')
  ].filter(Boolean);
  for (const root of roots) {
    let versions = [];
    try { versions = fsApi.readdirSync(root).slice(0, 50).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
    catch { continue; }
    for (const version of versions) {
      const editor = path.join(root, version, 'Editor', 'Unity.exe');
      try { if (fsApi.statSync(editor).isFile()) return editor; } catch {}
    }
  }
  return null;
}

async function discoverToolchains(languages, options = {}) {
  const names = [...new Set([...(options.requestedToolNames || []), ...languages.flatMap(language => TOOLCHAINS_BY_LANGUAGE[language] || [])])].sort();
  const cacheKey = String(options.cacheKey || '') + '|' + names.join(',') + '|' + (options.platform || process.platform);
  const cached = toolchainCache.get(cacheKey);
  if (!options.noCache && cached && Date.now() - cached.checkedAt < TOOLCHAIN_TTL_MS) return cached.tools.map(tool => ({ ...tool }));
  const visualStudioPaths = names.some(name => ['msbuild', 'cl'].includes(name)) ? await discoverVisualStudioExecutablePaths(options) : {};
  const probeOptions = { ...options, executablePaths: { ...(options.executablePaths || {}), ...visualStudioPaths } };
  const tools = new Array(names.length);
  let nextTool = 0;
  const probeWorkers = Array.from({ length: Math.min(8, names.length) }, async () => {
    while (nextTool < names.length) {
      const index = nextTool++;
      tools[index] = await discoverToolchain(names[index], probeOptions);
    }
  });
  await Promise.all(probeWorkers);
  if (names.includes('unity')) {
    const editorPath = discoverUnityEditorPath(options);
    const index = tools.findIndex(tool => tool.name === 'unity');
    const record = { name: 'unity', available: Boolean(editorPath), path: editorPath, version: null, usable: false, error: editorPath ? 'version_probe_skipped_to_avoid_launching_editor' : 'not_found' };
    if (index >= 0) tools[index] = record; else tools.push(record);
  }
  const interpreter = tools.find(tool => ['python', 'py'].includes(tool.name) && tool.usable);
  if (interpreter) {
    try {
      const checked = await (options.toolExecFileAsync || options.execFileAsync || promisify(execFile))(interpreter.path, ['-m', 'pytest', '--version'], { encoding: 'utf8', timeout: options.toolTimeoutMs || 2000, maxBuffer: 32 * 1024, windowsHide: true, shell: false });
      const output = String(checked.stdout || '') + '\n' + String(checked.stderr || '');
      const version = output.split(/\r?\n/).map(value => value.trim()).find(value => value && /pytest/i.test(value)) || null;
      if (version) tools.push({ name: 'pytest-module', available: true, path: interpreter.path, version: version.slice(0, 180), usable: true, error: null });
    } catch { /* Missing pytest module is distinct from a missing Python interpreter. */ }
  }
  if (!options.noCache) toolchainCache.set(cacheKey, { tools, checkedAt: Date.now() });
  while (toolchainCache.size > 100) toolchainCache.delete(toolchainCache.keys().next().value);
  return tools.map(tool => ({ ...tool }));
}

function languageCounts(files) {
  const counts = new Map();
  for (const file of files) counts.set(file.language, (counts.get(file.language) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([language, count]) => ({ language, files: count }));
}

async function discoverWorkspaceProjects(workspaceRoot, options = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim() || workspaceRoot.length > 2048) throw new Error('A valid workspace directory is required.');
  const root = path.resolve(workspaceRoot);
  const fsApi = options.fsApi || fs;
  const stat = fsApi.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The selected workspace must be a real directory, not a symbolic link.');
  const limits = {
    maxDepth: Number.isInteger(options.maxDepth) ? Math.min(Math.max(options.maxDepth, 1), 8) : DEFAULT_LIMITS.maxDepth,
    maxEntries: Number.isInteger(options.maxEntries) ? Math.min(Math.max(options.maxEntries, 100), 20000) : DEFAULT_LIMITS.maxEntries,
    maxProjects: Number.isInteger(options.maxProjects) ? Math.min(Math.max(options.maxProjects, 1), 200) : DEFAULT_LIMITS.maxProjects,
    maxManifestBytes: Number.isInteger(options.maxManifestBytes) ? Math.min(Math.max(options.maxManifestBytes, 1024), 1024 * 1024) : DEFAULT_LIMITS.maxManifestBytes
  };
  const profileCacheKey = [root, limits.maxDepth, limits.maxEntries, limits.maxProjects, limits.maxManifestBytes, options.platform || process.platform].join('|');
  const cachedProfile = projectProfileCache.get(profileCacheKey);
  if (!options.noCache && !options.force && cachedProfile && Date.now() - cachedProfile.checkedAt < PROJECT_PROFILE_TTL_MS) return structuredClone(cachedProfile.profile);
  const scanned = scanWorkspace(root, fsApi, limits);
  const projects = [];
  for (const [relativeRoot, entries] of scanned.directories) {
    const sourceFiles = scanned.files.filter(file => !relativeRoot || file.path.startsWith(relativeRoot + '/'));
    const projectTypes = projectKinds(entries, sourceFiles);
    if (!projectTypes.length) continue;
    const manifests = manifestPaths(entries, relativeRoot);
    const projectFiles = sourceFiles;
    const projectPaths = [];
    for (const [directoryRoot, directoryEntries] of scanned.directories) {
      if (relativeRoot && directoryRoot !== relativeRoot && !directoryRoot.startsWith(relativeRoot + '/')) continue;
      for (const entry of directoryEntries) {
        const itemPath = directoryRoot ? directoryRoot + '/' + entry.name : entry.name;
        projectPaths.push({ path: itemPath, isFile: entry.isFile, isDirectory: entry.isDirectory });
      }
    }
    const languages = languageCounts(projectFiles);
    const kind = projectTypes[0];
    projects.push({
      root: relativeRoot || '.', name: path.posix.basename(relativeRoot || path.resolve(root)), kind,
      projectTypes, languages, manifests, buildSystems: projectTypes.filter(value => /CMake|Meson|Make|MSBuild|Maven|Gradle|Cargo|Composer|Xcode|Swift/.test(value)),
      packageManagers: [], files: projectPaths.filter(item => item.isFile).map(item => item.path), paths: projectPaths, metadata: null
    });
  }
  if (!projects.some(project => project.root === '.') && projects.length === 0 && scanned.files.length) {
    const sourceTypes = [...new Set(scanned.files.map(file => file.language))];
    const labels = sourceTypes.map(language => ({ c: 'C (source-only)', cpp: 'C++ (source-only)', csharp: 'C# (source-only)', python: 'Python (source-only)', java: 'Java (standard source-only)', rust: 'Rust (source-only)', go: 'Go (source-only)', javascript: 'JavaScript (source-only)', typescript: 'TypeScript (source-only)', kotlin: 'Kotlin (source-only)', swift: 'Swift (source-only)', php: 'PHP (source-only)', ruby: 'Ruby (source-only)', dart: 'Dart (source-only)' }[language] || language + ' (source-only)'));
    projects.push({ root: '.', name: path.basename(root), kind: labels[0], projectTypes: labels, languages: languageCounts(scanned.files), manifests: [], buildSystems: [], packageManagers: [], files: [...scanned.files].map(file => file.path), paths: [...scanned.directories.entries()].flatMap(([directoryRoot, entries]) => entries.map(entry => ({ path: directoryRoot ? directoryRoot + '/' + entry.name : entry.name, isFile: entry.isFile, isDirectory: entry.isDirectory }))), metadata: { packageScripts: [], packageManager: null, entryPoints: [], workspaceMembers: [], configErrors: [] } });
  }
  projects.sort((a, b) => a.root.split('/').length - b.root.split('/').length || a.root.localeCompare(b.root));
  const projectCountBeforeLimit = projects.length;
  if (projects.length > limits.maxProjects) projects.length = limits.maxProjects;
  for (const project of projects) {
    project.metadata = parseManifestMetadata(root, project, fsApi, limits.maxManifestBytes);
    const lockFiles = new Set(project.files.map(file => path.posix.basename(file).toLowerCase()));
    const packages = project.packageManagers;
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'cargo.toml')) packages.push('Cargo');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'go.mod')) packages.push('Go modules');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'package.json')) packages.push(project.metadata.packageManager || (lockFiles.has('pnpm-lock.yaml') ? 'pnpm' : lockFiles.has('yarn.lock') ? 'Yarn' : lockFiles.has('package-lock.json') ? 'npm' : 'Node.js package scripts'));
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'composer.json')) packages.push('Composer');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'gemfile')) packages.push('Bundler');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'pom.xml')) packages.push('Maven');
    if (project.projectTypes.includes('Gradle')) packages.push(lockFiles.has('gradlew.bat') || lockFiles.has('gradlew') ? 'Gradle wrapper' : 'Gradle');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'package.swift')) packages.push('Swift Package Manager');
    if (project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'pubspec.yaml')) packages.push('Dart pub');
    project.packageManagers = [...new Set(packages)];
    project.metadata.flutter = project.manifests.some(item => path.posix.basename(item).toLowerCase() === 'pubspec.yaml') &&
      Boolean(readManifest(root, project.manifests.find(item => path.posix.basename(item).toLowerCase() === 'pubspec.yaml'), fsApi, limits.maxManifestBytes).content?.match(/^\s*flutter\s*:/m));
    project.missingPrerequisites = [];
    project.workspaceMembers = project.metadata.workspaceMembers;
    project.children = projects.filter(other => other.root !== project.root && other.root.startsWith(project.root === '.' ? '' : project.root + '/') && other.root.split('/').length > project.root.split('/').length).map(other => other.root).slice(0, 100);
  }
  const languages = languageCounts(scanned.files);
  const requestedToolNames = [...new Set(projects.flatMap(projectToolNames))];
  const toolchainLanguages = [...new Set([...languages.map(item => item.language), ...requestedToolNames.flatMap(name => {
    const mapping = Object.entries(TOOLCHAINS_BY_LANGUAGE).find(([, toolNames]) => toolNames.includes(name));
    return mapping ? [mapping[0]] : [];
  })])];
  const toolchains = options.skipToolchainDiscovery === true ? [] : await discoverToolchains(toolchainLanguages, { ...options, cacheKey: root, requestedToolNames });
  const toolchainMap = new Map(toolchains.map(tool => [tool.name, tool]));
  for (const project of projects) {
    const required = projectRequiredTools(project);
    for (const requirement of required) {
      const matched = requirement.anyOf.map(name => toolchainMap.get(name)).find(item => item && item.usable);
      if (!matched) project.missingPrerequisites.push({ reason: requirement.reason, anyOf: requirement.anyOf,
        available: requirement.anyOf.some(name => toolchainMap.get(name)?.available === true) });
    }
    if (project.projectTypes.includes('Unreal Engine')) project.missingPrerequisites.push({ reason: 'Unreal Engine installation and UnrealBuildTool path have not been resolved from the project engine association/installation registry', anyOf: ['UnrealBuildTool'], available: false });
    if (project.projectTypes.includes('Unity')) project.missingPrerequisites.push({ reason: 'Unity Editor path and batch-mode target configuration have not been resolved', anyOf: ['unity'], available: toolchainMap.get('unity')?.available === true });
    project.toolchains = projectToolNames(project).map(name => toolchainMap.get(name)).filter(Boolean);
    if (project.languages.some(item => item.language === 'python') && toolchainMap.has('pytest-module')) project.toolchains.push(toolchainMap.get('pytest-module'));
    project.commandPlans = buildCommandPlans(project, project.toolchains, fsApi, root).map(plan => {
      const evidence = project.toolchains.find(tool => tool.name === plan.executable) || null;
      let command = plan.command;
      if (plan.executable === 'msbuild' && evidence?.usable && evidence.path) {
        const quotedExecutable = "'" + evidence.path.replace(/'/g, "''") + "'";
        command = '& ' + quotedExecutable + command.slice('msbuild'.length);
      }
      return { ...plan, command, toolchainPath: evidence?.path || null, toolchainVersion: evidence?.version || null,
        toolchainVerified: Boolean(evidence?.usable || (plan.source && /wrapper/i.test(plan.source))) };
    });
    project.supportLevel = project.missingPrerequisites.length ? 'detected_only' : project.commandPlans.length ? 'toolchain_ready' : 'toolchain_available';
  }
  const projectTypes = [...new Set(projects.flatMap(project => project.projectTypes))];
  const roots = projects.map(project => project.root);
  const relationships = [];
  for (const project of projects) {
    for (const member of project.workspaceMembers) {
      const normalized = normalizeRelative(path.posix.normalize(path.posix.join(project.root === '.' ? '' : project.root, member.replace(/^\.\//, ''))));
      const wildcard = normalized.indexOf('*');
      const prefix = wildcard >= 0 ? normalized.slice(0, wildcard) : null;
      const matches = projects.filter(other => other.root !== project.root && (other.root === normalized || other.root === normalized.replace(/\/$/, '') || (prefix !== null && other.root.startsWith(prefix))));
      for (const match of matches.slice(0, 100)) relationships.push({ from: project.root, to: match.root, kind: 'declared_workspace_member' });
    }
    for (const child of project.children) relationships.push({ from: project.root, to: child, kind: 'contains_project' });
  }
  const nestedProjectCandidates = projects.filter(project => project.root !== '.').map(project => ({ path: path.join(root, ...project.root.split('/')), projectTypes: project.projectTypes, root: project.root }));
  const rootProject = projects.find(project => project.root === '.') || (projects.length === 1 ? projects[0] : null);
  const rootProjectTypes = projects.find(project => project.root === '.')?.projectTypes || [];
  const flatCommands = projects.flatMap(project => project.commandPlans.map(plan => ({ ...plan, projectRoot: project.root })));
  const publicProjects = projects.map(project => ({
    root: project.root, name: project.name, kind: project.kind,
    projectTypes: project.projectTypes, languages: project.languages,
    manifests: project.manifests.slice(0, 50), buildSystems: project.buildSystems,
    packageManagers: project.packageManagers, metadata: {
      packageScripts: project.metadata.packageScripts,
      packageManager: project.metadata.packageManager,
      packageName: project.metadata.packageName || null,
      entryPoints: project.metadata.entryPoints.slice(0, 30),
      workspaceMembers: project.workspaceMembers.slice(0, 100),
      configErrors: project.metadata.configErrors.slice(0, 20),
      makeTargets: project.metadata.makeTargets.slice(0, 100),
      cmakeHasTests: project.metadata.cmakeHasTests, mesonHasTests: project.metadata.mesonHasTests, rakeHasTestTarget: project.metadata.rakeHasTestTarget,
      unrealModules: (project.metadata.unrealModules || []).slice(0, 100),
      flutter: project.metadata.flutter === true
    },
    children: project.children.slice(0, 50), missingPrerequisites: project.missingPrerequisites.slice(0, 30),
    toolchains: project.toolchains.map(tool => tool.name).slice(0, 40), commandPlans: project.commandPlans.slice(0, 15),
    supportLevel: project.supportLevel
  }));
  const profile = {
    workspaceRoot: root, languages, projectTypes, projects: publicProjects,
    detectedProjectRoot: rootProject ? path.join(root, ...rootProject.root.split('/')) : null,
    rootProjectTypes, nestedProjectCandidates, projectRoots: roots,
    relationships: relationships.slice(0, 500), toolchains,
    suggestedCommands: flatCommands.slice(0, 100),
    missingPrerequisites: [...new Map(projects.flatMap(project => project.missingPrerequisites.map(item => [item.reason, item])).map(([key, value]) => [key, value])).values()].slice(0, 100),
    scan: { entriesVisited: scanned.entriesVisited, filesConsidered: scanned.files.length, projectsDetected: projectCountBeforeLimit, projectsReturned: projects.length, truncated: scanned.truncated || projectCountBeforeLimit > projects.length, driveRootShallow: scanned.driveRootShallow, maxDepth: scanned.driveRootShallow ? 1 : limits.maxDepth, maxEntries: limits.maxEntries, skippedDirectories: scanned.skippedDirectories.slice(0, 50) },
    capabilityNote: 'Project manifests and source files establish detection. Toolchain availability is checked separately using executable-path and version probes (not compile smoke tests). Suggested commands are inferred only from recognized project configuration and verified executable probes or project-local build wrappers; no command is executed and no dependencies or SDKs are installed.'
  };
  if (!options.noCache) {
    projectProfileCache.set(profileCacheKey, { profile: structuredClone(profile), checkedAt: Date.now() });
    while (projectProfileCache.size > 80) projectProfileCache.delete(projectProfileCache.keys().next().value);
  }
  return profile;
}

module.exports = {
  DEFAULT_LIMITS, IGNORED_DIRECTORIES, SOURCE_LANGUAGES, TOOLCHAINS_BY_LANGUAGE,
  detectProjectTypes, discoverToolchains, discoverWorkspaceProjects
};
