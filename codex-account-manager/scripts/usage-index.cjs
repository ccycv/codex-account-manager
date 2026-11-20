'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');

const RANGES=['24h','7d','30d','90d'],PROVIDERS=['all','codex','claude-code'];
// Claude Code keeps one config directory per profile (~/.claude, ~/.claude-02, ...). Each with
// a projects/ folder is read as its own Claude account. An explicit list overrides discovery.
function claudeHomes(){
  const explicit=process.env.CODEX_ACCOUNT_CLAUDE_HOME||process.env.CLAUDE_CONFIG_DIR;
  if(explicit)return explicit.split(path.delimiter).filter(Boolean);
  const home=os.homedir();let names=[];try{names=fs.readdirSync(home);}catch{}
  return names.filter(n=>n==='.claude'||/^\.claude-[A-Za-z0-9._-]+$/.test(n)).map(n=>path.join(home,n))
    .filter(d=>{try{return fs.lstatSync(d).isDirectory()&&fs.statSync(path.join(d,'projects')).isDirectory();}catch{return false;}}).sort();
}
function run(payload,timeout){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.CODEX_ACCOUNT_PYTHON||'python3',[path.join(__dirname,'usage-index.py')],
      {stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_ACCOUNT_NODE:process.execPath}});
    let out='';const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);timer.unref();
    child.stdout.on('data',b=>out+=b);child.stderr.resume();
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Usage tracking requires Python 3.'));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Usage index could not be read.'));
      try{resolve(JSON.parse(out));}catch{reject(new Error('Usage index returned invalid data.'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
}
// Accept only known values so nothing user-controlled reaches the query beyond a fixed vocabulary.
function params(input={}){
  const range=RANGES.includes(input.range)?input.range:'24h',provider=PROVIDERS.includes(input.provider)?input.provider:'all';
  const account=typeof input.account==='string'&&/^(all|unassigned|(account|profile|claude):[A-Za-z0-9._:-]{1,120})$/.test(input.account)?input.account:'all';
  return {range,provider,account};
}
function startUsageIndex(manager,{budget=256*1024*1024}={}){
  let stopped=false,timer,status={pendingBytes:null,error:null},cache=new Map(),generation=0;
  async function tick(){
    if(stopped)return;let delay=15000;
    try{
      const r=await run({cmd:'index',root:manager.root,codexHome:manager.codexHome,claudeHomes:claudeHomes(),budget},10*60*1000);
      status={pendingBytes:r.pendingBytes,error:null};if(r.consumed>0){generation++;cache.clear();}
      if(r.pendingBytes>0)delay=500;
    }catch(e){status={...status,error:e.message};}
    if(!stopped){timer=setTimeout(tick,delay);timer.unref();}
  }
  async function query(input){
    const p=params(input),key=JSON.stringify(p),hit=cache.get(key);
    // Cached per index generation and for at most 15 seconds, so totals advance with the clock.
    if(hit&&hit.generation===generation&&Date.now()-hit.at<15000)return hit.value;
    const pending=run({cmd:'query',root:manager.root,ledger:path.join(manager.root,'local-tracking','local-usage.sqlite'),params:p},60000)
      .then(value=>({...value,indexError:status.error}));
    cache.set(key,{generation,at:Date.now(),value:pending});
    pending.catch(()=>cache.delete(key));
    return pending;
  }
  tick();
  return {query,stop:()=>{stopped=true;clearTimeout(timer);}};
}
module.exports={startUsageIndex,params,claudeHomes};
