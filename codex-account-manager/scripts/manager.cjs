'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {CodexRpc, RpcError} = require('./rpc.cjs');
const {normalizeTokens,tokenPeriods,tokenSummary}=require('./tokens.cjs');

const iso = () => new Date().toISOString();
function privateDir(p) {fs.mkdirSync(p,{recursive:true,mode:0o700}); fs.chmodSync(p,0o700);}
function atomic(p, bytes) {
  privateDir(path.dirname(p)); const tmp = p+'.'+randomUUID()+'.tmp';
  try {fs.writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'}); fs.renameSync(tmp,p); fs.chmodSync(p,0o600);}
  finally {fs.rmSync(tmp,{force:true});}
}
function readJson(p, fallback) {
  try {return JSON.parse(fs.readFileSync(p,'utf8'));}
  catch(e) {if(e.code==='ENOENT') return fallback; throw new Error('Account metadata is unreadable. Restore its backup before continuing.');}
}
function equalFiles(a,b) {
  try {return fs.readFileSync(a).equals(fs.readFileSync(b));} catch {return false;}
}
function authBytes(p) {
  const s=fs.lstatSync(p); if(!s.isFile() || s.isSymbolicLink() || s.size===0 || s.size>1024*1024) throw new Error('Invalid login file.');
  return fs.readFileSync(p);
}
function windowInfo(w) {
  if (!w) return null;
  const used = typeof w.usedPercent==='number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null;
  return {usedPercent:used,remainingPercent:used===null?null:Math.max(0,Math.min(100,100-used)),
    windowDurationMins:w.windowDurationMins ?? null,resetsAt:w.resetsAt ?? null};
}
function normalizeUsage(raw) {
  const source = raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length
    ? raw.rateLimitsByLimitId : raw.rateLimits ? {[raw.rateLimits.limitId || 'codex']:raw.rateLimits} : {};
  return {accountId:raw.accountId || null,checkedAt:iso(),
    buckets:Object.entries(source).filter(([,v])=>v).map(([id,b])=>({id,name:b.limitName || (id==='codex'?'Codex':id),
      planType:b.planType ?? null,primary:windowInfo(b.primary),secondary:windowInfo(b.secondary),
      credits:b.credits ? {hasCredits:b.credits.hasCredits,unlimited:b.credits.unlimited,balance:b.credits.balance}:null,
      spendControlReached:b.spendControlReached ?? null,rateLimitReachedType:b.rateLimitReachedType ?? null})),
    resets:raw.rateLimitResetCredits ? {availableCount:raw.rateLimitResetCredits.availableCount ?? null,
      credits:raw.rateLimitResetCredits.credits?.map(c=>({title:c.title,resetType:c.resetType,expiresAt:c.expiresAt})) ?? null}:null};
}
function identity(a) {
  return a?.type==='chatgpt' ? {type:a.type,email:a.email ?? null,planType:a.planType ?? null}:null;
}
function validateLabel(label) {
  if(typeof label!=='string'||!label.trim()||label.length>64||/[\x00-\x1f]/.test(label)) throw new Error('Enter an account name of 1–64 characters.');
  return label.trim();
}

class Manager {
  constructor({root=process.env.CODEX_ACCOUNT_MANAGER_HOME || path.join(os.homedir(),'.codex-account-manager'),
    codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),
    rpcFactory=(home,options)=>new CodexRpc(home,options),trackLocal=true}={}) {
    this.root=path.resolve(root); this.codexHome=path.resolve(codexHome); this.rpcFactory=rpcFactory;
    this.dbPath=path.join(this.root,'accounts.json'); this.activeAuth=path.join(this.codexHome,'auth.json');
    privateDir(this.root); privateDir(path.join(this.root,'accounts')); privateDir(path.join(this.root,'backups'));
    this.login=null; this.trackLocal=trackLocal;
  }
  db() {return readJson(this.dbPath,{version:1,accounts:[],activeId:null,active:null,switch:null});}
  write(db) {atomic(this.dbPath,JSON.stringify(db,null,2)+'\n');}
  home(id) {
    if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid account identifier.');
    return path.join(this.root,'accounts',id);
  }
  auth(id) {return path.join(this.home(id),'auth.json');}
  find(db,id) {const a=db.accounts.find(a=>a.id===id); if(!a) throw new Error('Saved account not found.'); return a;}
  async locked(fn) {
    const lock=path.join(this.root,'operation.lock');
    try {fs.mkdirSync(lock,{mode:0o700});}
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      const owner=readJson(path.join(lock,'owner.json'),null);
      let alive=true; if(owner?.pid) {try{process.kill(owner.pid,0);}catch(e){alive=e.code!=='ESRCH';}}
      if(!alive) {fs.rmSync(lock,{recursive:true,force:true}); return this.locked(fn);}
      throw new Error('Another account operation is running. Please wait.');
    }
    fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
    try{return await fn();}finally{fs.rmSync(lock,{recursive:true,force:true});}
  }
  async withRpc(home,fn) {
    const rpc=this.rpcFactory(home);
    try {await rpc.init(); return await fn(rpc);} finally {await rpc.close();}
  }
  async inspect(home,usage=true) {
    return this.withRpc(home,async rpc=>{
      const a=identity((await rpc.request('account/read',{refreshToken:false})).account);
      if(!a) throw new RpcError('reconnect','A ChatGPT login is required. Connect this account again.');
      if(!usage) return {identity:a};
      const result={identity:a};
      try {result.usage=normalizeUsage(await rpc.request('account/rateLimits/read'));}
      catch(e) {result.error={code:e.code||'unavailable',message:e.message};result.checkedAt=iso();}
      if(result.error?.code==='reconnect') result.tokenError='Reconnect this account to read its token history.';
      else {
        try {result.tokenUsage=normalizeTokens(await rpc.request('account/usage/read',{}));}
        catch(e) {result.tokenError=e.message;}
      }
      return result;
    });
  }
  backup(bytes,label='session') {
    const p=path.join(this.root,'backups',`${Date.now()}-${label}-${randomUUID()}.json`); atomic(p,bytes); return p;
  }
  // Read live auth through Codex in a private temporary home. Any refreshed login is
  // propagated back with compare-and-swap, never silently discarded or applied to another account.
  async activeSnapshot(usage=false) {
    if(!fs.existsSync(this.activeAuth)) return null;
    const before=authBytes(this.activeAuth);
    const home=fs.mkdtempSync(path.join(this.root,'active-')); fs.chmodSync(home,0o700);
    atomic(path.join(home,'auth.json'),before);
    try {
      const result=await this.inspect(home,usage);
      const after=authBytes(path.join(home,'auth.json'));
      if(!authBytes(this.activeAuth).equals(before)) throw new Error('The app changed accounts during this check. Refresh again.');
      if(!before.equals(after)) {this.backup(before); atomic(this.activeAuth,after);}
      return {...result,bytes:after};
    } finally {fs.rmSync(home,{recursive:true,force:true});}
  }
  match(db,snap) {
    if(!snap) return null;
    const exact=db.accounts.filter(a=>{try{return authBytes(this.auth(a.id)).equals(snap.bytes);}catch{return false;}});
    if(exact.length===1) return exact[0];
    if(snap.usage?.accountId) {
      const ids=db.accounts.filter(a=>a.usage?.accountId===snap.usage.accountId);
      if(ids.length===1) return ids[0];
      if(ids.length>1) return null;
    }
    const candidates=db.accounts.filter(a=>snap.usage?.accountId && a.usage?.accountId
      ? snap.usage.accountId===a.usage.accountId
      : snap.identity?.email && a.identity?.email===snap.identity.email);
    return candidates.length===1 ? candidates[0]:null;
  }
  applySnapshot(account,snap) {
    if(snap.tokenUsage){account.tokenUsage=snap.tokenUsage;delete account.tokenError;}
    else if(snap.tokenError)account.tokenError=snap.tokenError;
    if(snap.identity) account.identity=snap.identity;
    if(snap.usage) {account.usage=snap.usage; account.status='ready'; delete account.error;}
    else if(snap.error) {account.status=snap.error.code==='reconnect'?'reconnect':'unavailable'; account.error=snap.error.message;}
    account.lastCheckedAt=snap.usage?.checkedAt || snap.checkedAt || iso();
  }
  syncActive(db,snap) {
    const a=this.match(db,snap);
    if(a) {atomic(this.auth(a.id),snap.bytes); this.applySnapshot(a,snap);}
    db.activeId=a?.id || null;
    db.active=snap ? {identity:snap.identity,usage:snap.usage || (a?.usage ?? null),checkedAt:iso()}:null;
    return a;
  }
  publicState() {
    const db=this.db();
    const localUsage=readJson(path.join(this.root,'local-usage.json'),null);
    if(localUsage)delete localUsage.observedFingerprint;
    // Byte equality proves the selected file, without trusting yesterday's selection marker.
    const activeId=db.accounts.find(a=>equalFiles(this.auth(a.id),this.activeAuth))?.id || null;
    return {localUsage,tokenSummary:tokenSummary(db.accounts),accounts:db.accounts.map(a=>({...a,current:a.id===activeId,
      tokenPeriods:tokenPeriods(a.tokenUsage),tokenStale:!a.tokenUsage||!!a.tokenError||Date.now()-Date.parse(a.tokenUsage.checkedAt)>120000,
      stale:a.status!=='ready' || !a.usage || Date.now()-Date.parse(a.usage.checkedAt)>120000})),
      activeId,active:activeId ? db.active : null,switch:db.switch,
      login:this.login ? {id:this.login.id,label:this.login.label,status:this.login.status,
        authUrl:this.login.authUrl,error:this.login.error}:null};
  }
  async renameAccount(id,label) {
    label=validateLabel(label);
    return this.locked(async()=>{
      const db=this.db(),account=this.find(db,id);
      account.label=label;this.write(db);
      return {ok:true,id,message:'Account name updated.'};
    });
  }
  async removeAccount(id) {
    return this.locked(async()=>{
      const db=this.db();const account=this.find(db,id);
      // Ensure even a newly saved account has a durable local identity before its login is removed.
      // This only observes local files and metadata; it makes no account API requests.
      if(this.trackLocal)await require('./local-tracker.cjs').scanLocal(this,0);
      const home=this.home(id),staged=path.join(this.root,'removing-'+randomUUID());
      // Stage the directory so a metadata-write failure can restore the saved login.
      fs.renameSync(home,staged);
      try {
        db.accounts=db.accounts.filter(a=>a.id!==id);
        if(db.activeId===id){db.activeId=null;db.active=null;}
        this.write(db);
      } catch(e) {fs.renameSync(staged,home);throw e;}
      fs.rmSync(staged,{recursive:true,force:true});
      return {ok:true,id,message:`Removed ${account.label} from saved accounts. Local usage history is kept, and the app's current login is unchanged.`};
    });
  }
  async saveCurrent(label) {
    label=validateLabel(label);
    return this.locked(async()=>{
      const db=this.db(); const snap=await this.activeSnapshot(true);
      if(!snap) throw new Error('No file-backed Codex login found. Use Connect account.');
      let a=this.match(db,snap);
      if(!a && db.accounts.some(a=>a.label.toLowerCase()===label.toLowerCase())) throw new Error('That name is already in use. Choose a different name.');
      if(!a) {a={id:randomUUID(),label,savedAt:iso()}; db.accounts.push(a);}
      atomic(this.auth(a.id),snap.bytes); this.applySnapshot(a,snap); this.syncActive(db,snap); this.write(db);
      return {ok:true,id:a.id,message:`Saved ${a.label}.`};
    });
  }
  async refresh(id) {
    return this.locked(async()=>{
      const db=this.db(); if(id) this.find(db,id);
      const snap=await this.activeSnapshot(true); const active=this.syncActive(db,snap);
      // Sequential checks serialize refresh-token use, including byte-identical imported sessions.
      for(const a of db.accounts.filter(a=>(!id||a.id===id)&&a.id!==active?.id)) {
        try {this.applySnapshot(a,await this.inspect(this.home(a.id)));}
        catch(e) {a.status=e.code==='reconnect'?'reconnect':'unavailable'; a.error=e.message; a.tokenError=e.message; a.lastCheckedAt=iso();}
        this.write(db);
      }
      this.write(db); return this.publicState();
    });
  }
  async importLegacy(dir=path.join(os.homedir(),'.codex-account-profiles','profiles')) {
    return this.locked(async()=>{
      const db=this.db(); let imported=0,duplicates=0;
      if(!fs.existsSync(dir)) return {ok:true,imported,duplicates};
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        if(!entry.isDirectory()) continue;
        const source=path.join(dir,entry.name,'auth.json'); if(!fs.existsSync(source)) continue;
        const bytes=authBytes(source);
        if(db.accounts.some(a=>authBytes(this.auth(a.id)).equals(bytes))) {duplicates++;continue;}
        let label=entry.name; while(db.accounts.some(a=>a.label===label)) label+=' (imported)';
        const a={id:randomUUID(),label,savedAt:iso(),status:'unchecked',imported:true};
        atomic(this.auth(a.id),bytes); db.accounts.push(a); imported++;
      }
      this.write(db); return {ok:true,imported,duplicates};
    });
  }
  async connect(label,replaceId) {
    label=validateLabel(label);
    if(this.login?.status==='waiting') throw new Error('A login is already open. Finish or cancel it first.');
    const db=this.db(); if(replaceId) this.find(db,replaceId);
    else if(db.accounts.some(a=>a.label.toLowerCase()===label.toLowerCase())) throw new Error('That account name is already in use.');
    const home=fs.mkdtempSync(path.join(this.root,'login-')); fs.chmodSync(home,0o700);
    const login={id:randomUUID(),label,replaceId,status:'starting',home}; this.login=login;
    const rpc=this.rpcFactory(home,{onNotification:m=>{
      if(m.method==='account/login/completed') this.finishLogin(login,m.params).catch(()=>{});
    }}); login.rpc=rpc;
    try {
      await rpc.init();
      const result=await rpc.request('account/login/start',{type:'chatgpt'});
      if(result.type!=='chatgpt' || !result.authUrl?.startsWith('https://auth.openai.com/')) throw new Error('Unsupported login response.');
      login.authUrl=result.authUrl; login.loginId=result.loginId; login.status='waiting';
      login.timer=setTimeout(()=>this.cancelLogin().catch(()=>{}),10*60*1000); login.timer.unref();
      return {ok:true,id:login.id,authUrl:login.authUrl};
    }catch(e){await this.cleanLogin(login); login.status='error';login.error=e.message;throw e;}
  }
  async finishLogin(login,result) {
    if(login!==this.login || login.status==='cancelled') return;
    clearTimeout(login.timer); login.status='saving';
    try {
      if(!result?.success) throw new Error('Login was not completed. Try connecting again.');
      const info=identity((await login.rpc.request('account/read',{refreshToken:false})).account);
      if(!info) throw new Error('This connection is not a ChatGPT account.');
      let usage=null,usageError=null;
      try {usage=normalizeUsage(await login.rpc.request('account/rateLimits/read'));}
      catch(e) {usageError={code:e.code || 'unavailable',message:e.message};}
      let tokenUsage=null,tokenError=null;
      try {tokenUsage=normalizeTokens(await login.rpc.request('account/usage/read',{}));}
      catch(e) {tokenError=e.message;}
      const bytes=authBytes(path.join(login.home,'auth.json'));
      await this.locked(async()=>{
        const db=this.db(); let a=login.replaceId ? this.find(db,login.replaceId):null;
        if(a?.identity?.email && a.identity.email!==info.email) throw new Error('You signed into a different account. Connect it under a new name.');
        if(a?.usage?.accountId && usage?.accountId && a.usage.accountId!==usage.accountId) throw new Error('You selected a different workspace. Connect it as a separate account.');
        if(!a) a=db.accounts.find(a=>usage?.accountId && a.usage?.accountId===usage.accountId);
        if(!a) {a={id:randomUUID(),label:login.label,savedAt:iso()};db.accounts.push(a);}
        if(fs.existsSync(this.auth(a.id))) this.backup(authBytes(this.auth(a.id)));
        atomic(this.auth(a.id),bytes);this.applySnapshot(a,{identity:info,usage,error:usageError,tokenUsage,tokenError});this.write(db);
      });
      login.status='complete';
    }catch(e){login.status='error';login.error=e.message;}
    finally{await this.cleanLogin(login);}
  }
  async cleanLogin(login) {
    clearTimeout(login.timer); await login.rpc.close(); fs.rmSync(login.home,{recursive:true,force:true}); delete login.authUrl;
  }
  async cancelLogin() {
    const login=this.login; if(!login || !['starting','waiting'].includes(login.status)) return {ok:true};
    login.status='cancelled'; await this.cleanLogin(login); return {ok:true};
  }
  async switchAccount(id,{quitApp,reopenApp}={}) {
    return this.locked(async()=>{
      const db=this.db(); const target=this.find(db,id);
      const original=await this.activeSnapshot(false);
      const outgoing=this.match(db,original);
      if(outgoing?.id===id) return {ok:true,message:'This account is already selected.'};
      const checked=await this.inspect(this.home(id)); this.applySnapshot(target,checked); this.write(db);
      if(!checked.usage) throw new Error('This account could not be verified. Refresh or reconnect it before switching.');
      if(typeof quitApp!=='function'||typeof reopenApp!=='function') throw new Error('Open the dashboard to switch and safely reopen the app.');
      const previousActive=db.active,previousActiveId=db.activeId;
      let quit=false,changed=false,backup=null;
      try {
        db.switch={status:'closing',label:target.label,at:iso()};this.write(db);
        await quitApp(); quit=true;
        // The app may refresh during quit. Save the final live session, not the preflight snapshot.
        const final=await this.activeSnapshot(false);
        if(final) {
          backup=final.bytes; this.backup(backup,'before-switch');
          let previous=this.match(db,final);
          if(!previous) {previous={id:randomUUID(),label:'Saved before switch '+new Date().toLocaleString(),savedAt:iso()};db.accounts.push(previous);}
          atomic(this.auth(previous.id),final.bytes);this.applySnapshot(previous,final);
        }
        const targetBytes=authBytes(this.auth(id)); atomic(this.activeAuth,targetBytes);changed=true;
        if(!equalFiles(this.activeAuth,this.auth(id))) throw new Error('The login file changed during switching.');
        db.activeId=id;db.active={identity:target.identity,usage:target.usage,checkedAt:iso()};target.lastUsedAt=iso();
        db.switch={status:'reopening',label:target.label,at:iso()};this.write(db);
        await reopenApp();
        db.switch={status:'complete',label:target.label,at:iso()};this.write(db);
        return {ok:true,message:`Selected ${target.label} and reopened the app.`};
      }catch(e){
        if(changed) {
          if(backup) atomic(this.activeAuth,backup); else fs.rmSync(this.activeAuth,{force:true});
          db.active=previousActive;db.activeId=previousActiveId;
        }
        db.switch={status:'error',label:target.label,message:e.message,at:iso()};this.write(db);
        if(quit) await reopenApp().catch(()=>{});
        throw e;
      }
    });
  }
}
module.exports={Manager,atomic,privateDir,readJson,normalizeUsage,windowInfo,validateLabel,equalFiles};
