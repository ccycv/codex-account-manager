const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Manager,normalizeUsage,atomic}=require('../scripts/manager.cjs');
const {serve}=require('../scripts/server.cjs');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-manager-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codexHome=path.join(root,'codex');fs.mkdirSync(codexHome);
  const sessions=new Map([['a-old',{email:'a@example.test',id:'a',refresh:'a-new'}],['a-new',{email:'a@example.test',id:'a'}],['a-final',{email:'a@example.test',id:'a'}],['b-old',{email:'b@example.test',id:'b',refresh:'b-new'}],['b-new',{email:'b@example.test',id:'b'}],['b-expired',{email:'b@example.test',id:'b',fail:true}]]);
  const m=new Manager({root:path.join(root,'vault'),codexHome,trackLocal:false,rpcFactory:(home,options={})=>({
    init:async()=>{},close:async()=>{},request:async(method)=>{
      const file=path.join(home,'auth.json');const session=sessions.get(fs.readFileSync(file,'utf8'));
      if(!session)throw new Error('Unknown fixture');
      if(method==='account/read')return {account:{type:'chatgpt',email:session.email,planType:'pro'}};
      if(session.fail){const e=new Error('This saved login needs reconnecting.');e.code='reconnect';throw e;}
      if(session.refresh)atomic(file,session.refresh);
      return {accountId:session.id,rateLimitsByLimitId:{codex:{primary:{usedPercent:21,windowDurationMins:10080,resetsAt:1900000000}}},rateLimitResetCredits:{availableCount:2,credits:[]}};
    }
  })});
  const active=value=>atomic(m.activeAuth,value);
  return {m,root,codexHome,active};
}
test('normalizes multiple buckets and preserves unknown versus zero reset credits',()=>{
  const data=normalizeUsage({rateLimitsByLimitId:{codex:{primary:{usedPercent:120}},spark:{primary:{usedPercent:0}}},rateLimitResetCredits:null});
  assert.equal(data.buckets[0].primary.remainingPercent,0);assert.equal(data.buckets[1].primary.remainingPercent,100);assert.equal(data.resets,null);
  assert.equal(normalizeUsage({rateLimits:{primary:{usedPercent:null}},rateLimitResetCredits:{availableCount:0,credits:[]}}).resets.availableCount,0);
});
test('saving persists refreshed active session and deduplicates the account',async t=>{
  const {m,active}=fixture(t);active('a-old');const a=await m.saveCurrent('Personal');
  assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');assert.equal(fs.readFileSync(m.auth(a.id),'utf8'),'a-new');
  await m.saveCurrent('Duplicate');assert.equal(m.publicState().accounts.length,1);
  assert.equal(fs.statSync(m.auth(a.id)).mode&0o777,0o600);
});
test('refresh saves rotating tokens for inactive accounts and never switches the active account',async t=>{
  const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');
  active('a-new');atomic(m.auth(b.id),'b-old');await m.refresh();
  assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');assert.equal(fs.readFileSync(m.auth(b.id),'utf8'),'b-new');assert.equal(m.publicState().activeId,a.id);
});
test('expired target never closes app or replaces working login',async t=>{
  const {m,active}=fixture(t);active('a-new');await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');active('a-new');atomic(m.auth(b.id),'b-expired');let quit=false;
  await assert.rejects(m.switchAccount(b.id,{quitApp:async()=>quit=true,reopenApp:async()=>{}}),/could not be verified/);
  assert.equal(quit,false);assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');assert.equal(m.db().accounts.find(a=>a.id===b.id).status,'reconnect');
});
test('switch captures outgoing refresh during app quit and leaves conversation files intact',async t=>{
  const {m,active,codexHome}=fixture(t);fs.mkdirSync(path.join(codexHome,'sessions'));fs.writeFileSync(path.join(codexHome,'sessions','thread'),'conversation');
  active('a-new');const a=await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');active('a-new');let reopened=0;
  await m.switchAccount(b.id,{quitApp:async()=>active('a-final'),reopenApp:async()=>reopened++});
  assert.equal(fs.readFileSync(m.auth(a.id),'utf8'),'a-final');assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'b-new');assert.equal(reopened,1);
  assert.equal(fs.readFileSync(path.join(codexHome,'sessions','thread'),'utf8'),'conversation');
});
test('failed graceful quit leaves active session untouched',async t=>{
  const {m,active}=fixture(t);active('a-new');await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');active('a-new');
  await assert.rejects(m.switchAccount(b.id,{quitApp:async()=>{throw new Error('App is busy');},reopenApp:async()=>{}}),/App is busy/);
  assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');
});
test('failed reopen rolls back to the latest outgoing session',async t=>{
  const {m,active}=fixture(t);active('a-new');await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');active('a-new');
  await assert.rejects(m.switchAccount(b.id,{quitApp:async()=>active('a-final'),reopenApp:async()=>{throw new Error('Open failed');}}),/Open failed/);
  assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-final');
});
test('unknown outgoing account is saved automatically on switch',async t=>{
  const {m,active}=fixture(t);active('b-new');const b=await m.saveCurrent('B');active('a-final');await m.switchAccount(b.id,{quitApp:async()=>{},reopenApp:async()=>{}});
  const recovered=m.db().accounts.find(a=>a.id!==b.id);assert.ok(recovered);assert.equal(fs.readFileSync(m.auth(recovered.id),'utf8'),'a-final');
});
test('legacy import skips duplicate sessions without modifying originals',async t=>{
  const {m,root}=fixture(t);const legacy=path.join(root,'legacy');for(const name of ['one','two'])atomic(path.join(legacy,name,'auth.json'),'a-old');
  const result=await m.importLegacy(legacy);assert.equal(result.imported,1);assert.equal(result.duplicates,1);assert.equal(fs.readFileSync(path.join(legacy,'one','auth.json'),'utf8'),'a-old');
});
test('separate processes cannot overlap credential mutations',async t=>{
  const {m}=fixture(t);await m.locked(async()=>{await assert.rejects(m.locked(async()=>{}),/Another account operation/);});
});
test('local HTTP API requires bearer auth and rejects cross-origin requests',async t=>{
  const {m}=fixture(t);const app=await serve({manager:m,trackLocal:false});t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
  assert.equal((await fetch(app.origin+'/api/state')).status,401);
  assert.equal((await fetch(app.origin+'/api/sessions')).status,401);
  assert.equal((await fetch(app.origin+'/api/sessions',{headers:{Authorization:'Bearer '+app.token,Origin:'https://example.com'}})).status,403);
  const sessions=await fetch(app.origin+'/api/sessions',{headers:{Authorization:'Bearer '+app.token}});assert.equal(sessions.status,200);assert.ok(Array.isArray((await sessions.json()).sessions));
  assert.equal((await fetch(app.origin+'/api/state',{headers:{Authorization:'Bearer '+app.token,Origin:'https://example.com'}})).status,403);
  const good=await fetch(app.origin+'/api/state',{headers:{Authorization:'Bearer '+app.token}});assert.equal(good.status,200);
  const data=await good.json();assert.ok(Array.isArray(data.accounts));assert.equal(JSON.stringify(data).includes('auth.json'),false);
  assert.equal((await fetch(app.origin+'/../scripts/manager.cjs')).status,404);
});

