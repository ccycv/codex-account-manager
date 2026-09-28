'use strict';
const DAY=86400000;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function normalizeTokens(raw,now=new Date()) {
  const rows=raw?.dailyUsageBuckets;
  const daily=Array.isArray(rows)?new Map():null;
  if(daily) for(const row of rows){
    const date=row?.startDate;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||count(row.tokens)===null||daily.has(date))
      throw new Error('Token history contains invalid or duplicate daily counts.');
    daily.set(date,row.tokens);
  }
  return {checkedAt:now.toISOString(),lifetimeTokens:count(raw?.summary?.lifetimeTokens),
    daily:daily?[...daily].sort(([a],[b])=>a.localeCompare(b)).map(([date,tokens])=>({date,tokens})):null};
}
function tokenPeriods(snapshot,now=new Date()) {
  const today=now.toISOString().slice(0,10),end=Date.parse(today);
  const periods={today:null,days7:null,days30:null,allTime:count(snapshot?.lifetimeTokens)};
  if(Array.isArray(snapshot?.daily)) for(const [key,days] of [['today',1],['days7',7],['days30',30]]){
    if(key==='today'&&!snapshot.daily.some(d=>d.date===today))continue;
    // These are sums of provider-reported calendar-day buckets, not estimates from quota percentages.
    const start=new Date(end-(days-1)*DAY).toISOString().slice(0,10);
    periods[key]=count(snapshot.daily.filter(d=>d.date>=start&&d.date<=today).reduce((sum,d)=>sum+d.tokens,0));
  }
  return periods;
}
function tokenSummary(accounts,now=new Date()) {
  const groups=new Map();
  for(const a of accounts){
    const key=a.usage?.accountId?'id:'+a.usage.accountId:a.identity?.email?'email:'+a.identity.email.toLowerCase():'profile:'+a.id;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);
  }
  // Merge unidentified legacy entries with a single positively identified account of the same email.
  for(const [key,list] of [...groups]) if(key.startsWith('email:')){
    const matches=[...groups].filter(([k,values])=>k.startsWith('id:')&&values.some(a=>a.identity?.email?.toLowerCase()===key.slice(6)));
    if(matches.length===1){matches[0][1].push(...list);groups.delete(key);}
  }
  const totals={};
  for(const period of ['today','days7','days30','allTime']){
    let sum=0,available=0,stale=0;
    for(const entries of groups.values()){
      const candidates=entries.filter(a=>tokenPeriods(a.tokenUsage,now)[period]!==null)
        .sort((a,b)=>Date.parse(b.tokenUsage.checkedAt)-Date.parse(a.tokenUsage.checkedAt));
      const a=candidates[0];if(!a)continue;
      available++;sum+=tokenPeriods(a.tokenUsage,now)[period];
      if(a.tokenError||now-Date.parse(a.tokenUsage.checkedAt)>120000)stale++;
    }
    totals[period]={tokens:available?count(sum):null,availableAccounts:available,totalAccounts:groups.size,
      incomplete:available<groups.size,staleAccounts:stale};
  }
  return {periods:totals,dayBasis:'UTC calendar dates; 7 and 30 days include today',source:'Codex account token history'};
}
module.exports={normalizeTokens,tokenPeriods,tokenSummary};
