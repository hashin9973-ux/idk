'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const VERSION=2,MAX_FILES=50000,MAX_ENTRIES=250000,MAX_BYTES=1024*1024*1024,MAX_FILE=1024*1024,MAX_CACHE_BYTES=256*1024*1024,MAX_SEARCH_POSTINGS=250000;
const IGNORED=new Set(['.git','.hg','.svn','.idea','.vscode','.bridge-worktrees','node_modules','bower_components','.venv','venv','env','dist','build','out','coverage','.next','.nuxt','.cache','.turbo','target','bin','obj','__pycache__','.pytest_cache','.mypy_cache','.gradle','.terraform','vendor','pods','.angular']);
const LANG=Object.freeze({'.js':'javascript','.jsx':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.tsx':'typescript','.mts':'typescript','.cts':'typescript','.py':'python','.pyi':'python','.go':'go','.rs':'rust','.java':'java','.kt':'kotlin','.kts':'kotlin','.cs':'csharp','.cpp':'cpp','.cc':'cpp','.cxx':'cpp','.c':'c','.h':'c','.hpp':'cpp','.hh':'cpp','.php':'php','.rb':'ruby','.swift':'swift','.vue':'vue','.svelte':'svelte','.md':'markdown','.mdx':'markdown','.json':'json','.yaml':'yaml','.yml':'yaml','.toml':'toml','.sql':'sql','.sh':'shell','.ps1':'powershell'});
function rel(v){return String(v||'').replace(/\\/g,'/').replace(/^\.\/+/, '').replace(/\/+$/,'');}
function inside(root,target){const r=path.relative(root,target);return r===''||(r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));}
function keyFor(root){let v=path.resolve(root).replace(/\\/g,'/');if(process.platform==='win32')v=v.toLowerCase();return crypto.createHash('sha256').update(v).digest('hex');}
function driveRoot(root){const v=path.resolve(root);return v.toLowerCase()===path.parse(v).root.toLowerCase();}
function sensitive(p){return rel(p).split('/').some(s=>{s=s.toLowerCase();return /^\.env(?:\.|$)/.test(s)||/(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|password|passwords|private[-_]?keys?)(?:[._-]|$)/.test(s)||/^(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/.test(s)||/\.(?:pem|key|p12|pfx|jks|keystore|p8|mobileprovision)$/.test(s);});}
function tokenize(v){return String(v||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').toLowerCase().match(/[a-z0-9_$]{2,}/g)||[];}
function unique(values,limit){const out=[],seen=new Set();for(const v of values){const t=String(v||'').toLowerCase();if(t.length<2||t.length>80||seen.has(t))continue;seen.add(t);out.push(t);if(out.length>=limit)break;}return out;}
function lineAt(s,n){let line=1;for(let i=0;i<n;i++)if(s.charCodeAt(i)===10)line++;return line;}
function symbols(s,lang){
 const p=[
 ['function',/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g],
 ['class',/\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g],
 ['interface',/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g],
 ['type',/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g],
 ['enum',/\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g],
 ['function',/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm],
 ['class',/^\s*class\s+([A-Za-z_]\w*)\b/gm],
 ['function',/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g],
 ['function',/\bfn\s+([A-Za-z_]\w*)\s*[<(]/g],
 ['type',/\b(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g],
 ['declaration',/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/g]
 ];
 const chosen=lang==='python'?[p[5],p[6]]:lang==='go'?[p[7]]:lang==='rust'?[p[8],p[9]]:['javascript','typescript','vue','svelte'].includes(lang)?[p[0],p[1],p[2],p[3],p[4],p[10]]:[p[0],p[1],p[2],p[4]];
 const out=[],seen=new Set();for(const [kind,re] of chosen){re.lastIndex=0;let m;while((m=re.exec(s))&&out.length<160){if(m[1].length>200){if(!m[0].length)re.lastIndex++;continue;}const id=kind+':'+m[1];if(!seen.has(id)){seen.add(id);out.push({name:m[1],kind,line:lineAt(s,m.index)});}if(!m[0].length)re.lastIndex++;}}
 return out.sort((a,b)=>a.line-b.line||a.name.localeCompare(b.name));
}
function imports(s,lang){
 const patterns=lang==='python'?[/^\s*(?:from|import)\s+([.\w]+)/gm]:lang==='rust'?[/^\s*use\s+([\w:]+)/gm,/\bmod\s+([A-Za-z_]\w*)/g]:[/\bfrom\s+['"]([^'"]+)['"]/g,/\bimport\s+['"]([^'"]+)['"]/g,/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
 const out=[],seen=new Set();for(const re of patterns){re.lastIndex=0;let m;while((m=re.exec(s))&&out.length<80){const v=String(m[1]||'').trim();if(v&&v.length<=2048&&!seen.has(v)){seen.add(v);out.push(v);}if(!m[0].length)re.lastIndex++;}}return out;
}
function makeDoc(p,st,b){const ext=path.posix.extname(p).toLowerCase(),language=LANG[ext];if(!language||b.includes(0))return null;let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return null;}const syms=symbols(source,language),imps=imports(source,language),ids=(source.match(/[A-Za-z_$][A-Za-z0-9_$]{1,}/g)||[]).slice(0,5000);return{path:p,extension:ext,language,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs,terms:unique([...tokenize(path.posix.basename(p)),...tokenize(p),...syms.flatMap(x=>tokenize(x.name)),...imps.flatMap(tokenize),...ids.flatMap(tokenize)],220),symbols:syms,imports:imps};}
function resolveImport(from,spec,map){if(!spec.startsWith('.'))return null;const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec)),ext=path.posix.extname(base),extensions=Object.keys(LANG);const tries=ext?[base,base+'/index']:[base,...extensions.map(x=>base+x),...extensions.map(x=>base+'/index'+x)];for(const p of tries){const hit=map.get(p.toLowerCase());if(hit)return hit;}return null;}
function graph(docs){const paths=new Map();for(const d of docs.values())paths.set(d.path.toLowerCase(),d.path);const reverse=new Map();let edges=0;for(const d of docs.values())for(const spec of d.imports){const to=resolveImport(d.path,spec,paths);if(!to||to===d.path)continue;const k=to.toLowerCase();if(!reverse.has(k))reverse.set(k,new Set());reverse.get(k).add(d.path);edges++;}return{reverse,edges};}
function createProjectIntelligence(options={}){
 const storage=options.storageDirectory?path.resolve(options.storageDirectory):'',maxFiles=Number.isInteger(options.maxFiles)?Math.max(100,Math.min(options.maxFiles,200000)):MAX_FILES,maxEntries=Number.isInteger(options.maxEntries)?Math.max(1000,Math.min(options.maxEntries,1000000)):MAX_ENTRIES,maxBytes=Number.isInteger(options.maxTotalBytes)?Math.max(MAX_FILE,Math.min(options.maxTotalBytes,MAX_BYTES*4)):MAX_BYTES,reconcileMs=Number.isInteger(options.reconcileMs)?Math.max(30000,options.reconcileMs):300000,onUpdate=typeof options.onUpdate==='function'?options.onUpdate:()=>{},states=new Map();let primary=null,stopped=false;
 function view(s){return{status:s.error?'error':s.refreshing?(s.documents.size?'updating':'indexing'):s.loaded?'ready':'starting',filesIndexed:s.documents.size,symbolsIndexed:s.symbolCount,dependencyEdges:s.edgeCount,totalIndexedBytes:s.indexedBytes,truncated:s.truncated,incompleteReasons:[...(s.incompleteReasons||[])].sort(),driveRootShallow:s.drive,watcherActive:!!s.watcher,generatedAt:s.generatedAt,lastFullScanAt:s.lastFullScanAt,refreshDurationMs:s.durationMs,progress:s.progress||{entries:0,files:0,bytes:0},cacheWarning:s.cacheWarning||null,error:s.error||null};}
 function emit(s){try{onUpdate(view(s));}catch{}}
 function rebuild(s){s.terms=new Map();s.symbolMap=new Map();s.symbolCount=0;s.indexedBytes=0;for(const d of s.documents.values()){s.indexedBytes+=d.size;s.symbolCount+=d.symbols.length;for(const t of d.terms){if(!s.terms.has(t))s.terms.set(t,new Set());s.terms.get(t).add(d.path);}for(const x of d.symbols){const k=x.name.toLowerCase();if(!s.symbolMap.has(k))s.symbolMap.set(k,[]);s.symbolMap.get(k).push({path:d.path,...x});}}const g=graph(s.documents);s.reverse=g.reverse;s.edgeCount=g.edges;}
 function abortError(reason){const error=reason instanceof Error?reason:new Error(String(reason||'Operation cancelled.'));if(!error.code)error.code='ABORT_ERR';if(error.name==='Error')error.name='AbortError';return error;}
 function throwIfAborted(signal){if(stopped)throw abortError('Project intelligence is stopping.');if(signal&&signal.aborted)throw abortError(signal.reason||'Project-index operation cancelled.');}
 function markIncomplete(s,reason){s.truncated=true;if(!s.incompleteReasons)s.incompleteReasons=new Set();s.incompleteReasons.add(reason);}
 function validCachedDocument(s,d){
  if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.path!=='string'||d.path.length>2048)return false;
  const p=rel(d.path),segments=p.split('/');
  if(!p||p!==d.path||p.startsWith('/')||/^[a-z]:/i.test(p)||segments.some(part=>!part||part==='.'||part==='..')||sensitive(p))return false;
  const absolute=path.resolve(s.root,...segments);
  if(!inside(s.root,absolute))return false;
  const extension=path.posix.extname(p).toLowerCase();
  if(extension!==d.extension||LANG[extension]!==d.language)return false;
  if(!Number.isSafeInteger(d.size)||d.size<0||d.size>MAX_FILE||!Number.isFinite(d.mtimeMs)||!Number.isFinite(d.ctimeMs))return false;
  if(!Array.isArray(d.terms)||d.terms.length>220||d.terms.some(term=>typeof term!=='string'||term.length<2||term.length>80))return false;
  if(!Array.isArray(d.symbols)||d.symbols.length>160||d.symbols.some(symbol=>!symbol||typeof symbol!=='object'||typeof symbol.name!=='string'||symbol.name.length<1||symbol.name.length>200||typeof symbol.kind!=='string'||symbol.kind.length>40||!Number.isSafeInteger(symbol.line)||symbol.line<1))return false;
  if(!Array.isArray(d.imports)||d.imports.length>80||d.imports.some(item=>typeof item!=='string'||!item.length||item.length>2048||/[\\x00-\\x1f]/.test(item)))return false;
  return true;
 }
 function ensure(root){if(stopped)throw Error('Project intelligence is stopped.');if(typeof root!=='string'||!root.trim())throw Error('Workspace root is required.');root=path.resolve(root);const k=keyFor(root);let s=states.get(k);if(!s){s={key:k,root,drive:driveRoot(root),documents:new Map(),terms:new Map(),symbolMap:new Map(),reverse:new Map(),symbolCount:0,indexedBytes:0,edgeCount:0,loaded:false,refreshing:false,refreshPromise:null,refreshQueued:false,refreshQueuedForce:false,dirty:new Set(),watcher:null,debounce:null,reconcile:null,generatedAt:null,lastFullScanAt:null,durationMs:null,truncated:false,incompleteReasons:new Set(),lastScan:null,error:'',progress:{entries:0,files:0,bytes:0}};states.set(k,s);}return s;}
 async function persist(s){
  if(!storage)return;
  await fsp.mkdir(storage,{recursive:true});
  const target=path.join(storage,'project-index-'+s.key+'.json'),temp=target+'.'+crypto.randomUUID()+'.tmp';
  const payload={version:VERSION,rootKey:s.key,generatedAt:s.generatedAt,lastFullScanAt:s.lastFullScanAt,truncated:s.truncated,incompleteReasons:[...(s.incompleteReasons||[])].sort(),lastScan:s.lastScan||null,documents:[...s.documents.values()]};
  const serialized=JSON.stringify(payload);
  if(Buffer.byteLength(serialized,'utf8')>MAX_CACHE_BYTES){s.cacheWarning='Index metadata exceeds the 256 MiB cache limit; it remains available in memory but requires a fresh scan after restart.';return;}
  try{await fsp.writeFile(temp,serialized,{encoding:'utf8',flag:'wx'});await fsp.rename(temp,target);s.cacheWarning='';}
  finally{await fsp.rm(temp,{force:true}).catch(()=>{});}
 }
 async function load(s){
  if(s.loaded)return;
  s.loaded=true;
  if(!storage)return;
  try{
   const file=path.join(storage,'project-index-'+s.key+'.json'),st=await fsp.stat(file);
   if(!st.isFile()||st.size>256*1024*1024)return;
   const data=JSON.parse(await fsp.readFile(file,'utf8'));
   if(data.version!==VERSION||data.rootKey!==s.key||!Array.isArray(data.documents)||data.documents.length>maxFiles)throw Error('cache header or document count is invalid');
   if(data.lastScan!==null&&data.lastScan!==undefined){
    const counters=['entriesVisited','eligibleFiles','indexedFiles','bytesRead','skippedForBudget','skippedLargeFiles','skippedNonTextFiles','unreadableFiles','unreadableDirectories','durationMs'];
    if(!data.lastScan||typeof data.lastScan!=='object'||Array.isArray(data.lastScan)||counters.some(key=>!Number.isSafeInteger(data.lastScan[key])||data.lastScan[key]<0)||typeof data.lastScan.truncated!=='boolean'||!Array.isArray(data.lastScan.incompleteReasons)||data.lastScan.incompleteReasons.length>20||data.lastScan.incompleteReasons.some(reason=>typeof reason!=='string'||reason.length>80))throw Error('cache scan metadata is invalid');
   }
   const restored=new Map();let bytes=0;
   for(const d of data.documents){
    if(!validCachedDocument(s,d))throw Error('cache contains invalid document metadata');
    const key=d.path.toLowerCase();if(restored.has(key))throw Error('cache contains duplicate paths');
    bytes+=d.size;if(bytes>maxBytes)throw Error('cache exceeds the configured byte budget');
    restored.set(key,d);
   }
   s.documents=restored;
   s.generatedAt=typeof data.generatedAt==='string'&&data.generatedAt.length<=80&&Number.isFinite(Date.parse(data.generatedAt))?data.generatedAt:null;
   s.lastFullScanAt=typeof data.lastFullScanAt==='string'&&data.lastFullScanAt.length<=80&&Number.isFinite(Date.parse(data.lastFullScanAt))?data.lastFullScanAt:null;
   s.truncated=data.truncated===true;
   s.incompleteReasons=new Set(Array.isArray(data.incompleteReasons)?data.incompleteReasons.filter(x=>typeof x==='string'&&x.length<=80).slice(0,20):[]);
   s.lastScan=data.lastScan?{entriesVisited:data.lastScan.entriesVisited,eligibleFiles:data.lastScan.eligibleFiles,indexedFiles:data.lastScan.indexedFiles,bytesRead:data.lastScan.bytesRead,skippedForBudget:data.lastScan.skippedForBudget,skippedLargeFiles:data.lastScan.skippedLargeFiles,skippedNonTextFiles:data.lastScan.skippedNonTextFiles,unreadableFiles:data.lastScan.unreadableFiles,unreadableDirectories:data.lastScan.unreadableDirectories,truncated:data.lastScan.truncated,incompleteReasons:[...data.lastScan.incompleteReasons],durationMs:data.lastScan.durationMs}:null;
   s.durationMs=s.lastScan?s.lastScan.durationMs:null;
   rebuild(s);
  }catch(e){if(e.code!=='ENOENT')s.error='Index cache rejected: '+String(e.message||e).slice(0,250);}
 }
 async function readDoc(s,abs,p,st,old){if(st.size>MAX_FILE||st.size<0||sensitive(p))return null;if(old&&old.size===st.size&&old.mtimeMs===st.mtimeMs&&old.ctimeMs===st.ctimeMs)return old;try{const b=await fsp.readFile(abs);return b.length<=MAX_FILE?makeDoc(p,st,b):null;}catch{return null;}}
 async function walk(s,rootAbs,rootRel,output,c,budget={files:0,bytes:0},signal=null,oldDocuments=s.documents){
  const stack=[{abs:rootAbs,rel:rootRel}];let stopWalk=false;
  while(stack.length&&!stopWalk){
   throwIfAborted(signal);
   const cur=stack.pop();let children;
   try{children=await fsp.readdir(cur.abs,{withFileTypes:true});}
   catch{c.unreadableDirectories++;markIncomplete(s,'unreadable_directories');continue;}
   children.sort((a,b)=>{const x=a.name.toLowerCase(),y=b.name.toLowerCase();return x<y?-1:x>y?1:a.name<b.name?-1:a.name>b.name?1:0;});
   const candidates=[];
   for(const child of children){
    if(++c.entries>maxEntries){markIncomplete(s,'directory_entry_limit');stopWalk=true;break;}
    if(child.isSymbolicLink())continue;
    const p=cur.rel?cur.rel+'/'+child.name:child.name,abs=path.join(cur.abs,child.name);
    if(child.isDirectory()){if(!IGNORED.has(child.name.toLowerCase())&&!sensitive(p)&&!s.drive)stack.push({abs,rel:p});continue;}
    if(!child.isFile()||!LANG[path.posix.extname(p).toLowerCase()]||sensitive(p))continue;
    let st;try{st=await fsp.stat(abs);}catch{c.unreadableFiles++;markIncomplete(s,'unreadable_files');continue;}
    if(st.size>MAX_FILE){c.skippedLargeFiles++;markIncomplete(s,'file_size_limit');continue;}
    if(budget.files+output.size+candidates.length>=maxFiles){markIncomplete(s,'file_count_limit');stopWalk=true;break;}
    if(budget.bytes+c.bytes+st.size>maxBytes){c.skippedForBudget++;markIncomplete(s,'source_byte_limit');continue;}
    c.bytes+=st.size;c.eligibleFiles++;candidates.push({abs,path:p,stat:st});
   }
   for(let offset=0;offset<candidates.length;offset+=8){
    throwIfAborted(signal);
    const chunk=candidates.slice(offset,offset+8);
    const documents=await Promise.all(chunk.map(item=>readDoc(s,item.abs,item.path,item.stat,oldDocuments.get(item.path.toLowerCase()))));
    for(let j=0;j<chunk.length;j++){if(documents[j])output.set(chunk[j].path.toLowerCase(),documents[j]);else c.skippedNonTextFiles++;}
    s.progress={entries:c.entries,files:budget.files+output.size,bytes:budget.bytes+c.bytes};
    emit(s);await new Promise(resolve=>setImmediate(resolve));
   }
  }
  throwIfAborted(signal);
 }
 async function refreshState(s,force=false,signal=null){
  if(s.refreshPromise){s.refreshQueued=true;s.refreshQueuedForce=s.refreshQueuedForce||force;return s.refreshPromise;}
  const previousTruncated=s.truncated,previousReasons=new Set(s.incompleteReasons||[]);
  s.refreshing=true;s.error='';s.truncated=false;s.incompleteReasons=new Set();s.progress={entries:0,files:0,bytes:0};
  const began=Date.now();emit(s);
  const task=(async()=>{
   try{
    throwIfAborted(signal);
    const st=await fsp.lstat(s.root);
    if(st.isSymbolicLink()||!st.isDirectory())throw Error('Workspace root must be a real directory, not a symbolic link.');
    const next=new Map(),c={entries:0,bytes:0,eligibleFiles:0,skippedForBudget:0,skippedLargeFiles:0,skippedNonTextFiles:0,unreadableFiles:0,unreadableDirectories:0};
    await walk(s,s.root,'',next,c,{files:0,bytes:0},signal,force?new Map():s.documents);
    throwIfAborted(signal);
    s.documents=next;rebuild(s);
    s.generatedAt=new Date().toISOString();s.lastFullScanAt=s.generatedAt;s.durationMs=Date.now()-began;
    s.progress={entries:c.entries,files:next.size,bytes:c.bytes};
    s.lastScan={entriesVisited:c.entries,eligibleFiles:c.eligibleFiles,indexedFiles:next.size,bytesRead:c.bytes,skippedForBudget:c.skippedForBudget,skippedLargeFiles:c.skippedLargeFiles,skippedNonTextFiles:c.skippedNonTextFiles,unreadableFiles:c.unreadableFiles,unreadableDirectories:c.unreadableDirectories,truncated:s.truncated,incompleteReasons:[...s.incompleteReasons].sort(),durationMs:s.durationMs};
    await persist(s);
   }catch(e){
    s.truncated=previousTruncated;s.incompleteReasons=previousReasons;
    if(e.code==='ABORT_ERR')s.error='';
    else s.error=String(e.message||e).slice(0,500);
   }finally{s.refreshing=false;s.refreshPromise=null;emit(s);}
   if(s.refreshQueued&&!stopped){const queuedForce=s.refreshQueuedForce===true;s.refreshQueued=false;s.refreshQueuedForce=false;return refreshState(s,queuedForce);}
   return view(s);
  })();
  s.refreshPromise=task;return task;
 }
 async function refreshPath(s,p,options={}){
  p=rel(p);if(!p||p.split('/').includes('..')||sensitive(p))return;
  throwIfAborted(options.signal);
  const abs=path.resolve(s.root,...p.split('/'));if(!inside(s.root,abs))return;
  let st;
  try{st=await fsp.lstat(abs);}
  catch(error){
   if(error.code==='ENOENT')st=null;
   else{markIncomplete(s,'unreadable_paths');s.error='Filesystem metadata read failed: '+String(error.message||error).slice(0,250);return;}
  }
  const k=p.toLowerCase(),old=s.documents.get(k),oldSize=old?old.size:0;
  let byteDelta=0;
  if(!st){
   for(const [key,doc] of [...s.documents])if(key===k||key.startsWith(k+'/')){byteDelta-=doc.size;s.documents.delete(key);}
  }else if(st.isSymbolicLink()){
   s.documents.delete(k);byteDelta-=oldSize;
  }else if(st.isDirectory()){
   const prior=new Set([...s.documents.keys()].filter(key=>key===k||key.startsWith(k+'/')));
   const priorBytes=[...prior].reduce((sum,key)=>sum+(s.documents.get(key)?.size||0),0);
   const oldDocuments=s.documents,next=new Map(),baseFiles=Math.max(0,s.documents.size-prior.size),baseBytes=Math.max(0,s.indexedBytes-priorBytes);
   const c={entries:0,bytes:0,eligibleFiles:0,skippedForBudget:0,skippedLargeFiles:0,skippedNonTextFiles:0,unreadableFiles:0,unreadableDirectories:0};
   await walk(s,abs,p,next,c,{files:baseFiles,bytes:baseBytes},options.signal,oldDocuments);
   s.documents=oldDocuments;for(const key of prior)s.documents.delete(key);
   for(const [key,value]of next)s.documents.set(key,value);
   const nextBytes=[...next.values()].reduce((sum,value)=>sum+value.size,0);
   byteDelta=nextBytes-priorBytes;
  }else if(st.isFile()){
   if(!LANG[path.posix.extname(p).toLowerCase()]){s.documents.delete(k);byteDelta-=oldSize;}
   else{
    const d=await readDoc(s,abs,p,st,old);
    if(d){
     const nextBytes=s.indexedBytes-oldSize+d.size;
     if(!old&&s.documents.size>=maxFiles)markIncomplete(s,'file_count_limit');
     else if(nextBytes>maxBytes){s.documents.delete(k);byteDelta-=oldSize;markIncomplete(s,'source_byte_limit');}
     else{s.documents.set(k,d);byteDelta=d.size-oldSize;}
    }else{s.documents.delete(k);byteDelta-=oldSize;markIncomplete(s,st.size>MAX_FILE?'file_size_limit':'unreadable_or_non_text_file');}
   }
  }
  if(options.rebuild!==false)rebuild(s);
  else s.indexedBytes=Math.max(0,s.indexedBytes+byteDelta);
  s.generatedAt=new Date().toISOString();
  if(options.persist!==false)await persist(s);
  if(options.emit!==false)emit(s);
 }
 async function flush(s){if(s.refreshing){s.refreshQueued=true;return;}const paths=[...s.dirty];s.dirty.clear();for(const p of paths)try{await refreshPath(s,p,{rebuild:false,persist:false,emit:false});}catch(e){s.error=String(e.message||e).slice(0,300);}if(paths.length){rebuild(s);s.generatedAt=new Date().toISOString();await persist(s).catch(e=>{s.error='Index persistence failed: '+String(e.message||e).slice(0,250);});emit(s);}}
 function watch(s){if(s.watcher||s.drive||options.watch===false)return;try{s.watcher=fs.watch(s.root,{recursive:true},(_event,name)=>{if(!name){s.refreshQueued=true;clearTimeout(s.debounce);s.debounce=setTimeout(()=>void refreshState(s),500);return;}const p=rel(String(name));if(!p||p.length>2048)return;s.dirty.add(p);clearTimeout(s.debounce);s.debounce=setTimeout(()=>void flush(s),350);});s.watcher.on('error',e=>{s.error='Filesystem watcher failed: '+String(e.message||e).slice(0,250);try{s.watcher.close();}catch{}s.watcher=null;emit(s);});}catch(e){s.error='Filesystem watcher unavailable: '+String(e.message||e).slice(0,250);}}
 async function ready(root,watcher=false){const s=ensure(root);await load(s);if(watcher)watch(s);if(!s.lastFullScanAt&&!s.refreshPromise)void refreshState(s);return s;}
 async function start(root){const s=await ready(root,true);const previous=primary&&states.get(primary);if(previous&&previous!==s){clearTimeout(previous.debounce);clearInterval(previous.reconcile);if(previous.watcher)try{previous.watcher.close();}catch{}previous.watcher=null;previous.reconcile=null;}primary=s.key;if(!s.reconcile&&!s.drive)s.reconcile=setInterval(()=>void refreshState(s),reconcileMs);if(s.lastFullScanAt){void refreshState(s,false);}else if(s.refreshPromise)await s.refreshPromise;return view(s);}
 async function status(root,options={}){throwIfAborted(options.signal);const s=await ready(root);throwIfAborted(options.signal);return{...view(s),lastScan:s.lastScan||null};}
 async function refresh(root,args={},options={}){throwIfAborted(options.signal);const s=await ready(root,keyFor(root)===primary);if(s.refreshPromise)await s.refreshPromise;throwIfAborted(options.signal);return refreshState(s,args.force===true,options.signal);}
 async function search(root,args={},options={}){throwIfAborted(options.signal);const query=String(args.query||'').trim();if(!query||query.length>300)throw Error('project_search.query must contain 1–300 characters.');const s=await ready(root,keyFor(root)===primary);if(!s.documents.size&&s.refreshPromise)await s.refreshPromise;const rawIdentifier=query.replace(/[^A-Za-z0-9_$]/g,'').toLowerCase(),terms=unique([...tokenize(query),...(rawIdentifier?[rawIdentifier]:[])],20);if(!terms.length)throw Error('Query contains no searchable identifiers.');const kind=['all','symbol','file'].includes(args.kind)?args.kind:'all',limit=Number.isInteger(args.maxResults)?Math.min(Math.max(args.maxResults,1),100):30,filter=args.path?rel(args.path).toLowerCase():'';if(args.path&&!inside(s.root,path.resolve(s.root,args.path)))throw Error('Search path must remain inside the workspace.');const hits=new Map();let postingsScanned=0,scanTruncated=false;function add(d,score,type,sym){if(filter&&d.path.toLowerCase()!==filter&&!d.path.toLowerCase().startsWith(filter.replace(/\/+$/,'')+'/'))return;let h=hits.get(d.path);if(!h){h={path:d.path,language:d.language,size:d.size,score:0,matchTypes:new Set(),symbols:[]};hits.set(d.path,h);}h.score+=score;h.matchTypes.add(type);if(sym&&h.symbols.length<20)h.symbols.push({name:sym.name,kind:sym.kind,line:sym.line});}for(const t of terms){throwIfAborted(options.signal);for(const p of s.terms.get(t)||[]){if(++postingsScanned>MAX_SEARCH_POSTINGS){scanTruncated=true;break;}const d=s.documents.get(p.toLowerCase());if(d)add(d,2,'identifier-or-path');}if(scanTruncated)break;/* Exact postings avoid scanning the whole vocabulary for each token. */for(const hit of s.symbolMap.get(t)||[]){if(++postingsScanned>MAX_SEARCH_POSTINGS){scanTruncated=true;break;}const d=s.documents.get(hit.path.toLowerCase());if(d)add(d,8,'symbol',hit);}if(scanTruncated)break;}let matches=[...hits.values()].filter(h=>kind!=='symbol'||h.matchTypes.has('symbol')).map(h=>({...h,matchTypes:[...h.matchTypes]})).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,limit);return{query,kind,count:matches.length,matches,truncated:hits.size>limit||scanTruncated,scanTruncated,postingsScanned,index:view(s),searchMode:'local lexical, path, and symbol ranking; no source text is transmitted'};}
 async function overview(root,options={}){throwIfAborted(options.signal);const s=await ready(root,keyFor(root)===primary);if(!s.documents.size&&s.refreshPromise)await s.refreshPromise;const languages={},dirs={};let tests=0,entries=0;for(const d of s.documents.values()){throwIfAborted(options.signal);languages[d.language]=(languages[d.language]||0)+1;const first=d.path.split('/')[0];if(d.path.includes('/'))dirs[first]=(dirs[first]||0)+1;if(/(^|[/._-])(test|tests|spec|specs)([/._-]|$)/i.test(d.path))tests++;if(/(^|\/)(index|main|app|server|entry|bootstrap)\.[^.]+$/i.test(d.path))entries++;}return{index:view(s),indexedFiles:s.documents.size,indexedBytes:s.indexedBytes,symbolCount:s.symbolCount,dependencyEdges:s.edgeCount,testFiles:tests,likelyEntryPoints:entries,languages:Object.entries(languages).sort((a,b)=>b[1]-a[1]).map(([language,files])=>({language,files})),topDirectories:Object.entries(dirs).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([directory,files])=>({directory,files})),driveRootNote:s.drive?'Drive-root indexing is intentionally shallow. Select a project folder for full indexing.':null};}
 async function impact(root,args={},options={}){throwIfAborted(options.signal);const s=await ready(root,keyFor(root)===primary);if(!s.documents.size&&s.refreshPromise)await s.refreshPromise;let targets=[];if(args.path){const d=s.documents.get(rel(args.path).toLowerCase());if(!d)throw Error('Path is not present in the project index: '+args.path);targets=[d.path];}else if(args.symbol){targets=(s.symbolMap.get(String(args.symbol).toLowerCase())||[]).map(x=>x.path);if(!targets.length)throw Error('Symbol not found in the project index: '+args.symbol);}else throw Error('project_impact requires either path or symbol.');const found=new Set(),pending=targets.map(x=>x.toLowerCase());while(pending.length){throwIfAborted(options.signal);const p=pending.shift();for(const dependent of s.reverse.get(p)||[]){const k=dependent.toLowerCase();if(found.has(k)||targets.some(t=>t.toLowerCase()===k))continue;found.add(k);pending.push(k);}}const docs=[...found].map(k=>s.documents.get(k)).filter(Boolean);return{targets,directAndTransitiveDependents:docs.map(d=>d.path).sort(),affectedTestCandidates:docs.filter(d=>/(test|spec)/i.test(d.path)).map(d=>d.path).sort(),dependentCount:docs.length,dependencyEdges:s.edgeCount,confidence:'Relative import graph only; package aliases, reflection, generated code, and dynamic imports may be unresolved.',index:view(s)};}
 async function stop(){stopped=true;for(const s of states.values()){clearTimeout(s.debounce);clearInterval(s.reconcile);if(s.watcher)try{s.watcher.close();}catch{}if(s.refreshPromise)try{await s.refreshPromise;}catch{}await persist(s).catch(()=>{});}states.clear();primary=null;}
 function getState(root){const k=root?keyFor(root):primary,s=k&&states.get(k);return s?view(s):{status:'not_started',filesIndexed:0,symbolsIndexed:0,dependencyEdges:0,totalIndexedBytes:0,truncated:false,driveRootShallow:false,watcherActive:false,generatedAt:null,lastFullScanAt:null,refreshDurationMs:null,error:null};}
 return{start,stop,getState,status,refresh,search,overview,impact};
}
module.exports={INDEX_VERSION:VERSION,LANGUAGE_BY_EXTENSION:LANG,tokenize,extractSymbols:symbols,extractImports:imports,createProjectIntelligence};