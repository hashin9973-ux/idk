'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  detectProjectTypes,
  discoverToolchains,
  discoverWorkspaceProjects
} = require('../desktop/project-support');

function makeToolProbe(installed = []) {
  // TEST DOUBLE ONLY: this simulates PATH lookup and version text; it does not execute or prove real compilers.
  const available = new Set(installed);
  return async (command, args) => {
    if (command === 'which' || command === 'where.exe') {
      const name = args[0];
      return { stdout: available.has(name) ? `/test-tool-bin/${name}\n` : '' };
    }
    const name = path.basename(command).replace(/\.exe$/i, '');
    if (!available.has(name)) {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
    if (args.includes('-m') && args.includes('pytest') && (available.has('pytest-module') || available.has('pytest'))) return { stdout: 'pytest 8.4.0\n' };
    return { stdout: `${name} version 99.1.0\n`, stderr: '' };
  };
}

async function fixture(prefix = 'project-support-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function put(root, relative, contents = '') {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
}
async function inspect(root, installed = [], extra = {}) {
  return discoverWorkspaceProjects(root, {
    noCache: true,
    platform: 'linux',
    toolExecFileAsync: makeToolProbe(installed),
    ...extra
  });
}
function projectAt(profile, root) {
  const found = profile.projects.find(project => project.root === root);
  assert.ok(found, `expected project at ${root}; detected ${profile.projects.map(item => item.root).join(', ')}`);
  return found;
}

test('project marker detection distinguishes CMake, MSBuild, .NET, game engines and package ecosystems', () => {
  const types = detectProjectTypes([
    { name: 'CMakeLists.txt', isFile: true },
    { name: 'Engine.vcxproj', isFile: true },
    { name: 'App.csproj', isFile: true },
    { name: 'Sample.uproject', isFile: true },
    { name: 'Assets', isDirectory: true },
    { name: 'ProjectSettings', isDirectory: true }
  ], [{ language: 'cpp' }, { language: 'csharp' }]);
  assert.ok(types.includes('C/C++ (CMake)'));
  assert.ok(types.includes('C++ (MSBuild)'));
  assert.ok(types.includes('.NET / C#'));
  assert.ok(types.includes('Unreal Engine'));
  assert.ok(types.includes('Unity'));
});

test('CMake C++ project reports verified compiler/build tool and a configure plan', async () => {
  const root = await fixture('C++ CMake ü ');
  try {
    put(root, 'CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\nproject(sample LANGUAGES CXX)\n');
    put(root, 'src/main.cpp', 'int main() { return 0; }\n');
    const profile = await inspect(root, ['cmake', 'g++']);
    const project = projectAt(profile, '.');
    assert.deepEqual(project.projectTypes, ['C/C++ (CMake)']);
    assert.equal(project.supportLevel, 'toolchain_ready');
    assert.ok(profile.toolchains.some(tool => tool.name === 'cmake' && tool.usable && tool.path === '/test-tool-bin/cmake'));
    assert.ok(profile.toolchains.some(tool => tool.name === 'g++' && tool.usable));
    assert.ok(project.toolchains.includes('g++'));
    assert.ok(project.commandPlans.some(plan => plan.kind === 'configure' && plan.command === 'cmake -S . -B build' && plan.executed === false));
    assert.equal(Object.hasOwn(project, 'files'), false, 'file inventories must not be copied into agent context');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('CMake test commands require CTest registration and a verified CTest executable', async () => {
  const root = await fixture();
  try {
    put(root, 'CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\nproject(sample LANGUAGES CXX)\nenable_testing()\nadd_test(NAME smoke COMMAND demo)\n');
    put(root, 'src/main.cpp', 'int main() { return 0; }\n');
    const profile = await inspect(root, ['cmake', 'g++', 'ctest']);
    const project = projectAt(profile, '.');
    assert.ok(project.commandPlans.some(plan => plan.kind === 'configure'));
    assert.equal(project.commandPlans.some(plan => plan.kind === 'test'), false, 'CTest needs a configured build tree');
    put(root, 'build/CMakeCache.txt', '# configured test fixture\n');
    const configured = await inspect(root, ['cmake', 'g++', 'ctest']);
    assert.ok(projectAt(configured, '.').commandPlans.some(plan => plan.kind === 'test' && plan.command === 'ctest --test-dir \"build\" --output-on-failure'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Meson waits for Ninja and detects an existing configured build despite ignoring generated directories', async () => {
  const root = await fixture();
  try {
    put(root, 'meson.build', "project('sample', 'cpp')\ntest('smoke', find_program('echo'))\n");
    put(root, 'src/main.cpp', 'int main() { return 0; }\n');
    const withoutNinja = await inspect(root, ['meson', 'g++']);
    const missingNinjaProject = projectAt(withoutNinja, '.');
    assert.ok(missingNinjaProject.missingPrerequisites.some(item => item.reason === 'Ninja build backend for Meson'));
    assert.equal(missingNinjaProject.commandPlans.some(plan => /meson setup|meson compile|meson test/.test(plan.command)), false);

    const unconfigured = await inspect(root, ['meson', 'ninja', 'g++']);
    assert.ok(projectAt(unconfigured, '.').commandPlans.some(plan => plan.kind === 'configure' && plan.command === 'meson setup build'));

    // The production scanner intentionally skips generated build/ folders.
    // A targeted existence check must still discover Meson's private build marker.
    put(root, 'build/meson-private/coredata.dat', 'test fixture');
    const configured = await inspect(root, ['meson', 'ninja', 'g++']);
    const plans = projectAt(configured, '.').commandPlans;
    assert.ok(plans.some(plan => plan.kind === 'build' && plan.command === 'meson compile -C build'));
    assert.ok(plans.some(plan => plan.kind === 'test' && plan.command === 'meson test -C build'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('MSBuild C++ solution and project use the resolved executable path', async () => {
  const root = await fixture();
  try {
    put(root, 'Sample.sln', 'Microsoft Visual Studio Solution File, Format Version 12.00\n');
    put(root, 'src/Sample.vcxproj', '<Project />\n');
    put(root, 'src/main.cpp', 'int main() { return 0; }\n');
    const profile = await inspect(root, ['msbuild', 'cl']);
    const solution = projectAt(profile, '.');
    const cppProject = projectAt(profile, 'src');
    assert.ok(solution.projectTypes.includes('Visual Studio solution'));
    assert.ok(cppProject.projectTypes.includes('C++ (MSBuild)'));
    assert.ok(solution.commandPlans.some(plan => plan.kind === 'build' && plan.command.includes('Sample.sln') && plan.command.includes('/test-tool-bin/msbuild')));
    assert.ok(cppProject.commandPlans.some(plan => plan.kind === 'build' && plan.command.includes('Sample.vcxproj') && plan.command.includes('/test-tool-bin/msbuild')));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Windows Visual Studio discovery resolves MSBuild and MSVC from vswhere without PATH entries', async () => {
  const root = await fixture();
  const programFiles = path.join(root, 'Program Files');
  const install = path.join(programFiles, 'Microsoft Visual Studio', '2022', 'BuildTools');
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const msbuild = path.join(install, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  const msvcRoot = path.join(install, 'VC', 'Tools', 'MSVC');
  const cl = path.join(msvcRoot, '14.40.33807', 'bin', 'Hostx64', 'x64', 'cl.exe');
  try {
    for (const file of [vswhere, msbuild, cl]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'test executable placeholder'); }
    const tools = await discoverToolchains(['cpp'], {
      platform: 'win32', noCache: true, environment: { 'ProgramFiles(x86)': programFiles },
      toolExecFileAsync: async (command, args) => {
        if (command === 'where.exe') { const error = new Error('not found'); error.code = 'ENOENT'; throw error; }
        if (command === vswhere) return { stdout: install + '\n' };
        if (command === msbuild) return { stdout: 'Microsoft Build Engine version 17.10.0\n' };
        if (command === cl) return { stderr: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.40.33811\n' };
        const error = new Error('not found'); error.code = 'ENOENT'; throw error;
      }
    });
    assert.ok(tools.some(tool => tool.name === 'msbuild' && tool.usable && tool.path === msbuild));
    assert.ok(tools.some(tool => tool.name === 'cl' && tool.usable && tool.path === cl));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Unreal project records project modules and does not claim UBT build readiness', async () => {
  const root = await fixture();
  try {
    put(root, 'Ashen.uproject', JSON.stringify({ EngineAssociation: '5.4', Modules: [{ Name: 'Ashen', Type: 'Runtime' }] }));
    put(root, 'Source/Ashen/Ashen.Build.cs', 'public class Ashen : ModuleRules {}\n');
    put(root, 'Source/Ashen/Ashen.Target.cs', 'public class AshenTarget {}\n');
    put(root, 'Source/Ashen/main.cpp', 'int main() { return 0; }\n');
    const profile = await inspect(root, ['msbuild', 'cl']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Unreal Engine'));
    assert.deepEqual(project.metadata.unrealModules, ['Ashen']);
    assert.equal(project.supportLevel, 'detected_only');
    assert.ok(project.missingPrerequisites.some(item => item.anyOf.includes('UnrealBuildTool')));
    assert.equal(project.commandPlans.some(plan => /UnrealBuildTool|Build\.bat/.test(plan.command)), false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('.NET project reports dotnet build and test only when SDK probe succeeds', async () => {
  const root = await fixture();
  try {
    put(root, 'App.csproj', '<Project Sdk=\"Microsoft.NET.Sdk\" />\n');
    put(root, 'Program.cs', 'class Program {}\n');
    const ready = await inspect(root, ['dotnet']);
    const project = projectAt(ready, '.');
    assert.equal(project.supportLevel, 'toolchain_ready');
    assert.ok(project.commandPlans.some(plan => plan.command === 'dotnet build \"App.csproj\"'));
    assert.ok(project.commandPlans.some(plan => plan.command === 'dotnet test \"App.csproj\"'));
    const missing = await inspect(root, []);
    assert.equal(projectAt(missing, '.').supportLevel, 'detected_only');
    assert.ok(projectAt(missing, '.').missingPrerequisites.some(item => item.reason === '.NET SDK or MSBuild'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Unity project identifies C# scripts but does not pretend an Editor is installed', async () => {
  const root = await fixture();
  try {
    put(root, 'Assets/Scripts/Main.cs', 'public class Main {}\n');
    put(root, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.0f1\n');
    const profile = await inspect(root, ['dotnet']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Unity'));
    assert.equal(project.supportLevel, 'detected_only');
    assert.ok(project.missingPrerequisites.some(item => item.reason.includes('Unity Editor')));
    assert.equal(project.commandPlans.some(plan => /unity|Unity/.test(plan.command)), false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Cargo workspace discovers nested crates and declared workspace relationships', async () => {
  const root = await fixture();
  try {
    put(root, 'Cargo.toml', '[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n');
    put(root, 'crates/core/Cargo.toml', '[package]\nname = \"core\"\nversion = \"0.1.0\"\n');
    put(root, 'crates/core/src/lib.rs', 'pub fn value() -> i32 { 1 }\n');
    const profile = await inspect(root, ['rustc', 'cargo', 'rustfmt']);
    const workspace = projectAt(profile, '.');
    const crate = projectAt(profile, 'crates/core');
    assert.ok(workspace.projectTypes.includes('Rust (Cargo)'));
    assert.ok(crate.projectTypes.includes('Rust (Cargo)'));
    assert.ok(profile.relationships.some(item => item.from === '.' && item.to === 'crates/core' && item.kind === 'declared_workspace_member'));
    assert.ok(crate.commandPlans.some(plan => plan.command === 'cargo test --workspace'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Maven Java project produces commands only with verified JDK and Maven', async () => {
  const root = await fixture();
  try {
    put(root, 'pom.xml', '<project><modules><module>module-a</module></modules></project>\n');
    put(root, 'mvnw', '#!/bin/sh\n');
    put(root, 'src/main/java/Main.java', 'class Main {}\n');
    const profile = await inspect(root, ['java', 'javac', 'mvn']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Java (Maven)'));
    assert.ok(project.commandPlans.some(plan => plan.command === 'mvn -DskipTests package'));
    assert.ok(project.commandPlans.some(plan => plan.command === 'mvn test'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Gradle Java/Kotlin wrapper is recognized and wrapper commands include actual project path', async () => {
  const root = await fixture();
  try {
    put(root, 'settings.gradle.kts', 'rootProject.name = \"sample\"\ninclude(\":app\")\n');
    put(root, 'build.gradle.kts', 'plugins { kotlin(\"jvm\") version \"2.0.0\" }\n');
    put(root, 'gradlew.bat', '@echo off\n');
    put(root, 'src/main/kotlin/Main.kt', 'fun main() {}\n');
    put(root, 'src/main/java/JavaMain.java', 'class JavaMain {}\n');
    const profile = await inspect(root, ['java', 'javac']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Gradle'));
    assert.ok(project.projectTypes.includes('Kotlin (Gradle)'));
    const gradleBuild = project.commandPlans.find(plan => plan.kind === 'build');
    assert.ok(gradleBuild);
    assert.match(gradleBuild.command, /^\.[\\/]gradlew\.bat build$/);
    assert.equal(gradleBuild.toolchainVerified, true);
    assert.ok(project.commandPlans.some(plan => plan.kind === 'test' && /gradlew\.bat test$/.test(plan.command)));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Python pyproject and requirements projects distinguish interpreter from pytest', async () => {
  const root = await fixture();
  try {
    put(root, 'pyproject.toml', '[project]\nname = \"demo\"\n');
    put(root, 'tests/test_demo.py', 'def test_demo(): assert True\n');
    const profile = await inspect(root, ['python']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Python'));
    assert.equal(project.supportLevel, 'toolchain_available');
    assert.equal(project.commandPlans.some(plan => plan.kind === 'test'), false, 'pytest module is not assumed');
    const root2 = await fixture();
    try {
      put(root2, 'requirements-dev.txt', 'pytest>=8\n');
      put(root2, 'tests/test_demo.py', 'def test_demo(): assert True\n');
      const profile2 = await inspect(root2, ['python', 'pytest']);
      assert.ok(projectAt(profile2, '.').projectTypes.includes('Python'));
    } finally { await fs.promises.rm(root2, { recursive: true, force: true }); }
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Go module and go.work workspace are separately discovered', async () => {
  const root = await fixture();
  try {
    put(root, 'go.work', 'go 1.22\nuse (\n  ./services/api\n  ./services/worker\n)\n');
    put(root, 'services/api/go.mod', 'module example.com/api\n\ngo 1.22\n');
    put(root, 'services/api/main.go', 'package main\nfunc main() {}\n');
    put(root, 'services/worker/go.mod', 'module example.com/worker\n\ngo 1.22\n');
    put(root, 'services/worker/main.go', 'package main\nfunc main() {}\n');
    const profile = await inspect(root, ['go']);
    const workspace = projectAt(profile, '.');
    assert.ok(workspace.projectTypes.includes('Go'));
    assert.ok(profile.relationships.some(item => item.from === '.' && item.to === 'services/api' && item.kind === 'declared_workspace_member'));
    assert.equal(projectAt(profile, '.').commandPlans.some(plan => plan.kind === 'build' || plan.kind === 'test'), false, 'go.work alone is not a Go module root');
    assert.ok(projectAt(profile, 'services/api').commandPlans.some(plan => plan.command === 'go test ./...'));
    assert.ok(projectAt(profile, 'services/worker'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Node and TypeScript package scripts are derived from manifest script names and detected package manager', async () => {
  const root = await fixture();
  try {
    put(root, 'package.json', JSON.stringify({ name: 'web', packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run', build: 'tsc -b' } }));
    put(root, 'src/index.ts', 'export const answer: number = 42;\n');
    const profile = await inspect(root, ['node', 'pnpm']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Node.js'));
    assert.ok(project.languages.some(item => item.language === 'typescript'));
    assert.ok(project.commandPlans.some(plan => plan.command === 'pnpm test'));
    assert.ok(project.commandPlans.some(plan => plan.command === 'pnpm build'));
    assert.equal(project.commandPlans.some(plan => plan.command === 'npm run test'), false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('PHP, Ruby, Swift and Dart manifests produce distinct project types', async () => {
  const root = await fixture();
  try {
    put(root, 'php/composer.json', JSON.stringify({ name: 'demo/app', scripts: { test: 'phpunit' } }));
    put(root, 'ruby/Gemfile', 'source \"https://rubygems.org\"\n');
    put(root, 'ruby/app.gemspec', 'Gem::Specification.new\n');
    put(root, 'swift/Package.swift', '// swift-tools-version: 5.9\n');
    put(root, 'dart/pubspec.yaml', 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n');
    const profile = await inspect(root, ['php', 'composer', 'ruby', 'bundle', 'swift', 'dart', 'flutter']);
    assert.ok(projectAt(profile, 'php').projectTypes.includes('PHP / Composer'));
    assert.ok(projectAt(profile, 'ruby').projectTypes.includes('Ruby'));
    assert.ok(projectAt(profile, 'swift').projectTypes.includes('Swift / Xcode'));
    assert.ok(projectAt(profile, 'dart').projectTypes.includes('Dart / Flutter'));
    assert.ok(projectAt(profile, 'dart').metadata.flutter);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('malformed manifests remain detected but carry explicit parse errors', async () => {
  const root = await fixture();
  try {
    put(root, 'package.json', '{ invalid json');
    put(root, 'src/index.js', 'console.log(\"hi\");\n');
    const profile = await inspect(root, ['node']);
    const project = projectAt(profile, '.');
    assert.ok(project.projectTypes.includes('Node.js'));
    assert.ok(project.metadata.configErrors.some(item => item.path === 'package.json' && item.reason === 'malformed_json'));
    assert.equal(project.commandPlans.length, 0);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('monorepo detects multiple project roots without conflating their project command contexts', async () => {
  const root = await fixture();
  try {
    put(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/*'] }));
    put(root, 'apps/web/package.json', JSON.stringify({ name: 'web', scripts: { test: 'vitest' } }));
    put(root, 'apps/web/src/index.ts', 'export {};\n');
    put(root, 'apps/service/go.mod', 'module example.com/service\n');
    put(root, 'apps/service/main.go', 'package main\n');
    const profile = await inspect(root, ['node', 'npm', 'go']);
    assert.ok(profile.projects.length >= 3);
    assert.ok(profile.relationships.some(item => item.from === '.' && item.to === 'apps/web' && item.kind === 'declared_workspace_member'));
    assert.ok(projectAt(profile, 'apps/web').commandPlans.some(plan => plan.command === 'npm test'));
    assert.ok(projectAt(profile, 'apps/service').commandPlans.some(plan => plan.command === 'go build ./...'));
    assert.ok(profile.languages.some(item => item.language === 'typescript'));
    assert.ok(profile.languages.some(item => item.language === 'go'));
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('bounded scanning reports truncation and honours ignored folders and symlinks', async () => {
  const root = await fixture();
  try {
    put(root, 'CMakeLists.txt', 'project(test)\n');
    put(root, 'src/main.cpp', 'int main() {}\n');
    put(root, 'node_modules/ignore/index.js', 'this must not be indexed\n');
    for (let i = 0; i < 160; i++) put(root, `misc/file-${i}.txt`, 'x');
    const outside = await fixture('project-support-outside-');
    try {
      put(outside, 'src/escaped.cpp', 'int main() {}\n');
      try { fs.symlinkSync(outside, path.join(root, 'linked'), 'dir'); } catch { /* platform may disallow symlink creation */ }
      const profile = await inspect(root, ['cmake', 'g++'], { maxEntries: 100 });
      assert.equal(profile.scan.truncated, true);
      assert.equal(profile.scan.maxEntries, 100);
      assert.equal(JSON.stringify(profile).includes('node_modules/ignore'), false);
      assert.equal(JSON.stringify(profile).includes('linked/'), false);
    } finally { await fs.promises.rm(outside, { recursive: true, force: true }); }
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('reaching the exact scan-entry limit does not falsely mark a complete scan truncated', async () => {
  const root = await fixture();
  try {
    for (let index = 0; index < 100; index++) put(root, 'file-' + index + '.txt', 'x');
    const profile = await discoverWorkspaceProjects(root, {
      noCache: true, maxEntries: 100, maxProjects: 10, platform: 'linux',
      toolExecFileAsync: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    });
    assert.equal(profile.scan.entriesVisited, 100);
    assert.equal(profile.scan.truncated, false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('Windows command-shim package managers are version-probed with fixed arguments and shell disabled', async () => {
  const calls = [];
  const tools = await discoverToolchains(['javascript'], {
    platform: 'win32',
    noCache: true,
    environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    toolExecFileAsync: async (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      if (command === 'where.exe') {
        if (args[0] === 'npm') return { stdout: 'C:\\Program Files\\nodejs\\npm\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n' };
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      if (command === 'C:\\Windows\\System32\\cmd.exe') {
        assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
        assert.match(args[3], /^""C:\\Program Files\\nodejs\\npm\.cmd" "--version""$/);
        assert.equal(options.shell, false);
        return { stdout: '10.8.2\r\n', stderr: '' };
      }
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
  });
  const npm = tools.find(tool => tool.name === 'npm');
  assert.ok(npm && npm.usable);
  assert.equal(npm.path, 'C:\\Program Files\\nodejs\\npm.cmd');
  assert.equal(npm.version, '10.8.2');
  assert.ok(calls.some(call => call.command === 'C:\\Windows\\System32\\cmd.exe' && call.shell === false));
});

test('toolchain discovery reports unavailable executables and does not claim mocked paths are real', async () => {
  const missing = await discoverToolchains(['cpp', 'csharp'], {
    platform: 'linux', noCache: true, toolExecFileAsync: makeToolProbe([])
  });
  assert.ok(missing.some(tool => tool.name === 'cmake' && !tool.available && !tool.usable && tool.error === 'not_found'));
  const found = await discoverToolchains(['cpp'], {
    platform: 'linux', noCache: true, toolExecFileAsync: makeToolProbe(['cmake', 'g++'])
  });
  assert.ok(found.some(tool => tool.name === 'cmake' && tool.usable && tool.path === '/test-tool-bin/cmake'));
  assert.ok(found.every(tool => !tool.path || tool.path.startsWith('/test-tool-bin/')), 'all paths are explicitly test-double paths');
});

test('large project counts and public profiles stay bounded', async () => {
  const root = await fixture();
  try {
    for (let i = 0; i < 40; i++) {
      const name = `packages/p${String(i).padStart(2, '0')}`;
      put(root, `${name}/go.mod`, `module example.com/p${i}\n`);
      put(root, `${name}/main.go`, 'package main\n');
    }
    const profile = await inspect(root, ['go'], { maxProjects: 10 });
    assert.equal(profile.projects.length, 10);
    assert.equal(profile.scan.truncated, true);
    assert.equal(profile.scan.projectsDetected, 40);
    assert.equal(profile.scan.projectsReturned, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(profile)) < 100_000);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
