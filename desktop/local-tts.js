'use strict';

const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const https=require('node:https');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const PIPER_VERSION='1.8.0';
const VOICE_NAME='en_US-libritts-high';
const SPEAKER_ID=0;
const VOICE_MODEL_SHA256='9127a559e11603f10b366d1a20ac7426826081dbc521de4c2420c57728d73f0f';
const VOICE_BASE_URL='https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/libritts/high/';
const MAX_VOICE_BYTES=200*1024*1024;
const RESOURCE_SAMPLE_MS=250;
const WORKER_START_TIMEOUT_MS=180000;
const PYTHON_WORKER_SOURCE="import sys,json,time,wave,io\nfrom pathlib import Path\nfrom piper import PiperVoice\nfrom piper.config import SynthesisConfig\nmodel=Path(sys.argv[1]); config=Path(sys.argv[2]); speaker=0\nvoice=PiperVoice.load(str(model),config_path=str(config))\nrate=int(voice.config.sample_rate)\nwarm=io.BytesIO(); started=time.perf_counter()\nwith wave.open(warm,\"wb\") as out: voice.synthesize_wav(\"Ready.\",out,syn_config=SynthesisConfig(speaker_id=speaker))\nwith wave.open(io.BytesIO(warm.getvalue()),\"rb\") as wav:\n    if wav.getnframes()<=0 or wav.getframerate()!=rate: raise RuntimeError(\"Piper warm-up produced invalid WAV metadata.\")\nprint(json.dumps({\"type\":\"ready\",\"sample_rate\":rate,\"speaker_id\":speaker,\"warmup_ms\":round((time.perf_counter()-started)*1000,2)}),flush=True)\nfor line in sys.stdin:\n    request_id=\"\"\n    try:\n        req=json.loads(line); request_id=str(req.get(\"id\",\"\")); text=str(req.get(\"text\",\"\")); output_path=Path(str(req.get(\"output_path\",\"\")))\n        if not request_id or not text.strip() or not output_path.is_absolute(): raise ValueError(\"Malformed local Piper request.\")\n        started=time.perf_counter()\n        with wave.open(str(output_path),\"wb\") as out: voice.synthesize_wav(text,out,syn_config=SynthesisConfig(speaker_id=speaker))\n        with wave.open(str(output_path),\"rb\") as wav:\n            frames=wav.getnframes(); sample_rate=wav.getframerate()\n            if frames<=0 or sample_rate!=rate or wav.getnchannels()!=1 or wav.getsampwidth()!=2: raise RuntimeError(\"Piper returned invalid WAV metadata.\")\n        print(json.dumps({\"type\":\"result\",\"id\":request_id,\"ok\":True,\"synthesis_ms\":round((time.perf_counter()-started)*1000,2),\"duration_seconds\":round(frames/sample_rate,4),\"sample_rate\":sample_rate,\"channels\":1}),flush=True)\n    except Exception as error:\n        print(json.dumps({\"type\":\"result\",\"id\":request_id,\"ok\":False,\"error\":type(error).__name__+\": \"+str(error)[:1000]}),flush=True)\n";

