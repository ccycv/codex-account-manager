'use strict';
// Usage page: cost / tokens / limits across Codex and Claude Code. Shares helpers and
// state with app.js (classic scripts share one global scope).
window.UsagePage=(()=>{
  const A=Analytics,ns='http://www.w3.org/2000/svg';
  const opts={range:readPref('usage-range','24h'),measure:readPref('usage-measure','cost'),group:readPref('usage-group','model'),
    provider:readPref('usage-provider','all'),account:readPref('usage-account','all')};
  if(!['24h','7d','30d','90d'].includes(opts.range))opts.range='24h';
  if(!['cost','tokens','limits'].includes(opts.measure))opts.measure='cost';
  if(!['model','account','project','time'].includes(opts.group))opts.group='model';
  let lastState='',data=null,loading=false,expanded=false,timer=null,seq=0,error=null;

  function glyph(provider){
    const s=document.createElementNS(ns,'svg');s.setAttribute('viewBox','0 0 16 16');s.setAttribute('class','u-glyph');s.setAttribute('aria-hidden','true');
    const p=document.createElementNS(ns,'path');
    // Generic marks, not brand logos: a burst for Claude Code, a hexagon for Codex.
    p.setAttribute('d',provider==='claude-code'?'M8 1.5v13 M1.5 8h13 M3.4 3.4l9.2 9.2 M12.6 3.4l-9.2 9.2':'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z M8 5.6l2.1 1.2v2.4L8 10.4 5.9 9.2V6.8z');
    s.style.color=A.PROVIDERS[provider]?.color||'#999';s.append(p);return s;
  }
  const fmt=v=>opts.measure==='tokens'?A.compact(v):A.money(v);
  const otherFmt=(row)=>opts.measure==='tokens'?A.money(row.cost):A.compact(row.tokens);
  function claudeName(key){
    const list=data?.claudeAccounts||[],i=list.indexOf(key),dir=key.slice(7);
    return privacy?'Claude profile '+(i+1||''):'Claude Code · ~/'+dir;
  }
  function accountName(key){
    if(key==='claude-code')return 'Claude Code';
    if(key.startsWith('claude:'))return claudeName(key);
    if(key==='unassigned')return privacy?'Unassigned history':'Unassigned Codex history';
    const saved=state?.accounts.find(a=>Usage.localId(a)===key);if(saved)return name(saved);
    const known=state?.localUsage?.accounts?.find(a=>a.id===key)||data?.accounts?.find(a=>a.id===key);
    return known?Privacy.name(known,state,privacy):(privacy?'Account':'Removed account');
  }
  let projectAliases=new Map();
  function projectName(key){if(!privacy)return key;if(!projectAliases.has(key))projectAliases.set(key,'Project '+(projectAliases.size+1));return projectAliases.get(key);}
  function rowName(row){
    if(opts.group==='account')return accountName(row.key);
    if(opts.group==='project')return projectName(row.key);
    if(opts.group==='time')return A.bucketLabel(row.t,data.bucket,{long:true});
    return row.key;
  }

  function query(){return new URLSearchParams({range:opts.range,provider:opts.provider,account:opts.account}).toString();}
  async function load(){
    if(opts.measure==='limits'){render();return;}
    const id=++seq;loading=true;renderStatus();
    try{const r=await request('usage?'+query());if(id!==seq)return;data=r.loading?null:r;error=null;}
    catch(e){if(id!==seq)return;error=e.message;}
    finally{if(id===seq){loading=false;render();}}
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(page==='usage'&&!document.hidden)load();else schedule();},data?.index?.pendingBytes?4000:15000);}

  function renderControls(){
    for(const b of document.querySelectorAll('#usage-view [data-range]'))b.setAttribute('aria-pressed',String(b.dataset.range===opts.range));
    for(const b of document.querySelectorAll('#usage-view [data-measure]'))b.setAttribute('aria-pressed',String(b.dataset.measure===opts.measure));
    for(const b of document.querySelectorAll('#usage-view [data-group]'))b.setAttribute('aria-pressed',String(b.dataset.group===opts.group));
    for(const b of document.querySelectorAll('#usage-view [data-range]'))b.disabled=opts.measure==='limits';
    $('u-provider').value=opts.provider;$('u-provider').disabled=opts.measure==='limits'||opts.account!=='all';
    const options=[['all','All accounts']];
    const ids=new Set();
    for(const a of state?.accounts||[]){const id=Usage.localId(a);ids.add(id);options.push([id,name(a)]);}
    for(const a of data?.accounts||[])if(!ids.has(a.id)){ids.add(a.id);options.push([a.id,accountName(a.id)]);}
    options.push(['unassigned',privacy?'Unassigned history':'Unassigned Codex history']);
    for(const key of data?.claudeAccounts||[])options.push([key,claudeName(key)]);
    const sig=JSON.stringify(options),select=$('u-account');
    if(select.dataset.signature!==sig){select.replaceChildren(...options.map(([v,l])=>{const o=el('option',l);o.value=v;return o;}));select.dataset.signature=sig;}
    if(!options.some(([v])=>v===opts.account))opts.account='all';
    select.value=opts.account;select.disabled=opts.measure==='limits';
    $('u-group-time').textContent=data?.bucket==='day'?'Day':data?.bucket==='hour4'?'4 hours':'Hour';
  }
  function renderStatus(){
    const s=$('u-status'),idx=data?.index;let text='';
    if(error)text=privacy?'Usage could not be loaded.':error;
    else if(!data&&loading)text='Reading local usage…';
    else if(!data)text='Building the usage index from local Codex and Claude Code logs…';
    else if(idx?.pendingBytes)text=`Importing local history · ${A.compact(idx.pendingBytes)}B left. Totals grow as older logs are read.`;
    else if(idx&&!idx.zstd)text='Older compressed Codex logs need Node.js 22.15 or newer to read. Recent logs are included.';
    else if(data.indexError)text=data.indexError;
    s.hidden=!text;s.textContent=text;s.className='u-status'+(error?' error':'');
  }

  function renderSummary(){
    const t=data.totals,provs=[...data.providers].sort((a,b)=>A.value(b,opts.measure)-A.value(a,opts.measure)),total=opts.measure==='tokens'?t.tokens:t.cost;
    $('u-total').textContent=opts.measure==='tokens'?A.compact(total):A.money(total);
    $('u-total').title=opts.measure==='tokens'?full(total)+' processed tokens':'API-equivalent estimate';
    $('u-total-note').textContent=`${full(t.sessions)} session${t.sessions===1?'':'s'} · ${opts.measure==='tokens'?full(t.requests)+' requests':'API estimate'}`;
    const items=provs.map(p=>{
      const li=el('li'),line=el('div',null,'u-prov-line'),dot=el('span',null,'u-dot');dot.style.background=A.PROVIDERS[p.id]?.color;
      const nm=el('span',null,'u-prov-name');nm.append(glyph(p.id),el('span',p.name),el('small',`${full(p.sessions)} session${p.sessions===1?'':'s'}`));
      line.append(dot,nm,el('strong',fmt(A.value(p,opts.measure))));
      const sub=el('div',`${A.percent(A.value(p,opts.measure),total)} of ${opts.measure==='tokens'?'tokens':'cost'} · ${opts.measure==='tokens'?A.money(p.cost):A.compact(p.tokens)+' tokens'}`,'u-prov-sub');
      li.append(line,sub);return li;});
    if(!items.length)items.push(el('li','No usage recorded in this period.','u-empty'));
    $('u-providers').replaceChildren(...items);
  }

  let chartState=null;
  function drawChart(){
    const host=$('u-chart');host.replaceChildren();$('u-tip').hidden=true;
    $('u-chart-title').textContent=A.chartTitle(data.bucket,opts.measure);
    const series=A.providerSeries(data,opts.measure).sort((a,b)=>b.total-a.total),n=data.series.length;
    const W=Math.max(240,host.clientWidth),H=host.clientHeight||230,L=58,R=4,T=8,B=24,P=W-L-R,PH=H-T-B;
    const s=document.createElementNS(ns,'svg');s.setAttribute('viewBox',`0 0 ${W} ${H}`);s.setAttribute('width',W);s.setAttribute('height',H);
    const add=(parent,tag,attrs,text)=>{const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!=null)e.textContent=text;parent.append(e);return e;};
    const max=Math.max(0,...series.flatMap(x=>x.values)),axis=A.niceAxis(max);
    for(const tick of axis.ticks){const y=T+PH-tick/axis.top*PH;add(s,'line',{x1:L,x2:W-R,y1:y,y2:y,class:'u-grid'});add(s,'text',{x:L-10,y:y+4,'text-anchor':'end',class:'u-axis'},opts.measure==='tokens'?A.compact(tick):A.money(tick));}
    if(axis.empty)add(s,'text',{x:L+P/2,y:T+PH/2,'text-anchor':'middle',class:'u-axis'},'No usage in this period');
    const x=i=>L+(n<=1?P/2:i*P/(n-1)),y=v=>T+PH-v/axis.top*PH;
    const defs=add(s,'defs',{});
    series.forEach((sr,k)=>{
      const pts=sr.values.map((v,i)=>[x(i),y(v)]),line=A.monotonePath(pts);if(!line)return;
      const gid='u-fill-'+k,g=add(defs,'linearGradient',{id:gid,x1:0,x2:0,y1:0,y2:1});
      add(g,'stop',{offset:'0%','stop-color':sr.color,'stop-opacity':k===0?.22:.08});add(g,'stop',{offset:'100%','stop-color':sr.color,'stop-opacity':0});
      add(s,'path',{d:`${line}L${x(n-1)},${T+PH}L${x(0)},${T+PH}Z`,fill:`url(#${gid})`});
      add(s,'path',{d:line,fill:'none',stroke:sr.color,'stroke-width':k===0?1.8:1.5,'stroke-linejoin':'round','stroke-linecap':'round'});
    });
    add(s,'line',{x1:L,x2:W-R,y1:T+PH,y2:T+PH,class:'u-baseline'});
    const labelIdx=n<=1?[0]:[0,Math.floor((n-1)/2),n-1];
    for(const i of labelIdx)add(s,'text',{x:x(i),y:H-4,'text-anchor':i===0?'start':i===n-1?'end':'middle',class:'u-axis'},A.bucketLabel(data.series[i].t,data.bucket));
    const guide=add(s,'line',{x1:0,x2:0,y1:T,y2:T+PH,class:'u-guide',visibility:'hidden'});
    host.append(s);chartState={series,x,n,guide,W,L,P};
    host.setAttribute('aria-label',`${$('u-chart-title').textContent}: ${series.map(sr=>sr.name+' '+fmt(sr.total)).join(', ')||'no usage'}`);
  }
  function tip(e){
    if(!chartState||!data)return;const host=$('u-chart'),r=host.getBoundingClientRect(),{n,x,guide,L,P}=chartState;
    const px=e.clientX-r.left;if(px<L-8||n<1)return hideTip();
    const i=Math.max(0,Math.min(n-1,Math.round((px-L)/(P/Math.max(1,n-1)))));
    guide.setAttribute('x1',x(i));guide.setAttribute('x2',x(i));guide.setAttribute('visibility','visible');
    const box=$('u-tip'),b=data.series[i];box.replaceChildren(el('b',A.bucketLabel(b.t,data.bucket,{long:true})));
    for(const sr of chartState.series){const row=el('div',null,'u-tip-row'),d=el('span',null,'u-dot');d.style.background=sr.color;row.append(d,el('span',sr.name),el('strong',fmt(sr.values[i])));box.append(row);}
    box.hidden=false;const left=Math.min(r.width-box.offsetWidth-4,Math.max(0,x(i)+12));box.style.left=left+'px';
  }
  function hideTip(){$('u-tip').hidden=true;chartState?.guide.setAttribute('visibility','hidden');}

  function renderTotals(){
    const t=data.totals;
    const tiles=[['Processed tokens',A.compact(t.tokens),full(t.tokens)],['Cached input',A.compact(t.cacheRead),full(t.cacheRead)],
      ['Uncached input',A.compact(t.input),full(t.input)],['Output',A.compact(t.output),full(t.output)+' (includes '+full(t.reasoning)+' reasoning)'],
      opts.measure==='tokens'?['Cache writes',A.compact(t.cacheWrite),full(t.cacheWrite)]:['Cache savings',A.money(t.savings),'Estimated saving versus paying full input price for cached tokens']];
    $('u-totals').replaceChildren(...tiles.map(([label,value,title])=>{const d=el('div',null,'u-tile');d.append(el('p',label));const v=el('strong',value);v.title=title;d.append(v);return d;}));
  }
  function stackBar(bar,legend,segments,{shade}={}){
    const sum=segments.reduce((n,s)=>n+s.value,0);bar.replaceChildren();legend.replaceChildren();
    segments.forEach((sg,i)=>{
      const part=el('span',null,'u-bar-part u-shade-'+(shade?shade[i]:i));part.style.flexGrow=sum?sg.value/sum:0;part.title=`${sg.label}: ${fmt(sg.value)} (${A.percent(sg.value,sum)})`;if(sum&&sg.value>0)bar.append(part);
      const item=el('span',null,'u-legend-item'),sw=el('i',null,'u-shade-'+(shade?shade[i]:i));item.append(sw,el('span',sg.label),el('b',fmt(sg.value)));legend.append(item);
    });
    if(!sum)bar.append(el('span',null,'u-bar-empty'));
  }
  function renderBars(){
    const word=opts.measure==='tokens'?'Tokens':'Cost';
    $('u-type-title').textContent=word+' by type';$('u-speed-title').textContent=word+' by speed';
    stackBar($('u-type-bar'),$('u-type-legend'),A.typeSegments(data.totals,opts.measure));
    const speeds=A.speedSegments(data.speeds,opts.measure);stackBar($('u-speed-bar'),$('u-speed-legend'),speeds,{shade:speeds.map(s=>({standard:0,fast:2,unknown:1}[s.key]))});
    const premium=A.fastPremium(data.speeds);$('u-speed-note').textContent=opts.measure==='cost'&&premium>0?'Premium '+A.money(premium):'';
    $('u-speed-note').title='Extra cost of Fast mode over Standard rates';
    $('u-type-note').textContent='';
  }
  function renderBreakdown(){
    const rows=A.breakdown(data,opts.group,opts.measure),limit=expanded?rows.length:10;
    $('u-col-name').textContent={model:'Model',account:'Account',project:'Project',time:$('u-group-time').textContent}[opts.group];
    $('u-col-a').textContent=opts.measure==='tokens'?'Tokens':'Cost';$('u-col-b').textContent=opts.measure==='tokens'?'Cost':'Tokens';
    const trs=rows.slice(0,limit).map((r,i)=>{
      const tr=el('tr');tr.append(el('td',String(i+1),'u-rank'));
      const cell=el('td',null,'u-name'),label=el('div',null,'u-name-line');
      if(r.provider)label.append(glyph(r.provider));label.append(el('span',rowName(r)));
      const bar=el('i',null,'u-share-bar');bar.style.width=Math.max(3,r.relative*65)+'%';bar.style.background=A.PROVIDERS[r.provider]?.color||'#8a8a8a';
      cell.append(label,bar);cell.title=rowName(r)+(r.unpriced?` · ${full(r.unpriced)} request${r.unpriced===1?'':'s'} without a published rate`:'');tr.append(cell);
      const main=el('td',fmt(A.value(r,opts.measure)),'num');if(opts.measure==='cost'&&r.unpriced&&!r.cost)main.textContent='No rate';
      tr.append(main,el('td',A.percent(A.value(r,opts.measure),opts.measure==='tokens'?data.totals.tokens:data.totals.cost),'num u-muted'),el('td',otherFmt(r),'num u-muted'));
      return tr;});
    if(!trs.length){const tr=el('tr'),td=el('td','No usage in this period.','u-empty');td.colSpan=5;tr.append(td);trs.push(tr);}
    $('u-rows').replaceChildren(...trs);
    $('u-more').hidden=rows.length<=10;$('u-more').textContent=expanded?'Show top 10':`Show all ${rows.length}`;
  }
  function renderFoot(){
    const notes=['API-equivalent estimate at Standard list prices, not a subscription bill.',
      `Rates: OpenAI and Claude API, checked ${new Date(data.pricing.openai.checkedAt+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}.`,
      'Codex logs do not record Fast mode, so Codex requests use Standard rates.',
      'Local time. Reads this Mac’s Codex and Claude Code logs from the last 90 days; prompts are never stored.'];
    if(data.unpricedModels.length)notes.push('No published rate for: '+data.unpricedModels.join(', ')+'. Their tokens count, their cost does not.');
    if(data.index?.unreadable)notes.push(`${data.index.unreadable} compressed log${data.index.unreadable===1?'':'s'} could not be read.`);
    $('u-foot').textContent=notes.join(' ');
  }

  function renderLimits(){
    const cards=(state?.accounts||[]).map(a=>{
      const card=el('article',null,'u-limit-card'+(a.current?' current':'')),head=el('header');
      const id=el('div',null,'u-limit-id');id.append(avatar(a,true));const nm=el('div');nm.append(el('strong',name(a)),el('span',email(a)+' · '+accountPlan(a),'u-muted'));id.append(nm);head.append(id);
      if(a.current)head.append(el('span','Current','u-pill'));else if(a.status==='reconnect')head.append(el('span','Reconnect','u-pill warn'));
      card.append(head);
      const windows=[];for(const b of a.usage?.buckets||[])for(const w of [b.primary,b.secondary].filter(Boolean))windows.push([b,w]);
      for(const [b,w] of windows.slice(0,4)){
        const row=el('div',null,'u-limit-row'),top=el('div',null,'u-limit-top'),pct=w.remainingPercent;
        top.append(el('span',(a.usage.buckets.length>1?(b.name||b.id)+' · ':'')+duration(w.windowDurationMins)),el('b',pct==null?'N/A':Math.round(pct)+'% left'));
        const bar=el('div',null,'u-meter'+(pct!=null&&pct<15?' low':'')),fill=el('i');fill.style.width=(pct??0)+'%';bar.append(fill);
        let reset='Reset time unavailable';if(typeof w.resetsAt==='number'){const h=Math.max(0,Math.round((w.resetsAt*1000-Date.now())/3600000));reset=`Resets ${date(w.resetsAt)} · in ${h>=24?Math.floor(h/24)+'d '+(h%24)+'h':h+'h'}`;}
        row.append(top,bar,el('span',reset,'u-muted'));card.append(row);
      }
      if(!windows.length)card.append(el('p',a.status==='reconnect'?'Sign in again to read limits.':(a.error?safe(a.error):'Refresh to read limits.'),'u-muted'));
      const n=a.usage?.resets?.availableCount,foot=el('footer');
      foot.append(el('span',n==null?'Reset credits: N/A':`${n} reset credit${n===1?'':'s'}`),el('span',a.stale?'Last checked '+(a.lastCheckedAt?new Date(a.lastCheckedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'never'):'Up to date','u-muted'));
      const open=el('button','Open',null);open.onclick=()=>select(a.id);foot.append(open);card.append(foot);return card;});
    if(!cards.length)cards.push(el('p','Connect or save an account to see its limits.','u-empty'));
    $('u-limit-cards').replaceChildren(...cards);
    const busy=state?.operation?.status==='running';$('u-limits-refresh').disabled=busy;$('u-limits-refresh-label').textContent=busy&&state.operation.type==='refresh'?'Refreshing…':'Refresh limits';
    $('u-limits-note').textContent='Codex quota windows and reset credits for each saved account. Claude Code does not record its plan limits in local logs.';
  }

  function render(){
    if(page!=='usage')return;
    renderControls();
    const limits=opts.measure==='limits';$('u-analytics').hidden=limits;$('u-limits').hidden=!limits;
    if(limits){$('u-status').hidden=true;renderLimits();return;}
    renderStatus();
    if(!data){$('u-total').textContent='…';return;}
    renderSummary();drawChart();renderTotals();renderBars();renderBreakdown();renderFoot();schedule();
  }
  function set(key,value){opts[key]=value;pref('usage-'+key,value);}
  for(const b of document.querySelectorAll('#usage-view [data-range]'))b.onclick=()=>{set('range',b.dataset.range);load();};
  for(const b of document.querySelectorAll('#usage-view [data-measure]'))b.onclick=()=>{const was=opts.measure;set('measure',b.dataset.measure);if(was==='limits'&&data&&b.dataset.measure!=='limits')render();else if(b.dataset.measure==='limits'||!data)load();else render();};
  for(const b of document.querySelectorAll('#usage-view [data-group]'))b.onclick=()=>{set('group',b.dataset.group);expanded=false;renderBreakdown();renderControls();};
  $('u-provider').onchange=()=>{set('provider',$('u-provider').value);load();};
  $('u-account').onchange=()=>{set('account',$('u-account').value);if(opts.account!=='all')set('provider','all');load();};
  $('u-refresh').onclick=()=>{if(opts.measure==='limits')refresh();else load();};
  $('u-limits-refresh').onclick=()=>refresh();
  $('u-more').onclick=()=>{expanded=!expanded;renderBreakdown();};
  $('u-chart').addEventListener('pointermove',tip);$('u-chart').addEventListener('pointerleave',hideTip);
  new ResizeObserver(()=>{if(data&&page==='usage'&&opts.measure!=='limits')drawChart();}).observe($('u-chart'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&page==='usage')load();});
  const api={show(){render();load();},render(){projectAliases=new Map();render();},onState(){
    if(page!=='usage')return;
    const sig=JSON.stringify([state?.accounts?.map(a=>[a.id,a.label,a.current,a.usage?.checkedAt,a.status]),state?.operation,privacy]);
    if(sig===lastState)return;lastState=sig;
    if(opts.measure==='limits')render();else{renderControls();if(data)renderBreakdown();}
  }};
  if(page==='usage')api.show();
  return api;
})();
