'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeLocalTtsSettings,measureResources}=require('../desktop/local-tts');

test('local Piper defaults to disabled with a conservative CPU and free-RAM guard',()=>{
  assert.deepEqual(normalizeLocalTtsSettings(),{enabled:false,resourceGuardEnabled:true,maxCpuPercent:75,minFreeRamGb:2});
});
test('local Piper settings clamp thresholds and reject non-finite values',()=>{
  assert.deepEqual(normalizeLocalTtsSettings({enabled:true,resourceGuardEnabled:false,maxCpuPercent:120,minFreeRamGb:0.1}),{
    enabled:true,resourceGuardEnabled:false,maxCpuPercent:100,minFreeRamGb:0.5
  });
  assert.deepEqual(normalizeLocalTtsSettings({maxCpuPercent:'bad',minFreeRamGb:NaN}),{
    enabled:false,resourceGuardEnabled:true,maxCpuPercent:75,minFreeRamGb:2
  });
});
test('resource sampling reports bounded CPU and memory values',async()=>{
  const result=await measureResources();
  assert.ok(result.cpu_percent>=0&&result.cpu_percent<=100);
  assert.ok(result.free_ram_gb>=0);
  assert.ok(result.total_ram_gb>=result.free_ram_gb);
});
