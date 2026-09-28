import importlib.util,json,os,tempfile,unittest
spec=importlib.util.spec_from_file_location('tracker',os.path.join(os.path.dirname(__file__),'../scripts/local-tracker.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class TrackerTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=m.connect(self.tmp.name);self.now=1789000000.0
  self.state=dict(offset=0,previous=None,session='session',created=0,turn='turn',turn_at=self.now-5,provider='openai')
 def tearDown(self): self.db.close();self.tmp.cleanup()
 def token(self,total,last,at=None,state=None):
  stamp=m.dt.datetime.fromtimestamp(at or self.now,m.dt.timezone.utc).isoformat()
  event={'type':'event_msg','timestamp':stamp,'payload':{'type':'token_count','info':{'total_token_usage':{'total_tokens':total},'last_token_usage':{'total_tokens':last}}}}
  m.parse_event(self.db,json.dumps(event).encode(),state or self.state)
 def total(self):return self.db.execute('select coalesce(sum(tokens),0) from events').fetchone()[0]
 def test_incremental_and_duplicate_counts(self):
  self.token(100,100);self.token(100,100);self.token(180,80);self.assertEqual(self.total(),180)
 def test_first_cumulative_does_not_import_inherited_context(self):
  self.token(1000,50);self.assertEqual(self.total(),50)
 def test_interleaved_cumulative_counters_do_not_inflate_usage(self):
  self.token(50000000,100);self.token(90000000,200);self.token(50100000,300);self.token(90200000,400);self.assertEqual(self.total(),1000)
 def test_copied_turn_not_double_counted(self):
  self.token(100,100);other=dict(self.state,previous=None,session='fork');self.token(100,100,state=other);self.assertEqual(self.total(),100)
 def test_pre_fork_events_ignored(self):
  self.state['created']=self.now+1;self.token(100,100);self.assertEqual(self.total(),0)
 def test_observed_account_at_turn_start_and_removal_retains_usage(self):
  data={'accounts':[{'id':'a','label':'A','fingerprint':'hash'}],'activeFingerprint':'hash'}
  m.observe(self.db,data,self.now-10);m.observe(self.db,data,self.now)
  self.token(100,100);self.assertEqual(self.db.execute('select account from events').fetchone()[0],'a')
  m.observe(self.db,{'accounts':[],'activeFingerprint':'hash'},self.now+10)
  summary=m.summary(self.db,self.now+10);a=next(a for a in summary['accounts'] if a['id']=='a');self.assertFalse(a['connected']);self.assertEqual(a['periods']['allTime'],100)
  data['accounts'][0]['label']='A again';m.observe(self.db,data,self.now+20);self.assertEqual(self.db.execute('select count(*) from accounts').fetchone()[0],1);self.assertEqual(self.total(),100)
 def test_gap_and_switch_do_not_guess_account(self):
  m.observe(self.db,{'accounts':[{'id':'a','label':'A','fingerprint':'a'}],'activeFingerprint':'a'},self.now-100)
  m.observe(self.db,{'accounts':[{'id':'b','label':'B','fingerprint':'b'}],'activeFingerprint':'b'},self.now)
  self.token(100,100);self.assertIsNone(self.db.execute('select account from events').fetchone()[0])
 def test_non_openai_provider_excluded(self):self.state['provider']='other';self.token(100,100);self.assertEqual(self.total(),0)
 def test_calendar_periods_and_different_account_keep_old_totals(self):
  m.observe(self.db,{'accounts':[{'id':'a','label':'A'}]},self.now)
  today=m.dt.datetime.fromtimestamp(self.now,m.dt.timezone.utc).date()
  for age in [0,6,7,29,30]:
   day=(today-m.dt.timedelta(days=age)).isoformat()
   self.db.execute('insert into events values (?,?,?,?,?,?)',(str(age),self.now-age*m.DAY,day,'a',None,10))
  m.observe(self.db,{'accounts':[{'id':'b','label':'B'}]},self.now)
  self.db.commit();self.db.close();self.db=m.connect(self.tmp.name)
  result=m.summary(self.db,self.now)
  self.assertEqual(result['totals'],dict(today=10,days7=20,days30=40,allTime=50))
  self.assertEqual(next(a for a in result['accounts'] if a['id']=='b')['periods']['allTime'],0)
  self.assertFalse(next(a for a in result['accounts'] if a['id']=='a')['connected'])
 def test_persistent_offsets_partial_lines_and_file_removal(self):
  root=os.path.join(self.tmp.name,'sessions');os.mkdir(root);file=os.path.join(root,'a.jsonl')
  meta={'type':'session_meta','payload':{'id':'s','timestamp':'2026-01-01T00:00:00Z','model_provider':'openai'}}
  event={'type':'event_msg','timestamp':'2026-09-09T10:00:00Z','payload':{'type':'token_count','info':{'total_token_usage':{'total_tokens':100},'last_token_usage':{'total_tokens':100}}}}
  with open(file,'w')as f:f.write(json.dumps(meta)+'\n'+json.dumps(event))
  m.scan(self.db,[root],1000000);self.assertEqual(self.total(),0)
  with open(file,'a')as f:f.write('\n')
  m.scan(self.db,[root],1000000);m.scan(self.db,[root],1000000);self.assertEqual(self.total(),100)
  os.remove(file);m.scan(self.db,[root],1000000);self.assertEqual(self.total(),100)

if __name__=='__main__':unittest.main()
