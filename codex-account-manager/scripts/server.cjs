'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {Manager,atomic}=require('./manager.cjs');
const {desktopLifecycle}=require('./desktop.cjs');
const {startTracker}=require('./local-tracker.cjs');
const {startSessions}=require('./live-sessions.cjs');

async function serve({manager=new Manager(),port=0,lifecycle=desktopLifecycle,trackLocal=true}={}) {
  const token=randomBytes(32).toString('hex'); let origin;
  let operation=null;
  let sessions=null;
  const web=path.join(__dirname,'../web');
  function json(res,status,data) {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
  async function body(req) {
    let bytes=0,chunks=[];
    for await (const chunk of req) {bytes+=chunk.length;if(bytes>8192) throw new Error('Request is too large.');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new Error('Invalid request.');}
  }
  function auth(req) {
    const candidate=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,''));const expected=Buffer.from(token);
    return candidate.length===expected.length && timingSafeEqual(candidate,expected);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.headers.host!==new URL(origin).host) return json(res,403,{error:'Invalid host.'});
    const url=new URL(req.url,origin);
    if(url.pathname==='/api/health' && req.method==='GET') return json(res,200,{ok:true,app:'codex-account-manager'});
    if(url.pathname.startsWith('/api/')) {
      if(!auth(req)) return json(res,401,{error:'Open this dashboard from the Account Manager plugin.'});
      if(req.headers.origin && req.headers.origin!==origin) return json(res,403,{error:'Invalid origin.'});
      try {
        if(req.method==='GET' && url.pathname==='/api/sessions') return json(res,200,sessions?.state()||{sessions:[],loading:true});
        if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,{...manager.publicState(),operation});
        if(req.method!=='POST') return json(res,405,{error:'Method not allowed.'});
        if(!String(req.headers['content-type']||'').startsWith('application/json')) return json(res,415,{error:'JSON required.'});
        const input=await body(req);let result;
        if(manager.login && ['starting','waiting','saving'].includes(manager.login.status) && url.pathname!=='/api/login/cancel')
          throw new Error('Finish or cancel the account connection before starting another operation.');
        if(operation?.status==='running' && url.pathname!=='/api/login/cancel') throw new Error('An account operation is already running.');
        if(url.pathname==='/api/refresh') {
          operation={type:'refresh',status:'running'};
          manager.refresh(input.id).then(()=>operation={type:'refresh',status:'complete'})
            .catch(e=>operation={type:'refresh',status:'error',message:e.message});
          return json(res,202,{ok:true});
        }
        if(url.pathname==='/api/save') result=await manager.saveCurrent(input.label);
        else if(url.pathname==='/api/rename') result=await manager.renameAccount(input.id,input.label);
        else if(url.pathname==='/api/remove') result=await manager.removeAccount(input.id);
        else if(url.pathname==='/api/connect') result=await manager.connect(input.label,input.id);
        else if(url.pathname==='/api/login/cancel') result=await manager.cancelLogin();
        else if(url.pathname==='/api/switch') {
          if(input.reopen!==true) throw new Error('Switching requires reopening the app.');
          const hooks=lifecycle(); operation={type:'switch',status:'running'};
          manager.switchAccount(input.id,hooks).then(r=>operation={type:'switch',status:'complete',message:r.message})
            .catch(e=>operation={type:'switch',status:'error',message:e.message});
          return json(res,202,{ok:true,message:'Checking the account before reopening the app.'});
        } else return json(res,404,{error:'Not found.'});
        return json(res,200,result);
      }catch(e){return json(res,400,{error:e.message});}
    }
    const files={'/':'index.html','/app.js':'app.js','/usage.js':'usage.js','/privacy.js':'privacy.js','/style.css':'style.css'};
    if(req.method!=='GET'||!files[url.pathname]) return json(res,404,{error:'Not found.'});
    const ext=path.extname(files[url.pathname]);res.setHeader('Content-Type',ext==='.js'?'text/javascript':ext==='.css'?'text/css':'text/html');
    res.end(fs.readFileSync(path.join(web,files[url.pathname])));
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const url=origin+'/#'+token;
  atomic(path.join(manager.root,'dashboard.json'),JSON.stringify({pid:process.pid,url,origin,token}));
  if(trackLocal){const stop=startTracker(manager);server.once('close',stop);sessions=startSessions(manager);server.once('close',sessions.stop);}
  return {server,url,token,origin,manager};
}
if(require.main===module) serve().then(()=>{}).catch(()=>{process.stderr.write('Account dashboard could not start.\n');process.exitCode=1;});
module.exports={serve};
