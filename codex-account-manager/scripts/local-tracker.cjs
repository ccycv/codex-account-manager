'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {atomic,readJson}=require('./manager.cjs');
function fingerprint(file){try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return null;}}
function input(manager,budget){
  return {root:path.join(manager.root,'local-tracking'),codexHome:manager.codexHome,budget,
    activeFingerprint:fingerprint(manager.activeAuth),accounts:manager.db().accounts.map(a=>({
      id:a.usage?.accountId?'account:'+a.usage.accountId:'profile:'+a.id,
      label:a.label,email:a.identity?.email||null,fingerprint:fingerprint(manager.auth(a.id))}))};
}
async function scanLocal(manager,budget){
  const data=input(manager,budget);
  const previous=readJson(path.join(manager.root,'local-usage.json'),{});
  // Normal token rotation changes the opaque file bytes. Resolve identity through
  // Codex itself only when the fingerprint changed, without decoding credentials.
  if(data.activeFingerprint && data.activeFingerprint!==previous.observedFingerprint &&
    !data.accounts.some(a=>a.fingerprint===data.activeFingerprint)&&!fs.existsSync(path.join(manager.root,'operation.lock'))){
    try{
      const snap=await manager.activeSnapshot(false);
      const email=snap?.identity?.email?.toLowerCase();
      const candidates=new Map([...data.accounts,...(previous.accounts||[])].filter(a=>email&&a.email?.toLowerCase()===email&&!a.unassigned).map(a=>[a.id,a]));
      if(candidates.size===1 && fingerprint(manager.activeAuth)===data.activeFingerprint)
        data.resolvedActiveId=candidates.keys().next().value;
    }catch{/* Unresolved identity remains unassigned; local counting continues. */}
  }
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.CODEX_ACCOUNT_PYTHON||'python3',[path.join(__dirname,'local-tracker.py')],{stdio:['pipe','pipe','pipe']});
    let out='';child.stdout.on('data',b=>out+=b);child.stderr.resume();
    child.on('error',()=>reject(new Error('Local tracking requires Python 3.')));
    child.on('exit',code=>{if(code!==0)return reject(new Error('Local usage scan failed. Previously recorded counters are preserved.'));try{const result=JSON.parse(out);result.observedFingerprint=data.activeFingerprint;atomic(path.join(manager.root,'local-usage.json'),JSON.stringify(result));resolve(result);}catch{reject(new Error('Local usage scan returned invalid data.'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(data));
  });
}
function startTracker(manager){
  let stopped=false,timer,running=false;
  async function tick(){
    if(stopped||running)return;running=true;let pending=false;
    try{const result=await scanLocal(manager);pending=result.pendingBytes>0;}
    catch(e){const prior=readJson(path.join(manager.root,'local-usage.json'),{});atomic(path.join(manager.root,'local-usage.json'),JSON.stringify({...prior,error:e.message}));}
    finally{running=false;if(!stopped){timer=setTimeout(tick,pending?200:15000);timer.unref();}}
  }
  tick();return ()=>{stopped=true;clearTimeout(timer);};
}
module.exports={scanLocal,startTracker};
