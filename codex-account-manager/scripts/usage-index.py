#!/usr/bin/env python3
"""Per-request usage index for the Usage page: Codex and Claude Code local logs.

Stores counters, model names, speed and cost estimates only. Prompt, completion and
reasoning text are never parsed beyond the usage-bearing records and never persisted.
Run with a JSON command on stdin: {"cmd": "index"|"query", ...}.
"""
import bisect
import datetime as dt
import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

PRICING = json.loads(Path(__file__).with_name('session-pricing.json').read_text())
HORIZON = 92 * 86400
FORMAT = '2'
PROVIDERS = {'codex': 'Codex', 'claude-code': 'Claude Code'}
RANGES = {'24h': (86400, 'hour'), '7d': (7 * 86400, 'hour4'), '30d': (30 * 86400, 'day'), '90d': (90 * 86400, 'day')}
COLUMNS = ('id', 'provider', 'account', 'at', 'session', 'project', 'model', 'speed', 'input', 'cache_read', 'cache_write',
           'cache_write_1h', 'output', 'reasoning', 'c_input', 'c_read', 'c_write', 'c_output', 'savings', 'priced')


def stamp(value):
    try: return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError): return None


def count(value):
    return value if type(value) is int and value >= 0 else 0


def pricing_version():
    return hashlib.sha256(json.dumps(PRICING, sort_keys=True).encode()).hexdigest()[:16]


def rates_for(table, model):
    if not model: return None
    if model in table: return table[model]
    # Dated or decorated IDs (e.g. "claude-opus-5-5[1m]") use their base model's rates.
    for key in sorted(table, key=len, reverse=True):
        if model.startswith(key + '-') or model.startswith(key + '['): return table[key]
    return None


def price(provider, model, speed, r):
    """Return (input, cache read, cache write, output, savings) in USD, or None when a rate is unknown."""
    if provider == 'codex':
        rates = rates_for(PRICING['models'], model)
        if not rates: return None
        total_input = r['input'] + r['cache_read'] + r['cache_write']
        p = rates['long'] if 'long' in rates and total_input > rates['threshold'] else rates['short']
        p_in, p_read, p_write, p_out = p
        writes = ((r['cache_write'], p_write),)
        multiplier = 1
    else:
        section = PRICING['anthropic']
        rates = rates_for(section['models'], model)
        if not rates: return None
        total_input = r['input'] + r['cache_read'] + r['cache_write']
        p = rates['long'] if 'long' in rates and total_input > rates['threshold'] else rates['short']
        p_in, p_read, p_w5, p_w1h, p_out = p
        writes = ((r['cache_write'] - r['cache_write_1h'], p_w5), (r['cache_write_1h'], p_w1h))
        multiplier = section.get('fastMultiplier', 2) if speed == 'fast' else 1
    if any(n and rate is None for n, rate in ((r['input'], p_in), (r['cache_read'], p_read), (r['output'], p_out), *writes)):
        return None
    m = multiplier / 1e6
    write = sum(n * (rate or 0) for n, rate in writes) * m
    return (r['input'] * p_in * m, r['cache_read'] * p_read * m, write, r['output'] * p_out * m,
            r['cache_read'] * max(0, p_in - p_read) * m)


