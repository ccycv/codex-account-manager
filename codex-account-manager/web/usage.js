(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Usage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const keys=['today','days7','days30','allTime'];
  const localId=a=>a.usage?.accountId?'account:'+a.usage.accountId:'profile:'+a.id;
  function rows(state,view){
    if(view==='wide')return state.accounts.map(a=>({id:a.id,label:a.label,email:a.identity?.email,periods:a.tokenPeriods||{},daily:a.tokenUsage?.daily??null,stale:a.tokenStale,error:a.tokenError,account:a}));
    const locals=state.localUsage?.accounts||[];
    const result=state.accounts.map(a=>{const row=locals.find(r=>r.id===localId(a));return {...row,id:a.id,localId:row?.id,label:a.label,email:a.identity?.email,periods:row?.periods||{},daily:row?localDaily(state,row):null,account:a};});
    for(const row of locals)if(!result.some(r=>r.localId===row.id))result.push({...row,localId:row.id,daily:localDaily(state,row)});
    return result;
  }
  function combined(state,view){
    if(view==='local')return {periods:state.localUsage?.totals||{},daily:sumDaily(state.localUsage?.daily),error:state.localUsage?.error};
    // Use the same account identity rules as the server's combined totals.
    const groups=new Map();
    for(const a of state.accounts){const key=a.usage?.accountId?'id:'+a.usage.accountId:a.identity?.email?'email:'+a.identity.email.toLowerCase():'profile:'+a.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
    for(const [key,list]of [...groups])if(key.startsWith('email:')){const matches=[...groups].filter(([k,values])=>k.startsWith('id:')&&values.some(a=>a.identity?.email?.toLowerCase()===key.slice(6)));if(matches.length===1){matches[0][1].push(...list);groups.delete(key);}}
    const snapshots=[...groups.values()].map(list=>list.filter(a=>Array.isArray(a.tokenUsage?.daily)).sort((a,b)=>Date.parse(b.tokenUsage.checkedAt)-Date.parse(a.tokenUsage.checkedAt))[0]).filter(Boolean);
    const periods=Object.fromEntries(keys.map(k=>[k,state.tokenSummary?.periods?.[k]?.tokens??null]));
    const checked=snapshots.map(a=>a.tokenUsage.checkedAt).filter(d=>Number.isFinite(Date.parse(d))).sort();
    return {periods,daily:snapshots.length?sumDaily(snapshots.flatMap(a=>a.tokenUsage.daily)):null,checkedAt:checked[0],stale:snapshots.some(a=>a.tokenStale),partial:keys.some(k=>state.tokenSummary?.periods?.[k]?.incomplete)};
  }
  function sumDaily(daily){
    if(!Array.isArray(daily))return null;
    const result=new Map();for(const d of daily)result.set(d.date,(result.get(d.date)||0)+d.tokens);
    return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([date,tokens])=>({date,tokens}));
  }
  function localDaily(state,row){return (state.localUsage?.daily||[]).filter(d=>d.accountId?d.accountId===row.id:d.account===row.label&&state.localUsage.accounts.filter(a=>a.label===row.label).length===1).map(d=>({date:d.date,tokens:d.tokens}));}
  function series(daily,period,now=new Date()){
    if(!Array.isArray(daily))return null;
    const end=Date.parse(now.toISOString().slice(0,10)),days={today:1,days7:7,days30:30}[period];
    const map=new Map();for(const d of daily)if(Number.isSafeInteger(d.tokens)&&d.tokens>=0&&Date.parse(d.date)<=end)map.set(d.date,(map.get(d.date)||0)+d.tokens);
    let start=days?end-(days-1)*86400000:Math.min(end,...[...map.keys()].map(d=>Date.parse(d)).filter(Number.isFinite));
    // Bound visual density by aggregating long histories into consecutive date buckets.
    const count=Math.floor((end-start)/86400000)+1,stride=Math.max(1,Math.ceil(count/45)),out=[];
    for(let at=start;at<=end;at+=stride*86400000){let tokens=0;const through=Math.min(end,at+(stride-1)*86400000);for(let day=at;day<=through;day+=86400000)tokens+=map.get(new Date(day).toISOString().slice(0,10))||0;out.push({date:new Date(at).toISOString().slice(0,10),endDate:new Date(through).toISOString().slice(0,10),tokens});}
    return out;
  }
  function tokenAxis(max){
    if(!Number.isFinite(max)||max<=0)return {top:1,ticks:[0],empty:true};
    // Tokens are whole numbers. Integer steps prevent fractional ticks and
    // floating-point artifacts such as 1.2000000000000002 on empty charts.
    const target=Math.max(1,max/3),magnitude=10**Math.floor(Math.log10(target));
    const step=Math.ceil(Math.ceil(target/magnitude)*magnitude);
    return {top:step*3,ticks:[0,step,step*2,step*3],empty:false};
  }
  return {keys,localId,rows,combined,series,tokenAxis};
});
