import importlib.util, json, os, shutil, sqlite3, subprocess, tempfile, time, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('usage', Path(__file__).parent / '../scripts/usage-index.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
NOW = time.time()
iso = lambda t: time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + 'Z'


def codex_rollout(path, session='s1', model='gpt-6-astra', turns=((NOW - 600, 1000, 600, 100),), provider='openai', cwd='/work/app'):
    start = min(t[0] for t in turns) - 60
    lines = [dict(type='session_meta', timestamp=iso(start), payload=dict(id=session, timestamp=iso(start), model_provider=provider, cwd=cwd))]
    total = 0
    for i, (at, inp, cached, out) in enumerate(turns):
        lines.append(dict(type='turn_context', timestamp=iso(at), payload=dict(turn_id=f'{session}-t{i}', model=model)))
        total += inp + out
        usage = dict(input_tokens=inp, cached_input_tokens=cached, cache_write_input_tokens=0, output_tokens=out, reasoning_output_tokens=10, total_tokens=inp + out)
        lines.append(dict(type='event_msg', timestamp=iso(at), payload=dict(type='token_count', info=dict(total_token_usage=dict(total_tokens=total), last_token_usage=usage))))
        lines.append(dict(type='response_item', timestamp=iso(at), payload=dict(type='message', content='secret prompt text')))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(l) + '\n' for l in lines))


def claude_line(mid, at, model='claude-opus-5-5', inp=10, read=1000, write=200, w1h=200, out=50, speed='standard', session='c1', cwd='/work/site'):
    usage = dict(input_tokens=inp, cache_read_input_tokens=read, cache_creation_input_tokens=write,
                 cache_creation=dict(ephemeral_1h_input_tokens=w1h, ephemeral_5m_input_tokens=write - w1h), output_tokens=out, speed=speed)
    return json.dumps(dict(type='assistant', timestamp=iso(at), requestId='req_' + mid, sessionId=session, cwd=cwd,
                           message=dict(id='msg_' + mid, model=model, usage=usage, content=[dict(type='text', text='secret answer')]))) + '\n'


class UsageIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.base = Path(self.tmp.name)
        self.codex = self.base / 'codex'; self.claude = self.base / '.claude'; self.root = self.base / 'root'
        (self.codex / 'sessions').mkdir(parents=True); (self.claude / 'projects' / 'p').mkdir(parents=True)
        self.db = m.connect(self.root)

    def tearDown(self): self.db.close(); self.tmp.cleanup()

    def run_index(self, homes=None, budget=10**9):
        return m.index(self.db, self.codex, homes if homes is not None else [self.claude], budget, NOW)

    def query(self, **params): return m.query(self.db, None, params, NOW)

    def test_codex_costs_split_by_type_and_never_store_text(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl')
        self.run_index()
        q = self.query(range='24h')
        t = q['totals']
        self.assertEqual((t['requests'], t['input'], t['cacheRead'], t['output'], t['tokens']), (1, 400, 600, 100, 1100))
        # gpt-6-astra short context: $10 input, $1 cached, $50 output per 1M.
        self.assertAlmostEqual(t['costInput'], 400 * 10 / 1e6); self.assertAlmostEqual(t['costRead'], 600 * 1 / 1e6)
        self.assertAlmostEqual(t['costOutput'], 100 * 50 / 1e6); self.assertAlmostEqual(t['savings'], 600 * 9 / 1e6)
        self.assertEqual(q['providers'][0]['id'], 'codex'); self.assertEqual(q['breakdown']['project'][0]['key'], 'app')
        dump = '\n'.join(self.db.iterdump())
        self.assertNotIn('secret', dump)

    def test_claude_dedupes_content_block_lines_and_prices_cache_ttl_and_fast(self):
        lines = claude_line('1', NOW - 300) * 3 + claude_line('2', NOW - 200, speed='fast', w1h=0)
        lines += json.dumps(dict(type='assistant', timestamp=iso(NOW), message=dict(model='<synthetic>', usage=dict(output_tokens=5)))) + '\n'
        (self.claude / 'projects' / 'p' / 's.jsonl').write_text(lines)
        self.run_index()
        q = self.query(range='24h', provider='claude-code')
        self.assertEqual(q['totals']['requests'], 2)
        # Opus 5.5: $4 in, $0.20 read, $5 5m write, $8 1h write, $20 out. Fast doubles every rate.
        standard = (10 * 4 + 1000 * 0.2 + 200 * 8 + 50 * 20) / 1e6
        fast = 2 * (10 * 4 + 1000 * 0.2 + 200 * 5 + 50 * 20) / 1e6
        self.assertAlmostEqual(q['totals']['cost'], standard + fast)
        self.assertAlmostEqual(q['speeds']['fast']['cost'], fast)
        self.assertEqual(q['claudeAccounts'], ['claude:.claude'])
        self.assertEqual(q['breakdown']['account'][0]['key'], 'claude:.claude')

    def test_unknown_models_count_tokens_but_not_cost(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl', model='gpt-9-future')
        self.run_index(); q = self.query()
        self.assertEqual(q['totals']['tokens'], 1100); self.assertEqual(q['totals']['cost'], 0)
        self.assertEqual(q['totals']['unpriced'], 1); self.assertEqual(q['unpricedModels'], ['gpt-9-future'])

    def test_long_context_and_dated_model_ids(self):
        r = dict(input=272001, cache_read=0, cache_write=0, cache_write_1h=0, output=0)
        self.assertAlmostEqual(m.price('codex', 'gpt-6-astra', None, r)[0], 272001 * 20 / 1e6)
        self.assertIsNotNone(m.price('claude-code', 'claude-opus-5-5[1m]', 'standard', r))
        r['input'] = 100001
        self.assertAlmostEqual(m.price('claude-code', 'claude-haiku-5-5', 'standard', r)[0], 100001 * 0.5 / 1e6)

    def test_incremental_reads_resume_and_skip_partial_lines(self):
        path = self.claude / 'projects' / 'p' / 's.jsonl'
        path.write_text(claude_line('1', NOW - 300) + claude_line('2', NOW - 200)[:-20])
        self.run_index(); self.assertEqual(self.query()['totals']['requests'], 1)
        path.write_text(claude_line('1', NOW - 300) + claude_line('2', NOW - 200) + claude_line('3', NOW - 100))
        self.run_index(); self.assertEqual(self.query()['totals']['requests'], 3)

    def test_budget_reports_pending_bytes(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl'); codex_rollout(self.codex / 'sessions' / 'b.jsonl', session='s2')
        r = self.run_index(budget=1)
        self.assertGreater(r['pendingBytes'], 0)
        while r['pendingBytes']: r = self.run_index(budget=1)
        self.assertEqual(self.query()['totals']['requests'], 2)

    def test_old_requests_fall_outside_the_horizon_and_ranges_bucket_locally(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl', turns=((NOW - 100 * 86400, 10, 0, 1), (NOW - 20 * 86400, 10, 0, 1), (NOW - 60, 10, 0, 1)))
        os.utime(self.codex / 'sessions' / 'a.jsonl', (NOW, NOW))
        self.run_index()
        self.assertEqual(self.query(range='90d')['totals']['requests'], 2)
        self.assertEqual(self.query(range='7d')['totals']['requests'], 1)
        q = self.query(range='30d')
        self.assertEqual((len(q['series']), q['bucket']), (30, 'day'))
        self.assertEqual(sum(sum(p['requests'] for p in b['providers'].values()) for b in q['series']), 2)
        self.assertEqual((len(self.query(range='24h')['series']), len(self.query(range='7d')['series'])), (24, 42))

    def test_account_filter_uses_ledger_attribution_and_claude_profiles(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl')
        (self.claude / 'projects' / 'p' / 's.jsonl').write_text(claude_line('1', NOW - 300))
        other = self.base / '.claude-02'; (other / 'projects' / 'q').mkdir(parents=True)
        (other / 'projects' / 'q' / 's.jsonl').write_text(claude_line('9', NOW - 300))
        self.run_index(homes=[self.claude, other])
        rid = self.db.execute("SELECT id FROM requests WHERE provider='codex'").fetchone()[0]
        ledger = self.base / 'ledger.sqlite'; l = sqlite3.connect(ledger)
        l.executescript('CREATE TABLE events(id TEXT PRIMARY KEY,account TEXT); CREATE TABLE accounts(id TEXT,label TEXT,email TEXT,connected INTEGER);')
        l.execute('INSERT INTO events VALUES (?,?)', (rid, 'account:abc')); l.execute("INSERT INTO accounts VALUES ('account:abc','Work',NULL,1)"); l.commit(); l.close()
        q = m.query(self.db, str(ledger), dict(range='24h', account='account:abc'), NOW)
        self.assertEqual((q['totals']['requests'], q['providers'][0]['id']), (1, 'codex'))
        self.assertEqual(q['accounts'][0]['label'], 'Work')
        q = m.query(self.db, str(ledger), dict(range='24h', account='claude:.claude-02'), NOW)
        self.assertEqual((q['totals']['requests'], q['providers'][0]['id']), (1, 'claude-code'))
        self.assertEqual(m.query(self.db, str(ledger), dict(range='24h', account='unassigned'), NOW)['totals']['requests'], 0)
        self.assertEqual(sorted(m.query(self.db, str(ledger), {}, NOW)['claudeAccounts']), ['claude:.claude', 'claude:.claude-02'])

    def test_repricing_follows_pricing_changes(self):
        codex_rollout(self.codex / 'sessions' / 'a.jsonl'); self.run_index()
        before = self.query()['totals']['cost']
        self.db.execute("UPDATE meta SET value='stale' WHERE key='pricing'"); self.db.execute('UPDATE requests SET c_output=0'); self.db.commit()
        self.db.close(); self.db = m.connect(self.root)
        self.assertAlmostEqual(self.query()['totals']['cost'], before)

    @unittest.skipUnless(shutil.which('node') and subprocess.run(['node', '-e', "process.exit(typeof require('zlib').zstdCompressSync==='function'?0:1)"]).returncode == 0, 'Node.js without zstd')
    def test_compressed_codex_rollouts_are_read_once(self):
        plain = self.base / 'plain.jsonl'; codex_rollout(plain)
        target = self.codex / 'sessions' / 'a.jsonl.zst'
        subprocess.run(['node', '-e', "const fs=require('fs'),z=require('zlib');fs.writeFileSync(process.argv[2],z.zstdCompressSync(fs.readFileSync(process.argv[1])))", str(plain), str(target)], check=True)
        self.run_index(); self.run_index()
        self.assertEqual(self.query()['totals']['requests'], 1)
        # A plain copy of the same rollout (before compression) is the same requests, not new ones.
        shutil.copy(plain, self.codex / 'sessions' / 'a.jsonl'); self.run_index()
        self.assertEqual(self.query()['totals']['requests'], 1)


if __name__ == '__main__': unittest.main()