test('account id beats stale duplicate email metadata when matching refreshed auth',async t=>{
  const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('A');const db=m.db();
  const duplicate={id:require('node:crypto').randomUUID(),label:'Old',identity:{email:'a@example.test'}};db.accounts.push(duplicate);atomic(m.auth(duplicate.id),'a-old');m.write(db);
  active('a-final');await m.refresh(a.id);assert.equal(m.publicState().activeId,a.id);assert.equal(m.db().accounts.length,2);
});

test('stale current marker is not shown after an external account change',async t=>{
  const {m,active}=fixture(t);active('a-new');await m.saveCurrent('A');active('b-new');
  assert.equal(m.publicState().activeId,null);assert.equal(m.publicState().active,null);
});

test('successful login is kept when the usage endpoint is unavailable',async t=>{
  const {m,root}=fixture(t);const home=path.join(root,'login');atomic(path.join(home,'auth.json'),'b-new');
  const login={id:'login-test',label:'B',status:'waiting',home,rpc:{close:async()=>{},request:async method=>{
    if(method==='account/read')return {account:{type:'chatgpt',email:'b@example.test',planType:'pro'}};
    const e=new Error('Usage unavailable');e.code='unavailable';throw e;
  }}};m.login=login;await m.finishLogin(login,{success:true});
  assert.equal(login.status,'complete');assert.equal(m.db().accounts.length,1);const a=m.db().accounts[0];
  assert.equal(fs.readFileSync(m.auth(a.id),'utf8'),'b-new');assert.equal(a.status,'unavailable');
});