def connect(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    path = root / 'usage.sqlite'
    db = sqlite3.connect(path, timeout=20)
    os.chmod(path, 0o600)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,provider TEXT,path TEXT,offset INTEGER,state TEXT,size INTEGER,mtime REAL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,provider TEXT,account TEXT,at REAL,session TEXT,project TEXT,model TEXT,speed TEXT,
        input INTEGER,cache_read INTEGER,cache_write INTEGER,cache_write_1h INTEGER,output INTEGER,reasoning INTEGER,
        c_input REAL,c_read REAL,c_write REAL,c_output REAL,savings REAL,priced INTEGER);
      CREATE INDEX IF NOT EXISTS request_time ON requests(at);
    ''')
    meta = dict(db.execute('SELECT key,value FROM meta'))
    if meta.get('format') != FORMAT:
        db.executescript('DROP TABLE requests; DELETE FROM files;')
        db.execute('''CREATE TABLE requests(id TEXT PRIMARY KEY,provider TEXT,account TEXT,at REAL,session TEXT,project TEXT,model TEXT,speed TEXT,
          input INTEGER,cache_read INTEGER,cache_write INTEGER,cache_write_1h INTEGER,output INTEGER,reasoning INTEGER,
          c_input REAL,c_read REAL,c_write REAL,c_output REAL,savings REAL,priced INTEGER)''')
        db.execute('CREATE INDEX IF NOT EXISTS request_time ON requests(at)')
        db.execute("INSERT OR REPLACE INTO meta VALUES ('format',?)", (FORMAT,))
        db.execute("INSERT OR REPLACE INTO meta VALUES ('started',?)", (str(time.time()),))
    if meta.get('pricing') != pricing_version():
        reprice(db)
        db.execute("INSERT OR REPLACE INTO meta VALUES ('pricing',?)", (pricing_version(),))
    db.commit()
    return db


def reprice(db):
    rows = db.execute('SELECT id,provider,model,speed,input,cache_read,cache_write,cache_write_1h,output FROM requests').fetchall()
    updates = []
    for rid, provider, model, speed, i, cr, cw, cw1, o in rows:
        cost = price(provider, model, speed, dict(input=i, cache_read=cr, cache_write=cw, cache_write_1h=cw1, output=o))
        updates.append((*(cost or (None,) * 5), 1 if cost else 0, rid))
    db.executemany('UPDATE requests SET c_input=?,c_read=?,c_write=?,c_output=?,savings=?,priced=? WHERE id=?', updates)


def store(db, provider, account, key, at, session, project, model, speed, r, replace=False):
    cost = price(provider, model, speed, r)
    values = (key, provider, account, at, session, project, model, speed, r['input'], r['cache_read'], r['cache_write'],
              r['cache_write_1h'], r['output'], r['reasoning'], *(cost or (None,) * 5), 1 if cost else 0)
    verb = 'INSERT OR REPLACE' if replace else 'INSERT OR IGNORE'
    db.execute(f'{verb} INTO requests VALUES ({",".join("?" * len(COLUMNS))})', values)


def codex_initial(fid):
    return dict(session=fid, created=0, provider='unknown', project='', turn=None, model=None, previous=None, meta=False)


def codex_line(db, line, state, cutoff):
    # Fast reject of content-bearing lines; only metadata and counters are parsed.
    if not any(m in line for m in (b'"session_meta"', b'"turn_context"', b'"token_count"', b'"task_started"')): return
    try: event = json.loads(line)
    except (ValueError, UnicodeDecodeError): return
    p = event.get('payload')
    if not isinstance(p, dict): return
    kind = event.get('type'); at = stamp(event.get('timestamp')) or 0
    if kind == 'session_meta':
        if state['meta']: return  # forks embed the parent's session_meta after their own
        state.update(meta=True, session=p.get('id') or p.get('session_id') or state['session'],
                     created=stamp(p.get('timestamp')) or at, provider=p.get('model_provider') or 'unknown',
                     project=os.path.basename(str(p.get('cwd') or '').rstrip('/')))
        return
    if at < state['created']: return  # copied pre-fork history
    if kind == 'turn_context':
        turn = p.get('turn_id')
        if turn and turn != state['turn']: state.update(turn=turn, previous=None)
        if p.get('model'): state['model'] = p.get('model')
        if p.get('cwd') and not state['project']: state['project'] = os.path.basename(str(p['cwd']).rstrip('/'))
        return
    if kind != 'event_msg': return
    if p.get('type') == 'task_started':
        if p.get('turn_id') and p.get('turn_id') != state['turn']: state.update(turn=p.get('turn_id'), previous=None)
        return
    if p.get('type') != 'token_count': return
    info = p.get('info') or {}
    total = info.get('total_token_usage') or {}; last = info.get('last_token_usage') or {}
    counter = total.get('total_tokens'); n = last.get('total_tokens')
    if type(counter) is not int or counter < 0: return
    previous = state['previous']; state['previous'] = counter
    if previous == counter or type(n) is not int or not 0 < n <= counter or state['provider'] != 'openai': return
    if at < cutoff: return
    i, cached, write = count(last.get('input_tokens')), count(last.get('cached_input_tokens')), count(last.get('cache_write_input_tokens'))
    if cached + write > i: return
    # Same identity as the durable ledger, so its account attribution joins exactly.
    key = hashlib.sha256(json.dumps([state['turn'] or state['session'], total], sort_keys=True).encode()).hexdigest()
    r = dict(input=i - cached - write, cache_read=cached, cache_write=write, cache_write_1h=0,
             output=count(last.get('output_tokens')), reasoning=count(last.get('reasoning_output_tokens')))
    store(db, 'codex', None, key, at, state['session'], state['project'], state['model'], None, r)


def claude_line(db, line, state, cutoff):
    if b'"usage"' not in line or b'"assistant"' not in line: return
    try: event = json.loads(line)
    except (ValueError, UnicodeDecodeError): return
    if event.get('type') != 'assistant': return
    m = event.get('message')
    if not isinstance(m, dict) or not isinstance(m.get('usage'), dict): return
    model = m.get('model')
    if not isinstance(model, str) or not model.startswith('claude'): return  # skips "<synthetic>" placeholders
    at = stamp(event.get('timestamp'))
    if at is None or at < cutoff: return
    u = m['usage']
    write = count(u.get('cache_creation_input_tokens'))
    split = u.get('cache_creation') if isinstance(u.get('cache_creation'), dict) else {}
    r = dict(input=count(u.get('input_tokens')), cache_read=count(u.get('cache_read_input_tokens')), cache_write=write,
             cache_write_1h=min(write, count(split.get('ephemeral_1h_input_tokens'))), output=count(u.get('output_tokens')),
             reasoning=count((u.get('output_tokens_details') or {}).get('thinking_tokens')))
    if not any(r.values()): return
    # Claude Code writes one line per content block with the same message usage: one request, counted once.
    ident = f"{m.get('id') or ''}:{event.get('requestId') or ''}"
    if ident == ':': ident = event.get('uuid') or line.decode('utf-8', 'replace')
    key = hashlib.sha256(('claude:' + ident).encode()).hexdigest()
    speed = 'fast' if u.get('speed') == 'fast' else 'standard'
    project = os.path.basename(str(event.get('cwd') or '').rstrip('/'))
    store(db, 'claude-code', state.get('account'), key, at, event.get('sessionId') or state['session'], project, model, speed, r, replace=True)


ZSTD = ("const z=require('zlib'),fs=require('fs');if(typeof z.createZstdDecompress!=='function')process.exit(3);"
        "fs.createReadStream(process.argv[1]).on('error',()=>process.exit(2)).pipe(z.createZstdDecompress())"
        ".on('error',()=>process.exit(2)).pipe(process.stdout);")


def decompressed(path, handle):
    """Stream a .zst rollout through Node's built-in zstd (Node 22.15+). Returns bytes read."""
    node = os.environ.get('CODEX_ACCOUNT_NODE') or 'node'
    proc = subprocess.Popen([node, '-e', ZSTD, path], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    total = 0
    try:
        for line in proc.stdout:
            total += len(line)
            if line.endswith(b'\n'): handle(line)
    finally:
        proc.stdout.close()
        code = proc.wait()
    if code == 3: raise LookupError('This Node.js has no built-in zstd')
    if code != 0: raise RuntimeError('zstd read failed')
    return total


def claude_account(home):
    return 'claude:' + (home.name or 'default')


def sources(codex_home, claude_homes, now):
    found = []
    groups = [('codex', None, [codex_home / 'sessions', codex_home / 'archived_sessions'])]
    groups += [('claude-code', claude_account(h), [h / 'projects']) for h in claude_homes]
    for provider, account, roots in groups:
        for base in roots:
            for root, dirs, names in os.walk(base):
                dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
                for name in names:
                    # Codex compresses finished rollouts to .jsonl.zst; those are read once, whole.
                    if not (name.endswith('.jsonl') or (provider == 'codex' and name.endswith('.jsonl.zst'))): continue
                    path = os.path.join(root, name)
                    try:
                        if os.path.islink(path): continue
                        stat = os.stat(path)
                    except OSError: continue  # moved or archived while walking
                    if stat.st_mtime < now - HORIZON: continue
                    found.append((stat.st_mtime, provider, path, stat, account))
    found.sort(reverse=True)  # recent activity first, then historical backfill
    return found


def index(db, codex_home, claude_homes, budget, now):
    cutoff = now - HORIZON
    consumed = pending = unreadable = 0
    zstd = True
    for _, provider, path, stat, account in sources(codex_home, claude_homes, now):
        fid = f'{stat.st_dev}:{stat.st_ino}'
        fresh = lambda: codex_initial(fid) if provider == 'codex' else {'session': fid, 'account': account}
        row = db.execute('SELECT offset,state FROM files WHERE id=?', (fid,)).fetchone()
        offset, state = (row[0], json.loads(row[1])) if row else (0, fresh())
        if stat.st_size < offset:  # rewritten: request IDs suppress anything already counted
            offset, state = 0, fresh()
        if stat.st_size == offset: continue
        if consumed >= budget or (path.endswith('.zst') and not zstd):
            pending += stat.st_size - offset; continue
        parse = codex_line if provider == 'codex' else claude_line
        try:
            if path.endswith('.zst'):
                consumed += decompressed(path, lambda line: parse(db, line, state, cutoff))
                offset = stat.st_size  # compressed rollouts are final: done
            else:
                with open(path, 'rb') as stream:
                    stream.seek(offset)
                    while consumed < budget:
                        line = stream.readline()
                        if not line or not line.endswith(b'\n'): break  # keep the offset before a partial write
                        consumed += len(line); offset = stream.tell()
                        parse(db, line, state, cutoff)
        except LookupError:
            zstd = False; unreadable += 1; pending += stat.st_size; continue
        except RuntimeError:
            unreadable += 1; offset = stat.st_size  # corrupt archive: skip it rather than retry forever
            db.rollback()
        except OSError: continue
        db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?)', (fid, provider, path, offset, json.dumps(state), stat.st_size, stat.st_mtime))
        pending += max(0, stat.st_size - offset)
        db.commit()
    db.execute('DELETE FROM requests WHERE at<?', (cutoff,))
    db.execute("DELETE FROM files WHERE mtime<?", (cutoff,))
    for key, value in (('pendingBytes', pending), ('scannedAt', time.time()), ('unreadable', unreadable), ('zstd', int(zstd))):
        db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, str(value)))
    db.commit()
    return {'pendingBytes': pending, 'consumed': consumed}


def buckets(span, unit, now):
    """Bucket start times in local time, oldest first, ending with the bucket containing now."""
    local = dt.datetime.fromtimestamp(now)
    if unit == 'day':
        day = local.replace(hour=0, minute=0, second=0, microsecond=0)
        days = span // 86400
        return [(day - dt.timedelta(days=i)).timestamp() for i in reversed(range(days))], 86400
    size = 3600 if unit == 'hour' else 4 * 3600
    hour = local.replace(minute=0, second=0, microsecond=0)
    if unit == 'hour4': hour -= dt.timedelta(hours=hour.hour % 4)
    n = span // size
    return [(hour - dt.timedelta(seconds=size * i)).timestamp() for i in reversed(range(n))], size


def empty():
    return dict(cost=0.0, tokens=0, requests=0, input=0, cacheRead=0, cacheWrite=0, output=0, reasoning=0,
                costInput=0.0, costRead=0.0, costWrite=0.0, costOutput=0.0, savings=0.0, unpriced=0, unpricedTokens=0)


def add(target, row):
    (n, i, cr, cw, o, rs, ci, cre, cwr, co, sv, unpriced, unpriced_tokens) = row
    tokens = i + cr + cw + o
    target['requests'] += n; target['tokens'] += tokens; target['input'] += i; target['cacheRead'] += cr
    target['cacheWrite'] += cw; target['output'] += o; target['reasoning'] += rs
    target['costInput'] += ci; target['costRead'] += cre; target['costWrite'] += cwr; target['costOutput'] += co
    target['cost'] += ci + cre + cwr + co; target['savings'] += sv
    target['unpriced'] += unpriced; target['unpricedTokens'] += unpriced_tokens



def query(db, ledger_path, params, now):
    span, unit = RANGES.get(params.get('range'), RANGES['24h'])
    provider = params.get('provider') if params.get('provider') in PROVIDERS else 'all'
    account = params.get('account') or 'all'
    starts, size = buckets(span, unit, now)
    start = starts[0]
    attached = False
    if ledger_path and Path(ledger_path).exists():
        try:
            db.execute('ATTACH DATABASE ? AS ledger', (Path(ledger_path).as_uri() + '?mode=ro',))
            attached = True
        except sqlite3.Error: attached = False
    account_expr = ("CASE WHEN r.provider='codex' THEN COALESCE(e.account,'unassigned') ELSE COALESCE(r.account,r.provider) END" if attached
                    else "CASE WHEN r.provider='codex' THEN 'unassigned' ELSE COALESCE(r.account,r.provider) END")
    join = 'LEFT JOIN ledger.events e ON e.id=r.id' if attached else ''
    where, args = ['r.at>=?', 'r.at<=?'], [start, now]
    if provider != 'all': where.append('r.provider=?'); args.append(provider)
    if account != 'all':
        where.append("r.provider='claude-code'" if account.startswith('claude:') else "r.provider='codex'")
        where.append(f'{account_expr}=?'); args.append(account)
    sql_where = ' AND '.join(where)
    measures = ('COUNT(*),SUM(r.input),SUM(r.cache_read),SUM(r.cache_write),SUM(r.output),SUM(r.reasoning),'
                'TOTAL(r.c_input),TOTAL(r.c_read),TOTAL(r.c_write),TOTAL(r.c_output),TOTAL(r.savings),'
                'SUM(r.priced=0),SUM(CASE WHEN r.priced=0 THEN r.input+r.cache_read+r.cache_write+r.output ELSE 0 END)')
    rows = db.execute(f'''SELECT r.provider,CAST(r.at/900 AS INTEGER),r.model,{account_expr},r.project,COALESCE(r.speed,'unknown'),{measures}
                          FROM requests r {join} WHERE {sql_where}
                          GROUP BY 1,2,3,4,5,6''', args).fetchall()
    sessions = dict(db.execute(f'SELECT r.provider,COUNT(DISTINCT r.session) FROM requests r {join} WHERE {sql_where} GROUP BY 1', args).fetchall())
    total = empty(); by_provider = {}; series = [{'t': t, 'providers': {}} for t in starts]
    groups = {'model': {}, 'account': {}, 'project': {}}; speeds = {}
    unpriced_models = set()
    for prov, quarter, model, acct, project, speed, *values in rows:
        values = [v or 0 for v in values]
        add(total, values)
        add(by_provider.setdefault(prov, empty()), values)
        i = bisect.bisect_right(starts, quarter * 900) - 1
        if i >= 0: add(series[i]['providers'].setdefault(prov, empty()), values)
        for kind, key in (('model', model or 'Unknown model'), ('account', acct), ('project', project or 'No project')):
            entry = groups[kind].setdefault((key, prov), empty())
            add(entry, values)
        add(speeds.setdefault(speed, empty()), values)
        if values[11]: unpriced_models.add(model or 'Unknown model')
    def ranked(kind):
        out = [dict(key=k, provider=p, **v) for (k, p), v in groups[kind].items()]
        return sorted(out, key=lambda r: (r['cost'], r['tokens']), reverse=True)
    meta = dict(db.execute('SELECT key,value FROM meta'))
    oldest = db.execute('SELECT MIN(at) FROM requests').fetchone()[0]
    if attached:
        try: accounts = [dict(id=a, label=l, email=e, connected=bool(c)) for a, l, e, c in db.execute('SELECT id,label,email,connected FROM ledger.accounts')]
        except sqlite3.Error: accounts = []
        db.execute('DETACH DATABASE ledger')
    else: accounts = []
    return dict(
        range=params.get('range') if params.get('range') in RANGES else '24h', provider=provider, account=account,
        start=start, end=now, bucket=unit, bucketSeconds=size,
        totals=dict(total, sessions=sum(sessions.values())),
        providers=[dict(id=p, name=PROVIDERS[p], sessions=sessions.get(p, 0), **v) for p, v in sorted(by_provider.items(), key=lambda kv: -kv[1]['cost'])],
        series=series, speeds=speeds,
        breakdown=dict(model=ranked('model'), account=ranked('account'), project=ranked('project')),
        unpricedModels=sorted(unpriced_models), accounts=accounts,
        claudeAccounts=[a for (a,) in db.execute("SELECT DISTINCT account FROM requests WHERE provider='claude-code' AND account IS NOT NULL ORDER BY account")],
        index=dict(pendingBytes=int(meta.get('pendingBytes', 0)), scannedAt=float(meta.get('scannedAt', 0)),
                   unreadable=int(meta.get('unreadable', 0)), zstd=meta.get('zstd', '1') == '1',
                   oldest=oldest, horizonDays=HORIZON // 86400),
        pricing=dict(openai=dict(checkedAt=PRICING['checkedAt'], source=PRICING['source']),
                     anthropic=dict(checkedAt=PRICING['anthropic']['checkedAt'], source=PRICING['anthropic']['source'])),
        generatedAt=time.time())


def main():
    os.umask(0o077)
    data = json.load(sys.stdin)
    root = Path(data['root']) / 'usage-index'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = data.get('now') or time.time()
    if data.get('cmd') == 'query':
        db = connect(root)
        print(json.dumps(query(db, data.get('ledger'), data.get('params') or {}, now)))
        db.close(); return
    # Serialize index passes, including separate processes.
    with open(root / 'index.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db = connect(root)
        homes = data.get('claudeHomes') or ([data['claudeHome']] if data.get('claudeHome') else [])
        result = index(db, Path(data['codexHome']), [Path(h) for h in homes], data.get('budget', 256 * 1024 * 1024), now)
        print(json.dumps(result))
        db.close()


if __name__ == '__main__': main()
