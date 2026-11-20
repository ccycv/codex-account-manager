const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {findBrowser,buildPrivateCommand,openPrivate}=require('../scripts/private-browser.cjs');

const url='https://auth.openai.com/authorize?state=fixture';
const chrome={name:'Google Chrome',app:'/Applications/Google Chrome.app',flag:'--incognito'};

test('browser detection prefers Chrome and checks both Applications folders',()=>{
  const dirs=['/Applications',path.join(os.homedir(),'Applications')];
  const browser=findBrowser({platform:'darwin',dirs,env:{},exists:p=>p==='/Applications/Google Chrome.app'});
  assert.equal(browser.name,'Google Chrome');assert.equal(browser.app,'/Applications/Google Chrome.app');
  const home=findBrowser({platform:'darwin',dirs,env:{},exists:p=>p.endsWith('/Applications/Firefox.app')});
  assert.equal(home.name,'Firefox');assert.equal(home.firefox,true);
  assert.equal(findBrowser({platform:'linux',dirs,env:{},exists:()=>true}),null);
});

test('an explicit browser path overrides detection',()=>{
  const browser=findBrowser({platform:'darwin',dirs:[],env:{CODEX_ACCOUNT_PRIVATE_BROWSER:'/opt/Brave Browser.app'},exists:p=>p==='/opt/Brave Browser.app'});
  assert.equal(browser.name,'Brave Browser');assert.equal(browser.app,'/opt/Brave Browser.app');
});

test('builds an isolated incognito launch without a shell',()=>{
  const launch=buildPrivateCommand(chrome,url,'/tmp/private profile');
  assert.equal(launch.command,'/usr/bin/open');
  assert.deepEqual(launch.args,['-na','/Applications/Google Chrome.app','--args','--user-data-dir=/tmp/private profile','--incognito','--no-first-run','--no-default-browser-check',url]);
  assert.deepEqual(buildPrivateCommand({name:'Microsoft Edge',app:'/Applications/Microsoft Edge.app',flag:'--inprivate'},url,'/tmp/p').args.slice(-4,-3),['--inprivate']);
  assert.throws(()=>buildPrivateCommand(chrome,'http://auth.openai.com/x','/tmp/p'),/HTTPS/);
});

test('Firefox uses a private window without managing a profile',()=>{
  const launch=buildPrivateCommand({name:'Firefox',app:'/Applications/Firefox.app',firefox:true,privateFlag:'-private-window'},url,null);
  assert.deepEqual(launch.args,['-na','/Applications/Firefox.app','--args','-private-window',url]);
});

test('openPrivate creates an owner-only profile and reports the launched browser',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-manager-browser-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profileDir=path.join(root,'profile');let call=null;
  const result=await openPrivate(url,{profileDir,browser:chrome,runner:async(command,args,options)=>{call={command,args,options};}});
  assert.deepEqual(result,{opened:true,browser:'Google Chrome'});
  assert.equal(call.command,'/usr/bin/open');
  assert.deepEqual(call.args,['-na','/Applications/Google Chrome.app','--args',`--user-data-dir=${profileDir}`,'--incognito','--no-first-run','--no-default-browser-check',url]);
  assert.equal(call.options.timeout,10000);
  assert.equal(fs.statSync(profileDir).mode&0o777,0o700);
});

test('openPrivate never surfaces launch errors or the sign-in link',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-manager-browser-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const result=await openPrivate(url,{profileDir:path.join(root,'profile'),browser:chrome,runner:async()=>{throw new Error('failed '+url);}});
  assert.deepEqual(result,{opened:false,browser:'Google Chrome',reason:'The private browser window could not be opened.'});
  assert.equal(JSON.stringify(result).includes('auth.openai.com'),false);
});

test('openPrivate falls back safely when no private-mode browser exists',async()=>{
  let ran=false;
  const result=await openPrivate(url,{platform:'darwin',dirs:[],env:{},exists:()=>false,runner:async()=>{ran=true;}});
  assert.equal(result.opened,false);assert.match(result.reason,/No private-mode browser/);assert.equal(ran,false);
  const invalid=await openPrivate('http://auth.openai.com/x',{browser:chrome,profileDir:'/tmp/unused',runner:async()=>{throw new Error('should not run');}});
  assert.equal(invalid.opened,false);assert.match(invalid.reason,/not valid/);
  assert.equal((await openPrivate(url,{platform:'linux',browser:chrome,runner:async()=>{}})).opened,false);
});
