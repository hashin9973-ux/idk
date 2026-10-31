(()=>{'use strict';
const $=id=>document.getElementById(id),api=window.windowsBridge;
const mainPage=$('main-page'),settingsPage=$('settings-page'),browserPage=$('browser-page'),browserHost=$('browser-host'),queue=$('queues-widget'),controls=$('controls-widget'),tabList=$('tab-list'),agentWidgetHost=$('agent-widget-host'),terminal=window.AgentTerminal;
const workerDot=$('worker-dot'),workerStatus=$('worker-status'),githubStatus=$('github-status'),message=$('dashboard-message'),obs=$('observe-toggle'),acceptBtn=$('auto-accept-toggle'),colab=$('quick-colab-connect'),workspace=$('workspace-button'),repoForm=$('repo-form'),repoMsg=$('repo-message'),volume=$('tts-volume'),volumeValue=$('tts-volume-value'),fps=$('observe-fps'),themeSelect=$('theme-select'),themeGallery=$('theme-gallery'),browserEnabled=$('browser-enabled'),keep=$('browser-keep-active'),low=$('browser-low-memory'),memory=$('browser-memory');
let tabs=[{id:'main',kind:'main',label:'Main',closable:false},{id:'settings',kind:'settings',label:'Settings',closable:true}],active='main',bridge={},github={},observe={},autoAccept=false,dragId=null,gesture=null;
let busy={observe:false,accept:false,colab:false,workspace:false,github:false,repo:false,volume:false};let widgetMoved={queues:false,controls:false};const agentWidgets=new Map(),agentActionMenus=new Map(),openAgentDetails=new Set();let savedWidgetLayout={};
document.addEventListener('pointerdown',event=>{if(event.target&&event.target.closest&&event.target.closest('.agent-action-menu'))return;for(const menu of agentActionMenus.values())menu.hidden=true});const grid=12,minW=180,minH=100;
function note(t,s=''){message.textContent=String(t||'');message.dataset.state=s}

let browserTabData=[],dashboardStateLoaded=false,suppressDashboardSave=false,dashboardSaveTimer=null,refreshTimer=null;
let pendingAgentDelete=null;
let refreshInFlight=false,refreshRequested=false,lastBrowserActivation=Symbol('unset');
let agentReplyRefreshInFlight=false;
function dashboardSnapshot(){
  const records=new Map(browserTabData.map(item=>[item.id,item]));
  const dim=(el,property,fallback,min,max)=>{
    const raw=parseFloat(el.style[property]);const n=Number.isFinite(raw)?raw:fallback;
    return Math.round(Math.max(min,Math.min(max,n)));
  };
  const widgets={
    queues:{x:dim(queue,'left',24,0,10000),y:dim(queue,'top',28,0,10000),width:dim(queue,'width',360,180,4000),height:dim(queue,'height',queue.scrollHeight||160,80,3000)},
    controls:{x:dim(controls,'left',24,0,10000),y:dim(controls,'top',210,0,10000),width:dim(controls,'width',360,180,4000),height:dim(controls,'height',controls.scrollHeight||207,80,3000)}
  };
  for(const [id,el] of agentWidgets)widgets[id]={
    x:dim(el,'left',420,0,10000),y:dim(el,'top',24,0,10000),
    width:dim(el,'width',360,180,4000),height:dim(el,'height',320,100,3000)
  };
  return {
    tabs:tabs.map((tab,order)=>{
      const saved=tab.kind==='browser'?records.get(tab.browserId):null;
      return {id:tab.id,kind:tab.kind,label:tab.label,closable:tab.closable!==false,order,
        ...(tab.kind==='browser'?{browserId:tab.browserId,url:saved&&saved.url||tab.url,title:saved&&saved.title||tab.title||tab.label}: {})};
    }),
    activeTabId:active,
    widgets
  };
}
function scheduleSaveDashboardState(){
  if(!dashboardStateLoaded||suppressDashboardSave)return;
  if(dashboardSaveTimer)clearTimeout(dashboardSaveTimer);
  dashboardSaveTimer=setTimeout(async()=>{
    dashboardSaveTimer=null;
    try{await api.saveDashboardState(dashboardSnapshot())}catch(e){note('Could not save tabs and widgets: '+e.message,'error')}
  },300);
}
function applyDashboardState(value){
  const source=value&&typeof value==='object'?value:{};
  suppressDashboardSave=true;
  try{
    if(Array.isArray(source.tabs)){
      const incoming=[];
      for(const raw of source.tabs.slice(0,100)){
        if(!raw||!['main','settings','browser'].includes(raw.kind)||typeof raw.id!=='string')continue;
        if(raw.kind==='browser'&&(!raw.browserId||!raw.url))continue;
        incoming.push({id:raw.id,kind:raw.kind,label:String(raw.label||'Web').slice(0,80),closable:raw.kind!=='main',
          ...(raw.kind==='browser'?{browserId:raw.browserId,url:raw.url,title:raw.title||raw.label}: {})});
      }
      if(!incoming.some(t=>t.id==='main'&&t.kind==='main'))incoming.unshift({id:'main',kind:'main',label:'Main',closable:false});
      const unique=new Set();tabs=incoming.filter(t=>!unique.has(t.id)&&unique.add(t.id));
      if(!tabs.some(t=>t.id==='settings'))tabs.splice(Math.min(1,tabs.length),0,{id:'settings',kind:'settings',label:'Settings',closable:true});
    }
    const widgets=source.widgets&&typeof source.widgets==='object'?source.widgets:{};
    savedWidgetLayout={};
    for(const [id,layout] of Object.entries(widgets)){
      if(/^agent-[0-9]{3,}$/.test(id)&&layout&&typeof layout==='object'){
        savedWidgetLayout[id]={x:layout.x,y:layout.y,width:layout.width,height:layout.height};
      }
    }
    for(const [id,el] of agentWidgets){
      const layout=savedWidgetLayout[id];
      if(layout&&Number.isFinite(layout.x)&&Number.isFinite(layout.y)&&Number.isFinite(layout.width)&&Number.isFinite(layout.height)){
        Object.assign(el.style,{left:layout.x+'px',top:layout.y+'px',width:layout.width+'px',height:layout.height+'px'});
      }
    }
    const savedSeatLayouts=Object.keys(savedWidgetLayout).length>0;
    for(const [id,el] of [['queues',queue],['controls',controls]]){
      const w=widgets[id]&&typeof widgets[id]==='object'?widgets[id]:{};
      const num=(key,def,min,max)=>Number.isFinite(w[key])?Math.max(min,Math.min(max,Math.round(w[key]))):def;
      const widthDefault=id==='queues'?360:360;
      let width=num('width',widthDefault,180,4000);
      if(!savedSeatLayouts&&id==='queues'&&width>650)width=360;
      if(!savedSeatLayouts&&id==='controls'&&width>520)width=380;
      Object.assign(el.style,{left:num('x',24,0,10000)+'px',top:num('y',id==='queues'?28:210,0,10000)+'px',
        width:width+'px',height:num('height',id==='queues'?160:207,80,3000)+'px'});
      widgetMoved[id]=Boolean(w&&Object.keys(w).length);
    }
    active=tabs.some(t=>t.id===source.activeTabId)?source.activeTabId:'main';renderTabs();setPage();
  }finally{suppressDashboardSave=false}
}
let taskDashboardData=null;
let taskDashboardLoading=false;
function renderTaskDashboard(data){
  taskDashboardData=data&&typeof data==='object'?data:null;
  const select=$('task-board-project'),summary=$('task-board-summary'),host=$('task-board-list');
  if(!select||!summary||!host)return;
  const projects=Array.isArray(taskDashboardData&&taskDashboardData.projects)?taskDashboardData.projects:[];
  const previous=select.value;
  select.replaceChildren();
  if(!projects.length){
    const option=document.createElement('option');option.value='';option.textContent='No project boards yet';select.append(option);
    select.disabled=true;summary.textContent=taskDashboardData&&taskDashboardData.unavailable?'Task dashboard is unavailable while the mailbox worker is offline.':'No shared projects have been created yet.';
    host.replaceChildren();
    const hint=document.createElement('p');hint.className='help-copy';hint.textContent='An agent can create a shared board with task_project_init, then share the returned project_id with other sessions.';
    host.append(hint);return;
  }
  select.disabled=false;
  for(const project of projects){
    const option=document.createElement('option');option.value=String(project.project_id||'');
    option.textContent=String(project.name||project.project_id)+' · '+Number(project.active_lease_count||0)+' active leases';
    select.append(option);
  }
  select.value=projects.some(item=>item.project_id===previous)?previous:projects[0].project_id;
  const project=projects.find(item=>item.project_id===select.value)||projects[0];
  const counts=project.task_counts&&typeof project.task_counts==='object'?project.task_counts:{};
  const visibleTasks=Array.isArray(project.tasks)?project.tasks:[];
  const countParts=['ready','claimed','in_progress','blocked','review','integration','verification','needs_rework']
    .filter(key=>Number(counts[key]||0)>0).map(key=>key.replace(/_/g,' ')+': '+counts[key]);
  summary.textContent=String(project.project_id)+' · '+Number(project.active_lease_count||0)+' active ownership leases · latest '+visibleTasks.length+' tasks'+
    (countParts.length?' · '+countParts.join(' · '):'');
  host.replaceChildren();
  if(!visibleTasks.length){
    const empty=document.createElement('p');empty.className='help-copy';empty.textContent='This project has no task records yet.';host.append(empty);return;
  }
  for(const task of visibleTasks){
    const row=document.createElement('article');row.className='task-board-row';
    const top=document.createElement('div');top.className='task-board-row-head';
    const title=document.createElement('strong');title.textContent=String(task.title||task.task_id);title.title=String(task.task_id||'');
    const badge=document.createElement('span');badge.className='task-board-state';badge.textContent=String(task.status||'unknown').replace(/_/g,' ');
    top.append(title,badge);
    const meta=document.createElement('div');meta.className='task-board-meta';
    const owner=task.assignee_agent_id?String(task.assignee_agent_id)+' · '+String(task.assignee_session_id||''):'unassigned';
    const scope=Array.isArray(task.scope_paths)&&task.scope_paths.length?task.scope_paths.join(', '):'No file scope';
    meta.textContent=owner+' · priority '+Number(task.priority||0)+' · '+Number(task.dependency_count||0)+' dependencies · '+scope;
    const id=document.createElement('code');id.textContent=String(task.task_id||'');
    row.append(top,meta,id);host.append(row);
  }
  if(project.task_list_truncated){
    const more=document.createElement('p');more.className='help-copy';more.textContent='Additional tasks exist. Use task_list with pagination to retrieve the rest.';host.append(more);
  }
}
async function loadTaskDashboard(){
  if(taskDashboardLoading)return;
  taskDashboardLoading=true;
  const button=$('task-board-refresh');if(button)button.disabled=true;
  try{renderTaskDashboard(await api.getTaskDashboard())}
  catch(error){const status=$('task-board-summary');if(status)status.textContent='Could not load task boards: '+String(error&&error.message||error)}
  finally{taskDashboardLoading=false;if(button)button.disabled=false}
}

function applyTtsSettings(value){
  const s=value&&typeof value==='object'?value:{};
  $('tts-mode').value=s.mode==='notification'?'notification':'autoplay';
  $('tts-captions-autoplay').checked=s.captionsOnAutoplay!==false;
  $('tts-transparent-bg').checked=s.captionTransparent===true;
  $('tts-caption-position').value=['top','center','bottom','custom'].includes(s.captionPosition)?s.captionPosition:'bottom';
  $('tts-caption-x').value=String(Number.isFinite(s.captionX)?s.captionX:50);
  $('tts-caption-y').value=String(Number.isFinite(s.captionY)?s.captionY:85);
  $('tts-caption-x-value').textContent=$('tts-caption-x').value+'%';$('tts-caption-y-value').textContent=$('tts-caption-y').value+'%';
  $('tts-caption-theme').value=['app','system','light','dark'].includes(s.captionTheme)?s.captionTheme:'app';
  $('tts-custom-position').hidden=$('tts-caption-position').value!=='custom';
}
function readTtsSettings(){return {mode:$('tts-mode').value,captionsOnAutoplay:$('tts-captions-autoplay').checked,
  captionTransparent:$('tts-transparent-bg').checked,captionPosition:$('tts-caption-position').value,
  captionX:Number($('tts-caption-x').value),captionY:Number($('tts-caption-y').value),captionTheme:$('tts-caption-theme').value};}
async function saveTtsSettings(){try{applyTtsSettings(await api.setTtsSettings(readTtsSettings()));note('Speech and caption settings saved.','success')}
  catch(e){note('Could not save speech settings: '+e.message,'error');await refresh()}}
function renderCloudStatus(value){
  const s=value&&typeof value==='object'?value:{};const folder=String(s.folder||'');
  $('cloud-folder-path').textContent=folder||'Not configured. Choose a synchronized local cloud folder.';
  $('cloud-sync-enabled').checked=s.enabled===true;$('cloud-sync-now').disabled=s.enabled!==true||s.configured!==true;
  let detail=s.state||(s.enabled?'connecting':'disabled');if(s.lastSyncedAt)detail+=' · last sync '+new Date(s.lastSyncedAt).toLocaleString();if(s.error)detail+=' · '+s.error;
  $('cloud-sync-status').textContent=detail;$('cloud-sync-status').dataset.state=s.error?'error':s.enabled&&s.state==='ready'?'success':'';
}
function readLocalTtsSettings(){return {enabled:$('local-tts-enabled').checked,resourceGuardEnabled:$('local-tts-resource-guard').checked,
  allowModelDownload:$('local-tts-download').checked,pageIdleEnabled:$('local-tts-page-idle').checked,pageIdleDelaySeconds:Number($('local-tts-page-delay').value),
  maxCpuPercent:Number($('local-tts-max-cpu').value),minFreeRamGb:Number($('local-tts-min-ram').value)};}
function applyLocalTtsSettings(value){
  const s=value&&typeof value==='object'?value:{};
  $('local-tts-enabled').checked=s.enabled===true;
  $('local-tts-download').checked=s.allowModelDownload===true;
  $('local-tts-page-idle').checked=s.pageIdleEnabled===true;
  $('local-tts-page-delay').value=String(Number.isFinite(s.pageIdleDelaySeconds)?s.pageIdleDelaySeconds:60);
  $('local-tts-page-delay-value').textContent=$('local-tts-page-delay').value+' seconds';
  $('local-tts-resource-guard').checked=s.resourceGuardEnabled!==false;
  $('local-tts-max-cpu').value=String(Number.isFinite(s.maxCpuPercent)?s.maxCpuPercent:75);
  $('local-tts-min-ram').value=String(Number.isFinite(s.minFreeRamGb)?s.minFreeRamGb:2);
  $('local-tts-max-cpu-value').textContent=$('local-tts-max-cpu').value+'%';
  $('local-tts-min-ram-value').textContent=$('local-tts-min-ram').value+' GB';
  const guard=$('local-tts-resource-guard').checked,enabled=$('local-tts-enabled').checked;
  $('local-tts-resource-guard').disabled=!enabled;
  $('local-tts-download').disabled=!enabled;
  $('local-tts-page-idle').disabled=!enabled;
  $('local-tts-page-delay').disabled=!enabled||!$('local-tts-page-idle').checked;
  $('local-tts-max-cpu').disabled=!enabled||!guard;$('local-tts-min-ram').disabled=!enabled||!guard;
  $('local-tts-prepare').disabled=!enabled;$('local-tts-test').disabled=!enabled;
}
function renderLocalTtsStatus(value){
  const s=value&&typeof value==='object'?value:{},status=String(s.status||'not_prepared');
  const text=status==='ready'?'Ready · Piper '+String(s.voice||'en_US-libritts-high')+' · speaker 0 · '+Number(s.sample_rate||22050)+' Hz':
    status==='downloading_voice'?'Downloading and verifying the LibriTTS High voice…':
    status==='installing_runtime'?'Installing the pinned Piper runtime…':
    status==='preparing'?'Preparing Piper and warming the voice…':
    status==='resource_guard_blocked'?'Waiting for CPU/RAM limits: '+String(s.error||'resource guard is active'):
    status==='error'?'Local Piper error: '+String(s.error||s.message||'unknown error'):
    status==='stopped'?(s.enabled?'Stopped · prepare the local voice again.':'Local Piper is off.'):
    'Not prepared · enable local TTS; permit model download only if the voice is not already installed.';
  $('local-tts-status').textContent=text;
  $('local-tts-status').dataset.state=status==='ready'?'success':status==='error'?'error':'';
}
async function saveLocalTtsSettings(){
  try{
    const saved=await api.setLocalTtsSettings(readLocalTtsSettings());applyLocalTtsSettings(saved);
    renderLocalTtsStatus(await api.getLocalTtsStatus());
    note(saved.enabled?'Local Piper TTS enabled. Voice preparation remains manual.':'Local Piper TTS disabled.','success');
  }catch(error){note('Could not save local TTS settings: '+error.message,'error')}
}
async function applyInitialSettings(settings){
  const s=settings&&typeof settings==='object'?settings:{};if(themeIds.includes(s.dashboardTheme))applyTheme(s.dashboardTheme);
  if(s.localTts)applyLocalTtsSettings(s.localTts);
  if(Number.isFinite(s.ttsVolume)){volume.value=String(s.ttsVolume);volumeValue.textContent=s.ttsVolume+'%'}
  if(s.ttsSettings)applyTtsSettings(s.ttsSettings);if(Number.isFinite(s.observeFps))fps.value=String(s.observeFps);
  browserEnabled.checked=s.browserEnabled===true;
  keep.checked=browserEnabled.checked&&s.browserKeepActive===true;
  low.checked=browserEnabled.checked&&s.browserLowMemory===true;
  updateBrowserMode();
}
const themeIds=['midnight','light','ocean','forest','sunset','rose','high-contrast','aurora','cyberpunk','dracula','nord','solarized-light','terminal','lavender','graphite'];
function applyTheme(raw){const theme=themeIds.includes(raw)?raw:'midnight';document.documentElement.dataset.theme=theme;themeSelect.value=theme;for(const card of themeGallery.querySelectorAll('[data-theme-id]'))card.setAttribute('aria-pressed',String(card.dataset.themeId===theme));}
async function chooseTheme(requested){const previous=document.documentElement.dataset.theme||'midnight';applyTheme(requested);try{const saved=await api.setTheme(requested);applyTheme(saved.theme);note('Theme saved.','success')}catch(e){applyTheme(previous);note(e.message,'error')}}
function setDot(el,s){el.classList.remove('online','waiting','error');el.classList.add(s)}
function renderTabs(){tabList.replaceChildren();for(const t of tabs){const b=document.createElement('div');b.className='tab';b.tabIndex=0;b.dataset.tabId=t.id;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(t.id===active));b.draggable=true;const l=document.createElement('span');l.className='tab-label';l.textContent=t.label;b.append(l);if(t.closable){const x=document.createElement('button');x.type='button';x.className='tab-close';x.textContent='×';x.title='Close tab';x.tabIndex=0;x.setAttribute('role','button');x.setAttribute('aria-label','Close '+t.label+' tab');x.addEventListener('pointerdown',e=>e.stopPropagation());x.addEventListener('click',e=>{e.stopPropagation();void closeTab(t.id)});b.append(x)}b.addEventListener('click',()=>{active=t.id;setPage()});b.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target===b){e.preventDefault();active=t.id;setPage()}});b.addEventListener('dragstart',e=>{dragId=t.id;b.classList.add('drag-source');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id)});b.addEventListener('dragover',e=>{e.preventDefault();b.classList.add('drag-over')});b.addEventListener('dragleave',()=>b.classList.remove('drag-over'));b.addEventListener('drop',e=>{e.preventDefault();reorderTab(dragId||e.dataTransfer.getData('text/plain'),t.id)});b.addEventListener('dragend',()=>{dragId=null;renderTabs()});tabList.append(b)}}
function reorderTab(a,b){if(!a||a===b)return;const i=tabs.findIndex(t=>t.id===a),j=tabs.findIndex(t=>t.id===b);if(i<0||j<0)return;const [t]=tabs.splice(i,1);tabs.splice(j,0,t);renderTabs();scheduleSaveDashboardState()}
function ensureSettingsTab(){if(!tabs.some(t=>t.id==='settings'))tabs.splice(Math.min(1,tabs.length),0,{id:'settings',kind:'settings',label:'Settings',closable:true})}
$('add-tab').addEventListener('click',()=>{ensureSettingsTab();active='settings';setPage()});
async function closeTab(id){const t=tabs.find(v=>v.id===id);if(!t||!t.closable||t.id==='main')return;if(t.kind==='browser')await api.closeBrowserTab(t.browserId).catch(()=>{});tabs=tabs.filter(v=>v.id!==id);if(active===id)active='main';setPage()}
function setPage(){
  const t=tabs.find(v=>v.id===active)||tabs[0],m=t.kind==='main',s=t.kind==='settings',b=t.kind==='browser';
  mainPage.hidden=!m;settingsPage.hidden=!s;browserPage.hidden=!b;
  const browserTarget=b?t.browserId:null;
  if(lastBrowserActivation!==browserTarget){
    lastBrowserActivation=browserTarget;
    const activation=b?api.setBrowserTabActive(t.browserId):api.setBrowserTabActive(null);
    void activation.catch(e=>{
      if(lastBrowserActivation===browserTarget)lastBrowserActivation=Symbol('retry');
      if(b)note(e.message,'error');
    });
  }
  renderTabs();updateBrowserBounds();scheduleSaveDashboardState()
}
function syncBrowserTabs(list){browserTabData=Array.isArray(list)?list:[];const ids=new Set(browserTabData.map(t=>t.id));tabs=tabs.filter(t=>t.kind!=='browser'||ids.has(t.browserId));for(const r of browserTabData){let t=tabs.find(x=>x.kind==='browser'&&x.browserId===r.id);if(!t){t={id:'tab-'+r.id,kind:'browser',browserId:r.id,label:r.title||'Web',url:r.url,title:r.title,closable:true};tabs.push(t)}else{t.label=r.title||t.label;t.url=r.url||t.url;t.title=r.title||t.title}}if(!tabs.some(t=>t.id===active))active='main';renderTabs();setPage();scheduleSaveDashboardState()}
function activateOpenedBrowserTab(value){const id=value&&typeof value.id==='string'?value.id:'';const tab=tabs.find(t=>t.kind==='browser'&&t.browserId===id);if(!tab)return;active=tab.id;setPage()}
function snap(v){return Math.round(v/grid)*grid}
function renderQueues(a,p){
  const total=a+p,ap=total?Math.round(a/total*100):0,pp=total-ap;
  const rows=[{label:'Active requests',n:a,p:ap,c:'active'},{label:'Queued requests',n:p,p:pp,c:'queued'}];
  $('queue-list').replaceChildren();
  for(const r of rows){
    const row=document.createElement('div');row.className='queue-row';
    const label=document.createElement('div');label.className='queue-label';label.textContent=r.label+' ('+r.n+')';
    const track=document.createElement('div');track.className='queue-track';
    const fill=document.createElement('div');fill.className='queue-fill '+r.c;fill.style.width=r.p+'%';track.append(fill);
    const pct=document.createElement('div');pct.className='queue-percent';pct.textContent=r.p+'%';pct.title='Share of current active plus queued requests';
    row.append(label,track,pct);$('queue-list').append(row);
  }
  if(!widgetMoved.queues){
    const viewportWidth=mainPage.clientWidth||window.innerWidth||1200;
    queue.style.left='24px';queue.style.top='28px';
    queue.style.width=Math.min(360,Math.max(270,Math.round(viewportWidth*0.28)))+'px';
    const controlsHeight=controls.offsetHeight||207;
    const maxHeight=Math.max(160,(mainPage.clientHeight||window.innerHeight||800)-28-controlsHeight-26);
    queue.style.height=Math.min(Math.max(150,queue.scrollHeight+4),maxHeight)+'px';
  }
  positionControls();
}
function showAgentRequestDetails(agentId,request){
  let dialog=$('agent-request-detail-dialog');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='agent-request-detail-dialog';dialog.className='agent-request-detail-dialog';
    const form=document.createElement('form');form.method='dialog';
    const heading=document.createElement('header');heading.className='agent-request-detail-heading';
    const title=document.createElement('h2');title.className='agent-request-detail-title';
    const close=document.createElement('button');close.type='submit';close.textContent='Close';close.className='agent-request-detail-close';
    heading.append(title,close);form.append(heading);
    for(const label of ['Request JSON','Claim JSON','Result JSON']){const section=document.createElement('section');section.className='agent-request-detail-section';const h=document.createElement('h3');h.textContent=label;const pre=document.createElement('pre');pre.dataset.jsonLabel=label;section.append(h,pre);form.append(section)}
    dialog.append(form);document.body.append(dialog);
  }
  dialog.querySelector('.agent-request-detail-title').textContent=agentId+' · '+String(request.request_id||'request');
  const values={'Request JSON':request.request_json,'Claim JSON':request.claim_json,'Result JSON':request.result_json};
  for(const pre of dialog.querySelectorAll('[data-json-label]'))pre.textContent=typeof values[pre.dataset.jsonLabel]==='string'&&values[pre.dataset.jsonLabel]?values[pre.dataset.jsonLabel]:'Not available yet.';
  if(!dialog.open)dialog.showModal();
}
function appendConsoleJsonDetails(parent,label,value){
  const details=document.createElement('details');details.className='agent-json-details';
  const summary=document.createElement('summary');summary.textContent=label;
  const pre=document.createElement('pre');pre.className='agent-json';
  pre.textContent=typeof value==='string'&&value.length?value:'Not available yet.';
  details.append(summary,pre);parent.append(details);
}
function agentLayoutFor(agentId,index){
  const saved=savedWidgetLayout[agentId];
  if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y)&&Number.isFinite(saved.width)&&Number.isFinite(saved.height)){
    return {x:saved.x,y:saved.y,width:saved.width,height:saved.height};
  }
  const viewportWidth=mainPage.clientWidth||window.innerWidth||1200;
  const viewportHeight=mainPage.clientHeight||window.innerHeight||800;
  const width=Math.min(360,Math.max(220,viewportWidth-48));
  const height=Math.min(320,Math.max(180,viewportHeight-48));
  const gap=18,utilityWidth=Math.min(360,Math.max(270,Math.round(viewportWidth*0.28)));
  const rightX=24+utilityWidth+gap,hasRightColumn=rightX+width<=viewportWidth-12;
  const baseX=hasRightColumn?rightX:24;
  const baseY=hasRightColumn?24:Math.max((queue.offsetTop||28)+(queue.offsetHeight||150)+18,(controls.offsetTop||220)+(controls.offsetHeight||207)+18);
  const columns=hasRightColumn?Math.max(1,Math.floor((viewportWidth-baseX-24+gap)/(width+gap))):1;
  const overlaps=(x,y)=>{
    const rects=[
      {left:queue.offsetLeft,top:queue.offsetTop,right:queue.offsetLeft+queue.offsetWidth,bottom:queue.offsetTop+queue.offsetHeight},
      {left:controls.offsetLeft,top:controls.offsetTop,right:controls.offsetLeft+controls.offsetWidth,bottom:controls.offsetTop+controls.offsetHeight},
      ...[...agentWidgets.entries()].filter(([id])=>id!==agentId).map(([,el])=>({left:el.offsetLeft,top:el.offsetTop,right:el.offsetLeft+el.offsetWidth,bottom:el.offsetTop+el.offsetHeight}))
    ];
    return rects.some(r=>x<r.right+1&&x+width>r.left-1&&y<r.bottom+1&&y+height>r.top-1);
  };
  for(let slot=0;slot<500;slot++){
    const x=baseX+(slot%columns)*(width+gap),y=baseY+Math.floor(slot/columns)*(height+gap);
    if(!overlaps(x,y))return {x,y,width,height};
  }
  return {x:baseX,y:baseY+index*(height+gap),width,height};
}
function attachWidgetGesture(el){
  el.addEventListener('pointerdown',e=>beginGesture(e,el));
  el.addEventListener('pointermove',moveGesture);
  el.addEventListener('pointerup',endGesture);
  el.addEventListener('pointercancel',endGesture);
}
function createAgentIcon(kind){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');
  const paths=kind==='workspace'
    ? ['M2.25 1.75h7l4.5 4.5v8h-11.5z','M9.25 1.75v4.5h4.5M4.5 9h7M4.5 11.5h7']
    : kind==='trash' ? ['M2.5 4h11M6 4V2.5h4V4M4 4.5l.7 9h6.6l.7-9M6.5 6.5v4.5M9.5 6.5v4.5']
    : kind==='history' ? ['M2 8a6 6 0 1 0 1.76-4.24M2 2v4h4M8 4.5v4l2.5 1.5']
    : kind==='edit' ? ['M2 11.5l-.5 3 3-.5L13 5.5 10.5 3z','M9.5 4l2.5 2.5']
    : kind==='pause' ? ['M5 3v10M11 3v10']
    : kind==='play' ? ['M4 2.5l9 5.5-9 5.5z']
    : kind==='scissors' ? ['M3 3l10 10M13 3L3 13','M2.5 3a1 1 0 1 0 2 0a1 1 0 0 0-2 0','M11.5 13a1 1 0 1 0 2 0a1 1 0 0 0-2 0']
    : ['M2 2.25h12v8.5H7l-3.5 2.5v-2.5H2z','M4.5 5.25h7M4.5 7.75h5'];
  for(const d of paths){const pathElement=document.createElementNS('http://www.w3.org/2000/svg','path');pathElement.setAttribute('d',d);svg.append(pathElement)}
  return svg;
}
function makeAgentWidget(agent,index){
  const card=document.createElement('section');card.id='agent-widget-'+agent.agent_id;
  card.className='widget agent-console';card.dataset.widget=agent.agent_id;
  card.setAttribute('aria-label','Terminal for '+agent.agent_id);
  const layout=agentLayoutFor(agent.agent_id,index);
  Object.assign(card.style,{left:layout.x+'px',top:layout.y+'px',width:layout.width+'px',height:layout.height+'px'});
  const header=document.createElement('div');header.className='agent-console-header';header.dataset.agentDragHandle='true';
  const identity=document.createElement('div');identity.className='agent-console-identity';
  const name=document.createElement('strong');name.className='agent-console-name';
  const sessionLine=document.createElement('div');sessionLine.className='agent-console-session';
  const workspaceLine=document.createElement('div');workspaceLine.className='agent-console-workspace';
  identity.append(name,sessionLine,workspaceLine);
  const status=document.createElement('span');status.className='agent-console-status';
  const busy=document.createElement('span');busy.className='agent-console-busy';
  const unread=document.createElement('span');unread.className='agent-console-unread';unread.hidden=true;
  const counts=document.createElement('span');counts.className='agent-console-counts';
  const actions=document.createElement('div');actions.className='agent-console-actions';
  const workspaceButton=document.createElement('button');workspaceButton.type='button';workspaceButton.className='agent-console-icon-button agent-workspace-button';
  workspaceButton.title='Configure this agent workspace';workspaceButton.setAttribute('aria-label','Configure workspace for '+agent.agent_id);
  workspaceButton.append(createAgentIcon('workspace'));
  const nicknameButton=document.createElement('button');nicknameButton.type='button';nicknameButton.className='agent-console-icon-button agent-nickname-button';nicknameButton.title='Set agent nickname';nicknameButton.setAttribute('aria-label','Set nickname for '+agent.agent_id);nicknameButton.append(createAgentIcon('edit'));
  const dumpButton=document.createElement('button');dumpButton.type='button';dumpButton.className='agent-console-icon-button agent-dump-button';dumpButton.title='Configure automatic widget-history cleanup';dumpButton.setAttribute('aria-label','Configure autodump for '+agent.agent_id);dumpButton.append(createAgentIcon('history'));
  const deleteButton=document.createElement('button');deleteButton.type='button';deleteButton.className='agent-console-icon-button agent-delete-button';deleteButton.title='Revoke this session and remove its widget';deleteButton.setAttribute('aria-label','Delete agent widget for '+agent.agent_id);deleteButton.append(createAgentIcon('trash'));
  const pauseButton=document.createElement('button');pauseButton.type='button';pauseButton.className='agent-console-icon-button agent-pause-button';pauseButton.title='Pause this session';pauseButton.setAttribute('aria-label','Pause this session');pauseButton.append(createAgentIcon('pause'));
  const disconnectButton=document.createElement('button');disconnectButton.type='button';disconnectButton.className='agent-console-icon-button agent-disconnect-button';disconnectButton.title='Disconnect this session from its agent seat';disconnectButton.setAttribute('aria-label','Disconnect session from agent seat');disconnectButton.append(createAgentIcon('scissors'));
  actions.append(workspaceButton,nicknameButton,dumpButton,pauseButton,disconnectButton,deleteButton);
  header.append(identity,status,busy,unread,counts,actions);
  const composer=document.createElement('form');composer.className='agent-message-composer';composer.dataset.noWidgetDrag='true';
  const input=document.createElement('input');input.type='text';input.maxLength=20000;input.placeholder='> message agent… (Enter to send)';input.setAttribute('aria-label','Message for '+agent.agent_id);input.autocomplete='off';
  composer.append(input);
  const body=document.createElement('div');body.className='agent-console-body';body.dataset.noWidgetDrag='true';
  const messageThread=document.createElement('div');messageThread.className='agent-message-thread';
  messageThread.hidden=true;messageThread.setAttribute('aria-live','polite');messageThread.dataset.noWidgetDrag='true';
  const workspaceMenu=document.createElement('div');workspaceMenu.className='agent-workspace-menu';workspaceMenu.hidden=true;workspaceMenu.dataset.noWidgetDrag='true';
  const actionMenu=document.createElement('div');actionMenu.className='agent-action-menu';actionMenu.hidden=true;actionMenu.dataset.noWidgetDrag='true';
  const actionItems=[['Workspace',workspaceButton],['Nickname',nicknameButton],['History cleanup',dumpButton],['Pause session',pauseButton],['Disconnect session',disconnectButton],['Delete widget',deleteButton]];
  for(const [label,target] of actionItems){const item=document.createElement('button');item.type='button';item.textContent=label;item.dataset.agentAction=label.toLowerCase().replaceAll(' ','-');item.addEventListener('click',()=>{actionMenu.hidden=true;target.click()});actionMenu.append(item)}
  document.body.append(actionMenu);agentActionMenus.set(agent.agent_id,actionMenu);
  card.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea'))return;event.preventDefault();event.stopPropagation();for(const menu of agentActionMenus.values())menu.hidden=true;actionMenu.hidden=false;actionMenu.style.left=Math.max(8,Math.min(window.innerWidth-190,event.clientX))+'px';actionMenu.style.top=Math.max(8,Math.min(window.innerHeight-240,event.clientY))+'px'});
  card.append(header,body,messageThread,composer,workspaceMenu);agentWidgetHost.append(card);agentWidgets.set(agent.agent_id,card);attachWidgetGesture(card);
  pauseButton.addEventListener('click',async event=>{
    event.stopPropagation();
    const sessionId=card.dataset.sessionId||'';
    if(!sessionId||pauseButton.disabled)return;
    const wasPaused=card.dataset.paused==='true';
    pauseButton.disabled=true;
    try{
      const result=await api.pauseAgentSession(agent.agent_id,sessionId,!wasPaused);
      note(result.paused?'Session paused. New requests are rejected until it is resumed.':'Session resumed.','success');
      await refresh();
    }catch(error){note('Could not '+(wasPaused?'resume':'pause')+' '+agent.agent_id+': '+String(error&&error.message||error),'error')}
    finally{pauseButton.disabled=false}
  });
  disconnectButton.addEventListener('click',async event=>{
    event.stopPropagation();
    const sessionId=card.dataset.sessionId||'';
    if(!sessionId||disconnectButton.disabled)return;
    const confirmed=window.confirm('Disconnect '+sessionId+' from '+agent.agent_id+'? Inactivity alone never frees the seat; disconnect explicitly releases it. The disconnected session ID cannot be reused.');
    if(!confirmed)return;
    disconnectButton.disabled=true;
    try{
      await api.disconnectAgentSession(agent.agent_id,sessionId);
      card.dataset.pendingMessageIds='[]';
      note('Session disconnected. '+agent.agent_id+' is available for reassignment.','success');
      await refresh();
    }catch(error){note('Could not disconnect '+agent.agent_id+': '+String(error&&error.message||error),'error')}
    finally{disconnectButton.disabled=false}
  });
  workspaceButton.addEventListener('click',event=>{
    event.stopPropagation();
    workspaceMenu.hidden=!workspaceMenu.hidden;
  });
  nicknameButton.addEventListener('click',async event=>{event.stopPropagation();try{const current=await api.getAgentWidgetSettings(agent.agent_id);const value=window.prompt('Custom nickname for '+agent.agent_id+' (leave blank to reset):',current.nickname||'');if(value===null)return;await api.setAgentWidgetSettings(agent.agent_id,{...current.autoDump,nickname:value});await refresh();}catch(error){note('Could not save agent nickname: '+error.message,'error')}});
  dumpButton.addEventListener('click',async event=>{event.stopPropagation();try{const current=await api.getAgentWidgetSettings(agent.agent_id),cfg=current.autoDump||{};autoDumpEditingAgent=agent.agent_id;$('agent-autodump-title').textContent='Auto-dump · '+agent.agent_id;$('agent-autodump-count').value=String(cfg.maxCount||0);$('agent-autodump-age').value=String(cfg.maxAgeMinutes||0);$('agent-autodump-exclusions').value=(cfg.exclusions||[]).join(', ');$('agent-autodump-dialog').showModal()}catch(error){note('Could not open autodump settings: '+error.message,'error')}});
  deleteButton.addEventListener('click',event=>{
    event.stopPropagation();
    const sessionId=card.dataset.sessionId||null;
    if(deleteButton.disabled)return;
    pendingAgentDelete={agentId:agent.agent_id,sessionId};
    $('agent-delete-agent-id').textContent=agent.agent_id;
    $('agent-delete-session-id').textContent=sessionId||'No current conversation session';
    $('agent-delete-wipe-mailbox').checked=false;
    $('agent-delete-wipe-mailbox').disabled=!sessionId;
    $('agent-delete-error').textContent='';
    $('agent-delete-confirm').disabled=false;
    $('agent-delete-dialog').showModal();
  });
  const sendMessage=async()=>{
    const sessionId=card.dataset.sessionId||'',message=input.value.trim();
    if(!sessionId||!message||input.disabled)return;
    input.disabled=true;input.placeholder='> sending…';
    try {
      const sent=await api.sendAgentMessage(sessionId,message);
      if(sent&&typeof sent.message_id==='string'){
        const ids=readPendingAgentMessageIds(card);
        if(!ids.includes(sent.message_id))ids.push(sent.message_id);
        card.dataset.pendingMessageIds=JSON.stringify(ids.slice(-100));
      }
      input.value='';input.placeholder='> message agent… (Enter to send)';
      note('Message sent to '+agent.agent_id+'.','success');
      void refreshAgentReplies();
      await refresh();
    } catch(error) { note('Could not message '+agent.agent_id+': '+error.message,'error'); }
    finally { input.disabled=false;input.placeholder='> message agent… (Enter to send)'; }
  };
  composer.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();void sendMessage();});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void sendMessage();}});
  return card;
}
function renderAgentMailboxes(rawAgents){
  if(!agentWidgetHost)return;
  const all=Array.isArray(rawAgents)?rawAgents:[];
  const agents=all.filter(agent=>agent&&typeof agent.agent_id==='string'&&/^agent-[0-9]{3,}$/.test(agent.agent_id));
  const visibleIds=new Set(agents.map(agent=>agent.agent_id));
  for(const [id,card] of agentWidgets){if(!visibleIds.has(id)){card.remove();agentWidgets.delete(id);const menu=agentActionMenus.get(id);if(menu)menu.remove();agentActionMenus.delete(id);}}
  const count=$('agent-mailbox-count');if(count)count.textContent=agents.length+' seat'+(agents.length===1?'':'s');
  agents.forEach((agent,index)=>{
    let card=agentWidgets.get(agent.agent_id);
    if(!card)card=makeAgentWidget(agent,index);
    const requiredWidgetParts=['.agent-console-header','.agent-console-name','.agent-console-session','.agent-console-workspace','.agent-console-unread','.agent-workspace-menu','.agent-console-status','.agent-console-busy','.agent-console-counts','.agent-workspace-button','.agent-nickname-button','.agent-dump-button','.agent-delete-button','.agent-pause-button','.agent-disconnect-button','.agent-message-composer input','.agent-console-body','.agent-message-thread'];
    const actionMenu=agentActionMenus.get(agent.agent_id);
    if(!card.isConnected||requiredWidgetParts.some(selector=>!card.querySelector(selector))||!actionMenu||!actionMenu.isConnected){
      card.remove();if(actionMenu)actionMenu.remove();agentWidgets.delete(agent.agent_id);agentActionMenus.delete(agent.agent_id);
      card=makeAgentWidget(agent,index);
    }
    if(!savedWidgetLayout[agent.agent_id]&&!widgetMoved[agent.agent_id]){
      const layout=agentLayoutFor(agent.agent_id,index);
      Object.assign(card.style,{left:layout.x+'px',top:layout.y+'px',width:layout.width+'px',height:layout.height+'px'});
    }
    const header=card.querySelector('.agent-console-header');
    const name=header.querySelector('.agent-console-name');
    const sessionLine=header.querySelector('.agent-console-session');
    const workspaceLine=header.querySelector('.agent-console-workspace');
    const unread=header.querySelector('.agent-console-unread');
    const workspaceMenu=card.querySelector('.agent-workspace-menu');
    const status=header.querySelector('.agent-console-status');
    const busy=header.querySelector('.agent-console-busy');
    const counts=header.querySelector('.agent-console-counts');
    const workspaceButton=header.querySelector('.agent-workspace-button');
    const nicknameButton=header.querySelector('.agent-nickname-button');
    const dumpButton=header.querySelector('.agent-dump-button');
    const deleteButton=header.querySelector('.agent-delete-button');
    const pauseButton=header.querySelector('.agent-pause-button');
    const disconnectButton=header.querySelector('.agent-disconnect-button');
    // The panel belongs to the seat, not the task/session label. Individual
    // requests and their tool names remain listed in the console body below.
    name.textContent=String(agent.nickname||agent.agent_id);name.title=String(agent.agent_id)+(agent.nickname?' · '+agent.nickname:'');
    nicknameButton.title='Set nickname for '+agent.agent_id;
    dumpButton.title='Auto-dump: '+String((agent.auto_dump&&agent.auto_dump.maxCount)||0)+' retained requests; '+String((agent.auto_dump&&agent.auto_dump.maxAgeMinutes)||0)+' minute age limit';
    sessionLine.textContent='SESSION '+String(agent.session_id||'none');
    sessionLine.title=String(agent.session_id||'No conversation currently owns this seat');
    const workspaceRoot=String(agent.workspace_root||'');
    const profile=agent.workspace_profile&&typeof agent.workspace_profile==='object'?agent.workspace_profile:{};
    const projectTypes=Array.isArray(profile.projectTypes)?profile.projectTypes:[];
    const git=profile.git&&typeof profile.git==='object'?profile.git:{};
    const parts=[workspaceRoot?workspaceRoot.split(/[\\/]/).filter(Boolean).pop():'Workspace unavailable'];
    if(projectTypes.length)parts.push(projectTypes.join('/'));
    if(git.repository)parts.push('Git '+String(git.branch||'HEAD')+(git.dirty?' · dirty':''));
    if(profile.detectedProjectRoot&&workspaceRoot&&String(profile.detectedProjectRoot).toLowerCase()!==workspaceRoot.toLowerCase())parts.push('Project: '+String(profile.detectedProjectRoot).split(/[\\/]/).filter(Boolean).pop());
    const sharedWith=Array.isArray(agent.workspace_shared_with)?agent.workspace_shared_with:[];
    if(sharedWith.length)parts.push('Shared: '+sharedWith.join(', '));
    workspaceLine.textContent=parts.join(' · ');
    workspaceLine.title=[workspaceRoot,projectTypes.join(', '),git.repository?'Git root: '+git.root:'',git.branch?'Branch: '+git.branch:'',git.dirty?'Tracked changes present':'',sharedWith.length?'Also used by '+sharedWith.join(', '):''].filter(Boolean).join('\\n');
    const unreadCount=Math.max(0,Number(agent.unread_message_count)||0);
    const unreadPartial=agent.unread_message_count_partial===true;
    unread.hidden=unreadCount===0&&!unreadPartial;
    unread.textContent=unreadPartial?(unreadCount>99?'MSG 99+':unreadCount?'MSG '+unreadCount+'+':'MSG ?'):(unreadCount>99?'MSG 99+':'MSG '+unreadCount);
    unread.title=unreadPartial
      ? 'At least '+unreadCount+' unread incoming agent message'+(unreadCount===1?'':'s')+' in the most recent 25 inbox entries; older inbox history may also contain unread messages.'
      : unreadCount+' unread incoming agent message'+(unreadCount===1?'':'s');
    const hasSession=Boolean(agent.session_id);
    workspaceButton.disabled=false;
    const messageInput=card.querySelector('.agent-message-composer input');
    if(messageInput){
      messageInput.disabled=!hasSession;
      messageInput.placeholder=hasSession?'> message agent… (Enter to send)':'[no active session]';
    }
    const paused=agent.session_status==='paused'||agent.paused===true;
    card.dataset.paused=paused?'true':'false';
    pauseButton.disabled=!hasSession;
    pauseButton.replaceChildren(createAgentIcon(paused?'play':'pause'));
    pauseButton.title=paused?'Resume this session':'Temporarily pause this session';
    pauseButton.setAttribute('aria-label',paused?'Resume this session':'Pause this session');
    const pauseMenuItem=agentActionMenus.get(agent.agent_id)?.querySelector('[data-agent-action="pause-session"]');if(pauseMenuItem){pauseMenuItem.textContent=paused?'Resume session':'Pause session';pauseMenuItem.disabled=!hasSession;}
    const disconnectMenuItem=agentActionMenus.get(agent.agent_id)?.querySelector('[data-agent-action="disconnect-session"]');if(disconnectMenuItem)disconnectMenuItem.disabled=!hasSession;
    disconnectButton.disabled=!hasSession;
    disconnectButton.title=hasSession?'Disconnect '+String(agent.session_id)+' from '+agent.agent_id:'No session to disconnect';
    deleteButton.disabled=false;
    deleteButton.title=hasSession?'Revoke '+String(agent.session_id)+' and remove '+agent.agent_id+' widget':'Remove this empty agent widget';
    workspaceButton.classList.toggle('is-custom',agent.workspace_custom===true);
    workspaceButton.title=agent.workspace_error||('Workspace: '+String(agent.workspace_root||'not available')+(agent.workspace_scope==='agent-default'?' · saved agent default':agent.workspace_scope==='session'?' · current conversation override':agent.workspace_custom?' · custom':' · global default'));
    workspaceMenu.replaceChildren();
    const menuHeading=document.createElement('div');menuHeading.className='agent-workspace-menu-label';menuHeading.textContent='Current: '+String(agent.workspace_root||'not available');workspaceMenu.append(menuHeading);
    const recentRoots=Array.isArray(agent.recent_workspace_roots)?agent.recent_workspace_roots.filter(value=>typeof value==='string'&&value.trim()).slice(0,5):[];
    if(recentRoots.length){const label=document.createElement('div');label.className='agent-workspace-menu-label';label.textContent='Recent folders';workspaceMenu.append(label);
      recentRoots.forEach(root=>{const option=document.createElement('button');option.type='button';option.textContent=root;option.title=root;option.addEventListener('click',async event=>{event.stopPropagation();if(option.disabled)return;option.disabled=true;try{const result=await api.setAgentWorkspaceFromRecent(agent.agent_id,card.dataset.sessionId||null,root);workspaceMenu.hidden=true;if(!result.canceled)note('Workspace for '+agent.agent_id+' updated.','success');await refresh()}catch(error){note('Could not use recent workspace for '+agent.agent_id+': '+String(error&&error.message||error),'error')}finally{option.disabled=false}});workspaceMenu.append(option)});
    }else{const empty=document.createElement('div');empty.className='agent-workspace-menu-label';empty.textContent='No recent folders saved for this agent';workspaceMenu.append(empty)}
    const browse=document.createElement('button');browse.type='button';browse.textContent='Browse for folder…';browse.addEventListener('click',async event=>{event.stopPropagation();workspaceMenu.hidden=true;if(workspaceButton.disabled)return;workspaceButton.disabled=true;try{const result=await api.selectAgentWorkspace(agent.agent_id,card.dataset.sessionId||null);if(!result.canceled)note('Workspace for '+agent.agent_id+' updated.','success');await refresh()}catch(error){note('Could not configure '+agent.agent_id+' workspace: '+String(error&&error.message||error),'error')}finally{workspaceButton.disabled=false}});workspaceMenu.append(browse);
    const active=agent.status==='active';
    status.className='agent-console-status '+(active?'is-active':'is-inactive');
    status.textContent=active?'ACTIVE':'INACTIVE';
    busy.className='agent-console-busy '+(agent.busy?'is-busy':'');
    busy.textContent=agent.busy?'BUSY':'IDLE';
    counts.textContent=Number(agent.active_count||0)+' active · '+Number(agent.queued_count||0)+' queued';
    const body=card.querySelector('.agent-console-body');
    const previousSessionId=card.dataset.sessionId||'';
    const currentSessionId=String(agent.session_id||'');
    const sessionChanged=Boolean(previousSessionId&&previousSessionId!==currentSessionId);
    const scrollTop=sessionChanged?0:body.scrollTop;
    if(sessionChanged){
      card.dataset.pendingMessageIds='[]';
      const messageThread=card.querySelector('.agent-message-thread');
      if(messageThread){messageThread.replaceChildren();messageThread.hidden=true;}
      const prefix=agent.agent_id+'|';
      for(const key of openAgentDetails)if(key.startsWith(prefix))openAgentDetails.delete(key);
    }
    card.dataset.sessionId=currentSessionId;
    for(const detail of body.querySelectorAll('details[data-detail-key]'))if(detail.open)openAgentDetails.add(detail.dataset.detailKey);
    body.replaceChildren();
    if(sessionChanged){
      const handoff=document.createElement('div');handoff.className='agent-console-empty';
      handoff.textContent='Seat reassigned from '+previousSessionId+'; previous session history is hidden.';
      body.append(handoff);
    }
    let requests=Array.isArray(agent.requests)?agent.requests:[];
    const dump=agent.auto_dump&&typeof agent.auto_dump==='object'?agent.auto_dump:{};
    const excluded=new Set((Array.isArray(dump.exclusions)?dump.exclusions:[]).map(x=>String(x).toLowerCase()));
    const cutoff=Number(dump.maxAgeMinutes)>0?Date.now()-Number(dump.maxAgeMinutes)*60000:0;
    requests=requests.filter(request=>{
      const tool=String(request.tool||'').toLowerCase();if(excluded.has(tool))return true;
      const time=Date.parse(request.created_at||request.started_at||'');if(cutoff&&Number.isFinite(time)&&time<cutoff)return false;return true;
    });
    if(Number(dump.maxCount)>0){const keep=Number(dump.maxCount);let remaining=0;requests=requests.filter(request=>excluded.has(String(request.tool||'').toLowerCase())||++remaining<=keep)}
    if(!requests.length){
      const idle=document.createElement('div');idle.className='agent-console-empty';
      const last=agent.last_activity_at||agent.last_seen_at;
      idle.textContent=last?'Last activity '+String(last):'No bridge-tool activity recorded yet';
      body.append(idle);
    }else{
      for(const request of requests){
        const row=document.createElement('article');row.className='agent-request';
        const command=document.createElement('div');command.className='agent-command-line';command.setAttribute('role','button');command.tabIndex=0;
        command.textContent=terminal.formatRequestCommands(request.request_json,request.tool);
        command.title='Open full request, claim, and result JSON';
        const reqStatus=String(request.status||'queued');
        const output=document.createElement('pre');output.className='agent-command-output';
        output.textContent=terminal.formatResultOutput(request.result_json,reqStatus,request.error);
        const openDetails=()=>showAgentRequestDetails(agent.agent_id,request);
        command.addEventListener('click',openDetails);
        command.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openDetails()}});
        row.append(command,output);body.append(row);
      }
    }
    body.scrollTop=scrollTop;
  });
  updateAgentCanvasHeight();
}
function updateAgentCanvasHeight(){
  if(!agentWidgetHost||!mainPage)return;
  let bottom=Math.max(
    (queue.offsetTop||0)+(queue.offsetHeight||0)+24,
    (controls.offsetTop||0)+(controls.offsetHeight||0)+24,
    mainPage.clientHeight||window.innerHeight||800
  );
  for(const card of agentWidgets.values()){
    if(!card.isConnected)continue;
    bottom=Math.max(bottom,(card.offsetTop||0)+(card.offsetHeight||0)+24);
  }
  agentWidgetHost.style.height=Math.max(1,bottom)+'px';
}
function readPendingAgentMessageIds(card){
  try{
    const ids=JSON.parse(card.dataset.pendingMessageIds||'[]');
    return Array.isArray(ids)?[...new Set(ids.filter(id=>typeof id==='string'&&/^msg-[0-9]{13}-[a-f0-9]{32}$/.test(id)))]:[];
  }catch{return []}
}
function renderAgentMessageReplies(card,pendingIds,replies){
  const host=card.querySelector('.agent-message-thread');if(!host)return;
  host.replaceChildren();
  if(pendingIds.length){
    const waiting=document.createElement('div');waiting.className='agent-message-thread-status';
    waiting.textContent='Waiting for '+pendingIds.length+' agent repl'+(pendingIds.length===1?'y':'ies')+'…';
    host.append(waiting);
  }
  for(const reply of replies){
    const item=document.createElement('article');item.className='agent-message-reply';
    const label=document.createElement('strong');label.className='agent-message-reply-label';
    label.textContent='REPLY · '+String(reply.created_at||'');
    const content=document.createElement('div');content.className='agent-message-reply-body';
    content.textContent=String(reply.message||'');
    item.append(label,content);host.append(item);
  }
  host.hidden=host.childElementCount===0;
}
async function refreshAgentReplies(){
  if(agentReplyRefreshInFlight)return;
  const cards=[...agentWidgets.values()].filter(card=>card.isConnected&&card.dataset.sessionId&&readPendingAgentMessageIds(card).length);
  if(!cards.length)return;
  agentReplyRefreshInFlight=true;
  try{
    for(let start=0;start<cards.length;start+=8){
      await Promise.all(cards.slice(start,start+8).map(async card=>{
        const sessionId=card.dataset.sessionId,ids=readPendingAgentMessageIds(card);
        if(!ids.length)return;
        try{
          const result=await api.readAgentReplies(sessionId,ids);
          if(card.dataset.sessionId!==sessionId)return;
          const replies=Array.isArray(result&&result.messages)?result.messages:[];
          const answered=new Set(replies.map(reply=>reply.in_reply_to).filter(Boolean));
          const remaining=ids.filter(messageId=>!answered.has(messageId));
          card.dataset.pendingMessageIds=JSON.stringify(remaining);
          renderAgentMessageReplies(card,remaining,replies);
        }catch(error){
          const host=card.querySelector('.agent-message-thread');
          if(host){host.replaceChildren();const status=document.createElement('div');status.className='agent-message-thread-status';status.textContent='Reply check failed: '+String(error&&error.message||error);host.append(status);host.hidden=false;}
        }
      }));
    }
  }finally{agentReplyRefreshInFlight=false;}
}
function positionControls(){if(widgetMoved.controls)return;const width=mainPage.clientWidth||window.innerWidth||1200;controls.style.left='24px';controls.style.top=snap((queue.offsetTop||28)+(queue.offsetHeight||150)+18)+'px';controls.style.width=Math.min(360,Math.max(270,Math.round(width*0.28)))+'px'}
function renderWorker(v){bridge=v||{};const s=String(bridge.workerStatus||bridge.status||(bridge.running?'online':'connecting')).toLowerCase();workerStatus.textContent=s==='online'?'Worker online':s==='reconnecting'?'Worker reconnecting · retrying mailbox':s==='offline'?'Worker offline':s==='attention'?'Worker needs attention':s==='setup'?'Worker setup required':'Worker connecting…';setDot(workerDot,s==='online'?'online':['offline','attention','setup'].includes(s)?'error':'waiting');renderAgentMailboxes(bridge.agentMailboxes);renderQueues(Number(bridge.activeCount||0),Number(bridge.pendingCount||0));autoAccept=bridge.autoAcceptAll===true;renderAccept()}
function renderGitHub(v){github=v||{};githubStatus.textContent=github.authenticated?'GitHub connected':github.verificationPending?'GitHub verifying…':'GitHub not connected';$('github-detail').textContent=github.authenticated?'Signed in as '+(github.login||'GitHub user'):'GitHub not connected';$('github-connect').textContent=github.authenticated?'Reconnect':'Sign in'}
function renderWorkspace(v){const root=String(v&&v.root||''),leaf=root.split(/[\\/]/).filter(Boolean).pop()||root,index=v&&v.projectIntelligence||{},scheduler=v&&v.taskScheduler||{};$('workspace-status').textContent=root?(/^[a-z]:[\\/]?$/i.test(root)?'Entire drive '+root:leaf):'Choose a folder or drive';$('workspace-detail').textContent=root||'No workspace selected';$('workspace-description').textContent=root?'Local path selected for bridge file operations.':'Choose a local folder or drive.';workspace.title=root;const status=$('project-index-status'),detail=$('project-index-detail'),queueStatus=$('task-scheduler-status');if(status)status.textContent=String(index.status||'Not started').replace(/_/g,' ');if(detail)detail.textContent=Number(index.filesIndexed||0).toLocaleString()+' files · '+Number(index.symbolsIndexed||0).toLocaleString()+' symbols · '+Number(index.dependencyEdges||0).toLocaleString()+' import edges'+(index.truncated?' · index is incomplete':'')+(index.driveRootShallow?' · drive-root scope is shallow':'')+(index.error?' · '+String(index.error):'');if(queueStatus)queueStatus.textContent=Number(scheduler.active||0)+' active · '+Number(scheduler.queued||0)+' queued · avg wait '+Number(scheduler.averageQueueWaitMs||0)+' ms';}
function renderObserve(){obs.setAttribute('aria-pressed',String(observe.enabled===true));$('observe-status').textContent=(observe.enabled?'ON':'OFF')+' · '+Number(observe.fps||fps.value||2)+' fps';if(observe.fps)fps.value=String(observe.fps)}
function renderAccept(){acceptBtn.setAttribute('aria-pressed',String(autoAccept));$('auto-accept-status').textContent=autoAccept?'ON':'OFF'}
function updateBrowserMode(){keep.disabled=!browserEnabled.checked;low.disabled=!browserEnabled.checked;memory.title=!browserEnabled.checked?'In-app browser is disabled.':keep.checked&&low.checked?'Background focus is enabled for the active page; inactive tabs are unloaded.':keep.checked?'Background focus compatibility can increase CPU use.':low.checked?'Inactive tabs unload, so their page cannot run until reopened.':'Neither behavior is enabled.'}
async function refresh(){
  if(refreshInFlight){refreshRequested=true;return}
  refreshInFlight=true;
  try{
    try{
      const s=await api.getState();
      renderWorker(s.bridge||{});
      void api.getLocalTtsStatus().then(renderLocalTtsStatus).catch(()=>{});
      void refreshAgentReplies();
      renderWorkspace(s.workspace||{});
      if(!dashboardStateLoaded){
        await applyInitialSettings(s.settings||{});
        void loadTaskDashboard();
        if(Array.isArray(s.browserTabs))syncBrowserTabs(s.browserTabs);
        if(s.dashboardState)applyDashboardState(s.dashboardState);
        if(s.cloudSync)renderCloudStatus(s.cloudSync);
        dashboardStateLoaded=true;
        scheduleSaveDashboardState();
      }
      applyTheme(s.settings&&s.settings.dashboardTheme||'midnight');
      const c=s.settings&&s.settings.repositoryBridge||s.bridge||{};
      if(!busy.repo){
        $('repo-owner').value=c.owner||'';
        $('repo-name').value=c.repo||'';
        $('repo-branch').value=c.branch||'';
        $('allow-public-mailbox').checked=c.allowPublicMailbox===true;
      }
      if(!busy.volume){
        const v=Number.isFinite(s.settings&&s.settings.ttsVolume)?s.settings.ttsVolume:100;
        volume.value=String(v);volumeValue.textContent=v+'%';
      }
    }catch(e){note('Could not refresh app status: '+e.message,'error')}
    try{renderGitHub(await api.getGitHubState())}catch{}
    try{observe=await api.getObserveStatus();renderObserve()}catch{}
    try{const b=await api.getBrowserSettings();browserEnabled.checked=b.enabled===true;keep.checked=b.keepActive;low.checked=b.lowMemory;updateBrowserMode()}catch{}
  
  }finally{
    refreshInFlight=false;
    if(refreshRequested){refreshRequested=false;queueMicrotask(()=>void refresh())}
  }
}
function updateBrowserBounds(){if(browserPage.hidden)return;const r=browserHost.getBoundingClientRect();void api.setBrowserBounds({x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}).catch(()=>{})}
const ro=new ResizeObserver(updateBrowserBounds);ro.observe(browserHost);api.onBrowserBoundsRefresh(updateBrowserBounds);
function beginGesture(e,el){if(e.button!==0||e.target.closest('button,input,select,textarea,a,label,details,summary,pre'))return;const r=el.getBoundingClientRect(),edge=10,L=e.clientX-r.left<=edge,R=r.right-e.clientX<=edge,T=e.clientY-r.top<=edge,B=r.bottom-e.clientY<=edge;const resize=L||R||T||B;const isAgent=el.classList.contains('agent-console');if(isAgent&&!resize&&!e.target.closest('.agent-console-header'))return;if(!isAgent&&!resize&&e.target.closest('[data-no-widget-drag]'))return;gesture={el,mode:resize?'resize':'drag',sx:e.clientX,sy:e.clientY,x:el.offsetLeft,y:el.offsetTop,w:el.offsetWidth,h:el.offsetHeight,L,R,T,B};el.classList.add(gesture.mode==='drag'?'dragging':'resizing');el.setPointerCapture(e.pointerId);e.preventDefault()}
function moveGesture(e){if(!gesture)return;const g=gesture,dx=e.clientX-g.sx,dy=e.clientY-g.sy;let x=g.x,y=g.y,w=g.w,h=g.h;if(g.mode==='drag'){x+=dx;y+=dy}else{if(g.R)w+=dx;if(g.B)h+=dy;if(g.L){x+=dx;w-=dx}if(g.T){y+=dy;h-=dy}if(w<minW){if(g.L)x-=minW-w;w=minW}if(h<minH){if(g.T)y-=minH-h;h=minH}}g.el.style.left=x+'px';g.el.style.top=y+'px';if(g.mode==='resize'){g.el.style.width=w+'px';g.el.style.height=h+'px'}}
function endGesture(){if(!gesture)return;const g=gesture,el=g.el;el.classList.remove('dragging','resizing');const r=mainPage.getBoundingClientRect();let x=snap(el.offsetLeft),y=snap(el.offsetTop),w=Math.max(minW,snap(el.offsetWidth)),h=Math.max(minH,snap(el.offsetHeight));x=Math.max(0,Math.min(Math.max(0,r.width-w),x));y=Math.max(0,y);Object.assign(el.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});widgetMoved[el.dataset.widget]=true;gesture=null;if(el===queue)positionControls();updateAgentCanvasHeight();scheduleSaveDashboardState()}
for(const el of [queue,controls])attachWidgetGesture(el)
obs.addEventListener('click',async()=>{if(busy.observe)return;busy.observe=true;obs.disabled=true;try{observe=await api.setObserveEnabled(!observe.enabled);renderObserve();note('Observe mode updated.','success')}catch(e){note(e.message,'error')}finally{busy.observe=false;obs.disabled=false}});
acceptBtn.addEventListener('click',async()=>{if(busy.accept)return;busy.accept=true;acceptBtn.disabled=true;try{const r=await api.setAutoAcceptAll(!autoAccept);autoAccept=Boolean(r.autoAcceptAll);renderAccept();note(autoAccept?'Auto-accept enabled after confirmation.':'Auto-accept disabled.','success')}catch(e){note(e.message,'error')}finally{busy.accept=false;acceptBtn.disabled=false}});
fps.addEventListener('change',async()=>{try{observe=await api.setObserveFps(Number(fps.value));renderObserve()}catch(e){note(e.message,'error')}});
async function chooseWorkspace(){if(busy.workspace)return;busy.workspace=true;try{const r=await api.selectWorkspace();if(!r.canceled){renderWorkspace(r.workspace);note('Workspace updated.','success')}}catch(e){note(e.message,'error')}finally{busy.workspace=false}}
workspace.addEventListener('click',()=>void chooseWorkspace());$('settings-workspace-button').addEventListener('click',()=>void chooseWorkspace());
$('project-index-refresh').addEventListener('click',async()=>{const button=$('project-index-refresh');button.disabled=true;try{const state=await api.refreshProjectIndex();note('Project index rebuilt: '+Number(state.filesIndexed||0).toLocaleString()+' files.','success');await refresh()}catch(error){note('Project index rebuild failed: '+error.message,'error')}finally{button.disabled=false}});
$('minimize-to-tray').addEventListener('click',()=>void api.minimizeToTray().catch(e=>note(e.message,'error')));
$('quit-app').addEventListener('click',()=>void api.quit().catch(e=>note(e.message,'error')));
colab.addEventListener('click',async()=>{if(busy.colab)return;busy.colab=true;colab.disabled=true;colab.querySelector('small').textContent='Opening Colab…';try{const opened=await api.openColabTab();syncBrowserTabs(await api.getBrowserTabs());const tab=tabs.find(v=>v.kind==='browser'&&v.browserId===opened.id);if(tab){active=tab.id;setPage()}const result=await api.connectColab();const currentTabs=await api.getBrowserTabs();syncBrowserTabs(currentTabs);const colabTab=currentTabs.find(v=>v.url&&v.url.startsWith('https://colab.research.google.com/'));const activeColabTab=colabTab&&tabs.find(v=>v.kind==='browser'&&v.browserId===colabTab.id);if(activeColabTab){active=activeColabTab.id;setPage()}$('colab-status').textContent=result.message||result.status||'Connection requested';note(result.message||'Colab connection requested.',result.connected?'success':'')}catch(e){$('colab-status').textContent=e.message;note(e.message,'error')}finally{busy.colab=false;colab.disabled=false}});
$('github-connect').addEventListener('click',async()=>{if(busy.github)return;busy.github=true;$('github-connect').disabled=true;try{const cur=await api.getGitHubState(),flow=cur.authenticated?await api.reconnectGitHub():await api.startGitHubLogin();if(flow&&flow.userCode){note('GitHub device code: '+flow.userCode+' — complete authorization in the browser.');let n=0;const poll=async()=>{if(!busy.github)return;try{const s=await api.pollGitHubLogin();if(s.status==='authenticated'){busy.github=false;$('github-connect').disabled=false;await refresh();return}if(s.status==='error'){note(s.message||'GitHub sign-in failed.','error');busy.github=false;$('github-connect').disabled=false;return}}catch{}if(++n<200)window.setTimeout(poll,3000);else{busy.github=false;$('github-connect').disabled=false;note('GitHub authorization polling stopped.','error')}};window.setTimeout(poll,3000)}else{await refresh();busy.github=false;$('github-connect').disabled=false}}catch(e){note(e.message,'error');busy.github=false;$('github-connect').disabled=false}});
repoForm.addEventListener('submit',async e=>{e.preventDefault();if(busy.repo)return;busy.repo=true;repoMsg.textContent='Validating and switching repository…';try{const r=await api.setRepositoryBridgeConfig({owner:$('repo-owner').value.trim(),repo:$('repo-name').value.trim(),branch:$('repo-branch').value.trim(),allowPublicMailbox:$('allow-public-mailbox').checked});repoMsg.textContent='Repository saved and worker restarted.';repoMsg.dataset.state='success';note('Bridge environment repository updated.','success');renderWorker(r.bridge||{})}catch(e){repoMsg.textContent=e.message;repoMsg.dataset.state='error';note(e.message,'error');await refresh()}finally{busy.repo=false}});
themeSelect.addEventListener('change',()=>void chooseTheme(themeSelect.value));themeGallery.addEventListener('click',e=>{const card=e.target.closest('[data-theme-id]');if(card&&themeIds.includes(card.dataset.themeId))void chooseTheme(card.dataset.themeId)});
volume.addEventListener('input',()=>volumeValue.textContent=volume.value+'%');volume.addEventListener('change',async()=>{if(busy.volume)return;busy.volume=true;try{const v=await api.setTtsVolume(Number(volume.value));volumeValue.textContent=v.volume+'%';note('TTS volume saved.','success')}catch(e){note(e.message,'error')}finally{busy.volume=false}});

