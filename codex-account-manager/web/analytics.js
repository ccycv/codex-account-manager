(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Analytics=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const PROVIDERS={'claude-code':{name:'Claude Code',color:'#d97757'},codex:{name:'Codex',color:'#ededed'}};
  function money(n,{cents=true}={}){
    if(n==null||!Number.isFinite(n))return 'N/A';
    if(n>0&&n<0.01)return '< $0.01';
    const digits=cents||Math.abs(n)<100?2:0;
    return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n);
  }
  function compact(n){
    if(n==null||!Number.isFinite(n))return 'N/A';if(n===0)return '0';
    for(const [value,suffix]of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']])if(Math.abs(n)>=value){const v=n/value;return v.toFixed(v>=100?0:v>=10?1:2).replace(/\.?0+$/,'')+suffix;}
    return String(Math.round(n));
  }
  function percent(part,whole){if(!whole)return '0%';const p=part/whole*100;return (p>0&&p<0.1?'< 0.1':p.toFixed(1))+'%';}
  // Three equal intervals with a 1/2/2.5/5 step, so labels stay round ($100.00, 2.5B, ...).
  function niceAxis(max){
    if(!Number.isFinite(max)||max<=0)return {top:1,ticks:[0],empty:true};
    const raw=max/3,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(f=>f*mag).find(s=>s>=raw-1e-12);
    return {top:step*3,ticks:[0,step,step*2,step*3],empty:false};
  }
  // Monotone cubic interpolation (Fritsch-Carlson): smooth, never overshoots below zero.
  function monotonePath(points){
    const n=points.length;if(!n)return '';if(n===1)return `M${points[0][0]},${points[0][1]}`;
    const dx=[],dy=[],m=[],t=[];
    for(let i=0;i<n-1;i++){dx[i]=points[i+1][0]-points[i][0];dy[i]=points[i+1][1]-points[i][1];m[i]=dx[i]?dy[i]/dx[i]:0;}
    t[0]=m[0];t[n-1]=m[n-2];
    for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:(m[i-1]+m[i])/2;
    for(let i=0;i<n-1;i++){if(m[i]===0){t[i]=0;t[i+1]=0;continue;}const a=t[i]/m[i],b=t[i+1]/m[i],h=a*a+b*b;if(h>9){const s=3/Math.sqrt(h);t[i]=s*a*m[i];t[i+1]=s*b*m[i];}}
    const f=v=>Math.round(v*100)/100;let d=`M${f(points[0][0])},${f(points[0][1])}`;
    for(let i=0;i<n-1;i++){const h=dx[i]/3;d+=`C${f(points[i][0]+h)},${f(points[i][1]+t[i]*h)} ${f(points[i+1][0]-h)},${f(points[i+1][1]-t[i+1]*h)} ${f(points[i+1][0])},${f(points[i+1][1])}`;}
    return d;
  }
  const value=(entry,measure)=>entry?measure==='tokens'?entry.tokens:entry.cost:0;
  function providerSeries(data,measure){
    const ids=(data?.providers||[]).map(p=>p.id);
    return ids.map(id=>({id,name:PROVIDERS[id]?.name||id,color:PROVIDERS[id]?.color||'#999',
      total:value(data.providers.find(p=>p.id===id),measure),
      values:(data.series||[]).map(b=>value(b.providers?.[id],measure))}));
  }
  function bucketLabel(t,unit,{long=false}={}){
    const d=new Date(t*1000);
    if(unit==='hour')return long?d.toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}):d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',hour12:false});
    if(unit==='hour4')return long?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    return d.toLocaleDateString(undefined,long?{weekday:'short',month:'short',day:'numeric'}:{month:'short',day:'numeric'});
  }
  function chartTitle(unit,measure){return ({hour:'Hourly',hour4:'4-hour',day:'Daily'}[unit]||'Hourly')+' '+(measure==='tokens'?'tokens':'cost');}
  // Breakdown rows ranked by the active measure; "time" uses the chart buckets, newest first.
  function breakdown(data,group,measure){
    if(!data)return [];
    let rows;
    if(group==='time')rows=(data.series||[]).map(b=>{const entry={key:String(b.t),t:b.t,provider:null,cost:0,tokens:0,requests:0,unpriced:0};for(const v of Object.values(b.providers||{})){entry.cost+=v.cost;entry.tokens+=v.tokens;entry.requests+=v.requests;entry.unpriced+=v.unpriced;}return entry;}).filter(r=>r.tokens>0).reverse();
    else rows=[...(data.breakdown?.[group]||[])].sort((a,b)=>value(b,measure)-value(a,measure)||b.tokens-a.tokens);
    const total=measure==='tokens'?data.totals?.tokens:data.totals?.cost,top=Math.max(0,...rows.map(r=>value(r,measure)));
    return rows.map(r=>({...r,share:total?value(r,measure)/total:0,relative:top?value(r,measure)/top:0}));
  }
  function typeSegments(t,measure){
    if(!t)return [];
    return measure==='tokens'
      ?[{key:'input',label:'Uncached input',value:t.input},{key:'read',label:'Cache read',value:t.cacheRead},{key:'write',label:'Cache write',value:t.cacheWrite},{key:'output',label:'Output',value:t.output}]
      :[{key:'input',label:'Input',value:t.costInput},{key:'read',label:'Cache read',value:t.costRead},{key:'write',label:'Cache write',value:t.costWrite},{key:'output',label:'Output',value:t.costOutput}];
  }
  function speedSegments(speeds,measure){
    const get=k=>value(speeds?.[k],measure);
    return [{key:'standard',label:'Standard',value:get('standard')},{key:'fast',label:'Fast',value:get('fast')},{key:'unknown',label:'Not recorded',value:get('unknown')}].filter(s=>s.value>0||s.key!=='unknown');
  }
  // Fast mode bills every rate at 2x Standard, so half of the fast cost is the premium paid for speed.
  function fastPremium(speeds,multiplier=2){const fast=speeds?.fast?.cost||0;return fast-fast/multiplier;}
  return {PROVIDERS,money,compact,percent,niceAxis,monotonePath,providerSeries,bucketLabel,chartTitle,breakdown,typeSegments,speedSegments,fastPremium,value};
});
