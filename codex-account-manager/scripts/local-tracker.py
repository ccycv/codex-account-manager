#!/usr/bin/env python3
"""Incremental, read-only Codex rollout scanner. Persist counters, never prompt text."""
import datetime as dt
import fcntl
import hashlib
import json
import os
import sqlite3
import sys
import time

DAY = 86400

def connect(root):
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    path = os.path.join(root, 'local-usage.sqlite')
    db = sqlite3.connect(path, timeout=15)
    os.chmod(path, 0o600)
    db.executescript('''
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,label TEXT,email TEXT,connected INTEGER);
      CREATE TABLE IF NOT EXISTS fingerprints(hash TEXT PRIMARY KEY,account TEXT);
      CREATE TABLE IF NOT EXISTS intervals(start REAL,end REAL,account TEXT);
      CREATE INDEX IF NOT EXISTS interval_time ON intervals(start,end);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,path TEXT,offset INTEGER,previous INTEGER,
        session TEXT,created REAL,turn TEXT,turn_at REAL,provider TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,at REAL,day TEXT,account TEXT,turn_at REAL,tokens INTEGER);
      CREATE INDEX IF NOT EXISTS event_day ON events(day,account);
    ''')
    db.execute("INSERT OR IGNORE INTO meta VALUES ('started',?)", (str(time.time()),))
    db.commit()
    return db

def stamp(value):
    try: return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError): return None

def observe(db, data, now):
    db.execute('UPDATE accounts SET connected=0')
    for a in data.get('accounts', []):
        db.execute('INSERT INTO accounts VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET label=excluded.label,email=excluded.email,connected=1', (a['id'], a['label'], a.get('email')))
        if a.get('fingerprint'):
            db.execute('INSERT INTO fingerprints VALUES (?,?) ON CONFLICT(hash) DO UPDATE SET account=excluded.account', (a['fingerprint'], a['id']))
    resolved = data.get('resolvedActiveId')
    if resolved and data.get('activeFingerprint') and db.execute('SELECT id FROM accounts WHERE id=?', (resolved,)).fetchone():
        db.execute('INSERT OR REPLACE INTO fingerprints VALUES (?,?)', (data['activeFingerprint'], resolved))
    match = db.execute('SELECT account FROM fingerprints WHERE hash=?', (data.get('activeFingerprint'),)).fetchone()
    current = match[0] if match else None
    old = db.execute("SELECT value FROM meta WHERE key='observation'").fetchone()
    if old:
        previous = json.loads(old[0])
        # Never fill gaps while the tracker is stopped, or an ambiguous switch interval.
        if current and current == previous.get('account') and 0 < now - previous['at'] <= 45:
            db.execute('INSERT INTO intervals VALUES (?,?,?)', (previous['at'], now, current))
    db.execute("INSERT OR REPLACE INTO meta VALUES ('observation',?)", (json.dumps({'at': now, 'account': current}),))

def account_at(db, at):
    if at is None: return None
    row = db.execute('SELECT account FROM intervals WHERE start<=? AND end>=? ORDER BY start DESC LIMIT 1', (at, at)).fetchone()
    return row[0] if row else None

def parse_event(db, line, state):
    # Avoid parsing content-bearing lines. No conversation text leaves this process.
    if not any(marker in line for marker in (b'"token_count"', b'"session_meta"', b'"turn_context"')):
        return
    try: event = json.loads(line)
    except (ValueError, UnicodeDecodeError): return
    payload = event.get('payload') or {}
    if not isinstance(payload, dict): return
    kind = event.get('type')
    if kind == 'session_meta':
        state['session'] = payload.get('id') or payload.get('session_id') or state['session']
        state['created'] = stamp(payload.get('timestamp')) or stamp(event.get('timestamp')) or 0
        state['provider'] = payload.get('model_provider') or 'unknown'
        return
    if kind == 'turn_context':
        turn = payload.get('turn_id')
        if turn and turn != state['turn']:
            state['turn'] = turn
            state['turn_at'] = stamp(event.get('timestamp'))
        return
    if kind != 'event_msg' or payload.get('type') != 'token_count': return
    info = payload.get('info') or {}
    current = (info.get('total_token_usage') or {}).get('total_tokens')
    last = (info.get('last_token_usage') or {}).get('total_tokens')
    if not isinstance(current, int) or isinstance(current, bool) or current < 0: return
    previous = state['previous']
    state['previous'] = current
    # Some older rollouts interleave independent cumulative counters in one file.
    # Differences between those counters can invent tens of millions of tokens.
    # Count the reported usage of the last request once per distinct counter event.
    if previous == current: return
    delta = last if isinstance(last, int) and not isinstance(last, bool) and 0 <= last <= current else 0
    if delta <= 0: return
    at = stamp(event.get('timestamp'))
    if at is None or at < state['created']: return # copied pre-fork history
    if state['provider'] != 'openai': return # no attribution of other provider tokens to ChatGPT
    day = dt.datetime.fromtimestamp(at, dt.timezone.utc).date().isoformat()
    # A replayed/copy of the same turn counter is one event, not another charge.
    source = [state['turn'] or state['session'], info.get('total_token_usage')]
    key = hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()
    account = account_at(db, state['turn_at'])
    db.execute('INSERT INTO events VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens', (key, at, day, account, state['turn_at'], delta))