for(const id of ['local-tts-enabled','local-tts-download','local-tts-page-idle','local-tts-page-delay','local-tts-resource-guard','local-tts-max-cpu','local-tts-min-ram']){
  $(id).addEventListener('change',()=>void saveLocalTtsSettings());
}
$('local-tts-max-cpu').addEventListener('input',()=>{$('local-tts-max-cpu-value').textContent=$('local-tts-max-cpu').value+'%'});
$('local-tts-min-ram').addEventListener('input',()=>{$('local-tts-min-ram-value').textContent=$('local-tts-min-ram').value+' GB'});
$('local-tts-page-delay').addEventListener('input',()=>{$('local-tts-page-delay-value').textContent=$('local-tts-page-delay').value+' seconds'});
$('local-tts-prepare').addEventListener('click',async()=>{
  const button=$('local-tts-prepare');button.disabled=true;
  try{renderLocalTtsStatus(await api.prepareLocalTts());note('Local Piper voice is ready.','success')}
  catch(error){renderLocalTtsStatus({status:error.code==='LOCAL_TTS_RESOURCE_GUARD'?'resource_guard_blocked':'error',error:error.message});note(error.message,'error')}
  finally{button.disabled=!$('local-tts-enabled').checked}
});
$('local-tts-test').addEventListener('click',async()=>{const button=$('local-tts-test');button.disabled=true;try{const result=await api.testLocalTts();note('Local Piper test playback started ('+String(result.engine||'local')+').','success')}catch(error){note('Local Piper test failed: '+error.message,'error')}finally{button.disabled=!$('local-tts-enabled').checked}});
for(const id of ['tts-mode','tts-captions-autoplay','tts-transparent-bg','tts-caption-position','tts-caption-theme']){
  $(id).addEventListener('change',()=>{applyTtsSettings(readTtsSettings());void saveTtsSettings()});
}
for(const id of ['tts-caption-x','tts-caption-y']){
  $(id).addEventListener('input',()=>{ $(id+'-value').textContent=$(id).value+'%'; $('tts-custom-position').hidden=$('tts-caption-position').value!=='custom'; });
  $(id).addEventListener('change',()=>void saveTtsSettings());
}
$('tts-caption-preview').addEventListener('click',async()=>{try{await api.previewCaptions();note('Caption preview opened.','success')}catch(e){note(e.message,'error')}});
$('save-now').addEventListener('click',async()=>{
  const b=$('save-now');b.disabled=true;
  try{if(dashboardSaveTimer){clearTimeout(dashboardSaveTimer);dashboardSaveTimer=null}await api.saveDashboardState(dashboardSnapshot());const result=await api.saveNow();$('save-status').textContent='Saved locally at '+new Date(result.savedAt).toLocaleTimeString();note('Application state saved locally.','success')}
  catch(e){note('Could not save application state: '+e.message,'error')}
  finally{b.disabled=false}
});
$('cloud-folder-choose').addEventListener('click',async()=>{
  const b=$('cloud-folder-choose');b.disabled=true;
  try{const r=await api.chooseCloudFolder();if(!r.canceled){renderCloudStatus({...r.status,folder:r.folder,enabled:$('cloud-sync-enabled').checked});note('Cloud folder configured. Enable live sync to share state.','success')}}
  catch(e){note('Could not configure cloud folder: '+e.message,'error')}
  finally{b.disabled=false}
});
$('cloud-sync-enabled').addEventListener('change',async()=>{
  const checkbox=$('cloud-sync-enabled');checkbox.disabled=true;
  try{const r=await api.configureCloudSync({enabled:checkbox.checked});renderCloudStatus({...r,folder:$('cloud-folder-path').textContent});if(r.error)note(r.error,'error');else note(r.enabled?'Live cloud sync enabled.':'Live cloud sync disabled.','success')}
  catch(e){checkbox.checked=!checkbox.checked;note(e.message,'error')}
  finally{checkbox.disabled=false}
});
$('cloud-sync-now').addEventListener('click',async()=>{
  const b=$('cloud-sync-now');b.disabled=true;
  try{const r=await api.syncCloudNow();renderCloudStatus({...r,folder:$('cloud-folder-path').textContent});if(r.error)note(r.error,'error');else note('Cloud sync completed.','success')}
  catch(e){note('Cloud sync failed: '+e.message,'error')}
  finally{b.disabled=!$('cloud-sync-enabled').checked}
});
$('vision-endpoint-connect').addEventListener('click',async()=>{
  const b=$('vision-endpoint-connect'),endpoint=$('vision-endpoint-url').value.trim();
  if(!endpoint){$('vision-status-details').textContent='Enter the HTTPS endpoint shown by the running Colab notebook.';return}
  b.disabled=true;$('vision-status-details').textContent='Validating endpoint and connecting…';
  try{const r=await api.connectColab(endpoint);$('vision-status-details').textContent=[r.status||'unknown',r.message||''].filter(Boolean).join(' · ');$('vision-status-details').dataset.state=r.connected?'success':r.status==='error'?'error':'';if(r.connected)note('Colab connected.','success')}
  catch(e){$('vision-status-details').textContent=e.message;$('vision-status-details').dataset.state='error'}
  finally{b.disabled=false}
});
$('vision-setup-check').addEventListener('click',async()=>{
  const b=$('vision-setup-check');b.disabled=true;$('vision-status-details').textContent='Running setup checks…';
  try{const r=await api.checkVisionSetup();const checks=r.checks&&typeof r.checks==='object'?Object.entries(r.checks).map(([name,item])=>name+': '+(item.status||'unknown')+(item.message?' — '+item.message:'')).join(' | '):'';$('vision-status-details').textContent=[r.status||'checked',checks,(Array.isArray(r.next_steps)?r.next_steps.join(' '):'')].filter(Boolean).join(' · ');$('vision-status-details').dataset.state=r.status==='passed'?'success':r.status==='failed'?'error':''}
  catch(e){$('vision-status-details').textContent=e.message;$('vision-status-details').dataset.state='error'}
  finally{b.disabled=false}
});