test('concurrent app auth change is never overwritten by current-account refresh',async t=>{
  const {m,active}=fixture(t);active('a-old');const original=m.inspect.bind(m);
  m.inspect=async(...args)=>{const result=await original(...args);active('b-new');return result;};
  await assert.rejects(m.saveCurrent('A'),/changed accounts/);assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'b-new');
});

test('removing a saved account deletes its session and keeps other accounts and active login',async t=>{
  const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('A');active('b-new');const b=await m.saveCurrent('B');active('a-new');
  await m.removeAccount(b.id);assert.equal(fs.existsSync(m.home(b.id)),false);assert.deepEqual(m.db().accounts.map(a=>a.id),[a.id]);assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');
});

test('removing current saved account does not log the app out or delete conversations',async t=>{
  const {m,active,codexHome}=fixture(t);active('a-new');const a=await m.saveCurrent('A');fs.mkdirSync(path.join(codexHome,'sessions'));fs.writeFileSync(path.join(codexHome,'sessions','thread'),'conversation');
  await m.removeAccount(a.id);assert.equal(m.publicState().accounts.length,0);assert.equal(m.db().activeId,null);assert.equal(fs.readFileSync(m.activeAuth,'utf8'),'a-new');assert.equal(fs.readFileSync(path.join(codexHome,'sessions','thread'),'utf8'),'conversation');
});

test('removal rolls back saved credentials when metadata cannot be written',async t=>{
  const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('A');m.write=()=>{throw new Error('Disk error');};
  await assert.rejects(m.removeAccount(a.id),/Disk error/);assert.equal(fs.readFileSync(m.auth(a.id),'utf8'),'a-new');assert.equal(m.db().accounts.length,1);
});

test('unknown removal id leaves saved accounts unchanged',async t=>{
  const {m,active}=fixture(t);active('a-new');await m.saveCurrent('A');await assert.rejects(m.removeAccount('../bad'),/not found/);assert.equal(m.db().accounts.length,1);
});

test('rename persists only the display label, preserving credentials, identity, and token history',async t=>{
 const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('Old name');const before=m.db().accounts[0],auth=fs.readFileSync(m.auth(a.id)),selectedAuth=fs.readFileSync(m.activeAuth);
 await m.renameAccount(a.id,'  Work account  ');const after=m.db().accounts[0];assert.equal(after.label,'Work account');assert.deepEqual({...after,label:before.label},before);assert.deepEqual(fs.readFileSync(m.auth(a.id)),auth);assert.deepEqual(fs.readFileSync(m.activeAuth),selectedAuth);assert.equal(m.publicState().accounts[0].label,'Work account');
 await m.refresh(a.id);assert.equal(m.db().accounts[0].label,'Work account');
});
test('rename validates names, account identity, and rolls back on metadata failure',async t=>{
 const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('Original');
 for(const label of ['', ' ', 'x'.repeat(65), 'bad\nname'])await assert.rejects(m.renameAccount(a.id,label),/1–64/);
 await assert.rejects(m.renameAccount('missing','Name'),/not found/);m.write=()=>{throw Error('Disk error');};await assert.rejects(m.renameAccount(a.id,'Changed'),/Disk error/);assert.equal(m.db().accounts[0].label,'Original');
});
test('authenticated HTTP rename updates the targeted saved account',async t=>{
 const {m,active}=fixture(t);active('a-new');const a=await m.saveCurrent('Before');const app=await serve({manager:m,trackLocal:false});t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
 const res=await fetch(app.origin+'/api/rename',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({id:a.id,label:'After'})});assert.equal(res.status,200);assert.equal(m.db().accounts[0].label,'After');
});
