(()=>{'use strict';
const $=id=>document.getElementById(id),api=window.windowsBridge;
const mainPage=$('main-page'),settingsPage=$('settings-page'),browserPage=$('browser-page'),browserHost=$('browser-host'),queue=$('queues-widget'),controls=$('controls-widget'),tabList=$('tab-list'),agentWidgetHost=$('agent-widget-host');
const workerDot=$('worker-dot'),workerStatus=$('worker-status'),githubStatus=$('github-status'),message=$('dashboard-message'),obs=$('observe-toggle'),acceptBtn=$('auto-accept-toggle'),colab=$('quick-colab-connect'),workspace=$('workspace-button'),repoForm=$('repo-form'),repoMsg=$('repo-message'),volume=$('tts-volume'),volumeValue=$('tts-volume-value'),fps=$('observe-fps'),themeSelect=$('theme-select'),themeGallery=$('theme-gallery'),browserEnabled=$('browser-enabled'),keep=$('browser-keep-active'),low=$('browser-low-memory'),memory=$('browser-memory');
let tabs=[{id:'main',kind:'main',label:'Main',closable:false},{id:'settings',kind:'settings',label:'Settings',closable:true}],active='main',bridge={},github={},observe={},autoAccept=false,dragId=null,gesture=null;
let busy={observe:false,accept:false,colab:false,workspace:false,github:false,repo:false,volume:false};let widgetMoved={queues:false,controls:false};const agentWidgets=new Map(),openAgentDetails=new Set();let savedWidgetLayout={};const grid=12,minW=180,minH=100;
function note(t,s=''){message.textContent=String(t||'');message.dataset.state=s}

let browserTabData=[],dashboardStateLoaded=false,suppressDashboardSave=false,dashboardSaveTimer=null,refreshTimer=null;
let refreshInFlight=false,refreshRequested=false,lastBrowserActivation=Symbol('unset');
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
async function applyInitialSettings(settings){
  const s=settings&&typeof settings==='object'?settings:{};if(themeIds.includes(s.dashboardTheme))applyTheme(s.dashboardTheme);
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
function updateAgentCanvasHeight(){
  if(!agentWidgetHost||!mainPage)return;
  let bottom=Math.max(
    (queue.offsetTop||0)+(queue.offsetHeight||0)+24,
    (controls.offsetTop||0)+(controls.offsetHeight||0)+24,
    mainPage.clientHeight||0
  );
  for(const card of agentWidgets.values())bottom=Math.max(bottom,card.offsetTop+card.offsetHeight+24);
  agentWidgetHost.style.height=Math.max(1,bottom)+'px';
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
  identity.append(name,sessionLine);
  const status=document.createElement('span');status.className='agent-console-status';
  const busy=document.createElement('span');busy.className='agent-console-busy';
  const counts=document.createElement('span');counts.className='agent-console-counts';
  header.append(identity,status,busy,counts);
  const body=document.createElement('div');body.className='agent-console-body';body.dataset.noWidgetDrag='true';
  card.append(header,body);agentWidgetHost.append(card);agentWidgets.set(agent.agent_id,card);attachWidgetGesture(card);
  return card;
}
function renderAgentMailboxes(rawAgents){
  if(!agentWidgetHost)return;
  const all=Array.isArray(rawAgents)?rawAgents:[];
  const agents=all.filter(agent=>agent&&typeof agent.agent_id==='string'&&/^agent-[0-9]{3,}$/.test(agent.agent_id));
  const count=$('agent-mailbox-count');if(count)count.textContent=agents.length+' seat'+(agents.length===1?'':'s');
  agents.forEach((agent,index)=>{
    let card=agentWidgets.get(agent.agent_id);
    if(!card)card=makeAgentWidget(agent,index);
    if(!savedWidgetLayout[agent.agent_id]&&!widgetMoved[agent.agent_id]){
      const layout=agentLayoutFor(agent.agent_id,index);
      Object.assign(card.style,{left:layout.x+'px',top:layout.y+'px',width:layout.width+'px',height:layout.height+'px'});
    }
    const header=card.querySelector('.agent-console-header');
    const name=header.querySelector('.agent-console-name');
    const sessionLine=header.querySelector('.agent-console-session');
    const status=header.querySelector('.agent-console-status');
    const busy=header.querySelector('.agent-console-busy');
    const counts=header.querySelector('.agent-console-counts');
    // The panel belongs to the seat, not the task/session label. Individual
    // requests and their tool names remain listed in the console body below.
    name.textContent=String(agent.agent_id);
    sessionLine.textContent='SESSION '+String(agent.session_id||'none');
    sessionLine.title=String(agent.session_id||'No conversation currently owns this seat');
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
    const requests=Array.isArray(agent.requests)?agent.requests:[];
    if(!requests.length){
      const idle=document.createElement('div');idle.className='agent-console-empty';
      const last=agent.last_activity_at||agent.last_seen_at;
      idle.textContent=last?'Last activity '+String(last):'No bridge-tool activity recorded yet';
      body.append(idle);
    }else{
      for(const request of requests){
        const row=document.createElement('article');row.className='agent-request';
        const titleLine=document.createElement('div');titleLine.className='agent-request-title';
        const tool=document.createElement('strong');tool.className='agent-tool-name';
        tool.textContent=String(request.tool||'unknown tool');tool.title='Exact registered tool name';
        const reqStatus=String(request.status||'queued');
        const stage=document.createElement('span');
        stage.className='agent-request-stage '+(['completed','partial','failed','rejected','cancelled'].includes(reqStatus)?'is-terminal':['queued','loading','claiming'].includes(reqStatus)?'is-queued':'is-running');
        stage.textContent=reqStatus;titleLine.append(tool,stage);
        const id=document.createElement('div');id.className='agent-request-id';id.textContent=String(request.request_id||'');id.title=String(request.request_id||'');
        row.append(titleLine,id);
        if(request.error){const error=document.createElement('div');error.className='agent-request-error';error.textContent=String(request.error);row.append(error)}
        const progressLine=document.createElement('div');progressLine.className='agent-progress-line';
        const progress=document.createElement('progress');progress.className='agent-progress';progress.max=100;
        progress.value=Math.max(0,Math.min(100,Number(request.progress)||0));progress.setAttribute('aria-label',String(request.tool||'request')+' stage progress');
        const percent=document.createElement('span');percent.className='agent-progress-value';percent.textContent=Math.round(progress.value)+'%';
        progressLine.append(progress,percent);row.append(progressLine);
        const json=document.createElement('div');json.className='agent-json-group';
        appendConsoleJsonDetails(json,'Request JSON',request.request_json);
        appendConsoleJsonDetails(json,'Claim JSON',request.claim_json);
        appendConsoleJsonDetails(json,'Result JSON',request.result_json);
        for(const detail of json.querySelectorAll('details')){
          const key=agent.agent_id+'|'+String(request.request_id||'')+'|'+detail.querySelector('summary').textContent;
          detail.dataset.detailKey=key;
          detail.open=openAgentDetails.has(key);
          detail.addEventListener('toggle',()=>{if(detail.open)openAgentDetails.add(key);else openAgentDetails.delete(key)});
        }
        row.append(json);body.append(row);
      }
    }
    body.scrollTop=scrollTop;
  });
  updateAgentCanvasHeight();
}
function positionControls(){if(widgetMoved.controls)return;const width=mainPage.clientWidth||window.innerWidth||1200;controls.style.left='24px';controls.style.top=snap((queue.offsetTop||28)+(queue.offsetHeight||150)+18)+'px';controls.style.width=Math.min(360,Math.max(270,Math.round(width*0.28)))+'px'}
function renderWorker(v){bridge=v||{};const s=String(bridge.workerStatus||bridge.status||(bridge.running?'online':'connecting')).toLowerCase();workerStatus.textContent=s==='online'?'Worker online':s==='reconnecting'?'Worker reconnecting · retrying mailbox':s==='offline'?'Worker offline':s==='attention'?'Worker needs attention':s==='setup'?'Worker setup required':'Worker connecting…';setDot(workerDot,s==='online'?'online':['offline','attention','setup'].includes(s)?'error':'waiting');renderAgentMailboxes(bridge.agentMailboxes);renderQueues(Number(bridge.activeCount||0),Number(bridge.pendingCount||0));autoAccept=bridge.autoAcceptAll===true;renderAccept()}
function renderGitHub(v){github=v||{};githubStatus.textContent=github.authenticated?'GitHub connected':github.verificationPending?'GitHub verifying…':'GitHub not connected';$('github-detail').textContent=github.authenticated?'Signed in as '+(github.login||'GitHub user'):'GitHub not connected';$('github-connect').textContent=github.authenticated?'Reconnect':'Sign in'}
function renderWorkspace(v){const root=String(v&&v.root||''),leaf=root.split(/[\\/]/).filter(Boolean).pop()||root;$('workspace-status').textContent=root?(/^[a-z]:[\\/]?$/i.test(root)?'Entire drive '+root:leaf):'Choose a folder or drive';$('workspace-detail').textContent=root||'No workspace selected';$('workspace-description').textContent=root?'Local path selected for bridge file operations.':'Choose a local folder or drive.';workspace.title=root}
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
      renderWorkspace(s.workspace||{});
      if(!dashboardStateLoaded){
        await applyInitialSettings(s.settings||{});
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
function endGesture(){if(!gesture)return;const g=gesture,el=g.el;el.classList.remove('dragging','resizing');const r=mainPage.getBoundingClientRect();let x=snap(el.offsetLeft),y=snap(el.offsetTop),w=Math.max(minW,snap(el.offsetWidth)),h=Math.max(minH,snap(el.offsetHeight));x=Math.max(0,Math.min(Math.max(0,r.width-w),x));if(!el.classList.contains('agent-console'))y=Math.max(0,Math.min(Math.max(0,r.height-h),y));else y=Math.max(0,y);Object.assign(el.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});widgetMoved[el.dataset.widget]=true;gesture=null;if(el===queue)positionControls();updateAgentCanvasHeight();scheduleSaveDashboardState()}
for(const el of [queue,controls])attachWidgetGesture(el)
obs.addEventListener('click',async()=>{if(busy.observe)return;busy.observe=true;obs.disabled=true;try{observe=await api.setObserveEnabled(!observe.enabled);renderObserve();note('Observe mode updated.','success')}catch(e){note(e.message,'error')}finally{busy.observe=false;obs.disabled=false}});
acceptBtn.addEventListener('click',async()=>{if(busy.accept)return;busy.accept=true;acceptBtn.disabled=true;try{const r=await api.setAutoAcceptAll(!autoAccept);autoAccept=Boolean(r.autoAcceptAll);renderAccept();note(autoAccept?'Auto-accept enabled after confirmation.':'Auto-accept disabled.','success')}catch(e){note(e.message,'error')}finally{busy.accept=false;acceptBtn.disabled=false}});
fps.addEventListener('change',async()=>{try{observe=await api.setObserveFps(Number(fps.value));renderObserve()}catch(e){note(e.message,'error')}});
async function chooseWorkspace(){if(busy.workspace)return;busy.workspace=true;try{const r=await api.selectWorkspace();if(!r.canceled){renderWorkspace(r.workspace);note('Workspace updated.','success')}}catch(e){note(e.message,'error')}finally{busy.workspace=false}}
workspace.addEventListener('click',()=>void chooseWorkspace());$('settings-workspace-button').addEventListener('click',()=>void chooseWorkspace());
$('minimize-to-tray').addEventListener('click',()=>void api.minimizeToTray().catch(e=>note(e.message,'error')));
$('quit-app').addEventListener('click',()=>void api.quit().catch(e=>note(e.message,'error')));
colab.addEventListener('click',async()=>{if(busy.colab)return;busy.colab=true;colab.disabled=true;colab.querySelector('small').textContent='Opening Colab…';try{const opened=await api.openColabTab();syncBrowserTabs(await api.getBrowserTabs());const tab=tabs.find(v=>v.kind==='browser'&&v.browserId===opened.id);if(tab){active=tab.id;setPage()}const result=await api.connectColab();const currentTabs=await api.getBrowserTabs();syncBrowserTabs(currentTabs);const colabTab=currentTabs.find(v=>v.url&&v.url.startsWith('https://colab.research.google.com/'));const activeColabTab=colabTab&&tabs.find(v=>v.kind==='browser'&&v.browserId===colabTab.id);if(activeColabTab){active=activeColabTab.id;setPage()}$('colab-status').textContent=result.message||result.status||'Connection requested';note(result.message||'Colab connection requested.',result.connected?'success':'')}catch(e){$('colab-status').textContent=e.message;note(e.message,'error')}finally{busy.colab=false;colab.disabled=false}});
$('github-connect').addEventListener('click',async()=>{if(busy.github)return;busy.github=true;$('github-connect').disabled=true;try{const cur=await api.getGitHubState(),flow=cur.authenticated?await api.reconnectGitHub():await api.startGitHubLogin();if(flow&&flow.userCode){note('GitHub device code: '+flow.userCode+' — complete authorization in the browser.');let n=0;const poll=async()=>{if(!busy.github)return;try{const s=await api.pollGitHubLogin();if(s.status==='authenticated'){busy.github=false;$('github-connect').disabled=false;await refresh();return}if(s.status==='error'){note(s.message||'GitHub sign-in failed.','error');busy.github=false;$('github-connect').disabled=false;return}}catch{}if(++n<200)window.setTimeout(poll,3000);else{busy.github=false;$('github-connect').disabled=false;note('GitHub authorization polling stopped.','error')}};window.setTimeout(poll,3000)}else{await refresh();busy.github=false;$('github-connect').disabled=false}}catch(e){note(e.message,'error');busy.github=false;$('github-connect').disabled=false}});
repoForm.addEventListener('submit',async e=>{e.preventDefault();if(busy.repo)return;busy.repo=true;repoMsg.textContent='Validating and switching repository…';try{const r=await api.setRepositoryBridgeConfig({owner:$('repo-owner').value.trim(),repo:$('repo-name').value.trim(),branch:$('repo-branch').value.trim(),allowPublicMailbox:$('allow-public-mailbox').checked});repoMsg.textContent='Repository saved and worker restarted.';repoMsg.dataset.state='success';note('Bridge environment repository updated.','success');renderWorker(r.bridge||{})}catch(e){repoMsg.textContent=e.message;repoMsg.dataset.state='error';note(e.message,'error');await refresh()}finally{busy.repo=false}});
themeSelect.addEventListener('change',()=>void chooseTheme(themeSelect.value));themeGallery.addEventListener('click',e=>{const card=e.target.closest('[data-theme-id]');if(card&&themeIds.includes(card.dataset.themeId))void chooseTheme(card.dataset.themeId)});
volume.addEventListener('input',()=>volumeValue.textContent=volume.value+'%');volume.addEventListener('change',async()=>{if(busy.volume)return;busy.volume=true;try{const v=await api.setTtsVolume(Number(volume.value));volumeValue.textContent=v.volume+'%';note('TTS volume saved.','success')}catch(e){note(e.message,'error')}finally{busy.volume=false}});

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
api.onBridgeState(renderWorker);api.onGitHubState(renderGitHub);
api.onPrepareForTray(async payload=>{
  if(dashboardSaveTimer){clearTimeout(dashboardSaveTimer);dashboardSaveTimer=null}
  const state=dashboardSnapshot();let saved=state;
  try{saved=await api.saveDashboardState(state)}catch(e){note('Saving before tray minimization failed: '+e.message,'error')}
  try{await api.acknowledgeTrayState(String(payload.requestId||''),saved)}catch(e){note('Tray state acknowledgement failed: '+e.message,'error')}
});
api.onBrowserTabsChanged(syncBrowserTabs);api.onBrowserTabOpened(activateOpenedBrowserTab);api.onDashboardState(applyDashboardState);api.onPreferences(s=>{if(s.dashboardTheme)applyTheme(s.dashboardTheme);if(s.ttsSettings)applyTtsSettings(s.ttsSettings);if(Number.isFinite(s.ttsVolume)&&!busy.volume){volume.value=String(s.ttsVolume);volumeValue.textContent=s.ttsVolume+'%'}});api.onCloudSyncStatus(renderCloudStatus);api.onBrowserMemory(v=>{if(Number.isFinite(v.privateMb)){memory.textContent=v.privateMb.toFixed(1)+' MB';memory.title=v.privateMb>100?'Over the 100 MB target. Chromium does not guarantee a hard per-site memory limit.':'Memory used by the active embedded page renderer.'}else{memory.textContent='Unavailable';memory.title='Electron did not expose a memory metric for the active embedded renderer.'}});api.onColabHandoffResult(v=>{if(v.message)note(v.message,v.connected?'success':'error')});
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