async function changeBrowserMode(){browserEnabled.disabled=true;try{const v=await api.setBrowserSettings({enabled:browserEnabled.checked,keepActive:keep.checked,lowMemory:low.checked});browserEnabled.checked=v.enabled===true;keep.checked=v.keepActive;low.checked=v.lowMemory;updateBrowserMode();note(v.enabled?'In-app browser enabled.':'In-app browser disabled; web links will open in your normal browser.','success')}catch(e){note(e.message,'error');await refresh()}finally{browserEnabled.disabled=false;updateBrowserMode()}}
browserEnabled.addEventListener('change',()=>void changeBrowserMode());
keep.addEventListener('change',()=>void changeBrowserMode());low.addEventListener('change',()=>void changeBrowserMode());

let assignmentState=null,assignmentWorkspaceRoot='',assignmentWorkspaceExplicit=false;

function closeAgentAssignment(){ const overlay=$('agent-assignment-overlay');overlay.classList.remove('is-visible');overlay.hidden=true;assignmentState=null;assignmentWorkspaceExplicit=false; }
function setAssignmentWorkspace(value,explicit=false){
  assignmentWorkspaceRoot=String(value||'');
  assignmentWorkspaceExplicit=explicit;
  $('agent-assignment-workspace-path').textContent=assignmentWorkspaceRoot||'Global default workspace';
}
function updateAssignmentRecentWorkspaces(agentId){
  const recent=$('agent-assignment-recent-workspace'),previous=recent.value;
  recent.replaceChildren();
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose a recent folder…';recent.append(placeholder);
  const all=assignmentState&&assignmentState.recentWorkspaceDefaults&&typeof assignmentState.recentWorkspaceDefaults==='object'?assignmentState.recentWorkspaceDefaults:{};
  const roots=Array.isArray(all[agentId])?all[agentId].filter(value=>typeof value==='string'&&value.trim()).slice(0,5):[];
  for(const root of roots){const option=document.createElement('option');option.value=root;option.textContent=root;option.title=root;recent.append(option)}
  recent.disabled=roots.length===0;
  recent.value=roots.includes(previous)?previous:'';
}
function showAgentAssignment(payload){
  if(!payload||typeof payload.requestId!=='string')return;
  assignmentState=payload;assignmentWorkspaceExplicit=false;
  const overlay=$('agent-assignment-overlay'),select=$('agent-assignment-id');
  $('agent-assignment-label').textContent='Session label: '+String(payload.label||'ChatGPT session');
  select.replaceChildren();
  const agents=Array.isArray(payload.agents)?payload.agents:[];
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose an available agent ID…';placeholder.disabled=true;placeholder.selected=true;select.append(placeholder);
  const available=agents.filter(agent=>agent&&typeof agent.agent_id==='string'&&agent.status==='inactive'&&agent.busy!==true&&agent.reusable!==false);
  for(const agent of available){
    const option=document.createElement('option');option.value=agent.agent_id;
    option.textContent=agent.agent_id+' · '+String(agent.status||'inactive');select.append(option);
  }
  const highestAgentNumber=agents.reduce((highest,agent)=>Math.max(highest,Number(String(agent&&agent.agent_id||'').slice(6))||0),0);
  const newAgentId='agent-'+String(highestAgentNumber+1).padStart(3,'0');
  const next=document.createElement('option');next.value=newAgentId;next.textContent=newAgentId+' · new agent';select.append(next);
  $('agent-assignment-auto').checked=false;
  $('agent-assignment-manual-fields').hidden=false;
  $('agent-assignment-message').value='';
  const updateWorkspace=()=>{
    const id=select.value,defaults=payload.workspaceDefaults&&typeof payload.workspaceDefaults==='object'?payload.workspaceDefaults:{};
    setAssignmentWorkspace(typeof defaults[id]==='string'&&defaults[id]?defaults[id]:String(payload.defaultWorkspace||''),false);
    updateAssignmentRecentWorkspaces(id);
  };
  updateWorkspace();select.onchange=updateWorkspace;
  const suggestion=payload.workspaceSuggestion&&typeof payload.workspaceSuggestion==='object'?payload.workspaceSuggestion:null;
  const suggestionHost=$('agent-assignment-suggestion');suggestionHost.hidden=!suggestion;
  $('agent-assignment-suggestion-path').textContent=suggestion?String(suggestion.path||''):'';
  $('agent-assignment-suggestion-reason').textContent=suggestion?String(suggestion.reason||''):'';
  $('agent-assignment-use-suggestion').disabled=!suggestion;
  $('agent-assignment-use-suggestion').onclick=()=>{
    if(!suggestion)return;
    setAssignmentWorkspace(suggestion.path,true);
    $('agent-assignment-status').textContent='Suggested directory selected for this conversation only; saved defaults will not change.';
    $('agent-assignment-status').dataset.state='success';
  };
  $('agent-assignment-keep-default').onclick=()=>{
    updateWorkspace();
    $('agent-assignment-status').textContent='Current agent/global default retained.';
    $('agent-assignment-status').dataset.state='';
  };
  $('agent-assignment-recent-workspace').onchange=event=>{
    const chosen=event.target.value;
    if(chosen)setAssignmentWorkspace(chosen,true);
  };
  $('agent-assignment-auto').onchange=()=>{
    const automatic=$('agent-assignment-auto').checked;
    $('agent-assignment-manual-fields').hidden=automatic;
    if(!automatic&&!select.value)updateWorkspace();
  };
  $('agent-assignment-status').textContent='Choose an agent and workspace, then confirm. This request expires after 90 seconds; Keep waiting adds 60 seconds.';
  $('agent-assignment-status').dataset.state='';
  $('agent-assignment-confirm').disabled=false;
  $('agent-assignment-extend').disabled=false;
  overlay.hidden=false;overlay.classList.remove('is-visible');requestAnimationFrame(()=>overlay.classList.add('is-visible'));select.focus();
}
async function chooseAssignmentWorkspace(){
  const button=$('agent-assignment-choose-workspace');button.disabled=true;
  try{
    const result=await api.chooseAgentAssignmentWorkspace();
    if(!result.canceled){setAssignmentWorkspace(result.workspaceRoot,true);$('agent-assignment-recent-workspace').value=''}
  }catch(error){$('agent-assignment-status').textContent='Could not choose workspace: '+error.message;$('agent-assignment-status').dataset.state='error'}
  finally{button.disabled=false}
}
async function submitAgentAssignment(cancelled=false){
  if(!assignmentState)return;
  const button=$('agent-assignment-confirm');
  const autoAssign=$('agent-assignment-auto').checked;
  const selectedAgentId=$('agent-assignment-id').value;
  if(!cancelled&&!autoAssign&&!selectedAgentId){
    $('agent-assignment-status').textContent='Select an agent ID or choose a new agent ID before starting the session.';
    $('agent-assignment-status').dataset.state='error';
    $('agent-assignment-id').focus();
    button.disabled=false;
    return;
  }
  button.disabled=true;
  const payload={requestId:assignmentState.requestId,cancelled,autoAssign,
    agentId:selectedAgentId,workspaceRoot:(!autoAssign||assignmentWorkspaceExplicit)?assignmentWorkspaceRoot:null,
    message:$('agent-assignment-message').value.trim()};
  try{
    await api.respondAgentAssignment(payload);closeAgentAssignment();
    note(cancelled?'Session start cancelled.':'Agent assignment confirmed. Creating session…',cancelled?'':'success');
  }catch(error){$('agent-assignment-status').textContent=error.message;$('agent-assignment-status').dataset.state='error';button.disabled=false}
}
$('agent-assignment-choose-workspace').addEventListener('click',()=>void chooseAssignmentWorkspace());
$('agent-assignment-extend').addEventListener('click',async()=>{
  if(!assignmentState)return;
  const button=$('agent-assignment-extend');button.disabled=true;
  try{
    const result=await api.extendAgentAssignment(assignmentState.requestId);
    if(result&&result.extended){
      $('agent-assignment-status').textContent='Still waiting. Added 60 seconds ('+result.extensionsRemaining+' extensions remaining).';
      $('agent-assignment-status').dataset.state='success';
      button.disabled=!(result.extensionsRemaining>0);
    }else{
      $('agent-assignment-status').textContent='The maximum number of extensions has been used.';
      $('agent-assignment-status').dataset.state='error';button.disabled=true;
    }
  }catch(error){
    $('agent-assignment-status').textContent='Could not extend assignment: '+String(error&&error.message||error);
    $('agent-assignment-status').dataset.state='error';button.disabled=false;
  }
});
$('agent-assignment-confirm').addEventListener('click',()=>void submitAgentAssignment(false));
$('agent-assignment-cancel').addEventListener('click',()=>void submitAgentAssignment(true));
$('agent-assignment-auto').addEventListener('change',()=>{$('agent-assignment-manual-fields').hidden=$('agent-assignment-auto').checked});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&assignmentState){event.preventDefault();void submitAgentAssignment(true)}});
api.onAgentAssignmentRequested(showAgentAssignment);
api.onAgentAssignmentDismissed(payload=>{if(assignmentState&&payload.requestId===assignmentState.requestId){closeAgentAssignment();note('Agent assignment expired. No session was created.','error')}});

