const {test}=require('node:test');const assert=require('node:assert/strict');
const {normalizeTokens,tokenPeriods,tokenSummary}=require('../scripts/tokens.cjs');
const now=new Date('2026-09-09T23:59:00Z');
const snapshot=()=>normalizeTokens({summary:{lifetimeTokens:10000},dailyUsageBuckets:[{startDate:'2026-09-09',tokens:10},{startDate:'2026-09-03',tokens:20},{startDate:'2026-09-02',tokens:40},{startDate:'2026-08-11',tokens:80},{startDate:'2026-08-10',tokens:160},{startDate:'2026-09-10',tokens:320}]},now);
test('calendar periods include today and exact 7/30 day boundaries, exclude future dates',()=>{assert.deepEqual(tokenPeriods(snapshot(),now),{today:10,days7:30,days30:150,allTime:10000});});
test('today stays unavailable until its daily bucket is explicitly reported',()=>{assert.equal(tokenPeriods(normalizeTokens({}),now).today,null);assert.equal(tokenPeriods(normalizeTokens({dailyUsageBuckets:[]}),now).today,null);});
test('rejects malformed dates, duplicate daily rows, and unsafe token integers',()=>{for(const rows of [[{startDate:'2026-02-30',tokens:1}],[{startDate:'2026-09-09',tokens:-1}],[{startDate:'2026-09-09',tokens:1},{startDate:'2026-09-09',tokens:2}],[{startDate:'2026-09-09',tokens:Number.MAX_SAFE_INTEGER+1}]])assert.throws(()=>normalizeTokens({dailyUsageBuckets:rows}));});
test('combined total deduplicates account ids and legacy email copies and labels incomplete totals',()=>{
 const a={id:'a',identity:{email:'a@test'},usage:{accountId:'one'},tokenUsage:snapshot()};
 const result=tokenSummary([a,{...a,id:'duplicate'},{id:'old',identity:{email:'a@test'}},{id:'missing',identity:{email:'b@test'}}],now);
 assert.deepEqual(result.periods.today,{tokens:10,availableAccounts:1,totalAccounts:2,incomplete:true,staleAccounts:0});
});
test('failed history refresh retains older data and marks combined total stale',()=>{const result=tokenSummary([{id:'a',tokenUsage:snapshot(),tokenError:'Unavailable'}],now);assert.equal(result.periods.days7.tokens,30);assert.equal(result.periods.days7.staleAccounts,1);});
test('no available data is N/A not zero and no accounts is N/A',()=>{assert.equal(tokenSummary([{id:'a'}],now).periods.today.tokens,null);assert.equal(tokenSummary([],now).periods.today.tokens,null);});
test('distinct accounts sum and same email with distinct account ids stays separate',()=>{const result=tokenSummary(['a','b'].map(id=>({id,identity:{email:'same@test'},usage:{accountId:id},tokenUsage:snapshot()})),now);assert.equal(result.periods.today.tokens,20);assert.equal(result.periods.today.totalAccounts,2);});

test('missing current day is unknown; explicit zero is zero; prior period sums are preserved',()=>{
 const data=normalizeTokens({summary:{lifetimeTokens:123},dailyUsageBuckets:[{startDate:'2026-09-08',tokens:123}]},now);
 assert.deepEqual(tokenPeriods(data,now),{today:null,days7:123,days30:123,allTime:123});
 const a={id:'a',tokenUsage:data},b={id:'b',tokenUsage:normalizeTokens({dailyUsageBuckets:[{startDate:'2026-09-09',tokens:0}]},now)};
 assert.equal(tokenPeriods(b.tokenUsage,now).today,0);
 assert.deepEqual(tokenSummary([a,b],now).periods.today,{tokens:0,availableAccounts:1,totalAccounts:2,incomplete:true,staleAccounts:0});
 assert.equal(tokenSummary([a],now).periods.today.tokens,null);
});
