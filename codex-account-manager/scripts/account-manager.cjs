#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {Manager,readJson}=require('./manager.cjs');

async function dashboard(manager=new Manager()) {
  const descriptor=path.join(manager.root,'dashboard.json');
  async function existing() {
    const d=readJson(descriptor,null);if(!d) return null;
    try {
      const u=new URL(d.origin);if(u.hostname!=='127.0.0.1') return null;
      const r=await fetch(d.origin+'/api/state',{headers:{Authorization:'Bearer '+d.token},signal:AbortSignal.timeout(1500)});
      if(r.ok) return d;
    }catch{}return null;
  }
  let d=await existing();
  if(!d){
    const child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{
      cwd:__dirname,detached:true,stdio:'ignore',env:{...process.env,CODEX_ACCOUNT_MANAGER_HOME:manager.root,CODEX_HOME:manager.codexHome}});
    child.unref();
    for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));d=await existing();if(d)break;}
  }
  if(!d) throw new Error('Could not start the account dashboard.');
  return {ok:true,url:d.url,message:'Open the URL in the Codex browser panel or your browser.'};
}
async function api(action,args) {
  const {url}=await dashboard();const u=new URL(url);const token=u.hash.slice(1);
  const r=await fetch(u.origin+'/api/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args||{})});
  const result=await r.json();if(!r.ok) throw new Error(result.error);return result;
}
async function liveState() {
  const {url}=await dashboard();const u=new URL(url);
  const response=await fetch(u.origin+'/api/state',{headers:{Authorization:'Bearer '+u.hash.slice(1)}});
  if(!response.ok) throw new Error('Could not read the account dashboard.');
  return response.json();
}
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[
  {name:'account_manager_open',description:'Open the local account dashboard to save, connect, compare usage, and switch paid ChatGPT accounts.',inputSchema:schema()},
  {name:'account_manager_list',description:'List accounts, quota/reset credits, account-wide tokens, and a separate durable ledger of usage on this Mac including removed accounts. Includes per-account and total Today/7/30-day/all-recorded counts. Stale, unassigned and incomplete data are marked.',inputSchema:schema()},
  {name:'account_manager_refresh',description:'Refresh live quota, token history, and reset-credit availability across saved accounts without switching. Does not redeem credits.',inputSchema:schema({id:{type:'string'}})},
  {name:'account_manager_save_current',description:'Save the current ChatGPT login and preserve its refreshed session.',inputSchema:schema({label:{type:'string'}},['label'])},
  {name:'account_manager_rename',description:'Change a saved account display name without changing its login or usage history.',inputSchema:schema({id:{type:'string'},label:{type:'string'}},['id','label'])},
  {name:'account_manager_remove',description:'Remove a saved account and its saved session, retaining local token history. Leaves the active app login, conversations, and previously created backups unchanged. Use only for an account the user asked to remove.',inputSchema:schema({id:{type:'string'}},['id'])},
  {name:'account_manager_connect',description:'Start normal ChatGPT sign-in to add or reconnect a saved account, without logging the app out.',inputSchema:schema({label:{type:'string'},id:{type:'string'}},['label'])},
  {name:'account_manager_switch',description:'Validate the destination, gracefully close the desktop app, save the outgoing login, switch, and reopen the app. Use only when the user asks to switch now and knows the app will reopen.',inputSchema:schema({id:{type:'string'},reopen:{type:'boolean',const:true}},['id','reopen'])}
];
async function call(name,args={}) {
  if(name==='account_manager_open') return dashboard();
  if(name==='account_manager_list') return liveState();
  if(name==='account_manager_refresh') return api('refresh',args);
  if(name==='account_manager_save_current') return api('save',args);
  if(name==='account_manager_rename') return api('rename',args);
  if(name==='account_manager_remove') return api('remove',args);
  if(name==='account_manager_connect') return api('connect',args);
  if(name==='account_manager_switch') return api('switch',args);
  throw new Error('Unknown account manager tool.');
}
async function main() {
  const [command,...args]=process.argv.slice(2);
  if(command){
    let r;
    if(command==='open') r=await dashboard();
    else if(command==='list') r=new Manager().publicState();
    else if(command==='refresh') r=await new Manager().refresh(args[0]);
    else if(command==='save') r=await new Manager().saveCurrent(args.join(' '));
    else if(command==='rename') r=await api('rename',{id:args[0],label:args.slice(1).join(' ')});
    else if(command==='remove') r=await api('remove',{id:args[0]});
    else if(command==='import-legacy') r=await new Manager().importLegacy();
    else if(command==='connect') r=await api('connect',{label:args.join(' ')});
    else {console.log('Account Manager: open | list | refresh [id] | save <name> | connect <name> | remove <id> | import-legacy');return;}
    console.log(JSON.stringify(r,null,2));return;
  }
  const lines=readline.createInterface({input:process.stdin});
  for await(const line of lines){
    let m;try{m=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}})+'\n');continue;}
    if(m.id===undefined) continue;
    let response;
    if(m.method==='initialize') response={protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'codex-account-manager',version:'1.0.0'}};
    else if(m.method==='ping') response={};
    else if(m.method==='tools/list') response={tools};
    else if(m.method==='tools/call') {
      try{response={content:[{type:'text',text:JSON.stringify(await call(m.params.name,m.params.arguments))}]};}
      catch(e){response={isError:true,content:[{type:'text',text:e.message}]};}
    }else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method'}})+'\n');continue;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:response})+'\n');
  }
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={dashboard,call,tools};