$('add-agent-widget').addEventListener('click',async()=>{try{const r=await api.addAgentWidget();note('Added '+r.agentId+'.','success');await refresh()}catch(error){note('Could not add agent widget: '+error.message,'error')}});
const contextMenu=$('widget-context-menu');
mainPage.addEventListener('contextmenu',event=>{event.preventDefault();contextMenu.hidden=false;const rect=mainPage.getBoundingClientRect();contextMenu.style.left=Math.max(8,Math.min(rect.width-200,event.clientX-rect.left))+'px';contextMenu.style.top=Math.max(8,Math.min(rect.height-100,event.clientY-rect.top))+'px'});
document.addEventListener('pointerdown',event=>{if(!contextMenu.hidden&&!contextMenu.contains(event.target))contextMenu.hidden=true});
contextMenu.addEventListener('click',event=>{const action=event.target.closest('[data-widget-action]')?.dataset.widgetAction;contextMenu.hidden=true;if(action==='arrange')autoArrangeWidgets();if(action==='add-agent')void api.addAgentWidget().then(refresh).catch(error=>note(error.message,'error'))});
function autoArrangeWidgets(){
  const width=mainPage.clientWidth||window.innerWidth||1200,gap=16,margin=24,leftWidth=Math.min(360,Math.max(270,Math.round(width*.28)));
  const cardWidth=Math.min(360,Math.max(200,width-leftWidth-margin*2-gap)),cardHeight=320;
  Object.assign(queue.style,{left:margin+'px',top:'28px',width:leftWidth+'px'});widgetMoved.queues=true;
  const queueBottom=queue.offsetTop+queue.offsetHeight;
  Object.assign(controls.style,{left:margin+'px',top:(queueBottom+gap)+'px',width:leftWidth+'px'});widgetMoved.controls=true;
  const hasRightColumn=width>=leftWidth+cardWidth+margin*2+gap;
  const startX=hasRightColumn?margin+leftWidth+gap:margin;
  let x=startX,y=hasRightColumn?24:controls.offsetTop+controls.offsetHeight+gap,col=0;const columns=Math.max(1,Math.floor((width-startX-margin+gap)/(cardWidth+gap)));
  for(const [id,el] of [...agentWidgets.entries()].sort((a,b)=>Number(a[0].slice(6))-Number(b[0].slice(6)))){
    Object.assign(el.style,{left:x+'px',top:y+'px',width:cardWidth+'px',height:cardHeight+'px'});
    savedWidgetLayout[id]={x,y,width:cardWidth,height:cardHeight};widgetMoved[id]=true;
    if(++col>=columns){col=0;x=startX;y+=cardHeight+gap}else{x+=cardWidth+gap}
  }
  updateAgentCanvasHeight();scheduleSaveDashboardState();note('Widgets arranged into a compact grid.','success');
}
let autoDumpEditingAgent='';
$('agent-delete-cancel').addEventListener('click',()=>{
  pendingAgentDelete=null;
  $('agent-delete-dialog').close();
});
$('agent-delete-confirm').addEventListener('click',async()=>{
  if(!pendingAgentDelete)return;
  const {agentId,sessionId}=pendingAgentDelete;
  const button=$('agent-delete-confirm');
  button.disabled=true;
  button.textContent='Revoking…';
  $('agent-delete-error').textContent='';
  const wipeMailbox=$('agent-delete-wipe-mailbox').checked===true;
  try{
    const result=await api.deleteAgentWidget(agentId,sessionId,wipeMailbox);
    const cleanup=result&&result.mailbox_cleanup||{};
    if(wipeMailbox&&cleanup.status!=='completed'){
      // The session is already revoked and the widget is hidden. Keep the
      // confirmation open so incomplete/failed mailbox cleanup can be retried.
      pendingAgentDelete={agentId,sessionId};
      const detail=cleanup.status==='failed'
        ? String(cleanup.error||'Mailbox cleanup failed.')
        : ['Preserved '+Number(cleanup.preserved_request_records||0)+' non-terminal or incomplete request records.',
            cleanup.preservation_note || 'The mailbox scan did not confirm that every attributable record was removed.'].filter(Boolean).join(' ');
      $('agent-delete-error').textContent='Session revoked and widget removed. Mailbox cleanup is not complete. '+detail+' You can retry this wipe after outstanding operations settle.';
      note('Session revoked and widget removed; mailbox cleanup needs a retry.','error');
      button.disabled=false;
      await refresh();
      return;
    }
    pendingAgentDelete=null;
    $('agent-delete-dialog').close();
    if(wipeMailbox){
      note('Session revoked, widget removed, and '+Number(cleanup.deleted_files||0)+' attributable mailbox files cleaned.','success');
    }else if(sessionId){
      note('Session revoked and widget removed. The agent ID remains available for reassignment.','success');
    }else{
      note('Empty agent widget removed. No conversation session was active.','success');
    }
    await refresh();
  }catch(error){
    $('agent-delete-error').textContent='Deletion failed: '+String(error&&error.message||error);
    button.disabled=false;
  }finally{
    button.textContent=pendingAgentDelete?'Retry mailbox wipe':'Delete and revoke';
  }
});
$('agent-autodump-cancel').addEventListener('click',()=>$('agent-autodump-dialog').close());
$('agent-autodump-save').addEventListener('click',async()=>{
  const id=autoDumpEditingAgent;if(!id)return;
  const count=$('agent-autodump-count'),age=$('agent-autodump-age');
  if(!count.reportValidity()||!age.reportValidity())return;
  const button=$('agent-autodump-save');button.disabled=true;
  try{const current=await api.getAgentWidgetSettings(id);await api.setAgentWidgetSettings(id,{nickname:current.nickname,maxCount:Number(count.value),maxAgeMinutes:Number(age.value),exclusions:$('agent-autodump-exclusions').value.split(',')});$('agent-autodump-dialog').close();note('Auto-dump settings saved for '+id+'.','success');await refresh()}
  catch(error){note('Could not save autodump settings: '+error.message,'error')}
  finally{button.disabled=false;autoDumpEditingAgent=''}
});
$('task-board-refresh').addEventListener('click',()=>void loadTaskDashboard());
$('task-board-project').addEventListener('change',()=>renderTaskDashboard(taskDashboardData));
api.onBridgeState(renderWorker);api.onGitHubState(renderGitHub);
api.onPrepareForTray(async payload=>{
  if(dashboardSaveTimer){clearTimeout(dashboardSaveTimer);dashboardSaveTimer=null}
  const state=dashboardSnapshot();let saved=state;
  try{saved=await api.saveDashboardState(state)}catch(e){note('Saving before tray minimization failed: '+e.message,'error')}
  try{await api.acknowledgeTrayState(String(payload.requestId||''),saved)}catch(e){note('Tray state acknowledgement failed: '+e.message,'error')}
});
api.onBrowserTabsChanged(syncBrowserTabs);api.onBrowserTabOpened(activateOpenedBrowserTab);api.onDashboardState(applyDashboardState);api.onPreferences(s=>{if(s.dashboardTheme)applyTheme(s.dashboardTheme);if(s.ttsSettings)applyTtsSettings(s.ttsSettings);if(s.localTts)applyLocalTtsSettings(s.localTts);if(Number.isFinite(s.ttsVolume)&&!busy.volume){volume.value=String(s.ttsVolume);volumeValue.textContent=s.ttsVolume+'%'}});api.onCloudSyncStatus(renderCloudStatus);api.onBrowserMemory(v=>{if(Number.isFinite(v.privateMb)){memory.textContent=v.privateMb.toFixed(1)+' MB';memory.title=v.privateMb>100?'Over the 100 MB target. Chromium does not guarantee a hard per-site memory limit.':'Memory used by the active embedded page renderer.'}else{memory.textContent='Unavailable';memory.title='Electron did not expose a memory metric for the active embedded renderer.'}});api.onColabHandoffResult(v=>{if(v.message)note(v.message,v.connected?'success':'error')});api.onLocalTtsStatus(renderLocalTtsStatus);
window.addEventListener('resize',()=>{
  if(!widgetMoved.queues)queue.style.width=Math.min(360,Math.max(270,Math.round(mainPage.clientWidth*0.28)))+'px';
  positionControls();
  let layoutChanged=false;
  if(!mainPage.hidden&&mainPage.clientWidth>0){
    for(const [id,el] of agentWidgets){
      const width=Math.min(el.offsetWidth,Math.max(180,mainPage.clientWidth-24));
      const left=Math.max(0,Math.min(Math.max(0,mainPage.clientWidth-width),el.offsetLeft));
      const top=Math.max(0,el.offsetTop);
      if(width!==el.offsetWidth||left!==el.offsetLeft||top!==el.offsetTop){
        Object.assign(el.style,{left:left+'px',top:top+'px',width:width+'px'});
        savedWidgetLayout[id]={x:left,y:top,width,height:el.offsetHeight};
        layoutChanged=true;
      }
    }
  }
  renderAgentMailboxes(bridge.agentMailboxes);
  if(layoutChanged)scheduleSaveDashboardState();
  updateBrowserBounds()
});window.addEventListener('beforeunload',()=>{ro.disconnect();if(dashboardSaveTimer)clearTimeout(dashboardSaveTimer);if(refreshTimer)clearInterval(refreshTimer)});
applyTheme('midnight');renderTabs();setPage();void api.getBrowserTabs().then(syncBrowserTabs).catch(()=>{});void refresh();refreshTimer=window.setInterval(()=>void refresh(),7000);
})();