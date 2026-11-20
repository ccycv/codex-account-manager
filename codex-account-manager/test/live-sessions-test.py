import importlib.util,json,os,shutil,sqlite3,subprocess,tempfile,time,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('sessions',Path(__file__).parent/'../scripts/live-sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SessionsTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=m.connect(self.root);self.s=m.initial('s');self.s.update(provider='openai',model='gpt-6-astra',effort='high',turn='t')
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def event(self,kind,p,at='2026-09-10T10:00:00Z',s=None):
  line=json.dumps(dict(type=kind,payload=p,timestamp=at)).encode();m.consume(line,s if s is not None else self.s,self.db);return line+b'\n'
 def token(self,total=1100,s=None,**kw):
  u=dict(input_tokens=1000,cached_input_tokens=600,cache_write_input_tokens=100,output_tokens=100,reasoning_output_tokens=80,total_tokens=1100);u.update(kw)
  return self.event('event_msg',dict(type='token_count',info=dict(total_token_usage=dict(total_tokens=total),last_token_usage=u)),s=s)
 def test_cache_and_reasoning_are_not_double_charged(self):
  self.token();u=m.metrics(self.db,'s');self.assertEqual(u['tokens']['total_tokens'],1100);self.assertAlmostEqual(u['cost'],.00985)
 def test_long_context_threshold_and_unknown_rates(self):
  u=dict(input_tokens=272000,cached_input_tokens=0,output_tokens=100)
  self.assertAlmostEqual(m.estimate('gpt-6-astra',u),2.725)
  u['input_tokens']+=1;self.assertAlmostEqual(m.estimate('gpt-6-astra',u),5.44752)
  self.assertIsNone(m.estimate('unknown-model',u));u['cached_input_tokens']=999999;self.assertIsNone(m.estimate('gpt-6-astra',u))
 def test_duplicates_interleaved_counters_and_replay(self):
  self.token(100000);self.token(100000);self.token(900000);self.token(101100)
  self.token(100000,s=dict(self.s,previous=None,session='fork'))
  self.assertEqual(m.metrics(self.db,'s')['tokens']['total_tokens'],3300);self.assertEqual(m.metrics(self.db,'fork')['requests'],0)
 def test_model_changes_price_each_request(self):
  self.token();self.s['model']='gpt-5.6-sol';self.token(2200);u=m.metrics(self.db,'s');self.assertAlmostEqual(u['cost'],.00985+.00394);self.assertEqual(len(u['models']),2)
 def test_missing_price_remains_partial(self):
  self.token();self.s['model']='unknown';self.token(2200);u=m.metrics(self.db,'s');self.assertEqual(u['unpricedRequests'],1);self.assertAlmostEqual(u['cost'],.00985)
 def test_fork_history_and_other_provider_excluded(self):
  self.s['created']=m.stamp('2026-09-11T00:00:00Z');self.token();self.s.update(created=0,provider='other');self.token(2200);self.assertEqual(m.metrics(self.db,'s')['requests'],0)
 def test_lifecycle_and_effort(self):
  self.event('event_msg',dict(type='task_started',turn_id='new'))
  self.event('turn_context',dict(turn_id='new',model='gpt-5.6-sol',effort='xhigh'))
  self.assertEqual(self.s['status'],'active');self.assertEqual(self.s['effort'],'xhigh')
  self.event('event_msg',dict(type='task_complete',turn_id='old'));self.assertEqual(self.s['status'],'active')
  self.event('event_msg',dict(type='turn_aborted',turn_id='new'));self.assertEqual(self.s['status'],'interrupted')
 def test_cursor_restart_partial_line_and_immediate_status(self):
  file=self.root/'rollout.jsonl';meta=json.dumps(dict(type='session_meta',payload=dict(id='s',model_provider='openai'))).encode()+b'\n'
  line=self.token();self.db.execute('delete from events');file.write_bytes(meta+line[:-1])
  info=dict(id='s');live,pending,_=m.scan_file(self.db,file,info,100000);self.assertGreater(pending,0);self.assertEqual(m.metrics(self.db,'s')['requests'],0)
  with file.open('ab') as f:f.write(b'\n')
  m.scan_file(self.db,file,info,100000);self.db.commit();self.db.close();self.db=m.connect(self.root)
  m.scan_file(self.db,file,info,100000);self.assertEqual(m.metrics(self.db,'s')['requests'],1)
 def test_copied_parent_metadata_cannot_change_fork_identity_or_creation(self):
  self.event('session_meta',dict(id='child',timestamp='2026-09-10T09:00:00Z',model_provider='openai'))
  self.event('session_meta',dict(id='parent',timestamp='2026-09-01T00:00:00Z',model_provider='openai'))
  self.assertEqual(self.s['session'],'child');self.assertEqual(self.s['created'],m.stamp('2026-09-10T09:00:00Z'))
  self.token();self.assertEqual(m.metrics(self.db,'child')['requests'],1);self.assertEqual(m.metrics(self.db,'parent')['requests'],0)
 def test_recent_turn_counts_immediately_and_backfill_does_not_duplicate(self):
  file=self.root/'rollout.jsonl';meta=json.dumps(dict(type='session_meta',payload=dict(id='s',model_provider='openai'))).encode()+b'\n'
  context=json.dumps(dict(type='turn_context',timestamp='2026-09-10T09:59:00Z',payload=dict(turn_id='t',model='gpt-6-astra',effort='high'))).encode()+b'\n'
  line=self.token();self.db.execute('delete from events');file.write_bytes(meta+context+line)
  _,pending,_=m.scan_file(self.db,file,dict(id='s'),0);self.assertGreater(pending,0);self.assertEqual(m.metrics(self.db,'s')['requests'],1)
  m.scan_file(self.db,file,dict(id='s'),100000);self.assertEqual(m.metrics(self.db,'s')['requests'],1)
 def test_snapshot_deduplicates_backup_paths_and_marks_silent_turns_stale(self):
  meta=json.dumps(dict(type='session_meta',payload=dict(id='s',model_provider='openai'))).encode()+b'\n'
  context=json.dumps(dict(type='turn_context',timestamp='2026-09-10T09:59:00Z',payload=dict(turn_id='t',model='gpt-6-astra',effort='high'))).encode()+b'\n'
  line=self.token();self.db.execute('delete from events');files=[self.root/'a.jsonl',self.root/'b.jsonl']
  for file in files:file.write_bytes(meta+context+line)
  original=m.candidates;m.candidates=lambda *_:[(0,f,dict(id='s'))for f in files]
  try:result=m.snapshot(self.db,self.root,self.root,m.stamp('2026-09-10T10:05:00Z'))
  finally:m.candidates=original
  self.assertEqual(len(result['sessions']),1);row=result['sessions'][0];self.assertEqual(row['status'],'stale');self.assertEqual(row['usage']['tokens']['total_tokens'],1100);self.assertIsNone(row['accountId'])
 def test_tail_does_not_add_usage_until_import(self):
  file=self.root/'rollout.jsonl';meta=json.dumps(dict(type='session_meta',payload=dict(id='s',model_provider='openai'))).encode()+b'\n';line=self.token();self.db.execute('delete from events');file.write_bytes(meta+line)
  _,pending,_=m.scan_file(self.db,file,dict(id='s'),0);self.assertGreater(pending,0);self.assertEqual(m.metrics(self.db,'s')['requests'],0)
 @unittest.skipUnless(shutil.which('node') and subprocess.run(['node','-e',"process.exit(typeof require('zlib').zstdCompressSync==='function'?0:1)"]).returncode==0,'Node.js without zstd')
 def test_compressed_rollouts_are_listed_once_with_their_usage(self):
  now=time.time();at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(now-300))
  lines=[dict(type='session_meta',timestamp=at,payload=dict(id='zs',timestamp=at,model_provider='openai')),
   dict(type='turn_context',timestamp=at,payload=dict(turn_id='t',model='gpt-6-astra',effort='high')),
   dict(type='event_msg',timestamp=at,payload=dict(type='token_count',info=dict(total_token_usage=dict(total_tokens=1100),last_token_usage=dict(input_tokens=1000,cached_input_tokens=600,output_tokens=100,total_tokens=1100)))),
   dict(type='event_msg',timestamp=at,payload=dict(type='task_complete',turn_id='t'))]
  home=self.root/'home';day=home/'sessions'/'2026'/'11'/'20';day.mkdir(parents=True)
  plain=self.root/'plain.jsonl';plain.write_text(''.join(json.dumps(l)+'\n' for l in lines))
  name='rollout-2026-11-20T10-00-00-0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'
  subprocess.run(['node','-e',"const fs=require('fs'),z=require('zlib');fs.writeFileSync(process.argv[2],z.zstdCompressSync(fs.readFileSync(process.argv[1])))",str(plain),str(day/(name+'.zst'))],check=True)
  # The app index still names the uncompressed path; the reader must follow it to the .zst file.
  idx=sqlite3.connect(home/'state_5.sqlite');idx.execute('CREATE TABLE threads(id,rollout_path,title,cwd,model,reasoning_effort,updated_at,model_provider)')
  idx.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)',('zs',str(day/name),'Compressed task','/w/app','gpt-6-astra','high',now,'openai'));idx.commit();idx.close()
  for _ in range(2):result=m.snapshot(self.db,home,self.root,now)
  self.assertEqual(len(result['sessions']),1);row=result['sessions'][0]
  self.assertEqual((row['id'],row['title'],row['status'],row['pendingBytes']),('zs','Compressed task','finished',0))
  self.assertEqual(row['usage']['tokens']['total_tokens'],1100);self.assertEqual(row['usage']['requests'],1)
 def run_main(self,root,home):
  p=subprocess.run(['python3',str(Path(__file__).parent/'../scripts/live-sessions.py')],input=json.dumps(dict(root=str(root),codexHome=str(home))),capture_output=True,text=True)
  self.assertEqual(p.returncode,0,p.stderr);return json.loads(p.stdout)
 def test_corrupt_session_cache_is_rebuilt_but_a_corrupt_ledger_is_never_moved(self):
  root=self.root/'app';home=self.root/'codex';(home/'sessions').mkdir(parents=True);(root/'live-sessions').mkdir(parents=True)
  cache=root/'live-sessions'/'sessions.sqlite';cache.write_bytes(b'SQLite format 3\x00'+b'\xff'*4096)
  (root/'local-tracking').mkdir();ledger=root/'local-tracking'/'local-usage.sqlite';ledger.write_bytes(b'not a database'*100)
  self.assertEqual(self.run_main(root,home)['sessions'],[])
  self.assertTrue((root/'live-sessions'/'sessions.sqlite.corrupt').exists());self.assertTrue(cache.exists())
  self.assertEqual(ledger.read_bytes(),b'not a database'*100);self.assertFalse((root/'local-tracking'/'local-usage.sqlite.corrupt').exists())
  self.assertEqual(self.run_main(root,home)['sessions'],[])
if __name__=='__main__':unittest.main()