def scan(db, homes, budget):
    paths = []
    for home in homes:
        for root, dirs, names in os.walk(home):
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
            for name in names:
                if name.endswith('.jsonl'):
                    path = os.path.join(root, name)
                    if not os.path.islink(path):
                        s = os.stat(path)
                        paths.append((s.st_mtime, path, s))
    paths.sort(reverse=True) # recent activity first, then historical backfill
    consumed, pending = 0, 0
    for _, path, stat in paths:
        fid = str(stat.st_dev) + ':' + str(stat.st_ino)
        row = db.execute('SELECT offset,previous,session,created,turn,turn_at,provider FROM files WHERE id=?', (fid,)).fetchone()
        keys = ['offset','previous','session','created','turn','turn_at','provider']
        state = dict(zip(keys, row)) if row else dict(offset=0, previous=None, session=fid, created=0, turn=None, turn_at=None, provider='unknown')
        if stat.st_size < state['offset']: # rewritten file; event IDs suppress copied history
            state.update(offset=0, previous=None, turn=None, turn_at=None)
        if stat.st_size == state['offset']: continue
        if consumed >= budget:
            pending += stat.st_size-state['offset']; continue
        with open(path, 'rb') as stream:
            stream.seek(state['offset'])
            while consumed < budget:
                before = stream.tell()
                line = stream.readline()
                if not line: break
                if not line.endswith(b'\n'): break # save offset before incomplete JSON write
                consumed += stream.tell()-before
                parse_event(db, line, state)
                state['offset'] = stream.tell()
        db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?,?)', (fid, path, *(state[k] for k in keys)))
        pending += max(0, stat.st_size-state['offset'])
        db.commit()
    db.execute("INSERT OR REPLACE INTO meta VALUES ('pendingBytes',?)", (str(pending),))
    db.execute("INSERT OR REPLACE INTO meta VALUES ('scannedAt',?)", (str(time.time()),))
    # A just-started turn can precede the next observation. Attribute only once its
    # start is bracketed by two observations of the same selected account.
    started = float(db.execute("SELECT value FROM meta WHERE key='started'").fetchone()[0])
    for key, at in db.execute('SELECT id,turn_at FROM events WHERE account IS NULL AND turn_at>=?', (started,)).fetchall():
        account = account_at(db, at)
        if account: db.execute('UPDATE events SET account=? WHERE id=?', (account, key))
    db.commit()

def summary(db, now):
    today = dt.datetime.fromtimestamp(now, dt.timezone.utc).date()
    starts = {'today': today.isoformat(), 'days7': (today-dt.timedelta(days=6)).isoformat(), 'days30': (today-dt.timedelta(days=29)).isoformat()}
    rows = db.execute('SELECT account,day,SUM(tokens) FROM events GROUP BY account,day').fetchall()
    groups = {a[0]: {'id': a[0], 'label': a[1], 'email': a[2], 'connected': bool(a[3]), 'periods': dict(today=0, days7=0, days30=0, allTime=0)} for a in db.execute('SELECT * FROM accounts')}
    groups[None] = {'id': 'unassigned', 'label': 'Unassigned local history', 'connected': False, 'unassigned': True, 'periods': dict(today=0, days7=0, days30=0, allTime=0)}
    totals = dict(today=0, days7=0, days30=0, allTime=0)
    daily = []
    for key, day, tokens in rows:
        if key not in groups: continue
        group = groups[key]
        if day > today.isoformat(): continue
        group['periods']['allTime'] += tokens
        totals['allTime'] += tokens
        for period, start in starts.items():
            if day >= start: group['periods'][period] += tokens; totals[period] += tokens
        daily.append({'date': day, 'accountId': group['id'], 'account': group['label'], 'tokens': tokens})
    meta = dict(db.execute('SELECT key,value FROM meta'))
    return {'accounts': list(groups.values()), 'totals': totals, 'daily': sorted(daily, key=lambda r:r['date'], reverse=True),
      'trackingStartedAt': float(meta['started']), 'scannedAt': float(meta.get('scannedAt', 0)), 'pendingBytes': int(meta.get('pendingBytes', 0)),
      'source': 'Local Codex rollout token events', 'attribution': 'Observed selected account at turn start; older or ambiguous turns remain unassigned.'}

def main():
    os.umask(0o077)
    data = json.load(sys.stdin)
    os.makedirs(data['root'], mode=0o700, exist_ok=True)
    # Serialize dashboard and account-removal scans, including separate processes.
    lock = open(os.path.join(data['root'], 'scan.lock'), 'a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    db = connect(data['root'])
    now = time.time()
    observe(db, data, now)
    db.commit()
    scan(db, [os.path.join(data['codexHome'], p) for p in ['sessions', 'archived_sessions']], data.get('budget', 512*1024*1024))
    print(json.dumps(summary(db, time.time())))
    db.close()
    lock.close()

if __name__ == '__main__': main()
