const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('../web/analytics.js'),{params}=require('../scripts/usage-index.cjs'),{serve}=require('../scripts/server.cjs'),{Manager}=require('../scripts/manager.cjs');

test('money and token formatting stay compact and honest about tiny values',()=>{
  assert.equal(A.money(1656.15),'$1,656.15');assert.equal(A.money(0.004),'< $0.01');assert.equal(A.money(null),'N/A');
  assert.equal(A.compact(4.89e9),'4.89B');assert.equal(A.compact(13.6e6),'13.6M');assert.equal(A.compact(185e6),'185M');assert.equal(A.compact(0),'0');
  assert.equal(A.percent(1602.82,1656.15),'96.8%');assert.equal(A.percent(1,100000),'< 0.1%');assert.equal(A.percent(1,0),'0%');
});
test('axes use three round intervals that cover the data',()=>{
  assert.deepEqual(A.niceAxis(0),{top:1,ticks:[0],empty:true});
  assert.deepEqual(A.niceAxis(285).ticks,[0,100,200,300]);
  for(const max of [0.3,1,7,99,285,1601,4.89e9]){const a=A.niceAxis(max);assert.ok(a.top>=max);assert.equal(a.ticks.length,4);assert.ok(a.ticks.every((t,i)=>i===0||t>a.ticks[i-1]));}
});
test('smooth chart paths pass through every point and never dip below the baseline',()=>{
  const pts=[[0,100],[10,0],[20,100],[30,100],[40,50]],d=A.monotonePath(pts);
  assert.match(d,/^M0,100C/);for(const [x,y] of pts)assert.ok(d.includes(`${x},${y}`));
  const ys=[...d.matchAll(/,(-?\d+(?:\.\d+)?)/g)].map(m=>Number(m[1]));assert.ok(Math.max(...ys)<=100&&Math.min(...ys)>=0);
  assert.equal(A.monotonePath([]),'');assert.equal(A.monotonePath([[5,5]]),'M5,5');
});
const data={totals:{cost:100,tokens:1000,input:10,cacheRead:900,cacheWrite:40,output:50,costInput:1,costRead:60,costWrite:9,costOutput:30},
  providers:[{id:'claude-code',cost:90,tokens:800},{id:'codex',cost:10,tokens:200}],
  series:[{t:1,providers:{'claude-code':{cost:40,tokens:300,requests:2,unpriced:0}}},{t:2,providers:{}},{t:3,providers:{'claude-code':{cost:50,tokens:500,requests:3,unpriced:0},codex:{cost:10,tokens:200,requests:1,unpriced:0}}}],
  speeds:{standard:{cost:86,tokens:900},fast:{cost:4,tokens:50},unknown:{cost:10,tokens:50}},
  breakdown:{model:[{key:'gpt',provider:'codex',cost:10,tokens:600},{key:'opus',provider:'claude-code',cost:90,tokens:400}]}};
test('breakdowns rank by the active measure with shares of the total',()=>{
  assert.deepEqual(A.breakdown(data,'model','cost').map(r=>[r.key,r.share]),[['opus',.9],['gpt',.1]]);
  assert.deepEqual(A.breakdown(data,'model','tokens').map(r=>r.key),['gpt','opus']);
  const time=A.breakdown(data,'time','cost');assert.deepEqual(time.map(r=>[r.t,r.cost,r.requests]),[[3,60,4],[1,40,2]]);
  assert.equal(time[0].relative,1);
});
test('series, type and speed segments follow the measure',()=>{
  const s=A.providerSeries(data,'cost');assert.deepEqual(s.map(x=>[x.id,x.values]),[['claude-code',[40,0,50]],['codex',[0,0,10]]]);
  assert.deepEqual(A.typeSegments(data.totals,'cost').map(x=>x.value),[1,60,9,30]);
  assert.deepEqual(A.typeSegments(data.totals,'tokens').map(x=>x.value),[10,900,40,50]);
  assert.deepEqual(A.speedSegments(data.speeds,'cost').map(x=>x.key),['standard','fast','unknown']);
  assert.deepEqual(A.speedSegments({standard:{cost:1}},'cost').map(x=>x.key),['standard','fast']);
  assert.equal(A.fastPremium(data.speeds),2);
});
test('usage query parameters accept only the fixed vocabulary',()=>{
  assert.deepEqual(params({range:'7d',provider:'codex',account:'account:abc-1'}),{range:'7d',provider:'codex',account:'account:abc-1'});
  assert.deepEqual(params({range:'1y',provider:'x',account:"'; DROP TABLE"}),{range:'24h',provider:'all',account:'all'});
  assert.equal(params({account:'claude:.claude-02'}).account,'claude:.claude-02');
});
test('usage endpoint requires the dashboard capability and passes validated parameters',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-usage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const seen=[],manager=new Manager({root,codexHome:path.join(root,'codex'),trackLocal:false});
  const app=await serve({manager,trackLocal:false,usageIndex:{query:async p=>{seen.push(p);return {ok:true};}}});
  t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
  assert.equal((await fetch(app.origin+'/api/usage')).status,401);
  const r=await fetch(app.origin+'/api/usage?range=30d&provider=claude-code',{headers:{Authorization:'Bearer '+app.token}});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});assert.deepEqual(seen,[{range:'30d',provider:'claude-code'}]);
  for(const file of ['/analytics.js','/usage-page.js'])assert.equal((await fetch(app.origin+file)).status,200);
});
