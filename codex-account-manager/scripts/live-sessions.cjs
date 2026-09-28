'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const {atomic,readJson}=require('./manager.cjs');
function startSessions(manager){
  let stopped=false,timer,child;
  let snapshot=readJson(path.join(manager.root,'live-sessions.json'),{sessions:[],scannedAt:null,loading:true});
  function tick(){
    if(stopped)return;
    child=spawn(process.env.CODEX_ACCOUNT_PYTHON||'python3',[path.join(__dirname,'live-sessions.py')],{stdio:['pipe','pipe','pipe']});
    let out='',settled=false;
    const timeout=setTimeout(()=>child?.kill('SIGTERM'),60000);timeout.unref();
    function done(error){
      if(settled)return;settled=true;clearTimeout(timeout);child=null;
      if(!error){try{snapshot=JSON.parse(out);atomic(path.join(manager.root,'live-sessions.json'),JSON.stringify(snapshot));}catch{error=true;}}
      if(error)snapshot={...snapshot,loading:false,error:'Session scan failed. Displaying the last recorded snapshot.'};
      if(!stopped){timer=setTimeout(tick,snapshot.pendingBytes&&!error?1000:5000);timer.unref();}
    }
    child.stdout.on('data',b=>out+=b);child.stderr.resume();child.once('error',()=>done(true));child.once('close',code=>done(code!==0));
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({root:manager.root,codexHome:manager.codexHome}));
  }
  tick();return {state:()=>snapshot,stop:()=>{stopped=true;clearTimeout(timer);child?.kill('SIGTERM');}};
}
module.exports={startSessions};
