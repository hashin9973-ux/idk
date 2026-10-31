'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED = new Set(['.git', 'node_modules', 'Binaries', 'Intermediate', 'DerivedDataCache', 'Library', 'Temp', 'obj', 'bin', '.bridge-worktrees']);
const MAX_FILES = 25000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function listFiles(root, limit = MAX_FILES) {
  const files = [];
  let truncated = false;
  function walk(dir, depth) {
    if (depth > 24 || files.length >= limit) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile()) {
        files.push(path.relative(root, absolute).replace(/\\/g, '/'));
        if (files.length >= limit) { truncated = true; return; }
      }
      if (truncated) return;
    }
  }
  walk(root, 0);
  return { files, truncated };
}
function readText(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return '';
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
    const bytes = fs.readFileSync(target);
    if (bytes.includes(0)) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return ''; }
}
function inspectUnreal(root, files) {
  const projectFiles = files.filter(file => /\.uproject$/i.test(file));
  const plugins = files.filter(file => /\.uplugin$/i.test(file));
  const buildFiles = files.filter(file => /(?:^|\/)[^/]+\.Build\.cs$/i.test(file));
  const targetFiles = files.filter(file => /(?:^|\/)[^/]+\.Target\.cs$/i.test(file));
  const headers = files.filter(file => /\.(?:h|hpp|inl)$/i.test(file));
  const assetRegistryExports = files.filter(file => /(?:^|\/)(?:AssetRegistry|asset-registry)\.json$/i.test(file));
  const binaryAssetRegistry = files.filter(file => /(?:^|\/)AssetRegistry\.bin$/i.test(file));
  const projectRecords = projectFiles.map(file => {
    const json = readJson(path.join(root, file)) || {};
    return { path: file, file_name: json.FileVersion || null, engine_association: json.EngineAssociation || null,
      modules: Array.isArray(json.Modules) ? json.Modules.map(item => ({ name: item.Name, type: item.Type, loading_phase: item.LoadingPhase })) : [],
      plugins: Array.isArray(json.Plugins) ? json.Plugins.map(item => ({ name: item.Name, enabled: item.Enabled !== false })) : [] };
  });
  const pluginRecords = plugins.map(file => {
    const json = readJson(path.join(root, file)) || {};
    return { path: file, name: json.FriendlyName || json.Name || path.basename(file, '.uplugin'),
      version: json.VersionName || null, modules: Array.isArray(json.Modules) ? json.Modules.map(item => ({ name: item.Name, type: item.Type })) : [],
      dependencies: Array.isArray(json.Plugins) ? json.Plugins.filter(item => item.Enabled !== false).map(item => item.Name) : [] };
  });
  const modules = buildFiles.map(file => {
    const source = readText(root, file);
    const match = source.match(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*ModuleRules/);
    const deps = [];
    for (const dep of source.matchAll(/(?:Public|Private|DynamicallyLoaded)DependencyModuleNames\s*\.\s*Add(?:Range)?\s*\(?\s*(?:new\s+string\s*\[\]\s*)?\s*\{([^}]*)\}/g)) {
      for (const name of dep[1].matchAll(/["']([A-Za-z0-9_]+)["']/g)) deps.push(name[1]);
    }
    return { path: file, module: match ? match[1] : path.basename(file, '.Build.cs'), dependencies: [...new Set(deps)].sort(),
      public_dependencies: [...new Set([...source.matchAll(/PublicDependencyModuleNames[\s\S]{0,800}?Add(?:Range)?\s*\(?\s*["']([A-Za-z0-9_]+)["']/g)].map(item => item[1]))].sort(),
      private_dependencies: [...new Set([...source.matchAll(/PrivateDependencyModuleNames[\s\S]{0,800}?Add(?:Range)?\s*\(?\s*["']([A-Za-z0-9_]+)["']/g)].map(item => item[1]))].sort() };
  });
  const targets = targetFiles.map(file => {
    const source = readText(root, file);
    const target = source.match(/TargetType\.([A-Za-z]+)/);
    return { path: file, target_name: path.basename(file, '.Target.cs'), target_type: target ? target[1] : null,
      extra_modules: [...new Set([...source.matchAll(/ExtraModuleNames\s*\.\s*Add\s*\(\s*["']([^"']+)["']/g)].map(item => item[1]))] };
  });
  const reflectedTypes = [];
  const reflectedFunctions = [];
  const reflectedProperties = [];
  let generatedBodyCount = 0;
  for (const file of headers) {
    const source = readText(root, file);
    generatedBodyCount += (source.match(/GENERATED_BODY\s*\(/g) || []).length;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (/\bUCLASS\s*\(/.test(line) || /\bUSTRUCT\s*\(/.test(line) || /\bUENUM\s*\(/.test(line)) {
        const kind = line.includes('UCLASS') ? 'class' : line.includes('USTRUCT') ? 'struct' : 'enum';
        let declaration = lines.slice(index + 1, Math.min(lines.length, index + 5)).join(' ');
        declaration = declaration.replace(/^\s*UCLASS[^)]*\)\s*/, '');
        const match = declaration.match(/(?:class|struct|enum(?:\s+class)?)\s+(?:[A-Z0-9_]+\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
        reflectedTypes.push({ path: file, line: index + 1, kind, name: match ? match[1] : null });
      }
      if (/\bUFUNCTION\s*\(/.test(line)) reflectedFunctions.push({ path: file, line: index + 1, declaration: lines[index + 1] ? lines[index + 1].trim().slice(0, 220) : '' });
      if (/\bUPROPERTY\s*\(/.test(line)) reflectedProperties.push({ path: file, line: index + 1, declaration: lines[index + 1] ? lines[index + 1].trim().slice(0, 220) : '' });
    }
  }
  const registry = assetRegistryExports.map(file => {
    const json = readJson(path.join(root, file));
    if (!json) return { path: file, readable: false, note: 'Asset Registry export could not be parsed as bounded JSON.' };
    const rows = Array.isArray(json.assets) ? json.assets : Array.isArray(json.Assets) ? json.Assets : [];
    return { path: file, readable: true, assets: rows.slice(0, 2000).map(asset => ({
      object_path: asset.object_path || asset.ObjectPath || asset.objectPath || null,
      class: asset.class || asset.Class || null,
      package: asset.package || asset.PackageName || null,
      references: Array.isArray(asset.references) ? asset.references.slice(0, 100) : []
    })) };
  });
  return {
    engine: 'unreal', detected: projectFiles.length > 0, project_files: projectRecords,
    plugins: pluginRecords, modules, targets,
    reflection: { types: reflectedTypes.slice(0, 5000), functions: reflectedFunctions.slice(0, 5000),
      properties: reflectedProperties.slice(0, 5000), generated_body_count: generatedBodyCount },
    assets: { registry_exports: registry, binary_registry_present: binaryAssetRegistry.length > 0,
      binary_handling: 'Binary .uasset/.umap/AssetRegistry.bin files are not parsed or rewritten. Use Unreal Asset Registry/UHT/UBT tooling or a JSON export for authoritative references.' },
    confidence: 'Metadata and C++ reflection macros are extracted lexically. UHT/UBT, Blueprint graphs, generated code, redirects, soft references, and full asset dependency resolution require Unreal-native tooling.'
  };
}
function inspectUnity(root, files) {
  const manifests = files.filter(file => file === 'Packages/manifest.json');
  const asmdefs = files.filter(file => /\.asmdef$/i.test(file));
  const scenes = files.filter(file => /\.unity$/i.test(file));
  const scripts = files.filter(file => /\.cs$/i.test(file));
  const packageManifest = manifests.length ? readJson(path.join(root, manifests[0])) : null;
  const assemblies = asmdefs.map(file => {
    const json = readJson(path.join(root, file)) || {};
    return { path: file, name: json.name || path.basename(file, '.asmdef'),
      references: Array.isArray(json.references) ? json.references : [],
      include_platforms: json.includePlatforms || [], exclude_platforms: json.excludePlatforms || [] };
  });
  const guidMap = {};
  for (const meta of files.filter(file => /\.meta$/i.test(file))) {
    const text = readText(root, meta);
    const guid = text.match(/^\s*guid:\s*([a-f0-9]{32})\s*$/mi);
    if (guid) guidMap[guid[1]] = meta.slice(0, -5);
  }
  const references = [];
  for (const scene of scenes.slice(0, 500)) {
    const source = readText(root, scene);
    for (const match of source.matchAll(/guid:\s*([a-f0-9]{32})/g)) references.push({ scene, guid: match[1], asset_path: guidMap[match[1]] || null });
  }
  return { engine: 'unity', detected: manifests.length > 0 || files.some(file => /(?:^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(file)),
    package_manifest: packageManifest ? { path: manifests[0], dependencies: packageManifest.dependencies || {} } : null,
    assemblies, scripts: scripts.length, scenes: scenes.length, references: references.slice(0, 5000),
    confidence: 'Assembly definitions and serialized GUID references are discovered. Runtime/editor-generated relationships and binary assets require Unity tooling.' };
}
function inspectGodot(root, files) {
  const configPath = files.find(file => file.toLowerCase() === 'project.godot');
  const sourceFiles = files.filter(file => /\.(?:gd|tscn|tres)$/i.test(file));
  const config = configPath ? readText(root, configPath) : '';
  const autoload = [];
  let section = '';
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    if (section === 'autoload') {
      const entry = line.match(/^\s*([^#=\s]+)\s*=\s*(.+?)\s*$/);
      if (entry) autoload.push({ name: entry[1], resource: entry[2].replace(/^["']|["']$/g, '') });
    }
  }
  return { engine: 'godot', detected: Boolean(configPath), project_config: configPath || null,
    autoload, source_and_scene_files: sourceFiles.length,
    confidence: 'project.godot autoloads and text scene/resource files are discovered; imported resources and runtime references may require Godot editor tooling.' };
}
function inspectGameProject(rootInput, options = {}) {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Game project workspace directory is unavailable.');
  const limit = Number.isInteger(options.maxFiles) ? Math.min(Math.max(options.maxFiles, 100), MAX_FILES) : MAX_FILES;
  const scan = listFiles(root, limit);
  const unreal = inspectUnreal(root, scan.files);
  const unity = inspectUnity(root, scan.files);
  const godot = inspectGodot(root, scan.files);
  const detected = [unreal, unity, godot].filter(item => item.detected);
  const primary = detected.length === 1 ? detected[0].engine : detected.length > 1 ? 'multiple' : 'custom';
  return {
    protocol: 'chatgpt-local-game-project-intelligence/v1',
    workspace: root, primary_engine: primary, detected_engines: detected.map(item => item.engine),
    scan: { files_examined: scan.files.length, truncated: scan.truncated, file_limit: limit },
    adapters: { unreal, unity, godot },
    custom_engine: { detected: detected.length === 0, note: 'Custom-engine support uses the generic local project index until a project-specific adapter is registered.' },
    limitations: ['This is read-only metadata discovery, not an Unreal Build Tool, Unreal Header Tool, Unity Editor, or Godot runtime replacement.',
      'Binary asset formats are never interpreted as UTF-8 or modified by this scanner.',
      'Use engine-native commands for authoritative builds, cooking, packaging, runtime validation, Blueprint graph analysis, and binary asset reference resolution.']
  };
}

module.exports = { inspectGameProject, inspectUnreal, inspectUnity, inspectGodot, MAX_FILES, MAX_FILE_BYTES };