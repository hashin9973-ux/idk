'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {normalizeLocalTtsSettings,measureResources,PYTHON_WORKER_SOURCE}=require('../desktop/local-tts');

test('local Piper defaults to disabled with a conservative CPU and free-RAM guard',()=>{
  assert.deepEqual(normalizeLocalTtsSettings(),{enabled:false,resourceGuardEnabled:true,allowModelDownload:false,pageIdleEnabled:false,pageIdleDelaySeconds:60,maxCpuPercent:75,minFreeRamGb:2});
});
test('local Piper settings clamp thresholds and reject non-finite values',()=>{
  assert.deepEqual(normalizeLocalTtsSettings({enabled:true,resourceGuardEnabled:false,maxCpuPercent:120,minFreeRamGb:0.1}),{
    enabled:true,resourceGuardEnabled:false,allowModelDownload:false,pageIdleEnabled:false,pageIdleDelaySeconds:60,maxCpuPercent:100,minFreeRamGb:0.5
  });
  assert.deepEqual(normalizeLocalTtsSettings({maxCpuPercent:'bad',minFreeRamGb:NaN}),{
    enabled:false,resourceGuardEnabled:true,allowModelDownload:false,pageIdleEnabled:false,pageIdleDelaySeconds:60,maxCpuPercent:75,minFreeRamGb:2
  });
});
test('resource sampling reports bounded CPU and memory values',async()=>{
  const result=await measureResources();
  assert.ok(result.cpu_percent>=0&&result.cpu_percent<=100);
  assert.ok(result.free_ram_gb>=0);
  assert.ok(result.total_ram_gb>=result.free_ram_gb);
});


test('persistent Piper worker source is valid Python',t=>{
  const result=spawnSync('python',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{
    input:PYTHON_WORKER_SOURCE,encoding:'utf8',windowsHide:true
  });
  if(result.error&&result.error.code==='ENOENT')return t.skip('Python is not installed in this test environment.');
  assert.equal(result.status,0,result.stderr||result.error&&result.error.message||'Python worker source failed to compile.');
});

test('local Piper model download and idle paging are opt-in',()=>{
  assert.deepEqual(normalizeLocalTtsSettings(),{enabled:false,resourceGuardEnabled:true,allowModelDownload:false,pageIdleEnabled:false,pageIdleDelaySeconds:60,maxCpuPercent:75,minFreeRamGb:2});
  assert.deepEqual(normalizeLocalTtsSettings({allowModelDownload:true,pageIdleEnabled:true,pageIdleDelaySeconds:1}),{enabled:false,resourceGuardEnabled:true,allowModelDownload:true,pageIdleEnabled:true,pageIdleDelaySeconds:10,maxCpuPercent:75,minFreeRamGb:2});
});
