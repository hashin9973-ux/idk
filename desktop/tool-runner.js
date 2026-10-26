'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync,spawn}=require('node:child_process');
const MAX_FILE=1024*1024,MAX_PATCH=2*1024*1024,MAX_OUTPUT=128*1024,MAX_RESULTS=150,MAX_MS=120000;
const IGNORED=new Set(['.git','node_modules','.venv','venv','dist','build','coverage','.next','.cache','target','bin','obj','__pycache__']);
function looksSensitiveFile(file){
 const segments=String(file).split(/[\\/]+/).filter(Boolean);
 return segments.some(segment=>{
  const name=segment.toLowerCase();
  return /^\.env(?:\.|$)/i.test(name) ||
   /^\.(?:npmrc|pypirc|netrc|dockerconfigjson)$/i.test(name) ||
   /(?:^|[._-])(credentials?|secrets?|tokens?|api[_-]?keys?|private|auth|id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:[._-]|$)/i.test(name) ||
   /\.(?:pem|pfx|p12|key|jks|kdbx)$/i.test(name);
 });
}
let plan=[];

function inside(root,target){const r=path.relative(root,target);return r===''||(r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));}
function safePath(rootInput,raw,allowRoot=false){
 if(typeof raw!=='string'||!raw.trim()||raw.length>2048)throw new Error('path must be a non-empty path up to 2048 characters.');
 const value=raw.trim(),root=path.resolve(rootInput);
 if(value==='.'&&allowRoot)return root;
 if(/^[a-z]:(?![\\/])/i.test(value))throw new Error('drive-relative paths are not allowed; use an absolute path such as C:\\folder or a workspace-relative path.');
 const absolute=path.isAbsolute(value)||/^[a-z]:[\\/]/i.test(value)||value.startsWith('\\\\')||value.startsWith('//');
 const target=absolute?path.resolve(value):path.resolve(root,value);
 if(!inside(root,target))throw new Error('path resolves outside the selected workspace.');
 if(target===root&&!allowRoot)throw new Error('a file path is required.');
 const realRoot=fs.realpathSync(root);let ancestor=target;
 while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('cannot resolve workspace path.');ancestor=parent;}
 const effective=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,target));
 if(!inside(realRoot,effective))throw new Error('path follows a symlink outside the workspace.');
 return target;
}
function readText(file,allowSensitive=false){
 const s=fs.statSync(file);if(!s.isFile())throw new Error('path is not a regular file.');
 if(s.size>MAX_FILE)throw new Error('file exceeds the 1 MiB read limit.');
 if(looksSensitiveFile(file)&&!allowSensitive)throw new Error('Refusing to read a file that looks like a secret or private key without explicit approval.');
 const b=fs.readFileSync(file);if(b.includes(0))throw new Error('binary files are not supported.');
 return new TextDecoder('utf-8',{fatal:true}).decode(b);
}
function atomicWrite(target,bytes){
 const dir=path.dirname(target);if(!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())throw new Error('parent directory must already exist.');
 const token=crypto.randomUUID(),temp=path.join(dir,'.'+path.basename(target)+'.'+token+'.tmp'),backup=path.join(dir,'.'+path.basename(target)+'.'+token+'.bak');let backed=false,installed=false;
 try{const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(fs.existsSync(target)){fs.renameSync(target,backup);backed=true;}fs.renameSync(temp,target);installed=true;if(backed)fs.rmSync(backup,{force:true});}
 catch(e){if(installed&&fs.existsSync(target))fs.rmSync(target,{force:true});if(backed&&fs.existsSync(backup))fs.renameSync(backup,target);throw e;}
 finally{if(fs.existsSync(temp))fs.rmSync(temp,{force:true});if(fs.existsSync(backup)&&fs.existsSync(target))fs.rmSync(backup,{force:true});}
}
function applyPlans(plans,approved=false){
 const staged=[];
 try{for(const p of plans){fs.mkdirSync(path.dirname(p.target),{recursive:true});const token=crypto.randomUUID(),temp=path.join(path.dirname(p.target),'.'+path.basename(p.target)+'.'+token+'.tmp'),backup=path.join(path.dirname(p.target),'.'+path.basename(p.target)+'.'+token+'.bak');const exists=fs.existsSync(p.target);if(p.kind==='add'&&exists)throw new Error('target already exists: '+p.relative);if(p.kind!=='add'&&!exists)throw new Error('file not found: '+p.relative);if(exists&&(!fs.statSync(p.target).isFile()||fs.statSync(p.target).size>MAX_FILE))throw new Error('target is not a supported text file: '+p.relative);if(exists)readText(p.target,approved===true);if(p.text!==null){const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,Buffer.from(p.text,'utf8'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}staged.push({...p,temp,backup,exists,backed:false,installed:false});}}
 catch(e){for(const p of staged)if(fs.existsSync(p.temp))fs.rmSync(p.temp,{force:true});throw e;}
 try{for(const p of staged){if(p.exists){fs.renameSync(p.target,p.backup);p.backed=true;}if(p.text!==null){fs.renameSync(p.temp,p.target);p.installed=true;}}}
 catch(e){const errors=[];for(const p of staged.slice().reverse()){try{if(p.installed&&fs.existsSync(p.target))fs.rmSync(p.target,{force:true});if(p.backed&&fs.existsSync(p.backup))fs.renameSync(p.backup,p.target);}catch(re){errors.push(p.relative+': '+re.message);}}for(const p of staged){if(fs.existsSync(p.temp))fs.rmSync(p.temp,{force:true});if(fs.existsSync(p.backup)&&fs.existsSync(p.target))fs.rmSync(p.backup,{force:true});}throw new Error(errors.length?'patch failed and rollback needs attention: '+errors.join('; '):'patch failed; changes rolled back: '+e.message);}
 for(const p of staged){if(fs.existsSync(p.temp))fs.rmSync(p.temp,{force:true});if(fs.existsSync(p.backup))fs.rmSync(p.backup,{force:true});}
 return{count:staged.length,changed:staged.map(p=>p.relative)};
}
function listDir(root,args={}){const dir=safePath(root,args.path||'.',true);if(!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())throw new Error('directory not found.');const all=fs.readdirSync(dir,{withFileTypes:true}),entries=all.filter(e=>!e.isSymbolicLink()).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,500).map(e=>{const full=path.join(dir,e.name);return{name:e.name,type:e.isDirectory()?'directory':'file',...(e.isFile()?{bytes:fs.statSync(full).size}:{})};});return{path:path.relative(root,dir)||'.',entries,truncated:all.length>entries.length};}
function globRegex(glob){const s=String(glob||'**/*').replace(/\\/g,'/').replace(/^\.\//,'');let out='^';for(let i=0;i<s.length;i++){const ch=s[i];if(ch==='*'){if(s[i+1]==='*'){i++;if(s[i+1]==='/'){i++;out+='(?:.*/)?';}else out+='.*';}else out+='[^/]*';}else if(ch==='?')out+='[^/]';else out+=/[.+^$()|[\]\\]/.test(ch)?'\\'+ch:ch;}return new RegExp(out+'$',process.platform==='win32'?'i':'');}
function walk(root,limit=5000){const files=[],stack=[root];while(stack.length&&files.length<limit){const dir=stack.pop();let es;try{es=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;}for(const e of es){if(e.isSymbolicLink())continue;const f=path.join(dir,e.name);if(e.isDirectory()){if(!IGNORED.has(e.name))stack.push(f);}else if(e.isFile())files.push(f);if(files.length>=limit)break;}}return files;}
function globFiles(root,args={}){
 const pattern=args.pattern||'**/*';
 if(typeof pattern!=='string'||pattern.length>300)throw new Error('pattern must be at most 300 characters.');
 const base=safePath(root,args.path||'.',true);
 if(!fs.existsSync(base)||!fs.statSync(base).isDirectory())throw new Error('search base directory not found.');
 const files=walk(base),re=globRegex(pattern),hits=files.filter(f=>re.test(path.relative(base,f).replace(/\\/g,'/'))).slice(0,200);
 return{path:path.relative(root,base).replace(/\\/g,'/')||'.',pattern,count:hits.length,truncated:files.length>=5000||hits.length>=200,files:hits.map(f=>path.relative(root,f).replace(/\\/g,'/'))};
}
function searchFiles(root,args={}){
 const q=args.query;
 if(typeof q!=='string'||!q.length||q.length>500)throw new Error('query must be 1–500 characters.');
 const base=safePath(root,args.path||'.',true);
 if(!fs.existsSync(base)||!fs.statSync(base).isDirectory())throw new Error('search base directory not found.');
 const include=typeof args.include==='string'?globRegex(args.include):null,max=Number.isInteger(args.maxResults)?Math.min(Math.max(args.maxResults,1),MAX_RESULTS):100;
 let re=null;
 if(args.regex===true){try{re=new RegExp(q,args.caseSensitive?'g':'gi');}catch(e){throw new Error('invalid regex: '+e.message);}}
 const hits=[];let scanned=0,truncated=false;
 for(const file of walk(base)){
  const rel=path.relative(base,file).replace(/\\/g,'/'),workspaceRel=path.relative(root,file).replace(/\\/g,'/');
  if(looksSensitiveFile(file))continue;
  if(include&&!include.test(rel))continue;
  let text;try{if(fs.statSync(file).size>MAX_FILE)continue;const b=fs.readFileSync(file);if(b.includes(0))continue;text=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{continue;}
  scanned++;const lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
   let col=-1;
   if(re){re.lastIndex=0;const m=re.exec(lines[i]);if(m)col=m.index;}
   else col=(args.caseSensitive?lines[i]:lines[i].toLowerCase()).indexOf(args.caseSensitive?q:q.toLowerCase());
   if(col>=0){hits.push({path:workspaceRel,line:i+1,column:col+1,text:lines[i].slice(0,500)});if(hits.length>=max){truncated=true;break;}}
  }
  if(truncated)break;
 }
 return{path:path.relative(root,base).replace(/\\/g,'/')||'.',query:q,filesScanned:scanned,count:hits.length,truncated,matches:hits};
}
function git(root,args){const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:MAX_OUTPUT,windowsHide:true,shell:false});if(r.error)throw new Error(r.error.code==='ENOENT'?'Git was not found on PATH.':'Git failed: '+r.error.message);return{exitCode:r.status===null?1:r.status,stdout:r.stdout||'',stderr:r.stderr||'',command:['git',...args]};}
function projectStatus(root){const names=fs.readdirSync(root),isGit=fs.existsSync(path.join(root,'.git')),tech=[];if(names.includes('package.json'))tech.push('Node.js');if(names.includes('pyproject.toml')||names.includes('requirements.txt'))tech.push('Python');if(names.includes('Cargo.toml'))tech.push('Rust');if(names.includes('go.mod'))tech.push('Go');if(names.some(n=>n.endsWith('.sln')||n.endsWith('.csproj')))tech.push('.NET');if(names.includes('pom.xml')||names.includes('build.gradle'))tech.push('Java');return{workspace:root,isGitRepository:isGit,git:isGit?git(root,['status','--short','--branch']):null,detectedTechnologies:tech,topLevelEntries:names.slice(0,100)};}
function readFile(root,args){const target=safePath(root,args.path,false);if(!fs.existsSync(target))throw new Error('file not found.');const full=readText(target,args.approved===true),lines=full.split(/\r?\n/);const hasRange=args.startLine!==undefined||args.endLine!==undefined;let content=full,startLine=1,endLine=lines.length;if(hasRange){startLine=Number.isInteger(args.startLine)?args.startLine:1;endLine=Number.isInteger(args.endLine)?args.endLine:Math.min(lines.length,startLine+4999);if(startLine<1||endLine<startLine)throw new Error('startLine/endLine must define a valid 1-based range.');if(endLine-startLine>4999)throw new Error('a single read may return at most 5,000 lines.');content=lines.slice(startLine-1,Math.min(endLine,lines.length)).join('\n');}return{path:path.relative(root,target).replace(/\\/g,'/'),bytes:Buffer.byteLength(full),sha256:crypto.createHash('sha256').update(full).digest('hex'),totalLines:lines.length,startLine,endLine:Math.min(endLine,lines.length),content};}
function writeFile(root,args){const target=safePath(root,args.path,false);if(typeof args.content!=='string')throw new Error('content must be a string.');const bytes=Buffer.from(args.content,'utf8');if(bytes.length>MAX_FILE)throw new Error('content exceeds 1 MiB.');if(!fs.existsSync(path.dirname(target)))throw new Error('parent directory must already exist.');const before=fs.existsSync(target)?crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'):null;if(before!==null)readText(target,args.approved===true);atomicWrite(target,bytes);return{path:path.relative(root,target).replace(/\\/g,'/'),bytesWritten:bytes.length,beforeSha256:before,afterSha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
function parsePatch(text,root,approved=false){if(typeof text!=='string'||Buffer.byteLength(text)>MAX_PATCH)throw new Error('patch must be a string up to 2 MiB.');const lines=text.replace(/\r\n/g,'\n').split('\n');if(lines[0]!=='*** Begin Patch')throw new Error('patch must start with *** Begin Patch.');const plans=[];let i=1;while(i<lines.length&&lines[i]!=='*** End Patch'){const h=lines[i++];if(h.startsWith('*** Add File: ')){const rel=h.slice(14).trim(),target=safePath(root,rel,false),body=[];while(i<lines.length&&!/^\*\*\* (Add File|Update File|Delete File): /.test(lines[i])&&lines[i]!=='*** End Patch'){const line=lines[i++];if(!line.startsWith('+'))throw new Error('Add File lines must start with +.');body.push(line.slice(1));}plans.push({kind:'add',relative:path.relative(root,target).replace(/\\/g,'/'),target,text:body.join('\n')+'\n'});}else if(h.startsWith('*** Delete File: ')){const rel=h.slice(17).trim(),target=safePath(root,rel,false);plans.push({kind:'delete',relative:path.relative(root,target).replace(/\\/g,'/'),target,text:null});}else if(h.startsWith('*** Update File: ')){const rel=h.slice(17).trim(),target=safePath(root,rel,false);if(!fs.existsSync(target))throw new Error('Update target not found: '+rel);const original=readText(target,approved===true),eol=original.includes('\r\n')?'\r\n':'\n',final=original.endsWith('\n');let current=original.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n'),cursor=0,saw=false;while(i<lines.length&&!/^\*\*\* (Add File|Update File|Delete File): /.test(lines[i])&&lines[i]!=='*** End Patch'){if(!lines[i].startsWith('@@'))throw new Error('expected @@ hunk header.');const hint=lines[i++].slice(2).trim(),old=[],neu=[];while(i<lines.length&&!lines[i].startsWith('@@')&&!/^\*\*\* (Add File|Update File|Delete File): /.test(lines[i])&&lines[i]!=='*** End Patch'){const line=lines[i++];if(line==='*** End of File')continue;if(!line.length)throw new Error('blank context line must start with a space.');if(line[0]===' '){old.push(line.slice(1));neu.push(line.slice(1));}else if(line[0]==='-')old.push(line.slice(1));else if(line[0]==='+')neu.push(line.slice(1));else if(line[0]==='\\')continue;else throw new Error('invalid patch line: '+line.slice(0,80));}let at=-1;if(!old.length){at=hint?current.findIndex(line=>line.includes(hint))+1:0;if(hint&&at===0)throw new Error('patch context not found: '+hint);}else{for(let k=Math.max(0,cursor);k<=current.length-old.length;k++){if(old.every((s,j)=>current[k+j]===s)){at=k;break;}}if(at<0)for(let k=0;k<Math.min(cursor,current.length-old.length+1);k++){if(old.every((s,j)=>current[k+j]===s)){at=k;break;}}if(at<0)throw new Error('patch context did not match '+rel+'; re-read and retry.');}current.splice(at,old.length,...neu);cursor=at+neu.length;saw=true;}if(!saw)throw new Error('Update File requires a hunk.');plans.push({kind:'update',relative:path.relative(root,target).replace(/\\/g,'/'),target,text:current.join(eol)+(final?eol:'')});}else throw new Error('unsupported patch operation: '+h);}if(lines[i]!=='*** End Patch'||!plans.length)throw new Error('patch is incomplete or empty.');const seen=new Set();for(const p of plans){const k=process.platform==='win32'?p.relative.toLowerCase():p.relative;if(seen.has(k))throw new Error('duplicate path in patch: '+p.relative);seen.add(k);if(p.text!==null&&Buffer.byteLength(p.text)>MAX_FILE)throw new Error('patched file exceeds 1 MiB: '+p.relative);}return plans;}
function applyPatch(root,args){const approved=args.approved===true,plans=parsePatch(args.patch,root,approved);return{...applyPlans(plans,approved),preview:plans.map(p=>({path:p.relative,action:p.kind}))};}
function initWorkspace(root){const target=path.join(root,'AGENTS.md');if(fs.existsSync(target))return{initialized:false,path:'AGENTS.md',reason:'Existing AGENTS.md left untouched.'};const s=projectStatus(root),text=['# Project Instructions','','## Working rules','- Inspect relevant files before editing.','- Prefer small focused patches.','- Do not claim commands succeeded without actual results.','- Inspect diffs before overwriting user changes.','- Keep secrets and local environment files out of version control.','- Run tests after edits and report actual exit codes.','','## Environment','- Workspace: '+root.replace(String.fromCharCode(96),''),'- Git repository: '+(s.isGitRepository?'yes':'no'),'- Detected technology: '+(s.detectedTechnologies.join(', ')||'not detected'),'','Add project-specific conventions below.'].join('\n')+'\n';atomicWrite(target,Buffer.from(text,'utf8'));return{initialized:true,path:'AGENTS.md',bytesWritten:Buffer.byteLength(text)};}
function runPowerShell(root,args){
 if(typeof args.command!=='string'||!args.command.trim()||args.command.length>20000)throw new Error('command must be 1–20,000 characters.');
 if(process.platform!=='win32')throw new Error('PowerShell is available only on Windows.');
 const timeoutMs=Number.isInteger(args.timeoutMs)?Math.min(Math.max(args.timeoutMs,1000),MAX_MS):60000;
 const exe=process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe';
 const startedAt=Date.now();
 return new Promise((resolve,reject)=>{
  const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',args.command],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  const out=[],err=[];
  let outBytes=0,errBytes=0,timedOut=false,finished=false,timer=null,hardTimer=null;
  function keep(arr,chunk,stream){
   const current=stream==='stdout'?outBytes:errBytes;
   const room=Math.max(0,MAX_OUTPUT-current);
   if(room)arr.push(chunk.subarray(0,room));
   if(stream==='stdout')outBytes+=chunk.length;else errBytes+=chunk.length;
  }
  function formatResult(exitCode,signal){
   return {
    command:['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-Command',args.command],
    cwd:root,
    exitCode:exitCode===null?1:exitCode,
    signal,
    timedOut,
    timeoutMs,
    durationMs:Date.now()-startedAt,
    stdout:Buffer.concat(out).toString('utf8')+(outBytes>MAX_OUTPUT?'\n[stdout truncated]':''),
    stderr:Buffer.concat(err).toString('utf8')+(errBytes>MAX_OUTPUT?'\n[stderr truncated]':''),
    stdout_truncated:outBytes>MAX_OUTPUT,
    stderr_truncated:errBytes>MAX_OUTPUT
   };
  }
  function finish(error,value){
   if(finished)return;
   finished=true;
   if(timer)clearTimeout(timer);
   if(hardTimer)clearTimeout(hardTimer);
   if(error)reject(error);else resolve(value);
  }
  function resolveTimeout(){
   const result=formatResult(1,'TIMEOUT');
   result.timeoutMessage='PowerShell did not exit within '+timeoutMs+' ms. The process tree was asked to terminate; partial stdout/stderr are included.';
   finish(null,result);
   try{if(child.stdout)child.stdout.destroy();}catch{}
   try{if(child.stderr)child.stderr.destroy();}catch{}
  }
  function terminateProcessTree(){
   return new Promise(done=>{
    let settled=false;
    const settle=()=>{if(settled)return;settled=true;done();};
    // The kill command itself might hang; bound that wait separately from the
    // command timeout so every terminal request still gets a result.
    hardTimer=setTimeout(settle,1500);
    if(Number.isInteger(child.pid)&&child.pid>0){
     try{
      const taskkill=process.env.SystemRoot
       ?path.join(process.env.SystemRoot,'System32','taskkill.exe')
       :'taskkill.exe';
      const killer=spawn(taskkill,['/PID',String(child.pid),'/T','/F'],{
       windowsHide:true,shell:false,stdio:'ignore'
      });
      killer.once('error',settle);
      killer.once('close',settle);
     }catch{settle();}
    }else settle();
    // Fallback in case taskkill cannot be launched; the tree-kill and timeout
    // watchdog above still run independently.
    try{child.kill();}catch{}
   });
  }
  child.stdout.on('data',chunk=>keep(out,chunk,'stdout'));
  child.stderr.on('data',chunk=>keep(err,chunk,'stderr'));
  child.once('error',error=>finish(new Error('PowerShell failed to start: '+error.message)));
  child.once('close',(code,signal)=>{
   if(finished)return;
   if(timedOut)return; // timeout handler waits for tree termination or hard deadline
   finish(null,formatResult(code,signal));
  });
  timer=setTimeout(async()=>{
   if(finished)return;
   timedOut=true;
   await terminateProcessTree();
   if(!finished)resolveTimeout();
  },timeoutMs);
 });
}
async function runTests(root,args={}){if(args.command!==undefined){if(typeof args.command!=='string'||!args.command.trim())throw new Error('command must be a non-empty PowerShell command when supplied.');return runPowerShell(root,{command:args.command,...(Number.isInteger(args.timeoutMs)?{timeoutMs:args.timeoutMs}:{})});}const p=path.join(root,'package.json');if(fs.existsSync(p)){try{const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.scripts&&typeof j.scripts.test==='string')return runPowerShell(root,{command:'npm test',...(Number.isInteger(args.timeoutMs)?{timeoutMs:args.timeoutMs}:{})});}catch{}}if(fs.existsSync(path.join(root,'pyproject.toml'))||fs.existsSync(path.join(root,'requirements.txt'))||fs.existsSync(path.join(root,'tests')))return runPowerShell(root,{command:'python -m pytest',...(Number.isInteger(args.timeoutMs)?{timeoutMs:args.timeoutMs}:{})});if(fs.existsSync(path.join(root,'global.json'))||fs.readdirSync(root).some(n=>n.endsWith('.sln')||n.endsWith('.csproj')))return runPowerShell(root,{command:'dotnet test',...(Number.isInteger(args.timeoutMs)?{timeoutMs:args.timeoutMs}:{})});throw new Error('No standard test command detected. Supply a project-native command with command if auto-detection does not apply.');}

function assertGitRepo(root){if(!fs.existsSync(path.join(root,'.git')))throw new Error('workspace is not a Git repository.');}
function boundedGit(root,args,limit=MAX_OUTPUT){assertGitRepo(root);const r=git(root,args);return{...r,stdout:r.stdout.slice(0,limit),stderr:r.stderr.slice(0,Math.min(limit,16000)),truncated:r.stdout.length>limit||r.stderr.length>Math.min(limit,16000)};}
function environmentInfo(root){return{workspace:root,platform:process.platform,architecture:process.arch,nodeVersion:process.version,os:os.type(),osRelease:os.release(),hostname:os.hostname(),cpuCount:os.cpus().length,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),homeDirectory:os.homedir(),tempDirectory:os.tmpdir(),shellAvailable:process.platform==='win32'?'PowerShell':'not configured'};}
function directoryTree(root,args={}){const start=safePath(root,args.path||'.',true);if(!fs.existsSync(start)||!fs.statSync(start).isDirectory())throw new Error('directory not found.');const depth=Number.isInteger(args.maxDepth)?Math.min(Math.max(args.maxDepth,1),12):4,limit=Number.isInteger(args.maxEntries)?Math.min(Math.max(args.maxEntries,1),2000):500,format=args.format==='paths'?'paths':'entries',entries=[];let truncated=false;function visit(dir,level){if(level>depth)return;let children;try{children=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}catch(e){const rel=path.relative(root,dir).replace(/\\/g,'/');entries.push(format==='paths'?rel+' [unreadable]':{path:rel,error:e.message});return;}for(const child of children){if(child.isSymbolicLink()||IGNORED.has(child.name))continue;const absolute=path.join(dir,child.name),relative=path.relative(root,absolute).replace(/\\/g,'/'),isDirectory=child.isDirectory();if(format==='paths')entries.push(relative+(isDirectory?'/':''));else entries.push({path:relative,type:isDirectory?'directory':'file',...(child.isFile()?{bytes:fs.statSync(absolute).size}:{})});if(entries.length>=limit){truncated=true;return;}if(isDirectory&&level<depth)visit(absolute,level+1);if(truncated)return;}}visit(start,1);const result={path:path.relative(root,start).replace(/\\/g,'/')||'.',maxDepth:depth,count:entries.length,truncated};if(format==='paths')return{...result,format,paths:entries};return{...result,entries};}
function fileInfo(root,args={}){const target=safePath(root,args.path,false);if(!fs.existsSync(target))throw new Error('path not found.');const stat=fs.lstatSync(target);return{path:path.relative(root,target).replace(/\\/g,'/'),type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'other',bytes:stat.size,createdAt:stat.birthtime.toISOString(),modifiedAt:stat.mtime.toISOString(),accessedAt:stat.atime.toISOString(),permissions:(stat.mode&0o777).toString(8),...(stat.isFile()&&!stat.isSymbolicLink()?{sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}:{})};}
function createDirectory(root,args={}){const target=safePath(root,args.path,false);if(fs.existsSync(target))throw new Error('target already exists.');fs.mkdirSync(target,{recursive:args.recursive!==false});return{created:true,path:path.relative(root,target).replace(/\\/g,'/'),recursive:args.recursive!==false};}
function movePath(root,args={}){const source=safePath(root,args.source,false),target=safePath(root,args.destination,false);if(!fs.existsSync(source))throw new Error('source path not found.');if(fs.existsSync(target))throw new Error('destination already exists; overwrites are not allowed.');if(!fs.existsSync(path.dirname(target)))throw new Error('destination parent directory must already exist.');if(!inside(root,path.resolve(path.dirname(target))))throw new Error('destination parent is outside the workspace.');fs.renameSync(source,target);return{moved:true,source:path.relative(root,source).replace(/\\/g,'/'),destination:path.relative(root,target).replace(/\\/g,'/')};}
function deletePath(root,args={}){const target=safePath(root,args.path,false);if(!fs.existsSync(target))throw new Error('path not found.');const stat=fs.lstatSync(target);if(stat.isDirectory()&&!args.recursive&&fs.readdirSync(target).length)throw new Error('directory is not empty; set recursive=true after reviewing the approval prompt.');fs.rmSync(target,{recursive:stat.isDirectory()&&args.recursive===true,force:false});return{deleted:true,path:path.relative(root,target).replace(/\\/g,'/'),type:stat.isDirectory()?'directory':stat.isSymbolicLink()?'symlink':'file'};}
function discoverInstructions(root,args={}){const found=[];const rootFile=path.join(root,'AGENTS.md');if(fs.existsSync(rootFile))found.push({path:'AGENTS.md',content:readText(rootFile)});const subdirs=Array.isArray(args.paths)?args.paths:[];if(subdirs.length>50||subdirs.some(p=>typeof p!=='string'))throw new Error('paths must be an array of at most 50 relative file or directory paths.');for(const raw of subdirs){const target=safePath(root,raw,false);const start=fs.existsSync(target)&&fs.statSync(target).isDirectory()?target:path.dirname(target);let current=start;while(inside(root,current)){const file=path.join(current,'AGENTS.md');if(fs.existsSync(file)){const rel=path.relative(root,file).replace(/\\/g,'/');if(!found.some(x=>x.path===rel))found.push({path:rel,content:readText(file)});}if(current===root)break;current=path.dirname(current);}}return{count:found.length,instructions:found};}
function changedFiles(root,args={}){const r=boundedGit(root,['status','--porcelain=v1','--untracked-files=all'],MAX_OUTPUT),files=r.stdout.split(/\r?\n/).filter(Boolean).map(line=>({indexStatus:line.slice(0,1),worktreeStatus:line.slice(1,2),path:line.slice(3),raw:line}));return{count:files.length,files,truncated:r.truncated,exitCode:r.exitCode,stderr:r.stderr};}
function gitLog(root,args={}){const limit=Number.isInteger(args.maxCount)?Math.min(Math.max(args.maxCount,1),100):20;const cmd=['log','--date=iso-strict','--format=%H%n%h%n%an%n%ad%n%s','-n',String(limit)];if(args.path!==undefined){if(typeof args.path!=='string')throw new Error('path must be a relative path.');cmd.push('--',path.relative(root,safePath(root,args.path,false)));}const r=boundedGit(root,cmd,MAX_OUTPUT);const commits=r.stdout.trim()?r.stdout.trim().split(/\r?\n(?=[0-9a-f]{40}\n)/i).map(block=>{const lines=block.split(/\r?\n/);return{sha:lines[0]||'',shortSha:lines[1]||'',author:lines[2]||'',date:lines[3]||'',subject:lines.slice(4).join('\n')};}):[];return{...r,commits};}
function gitShow(root,args={}){const ref=args.ref===undefined?'HEAD':args.ref;if(typeof ref!=='string'||!ref||ref.length>120||! /^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]*$/.test(ref)||ref.includes('..')||ref.includes('@{'))throw new Error('ref must be a simple Git revision name, not an option or revision expression.');const cmd=['show','--no-ext-diff','--format=fuller','--stat','--patch',ref];if(args.paths!==undefined){if(!Array.isArray(args.paths)||args.paths.length>100||args.paths.some(p=>typeof p!=='string'))throw new Error('paths must be an array of relative paths.');cmd.push('--',...args.paths.map(p=>path.relative(root,safePath(root,p,false))));}return boundedGit(root,cmd,MAX_OUTPUT);}
function validateBranchName(root,name){if(typeof name!=='string'||!name||name.length>100||! /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||name.includes('..')||name.includes('//')||name.includes('@{')||name.endsWith('/')||name.endsWith('.')||name.endsWith('.lock'))throw new Error('invalid local branch name.');const check=git(root,['check-ref-format','--branch',name]);if(check.exitCode!==0)throw new Error('invalid local branch name.');return name;}
function gitBranches(root,args={}){return boundedGit(root,['branch','--list','--format=%(HEAD)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)'],32000).stdout.split(/\r?\n/).filter(Boolean).map(line=>{const [current,name,sha,upstream]=line.split('\t');return{current:current==='*',name,sha,upstream:upstream||null};});}
function gitCreateBranch(root,args={}){const name=validateBranchName(root,args.name);const r=git(root,['branch',name]);if(r.exitCode!==0)throw new Error(r.stderr||'Could not create branch.');return{created:true,name};}
function gitSwitchBranch(root,args={}){const name=validateBranchName(root,args.name);const r=git(root,['switch',name]);if(r.exitCode!==0)throw new Error(r.stderr||'Could not switch branch.');return{switched:true,name,...r};}
function gitCommit(root,args={}){if(typeof args.message!=='string'||!args.message.trim()||args.message.length>500)throw new Error('message must be 1–500 characters.');if(args.paths!==undefined){if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>100||args.paths.some(p=>typeof p!=='string'))throw new Error('paths must be a non-empty array of relative paths.');const paths=args.paths.map(p=>path.relative(root,safePath(root,p,false)));const add=git(root,['add','--',...paths]);if(add.exitCode!==0)throw new Error(add.stderr||'git add failed.');}const r=git(root,['commit','-m',args.message]);if(r.exitCode!==0)throw new Error(r.stderr||r.stdout||'git commit failed.');return{committed:true,...r};}


