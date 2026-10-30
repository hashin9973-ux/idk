'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createExecutionScheduler}=require('../desktop/execution-scheduler');
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
test('overlapping writes serialize while independent work can share scheduler capacity',async()=>{const scheduler=createExecutionScheduler({maxActive:4}),aGate=gate(),bGate=gate(),started=[];try{const a=scheduler.run({reads:[],writes:['src/a.js'],resources:[],barrier:false},async()=>{started.push('a');await aGate.promise;return'a';},{id:'a',tool:'write_file'});const b=scheduler.run({reads:[],writes:['src/a.js'],resources:[],barrier:false},async()=>{started.push('b');await bGate.promise;return'b';},{id:'b',tool:'write_file'});const c=scheduler.run({reads:['*'],writes:[],resources:[],barrier:false},async()=>{started.push('c');},{id:'c',tool:'search'});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['a','c']);aGate.resolve();assert.equal(await a,'a');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['a','c','b']);bGate.resolve();assert.equal(await b,'b');await c;assert.equal(scheduler.getState().completed,3);}finally{await scheduler.stop();}});
test('barrier operations wait for active work and prevent later starts',async()=>{const scheduler=createExecutionScheduler({maxActive:3}),readGate=gate(),barrierGate=gate(),started=[];try{const a=scheduler.run({reads:['*'],writes:[],resources:[],barrier:false},async()=>{started.push('read');await readGate.promise;},{id:'read',tool:'search'});const b=scheduler.run({reads:[],writes:[],resources:[],barrier:true},async()=>{started.push('barrier');await barrierGate.promise;},{id:'barrier',tool:'shell'});const c=scheduler.run({reads:[],writes:['x'],resources:[],barrier:false},async()=>{started.push('write');},{id:'write',tool:'write_file'});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['read']);readGate.resolve();await a;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['read','barrier']);barrierGate.resolve();await b;await c;assert.deepEqual(started,['read','barrier','write']);}finally{await scheduler.stop();}});

test('shared project-index readers may run together but an index refresh waits for them',async()=>{
 const scheduler=createExecutionScheduler({maxActive:4}),gateA=gate(),startedBoth=gate(),release=gate(),started=[];
 try{
  const read1=scheduler.run({resourceReads:['project-index:C:/work/app']},async()=>{started.push('read1');if(started.length===2)startedBoth.resolve();await release.promise;},{id:'read1',tool:'project_search'});
  const read2=scheduler.run({resourceReads:['project-index:C:/work/app']},async()=>{started.push('read2');if(started.length===2)startedBoth.resolve();await release.promise;},{id:'read2',tool:'project_overview'});
  await startedBoth.promise;
  const refresh=scheduler.run({resourceWrites:['project-index:C:/work/app']},async()=>{started.push('refresh');},{id:'refresh',tool:'project_index_refresh'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,['read1','read2']);
  release.resolve();
  await Promise.all([read1,read2,refresh]);
  assert.deepEqual(started,['read1','read2','refresh']);
 }finally{await scheduler.stop();}
});

test('queued cancellation rejects the task without invoking its operation',async()=>{
 const scheduler=createExecutionScheduler({maxActive:1}),block=gate(),started=[];
 try{
  const active=scheduler.run({reads:['*']},async()=>{started.push('active');await block.promise;},{id:'active'});
  const queued=scheduler.run({writes:['a']},async()=>{started.push('queued');},{id:'queued'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scheduler.cancel('queued','no longer needed'),true);
  await assert.rejects(queued,error=>error.code==='ABORT_ERR');
  block.resolve();await active;
  assert.deepEqual(started,['active']);
  assert.equal(scheduler.getState().cancelled,1);
 }finally{await scheduler.stop();}
});

test('active cancellation propagates AbortSignal and shutdown drains cooperative work',async()=>{
 const scheduler=createExecutionScheduler({maxActive:1,shutdownTimeoutMs:1000}),started=gate(),seen=[];
 const active=scheduler.run({resources:['desktop']},async({signal})=>{
  started.resolve();
  await new Promise((resolve,reject)=>{
   if(signal.aborted){reject(signal.reason);return;}
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 },{id:'active-cancel'});
 await started.promise;
 assert.equal(scheduler.cancel('active-cancel','cancel active work'),true);
 await assert.rejects(active,error=>error.code==='ABORT_ERR');
 assert.equal(scheduler.getState().cancelled,1);

 const runningStarted=gate();
 const running=scheduler.run({barrier:true},async({signal})=>{
  runningStarted.resolve();
  await new Promise((resolve,reject)=>{
   if(signal.aborted){reject(signal.reason);return;}
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 },{id:'shutdown-active'});
 const queued=scheduler.run({reads:['x']},async()=>{seen.push('unexpected');},{id:'shutdown-queued'});
 await runningStarted.promise;
 const stopped=await scheduler.stop({timeoutMs:1000});
 await assert.rejects(running,error=>error.code==='ABORT_ERR');
 await assert.rejects(queued,error=>error.code==='ABORT_ERR');
 assert.deepEqual(seen,[]);
 assert.deepEqual(stopped,{stopped:true,drained:true,activeRemaining:0,queued:0});
});

test('an already-aborted signal rejects immediately without enqueuing',async()=>{
 const scheduler=createExecutionScheduler({maxActive:1}),controller=new AbortController(),started=[];
 controller.abort(new Error('cancelled before enqueue'));
 try{
  await assert.rejects(scheduler.run({reads:['*']},async()=>{started.push(true);},{id:'pre-aborted',signal:controller.signal}),error=>error.code==='ABORT_ERR');
  assert.equal(scheduler.getState().queued,0);assert.deepEqual(started,[]);
 }finally{await scheduler.stop();}
});