function normalizeLocalTtsSettings(value){
  const s=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const n=(v,d,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):d;
  return {enabled:s.enabled===true,resourceGuardEnabled:s.resourceGuardEnabled!==false,
    maxCpuPercent:Math.round(n(s.maxCpuPercent,75,10,100)),
    minFreeRamGb:Math.round(n(s.minFreeRamGb,2,.5,32)*2)/2};
}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function measureResources(){
  const cpus=()=>os.cpus().reduce((sum,c)=>{for(const n of Object.values(c.times||{}))sum+=Number(n)||0;return sum},0);
  const idle=()=>os.cpus().reduce((sum,c)=>sum+(Number(c.times&&c.times.idle)||0),0);
  const t0=cpus(),i0=idle();await wait(RESOURCE_SAMPLE_MS);const td=Math.max(1,cpus()-t0),id=Math.max(0,idle()-i0);
  return {cpu_percent:Math.round(Math.max(0,Math.min(100,(1-id/td)*100))*10)/10,
    free_ram_gb:Math.round(os.freemem()/1024**3*100)/100,total_ram_gb:Math.round(os.totalmem()/1024**3*100)/100};
}
function getBuffer(url,limit=4*1024*1024,redirects=0){
  return new Promise((resolve,reject)=>{
    const u=new URL(url),client=u.protocol==='https:'?https:http;
    const req=client.get(u,{headers:{'user-agent':'Windows-Repository-Bridge/0.3'}},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();if(redirects>=6)return reject(new Error('Too many redirects fetching Piper metadata.'));return getBuffer(new URL(res.headers.location,u).toString(),limit,redirects+1).then(resolve,reject)}
      if(res.statusCode!==200){res.resume();return reject(new Error('Piper download returned HTTP '+res.statusCode+'.'))}
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>limit){req.destroy(new Error('Piper metadata exceeded its size limit.'));return}chunks.push(chunk)});
      res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
    });
    req.setTimeout(30000,()=>req.destroy(new Error('Piper metadata request timed out.')));req.on('error',reject);
  });
}
function downloadVerified(url,destination,sha,maxBytes,redirects=0){
  return new Promise((resolve,reject)=>{
    const u=new URL(url),client=u.protocol==='https:'?https:http,partial=destination+'.partial';
    const req=client.get(u,{headers:{'user-agent':'Windows-Repository-Bridge/0.3'}},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();if(redirects>=6)return reject(new Error('Too many redirects downloading Piper assets.'));return downloadVerified(new URL(res.headers.location,u).toString(),destination,sha,maxBytes,redirects+1).then(resolve,reject)}
      if(res.statusCode!==200){res.resume();return reject(new Error('Piper asset download returned HTTP '+res.statusCode+'.'))}
      const output=fs.createWriteStream(partial,{flags:'w'}),hash=crypto.createHash('sha256');let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){req.destroy(new Error('Piper asset exceeded its maximum size.'));output.destroy(new Error('Piper asset exceeded its maximum size.'));return}hash.update(chunk)});
      res.pipe(output);
      output.on('finish',()=>output.close(()=>{const actual=hash.digest('hex');if(!size||actual!==sha){fs.rmSync(partial,{force:true});return reject(new Error('Piper asset SHA-256 verification failed.'))}try{fs.renameSync(partial,destination);resolve({path:destination,bytes:size,sha256:actual})}catch(e){fs.rmSync(partial,{force:true});reject(e)}}));
      output.on('error',e=>{fs.rmSync(partial,{force:true});reject(e)});res.on('error',e=>output.destroy(e));
    });
    req.setTimeout(15*60*1000,()=>req.destroy(new Error('Piper asset download timed out.')));
    req.on('error',e=>{fs.rmSync(partial,{force:true});reject(e)});
  });
}
function runProcess(command,args,options={}){
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:options.env||process.env})}catch(e){reject(e);return}
    let stdout='',stderr='';child.stdout.on('data',c=>stdout=(stdout+c.toString()).slice(-12000));child.stderr.on('data',c=>stderr=(stderr+c.toString()).slice(-12000));
    const timer=setTimeout(()=>{try{child.kill()}catch{}reject(new Error('Piper setup process timed out. '+stderr.slice(-1000)))},options.timeoutMs||600000);
    child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Piper setup exited with code '+code+'. '+(stderr||stdout).slice(-1800)));else resolve({stdout,stderr})});
  });
}
function createLocalPiperTts(options={}){
  const root=path.join(options.userDataPath||path.join(os.homedir(),'AppData','Local','WindowsRepositoryBridge'),'local-tts');
  const pythonTarget=path.join(root,'python'),voiceDir=path.join(root,'voices');
  const modelPath=path.join(voiceDir,VOICE_NAME+'.onnx'),configPath=path.join(voiceDir,VOICE_NAME+'.onnx.json');
  const workerPath=path.join(root,'piper-worker.py'),wheelPath=path.join(root,'piper-tts-'+PIPER_VERSION+'-win_amd64.whl');
  const pending=new Map();let python=null,child=null,readyPromise=null,stderrTail='';
  let state={ready:false,status:'not_prepared',voice:VOICE_NAME,speaker_id:SPEAKER_ID};
  const getSettings=()=>normalizeLocalTtsSettings(typeof options.getSettings==='function'?options.getSettings():{});
  async function findPython(){
    for(const c of [{command:'py',prefix:['-3']},{command:'python',prefix:[]},{command:'python3',prefix:[]}]){
      try{const r=await runProcess(c.command,[...c.prefix,'-c','import sys;print("%d.%d"%sys.version_info[:2])'],{timeoutMs:12000});const m=r.stdout.match(/(\d+)\.(\d+)/);if(m&&(Number(m[1])>3||(Number(m[1])===3&&Number(m[2])>=9)))return c}catch{}
    }
    throw new Error('Local Piper requires Python 3.9 or newer. Install Python 3.9+ with the Python launcher, then retry.');
  }
  async function ensureAssets(){
    fs.mkdirSync(voiceDir,{recursive:true});
    if(!fs.existsSync(modelPath)){
      state={...state,status:'downloading_voice',message:'Downloading the verified 137 MB Piper LibriTTS High voice.'};
      await downloadVerified(VOICE_BASE_URL+VOICE_NAME+'.onnx',modelPath,VOICE_MODEL_SHA256,MAX_VOICE_BYTES);
    }else if(crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex')!==VOICE_MODEL_SHA256){
      fs.rmSync(modelPath,{force:true});throw new Error('Cached Piper voice failed SHA-256 verification and was removed.');
    }
    if(!fs.existsSync(configPath)){
      const data=await getBuffer(VOICE_BASE_URL+VOICE_NAME+'.onnx.json',512*1024);let config;
      try{config=JSON.parse(data.toString('utf8'))}catch{throw new Error('Piper voice config was not valid JSON.')}
      if(config.dataset!=='libritts'||config.audio?.quality!=='high'||config.audio?.sample_rate!==22050)throw new Error('Downloaded voice config is not LibriTTS High at 22.05 kHz.');
      const tmp=configPath+'.partial';fs.writeFileSync(tmp,data);fs.renameSync(tmp,configPath);
    }
  }
  async function ensurePythonPackage(){
    fs.mkdirSync(root,{recursive:true});fs.mkdirSync(pythonTarget,{recursive:true});python=python||await findPython();
    const env={...process.env,PYTHONPATH:pythonTarget+(process.env.PYTHONPATH?path.delimiter+process.env.PYTHONPATH:'')};
    const installed=await runProcess(python.command,[...python.prefix,'-c','import piper'],{env,timeoutMs:15000}).then(()=>true,()=>false);
    if(installed)return;
    state={...state,status:'installing_runtime',message:'Installing pinned Piper TTS 1.8.0 and its runtime dependencies.'};
    const metadata=JSON.parse((await getBuffer('https://pypi.org/pypi/piper-tts/'+PIPER_VERSION+'/json')).toString('utf8'));
    const wheel=(metadata.urls||[]).find(x=>x.filename==='piper_tts-'+PIPER_VERSION+'-cp39-abi3-win_amd64.whl');
    if(!wheel||!wheel.digests?.sha256||typeof wheel.url!=='string')throw new Error('PyPI did not provide the pinned Piper TTS Windows wheel.');
    if(fs.existsSync(wheelPath)&&crypto.createHash('sha256').update(fs.readFileSync(wheelPath)).digest('hex')!==wheel.digests.sha256)fs.rmSync(wheelPath,{force:true});
    if(!fs.existsSync(wheelPath))await downloadVerified(wheel.url,wheelPath,wheel.digests.sha256,100*1024*1024);
    await runProcess(python.command,[...python.prefix,'-m','pip','install','--disable-pip-version-check','--no-warn-script-location','--upgrade','--target',pythonTarget,wheelPath],{env,timeoutMs:15*60*1000});
    await runProcess(python.command,[...python.prefix,'-c','import piper'],{env,timeoutMs:20000});
  }
  function handleLine(line){
    let r;try{r=JSON.parse(line)}catch{return}
    if(r.type==='ready'){state={ready:true,status:'ready',voice:VOICE_NAME,speaker_id:SPEAKER_ID,sample_rate:r.sample_rate,warmup_ms:r.warmup_ms,prepared_at:new Date().toISOString()};return}
    if(r.type!=='result'||typeof r.id!=='string')return;
    const p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);
    if(!r.ok)p.reject(new Error(r.error||'Piper synthesis failed.'));else p.resolve(r);
  }
  async function startWorker(){
    await ensurePythonPackage();await ensureAssets();fs.writeFileSync(workerPath,PYTHON_WORKER_SOURCE,'utf8');
    const env={...process.env,PYTHONPATH:pythonTarget+(process.env.PYTHONPATH?path.delimiter+process.env.PYTHONPATH:'')};
    child=spawn(python.command,[...python.prefix,'-u',workerPath,modelPath,configPath],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
    let buffer='';stderrTail='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>256*1024)buffer=buffer.slice(-128*1024);let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)handleLine(line)}});
    child.stderr.on('data',chunk=>stderrTail=(stderrTail+chunk).slice(-6000));
    child.once('error',e=>{state={...state,ready:false,status:'error',error:e.message};for(const p of pending.values()){clearTimeout(p.timer);p.reject(e)}pending.clear()});
    child.once('close',code=>{child=null;state={...state,ready:false,status:'stopped',error:code===0?'':'Piper worker exited with code '+code+'. '+stderrTail.slice(-1200)};for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(state.error||'Piper worker stopped.'))}pending.clear()});
    await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(state.ready)return resolve();if(['error','stopped'].includes(state.status))return reject(new Error(state.error||stderrTail||'Piper worker failed to start.'));if(Date.now()-start>WORKER_START_TIMEOUT_MS){try{child&&child.kill()}catch{}return reject(new Error('Piper did not finish loading and warming the voice within three minutes.'))}setTimeout(poll,100)};poll()});
  }
  async function ensureReady(){
    if(state.ready&&child&&!child.killed)return state;if(readyPromise)return readyPromise;
    state={...state,ready:false,status:'preparing',error:''};
    readyPromise=startWorker().then(()=>state).catch(e=>{state={...state,ready:false,status:'error',error:String(e&&e.message||e).slice(0,1600)};throw e}).finally(()=>{readyPromise=null});
    return readyPromise;
  }
  async function prepare(){await ensureReady();return getStatus()}
  async function synthesize(text,requestId){
    const source=String(text||'').trim();if(!source||source.length>240)throw new Error('Local Piper chunks must contain 1–240 characters.');
    const config=getSettings();if(!config.enabled)throw new Error('Local Piper TTS is disabled in Settings.');
    if(config.resourceGuardEnabled){
      const resources=await measureResources();
      if(resources.cpu_percent>config.maxCpuPercent||resources.free_ram_gb<config.minFreeRamGb)
        throw new Error('LOCAL_TTS_RESOURCE_GUARD: CPU '+resources.cpu_percent+'% (limit '+config.maxCpuPercent+'%) and free RAM '+resources.free_ram_gb+' GB (minimum '+config.minFreeRamGb+' GB).');
    }
    await ensureReady();const id=String(requestId||crypto.randomUUID());
    const outputPath=path.join(os.tmpdir(),'WindowsRepositoryBridge-local-piper-'+crypto.randomUUID()+'.wav');
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Local Piper synthesis timed out.'))},120000);
      pending.set(id,{resolve,reject,timer});
      try{child.stdin.write(JSON.stringify({id,text:source,output_path:outputPath})+'\n',e=>{if(e){clearTimeout(timer);pending.delete(id);reject(e)}})}
      catch(e){clearTimeout(timer);pending.delete(id);reject(e)}
    });
    try{
      const audio=await fs.promises.readFile(outputPath);
      if(audio.length<44||audio.subarray(0,4).toString('ascii')!=='RIFF'||audio.subarray(8,12).toString('ascii')!=='WAVE')throw new Error('Piper returned an invalid WAV file.');
      return {audio,remote:{synthesis_ms:result.synthesis_ms,duration_seconds:result.duration_seconds,sample_rate:result.sample_rate,channels:result.channels,tts_lock_wait_ms:0},engine:'local-piper'};
    }finally{await fs.promises.unlink(outputPath).catch(()=>{})}
  }
  function getStatus(){const s=getSettings();return {...state,enabled:s.enabled,resource_guard:s.resourceGuardEnabled,max_cpu_percent:s.maxCpuPercent,min_free_ram_gb:s.minFreeRamGb,python_available:Boolean(python),worker_running:Boolean(child&&!child.killed)}}
  async function dispose(){
    const current=child;child=null;if(current&&!current.killed){try{current.stdin.end()}catch{}try{current.kill()}catch{}}
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Local Piper is shutting down.'))}pending.clear();state={...state,ready:false,status:'stopped'};
  }
  return {prepare,ensureReady,synthesize,getStatus,dispose,measureResources,constants:{PIPER_VERSION,VOICE_NAME,SPEAKER_ID,VOICE_MODEL_SHA256}};
}
module.exports={createLocalPiperTts,normalizeLocalTtsSettings,measureResources};