const READ=new Set(['project_status','environment_info','list_dir','directory_tree','glob_file_search','read_file','file_info','search','git_status','git_diff','git_log','git_show','git_branches','git_changed_files','get_capabilities','discover_instructions','update_plan']);
const WRITE=new Set(['init','write_file','apply_patch','create_directory','move_path','delete_path','git_create_branch','git_switch_branch','git_commit','git_fetch','git_pull','git_push','git_clone','shell','run_tests']);
// Only workspace-relative file operations can run automatically. Potentially sensitive paths stay approval-gated.
const AUTO_WORKSPACE_WRITES=new Set(['write_file','apply_patch','create_directory','move_path','delete_path']);
function patchTouchesSensitivePath(patch){if(typeof patch!=='string')return false;const paths=[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/gm)].map(m=>m[1].trim());return paths.some(looksSensitiveFile);}
function getToolPolicy(tool,args={}){if(!READ.has(tool)&&!WRITE.has(tool))throw new Error('unknown local tool: '+tool);let sensitive=false;if(tool==='read_file'||tool==='write_file'||tool==='delete_path')sensitive=looksSensitiveFile(String(args.path||''));else if(tool==='move_path')sensitive=looksSensitiveFile(String(args.source||''))||looksSensitiveFile(String(args.destination||''));else if(tool==='apply_patch')sensitive=patchTouchesSensitivePath(args.patch);const automatic=(AUTO_WORKSPACE_WRITES.has(tool)&&!sensitive)||(!WRITE.has(tool)&&!sensitive);return{tool,requiresApproval:(WRITE.has(tool)&&!AUTO_WORKSPACE_WRITES.has(tool))||sensitive,automatic,sensitivePath:sensitive};}
function getCapabilities(root){return{workspaceRoot:root,protocol:'chatgpt-local-tools-v2',tools:[
{name:'get_capabilities',mode:'read'},{name:'project_status',mode:'read'},{name:'environment_info',mode:'read'},
{name:'list_dir',mode:'read'},{name:'directory_tree',mode:'read'},{name:'glob_file_search',mode:'read'},
{name:'read_file',mode:'read-or-approval-for-secret-like-paths'},{name:'file_info',mode:'read'},{name:'search',mode:'read'},
{name:'git_status',mode:'read'},{name:'git_diff',mode:'read'},{name:'git_log',mode:'read'},{name:'git_show',mode:'read'},
{name:'git_branches',mode:'read'},{name:'git_changed_files',mode:'read'},{name:'discover_instructions',mode:'read'},
{name:'git_fetch',mode:'approval'},{name:'git_pull',mode:'approval'},{name:'git_push',mode:'approval'},{name:'git_clone',mode:'approval'},
{name:'init',mode:'approval'},{name:'write_file',mode:'automatic-workspace-write'},{name:'apply_patch',mode:'automatic-workspace-write'},
{name:'create_directory',mode:'automatic-workspace-write'},{name:'move_path',mode:'automatic-workspace-write'},{name:'delete_path',mode:'automatic-workspace-write'},
{name:'git_create_branch',mode:'approval'},{name:'git_switch_branch',mode:'approval'},{name:'git_commit',mode:'approval'},
{name:'shell',mode:'approval'},{name:'run_tests',mode:'approval'},{name:'update_plan',mode:'local'}]};}
async function executeTool(rootInput,tool,args={}){
 if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('arguments must be a JSON object.');
 const root=path.resolve(rootInput);if(!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw new Error('workspace directory is unavailable.');getToolPolicy(tool,args);
 switch(tool){
 case'get_capabilities':return getCapabilities(root);
 case'project_status':return projectStatus(root);
 case'environment_info':return environmentInfo(root);
 case'list_dir':return listDir(root,args);
 case'directory_tree':return directoryTree(root,args);
 case'glob_file_search':return globFiles(root,args);
 case'read_file':return readFile(root,args);
 case'file_info':return fileInfo(root,args);
 case'search':return searchFiles(root,args);
 case'git_status':return fs.existsSync(path.join(root,'.git'))?{isGitRepository:true,...git(root,['status','--short','--branch'])}:{isGitRepository:false,message:'workspace is not a Git repository.'};
 case'git_diff':{assertGitRepo(root);const list=args.paths===undefined?[]:args.paths;if(!Array.isArray(list)||list.length>100||list.some(p=>typeof p!=='string'))throw new Error('paths must be an array of relative paths.');const ps=list.map(p=>path.relative(root,safePath(root,p,false))),cmd=['diff'];if(args.staged===true)cmd.push('--cached');if(Number.isInteger(args.contextLines))cmd.push('-U'+String(Math.min(Math.max(args.contextLines,0),20)));const r=git(root,[...cmd,'--',...ps]);return{...r,stdout:r.stdout.slice(0,MAX_OUTPUT),truncated:r.stdout.length>MAX_OUTPUT};}
 case'git_log':return gitLog(root,args);
 case'git_show':return gitShow(root,args);
 case'git_branches':return gitBranches(root,args);
 case'git_changed_files':return changedFiles(root,args);
 case'git_create_branch':return gitCreateBranch(root,args);
 case'git_switch_branch':return gitSwitchBranch(root,args);
 case'git_commit':return gitCommit(root,args);
 case'git_fetch':case'git_pull':case'git_push':case'git_clone':throw new Error('This operation requires the desktop app GitHub credential and must run through the native tool bridge.');
 case'discover_instructions':return discoverInstructions(root,args);
 case'init':return initWorkspace(root);
 case'write_file':return writeFile(root,args);
 case'apply_patch':return applyPatch(root,args);
 case'create_directory':return createDirectory(root,args);
 case'move_path':return movePath(root,args);
 case'delete_path':return deletePath(root,args);
 case'shell':return runPowerShell(root,args);
 case'run_tests':return args.command?runPowerShell(root,{command:args.command,timeoutMs:args.timeoutMs}):runTests(root);
 case'update_plan':if(!Array.isArray(args.items)||args.items.length>30)throw new Error('items must contain at most 30 plan steps.');plan=args.items.map((p,i)=>typeof p==='string'?{id:i+1,step:p,status:'pending'}:{id:i+1,step:String(p.step||''),status:['pending','in_progress','completed'].includes(p.status)?p.status:'pending'});return{plan};
 default:throw new Error('unsupported tool.');
 }}
module.exports={getToolPolicy,getCapabilities,executeTool,safePath,parsePatch,globRegex,looksSensitiveFile,patchTouchesSensitivePath,globFiles,searchFiles};
