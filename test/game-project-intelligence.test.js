'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectGameProject } = require('../desktop/game-project-intelligence');

test('Unreal adapter extracts project modules, target types, dependencies and reflected declarations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unreal-intelligence-'));
  try {
    fs.mkdirSync(path.join(root, 'Source', 'Game'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Game.uproject'), JSON.stringify({ EngineAssociation: '5.5', Modules: [{ Name: 'Game', Type: 'Runtime' }], Plugins: [{ Name: 'GameplayAbilities', Enabled: true }] }));
    fs.writeFileSync(path.join(root, 'Source', 'Game', 'Game.Build.cs'), 'public class Game : ModuleRules { public Game(ReadOnlyTargetRules Target) { PublicDependencyModuleNames.AddRange(new string[] { \"Core\", \"Engine\" }); PrivateDependencyModuleNames.Add(\"GameplayTasks\"); } }');
    fs.writeFileSync(path.join(root, 'Source', 'Game', 'Game.Target.cs'), 'public class GameTarget : TargetRules { Type = TargetType.Game; ExtraModuleNames.Add(\"Game\"); }');
    fs.writeFileSync(path.join(root, 'Source', 'Game', 'Player.h'), ['#pragma once', 'UCLASS()', 'class APlayer : public AActor { GENERATED_BODY()', ' UPROPERTY(EditAnywhere) int Health;', ' UFUNCTION(BlueprintCallable) void Attack();', '};'].join('\n'));
    const report = inspectGameProject(root);
    assert.equal(report.primary_engine, 'unreal');
    assert.equal(report.adapters.unreal.modules[0].module, 'Game');
    assert.ok(report.adapters.unreal.modules[0].dependencies.includes('Core'));
    assert.equal(report.adapters.unreal.targets[0].target_type, 'Game');
    assert.ok(report.adapters.unreal.reflection.types.some(item => item.name === 'APlayer'));
    assert.equal(report.adapters.unreal.reflection.functions.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanner does not attempt to parse binary Unreal asset registry files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unreal-binary-'));
  try {
    fs.writeFileSync(path.join(root, 'Game.uproject'), '{}');
    fs.writeFileSync(path.join(root, 'AssetRegistry.bin'), Buffer.from([0, 255, 0, 255]));
    const report = inspectGameProject(root);
    assert.equal(report.adapters.unreal.assets.binary_registry_present, true);
    assert.match(report.adapters.unreal.assets.binary_handling, /not parsed or rewritten/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Unity and Godot metadata adapters recognize their project manifests', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-multi-engine-'));
  try {
    fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.unity.inputsystem': '1.8.0' } }));
    fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.0f1');
    const report = inspectGameProject(root);
    assert.equal(report.primary_engine, 'unity');
    assert.ok(report.adapters.unity.package_manifest.dependencies['com.unity.inputsystem']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
