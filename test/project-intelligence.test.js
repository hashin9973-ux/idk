'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createProjectIntelligence,tokenize,extractSymbols,extractImports}=require('../desktop/project-intelligence');
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'project-intelligence-'));await fs.mkdir(path.join(root,'src'),{recursive:true});await fs.mkdir(path.join(root,'tests'),{recursive:true});await fs.mkdir(path.join(root,'node_modules','vendor'),{recursive:true});await fs.writeFile(path.join(root,'src','service.js'),"import { helper } from './helper';\nexport class ProjectService { runTask() { return helper(); } }\n");await fs.writeFile(path.join(root,'src','helper.js'),"export function helper() { return 'ok'; }\n");await fs.writeFile(path.join(root,'tests','service.test.js'),"import { ProjectService } from '../src/service';\ntest('service', () => new ProjectService());\n");await fs.writeFile(path.join(root,'.env'),'SHOULD_NOT_BE_INDEXED=yes\n');await fs.writeFile(path.join(root,'node_modules','vendor','hidden.js'),'export function hiddenDependency() {}\n');return root;}
test('tokenizer and language-aware symbol/import extraction work',()=>{assert.deepEqual(tokenize('ProjectService runTask'),['project','service','run','task']);const found=extractSymbols('export class Service {}\nexport function runTask() {}','javascript');assert.ok(found.some(x=>x.name==='Service'&&x.kind==='class'));assert.ok(found.some(x=>x.name==='runTask'&&x.kind==='function'));assert.deepEqual(extractImports("import x from './local';",'javascript'),['./local']);});
test('local project index persists metadata, ranks symbols, and follows relative dependencies',async()=>{const root=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-cache-')),service=createProjectIntelligence({storageDirectory:storage,watch:false});try{await service.start(root);const overview=await service.overview(root);assert.equal(overview.indexedFiles,3);assert.ok(overview.symbolCount>=2);const result=await service.search(root,{query:'ProjectService',kind:'symbol'});assert.equal(result.count,1);assert.equal(result.matches[0].path,'src/service.js');const impact=await service.impact(root,{path:'src/helper.js'});assert.ok(impact.directAndTransitiveDependents.includes('src/service.js'));assert.ok(impact.affectedTestCandidates.includes('tests/service.test.js'));assert.equal(JSON.stringify(overview).includes('SHOULD_NOT_BE_INDEXED'),false);const next=createProjectIntelligence({storageDirectory:storage,watch:false});try{const cached=await next.status(root);assert.equal(cached.filesIndexed,3);const search=await next.search(root,{query:'runTask',kind:'symbol'});assert.equal(search.count,1);}finally{await next.stop();}}finally{await service.stop();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage,{recursive:true,force:true});}});
test('refresh detects changes and ignores generated and secret-like files',async()=>{const root=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-refresh-')),service=createProjectIntelligence({storageDirectory:storage,watch:false});try{await service.start(root);await fs.writeFile(path.join(root,'src','helper.js'),'export function replacementSymbol() { return 2; }\n');await fs.writeFile(path.join(root,'src','extra.ts'),'export interface ExtraContract { value: string }\n');await service.refresh(root);const result=await service.search(root,{query:'replacementSymbol',kind:'symbol'});assert.equal(result.count,1);const overview=await service.overview(root);assert.equal(overview.indexedFiles,4);assert.ok(overview.languages.some(x=>x.language==='typescript'));}finally{await service.stop();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage,{recursive:true,force:true});}});

test('index reports configured file-count truncation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-budget-')),storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-budget-cache-'));
 const service=createProjectIntelligence({storageDirectory:storage,watch:false,maxFiles:100,maxEntries:1000,maxTotalBytes:1024*1024});
 try{
  for(let i=0;i<101;i++)await fs.writeFile(path.join(root,'file-'+String(i).padStart(3,'0')+'.js'),'export function symbol'+i+'() { return '+i+'; }\\n');
  await service.start(root);const status=await service.status(root);
  assert.equal(status.filesIndexed,100);assert.equal(status.truncated,true);
  assert.ok(status.incompleteReasons.includes('file_count_limit'));
  assert.equal(status.lastScan.indexedFiles,100);assert.equal(status.lastScan.truncated,true);
 }finally{await service.stop();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage,{recursive:true,force:true});}
});

test('cache restoration rejects unsafe paths and malformed document metadata',async()=>{
 const crypto=require('node:crypto'),root=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-cache-validation-'));
 const absolute=path.resolve(root).replace(/\\\\/g,'/'),key=crypto.createHash('sha256').update(process.platform==='win32'?absolute.toLowerCase():absolute).digest('hex');
 try{
  await fs.writeFile(path.join(storage,'project-index-'+key+'.json'),JSON.stringify({version:2,rootKey:key,documents:[{path:'../outside.js',extension:'.js',language:'javascript',size:10,mtimeMs:1,ctimeMs:1,terms:[],symbols:[],imports:[]}]}));
  const service=createProjectIntelligence({storageDirectory:storage,watch:false});
  try{
   await service.start(root);const found=await service.search(root,{query:'ProjectService',kind:'symbol'});
   assert.equal(found.count,1);assert.equal(found.matches[0].path,'src/service.js');
   assert.equal(JSON.stringify(found).includes('outside.js'),false);
  }finally{await service.stop();}
 }finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(storage,{recursive:true,force:true});}
});

test('full refresh removes deleted paths and keeps a complete index after ordinary edits',async()=>{
 const root=await fixture(),storage=await fs.mkdtemp(path.join(os.tmpdir(),'project-index-delete-')),service=createProjectIntelligence({storageDirectory:storage,watch:false});
 try{
  await service.start(root);await fs.rm(path.join(root,'src','helper.js'));await service.refresh(root);
  const search=await service.search(root,{query:'helper',kind:'file'});
  assert.equal(search.count,0);const overview=await service.overview(root);
  assert.equal(overview.indexedFiles,2);assert.equal(overview.index.truncated,false);
 }finally{await service.stop();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage,{recursive:true,force:true});}
});
