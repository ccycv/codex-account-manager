#!/usr/bin/env python3
"""Read local session metadata/counters. Never persist prompts or model reasoning text."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

PRICING = json.loads(Path(__file__).with_name('session-pricing.json').read_text())
FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens')

def stamp(s):
    try: return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError, TypeError): return None

def estimate(model, usage):
    rates = PRICING['models'].get(model)
    if not rates: return None
    for k in ('input_tokens', 'cached_input_tokens', 'output_tokens'):
        if type(usage.get(k)) is not int or usage[k] < 0: return None
    i, c, o = (usage[k] for k in ('input_tokens', 'cached_input_tokens', 'output_tokens'))
    w = usage.get('cache_write_input_tokens', 0)
    if type(w) is not int or w < 0 or c+w > i: return None
    prices = rates['long'] if 'long' in rates and i > rates['threshold'] else rates['short']
    counts = (i-c-w, c, w, o)
    if any(n and p is None for n, p in zip(counts, prices)): return None
    return sum(n*(p or 0) for n,p in zip(counts, prices))/1e6

def connect(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    file = root/'sessions.sqlite'
    db = sqlite3.connect(file, timeout=10)
    os.chmod(file, 0o600)
    db.executescript('''
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,identity TEXT,offset INTEGER,state TEXT,live TEXT,size INTEGER,mtime REAL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,session TEXT,turn TEXT,at REAL,model TEXT,effort TEXT,usage TEXT,cost REAL);
      CREATE INDEX IF NOT EXISTS session_events ON events(session,at);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    ''')
    if not db.execute("SELECT 1 FROM meta WHERE key='format' AND value='2'").fetchone():
        # Rebuild this derived session index after the fork-metadata parser fix.
        # The independent durable local-usage ledger is never modified.
        db.executescript("DELETE FROM events; DELETE FROM files; INSERT OR REPLACE INTO meta VALUES ('format','2');")
        db.commit()
    return db

def initial(sid):
    return dict(session=sid,created=0,provider='unknown',turn=None,turnAt=None,model=None,effort=None,previous=None,at=0,status='unknown')

def consume(line, state, db=None):
    # Fast reject content lines. Parsed payloads are restricted to metadata only.
    if not any(x in line for x in (b'"session_meta"',b'"turn_context"',b'"token_count"',b'"task_started"',b'"task_complete"',b'"turn_aborted"')): return
    try: r=json.loads(line)
    except (ValueError, UnicodeDecodeError): return
    p=r.get('payload')
    if not isinstance(p,dict): return
    kind=r.get('type'); at=stamp(r.get('timestamp')) or 0
    if kind=='session_meta':
        if state.get('metadataSeen'): return # Forks embed the parent session_meta after their own.
        state['metadataSeen']=True
        state.update(session=p.get('id') or p.get('session_id') or state['session'],created=stamp(p.get('timestamp')) or at,provider=p.get('model_provider') or 'unknown')
        return
    if at < state['created']: return
    if kind=='turn_context':
        turn=p.get('turn_id')
        if turn and turn!=state['turn']:
            state.update(turn=turn,turnAt=at,previous=None,status='active')
        state.update(model=p.get('model'),effort=p.get('effort'),at=max(state['at'],at))
        return
    if kind!='event_msg': return
    event=p.get('type')
    if event=='task_started':
        if p.get('turn_id')!=state['turn']: state['previous']=None
        state.update(turn=p.get('turn_id'),turnAt=stamp(p.get('started_at')) or at,status='active',at=at)
        return
    if event in ('task_complete','turn_aborted'):
        if not p.get('turn_id') or not state['turn'] or p['turn_id']==state['turn']:
            state.update(status='finished' if event=='task_complete' else 'interrupted',at=at)
        return
    if event!='token_count': return
    state['at']=max(state['at'],at)
    info=p.get('info') or {};total=info.get('total_token_usage') or {};usage=info.get('last_token_usage') or {}
    counter=total.get('total_tokens');n=usage.get('total_tokens')
    if type(counter) is not int or counter<0: return
    previous=state['previous'];state['previous']=counter
    if previous==counter or type(n) is not int or not 0<n<=counter or state['provider']!='openai': return
    if db is None: return
    key=hashlib.sha256(json.dumps([state['turn'] or state['session'],total],sort_keys=True).encode()).hexdigest()
    usage={k:usage[k] for k in FIELDS if type(usage.get(k)) is int and usage[k]>=0}
    db.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?)',(key,state['session'],state['turn'],at,state['model'],state['effort'],json.dumps(usage),estimate(state['model'],usage)))

def candidates(home, now):
    # The app's index supplies titles/settings; no first_user_message or preview is read.
    result={}
    for file in sorted(home.glob('state_*.sqlite'),reverse=True):
        try:
            db=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=2);db.row_factory=sqlite3.Row
            for row in db.execute('SELECT id,rollout_path,title,cwd,model,reasoning_effort,updated_at FROM threads WHERE model_provider=? AND updated_at>=? ORDER BY updated_at DESC LIMIT 100',('openai',now-7*86400)):
                r=dict(row);result[r['rollout_path']]=r
            db.close();break
        except sqlite3.Error: continue
    # Include CLI sessions and files that have not reached the app index yet.
    for folder in ('sessions','archived_sessions'):
        for root,dirs,names in os.walk(home/folder):
            dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(root,d))]
            for name in names:
                if not name.endswith('.jsonl'): continue
                path=Path(root)/name
                try:
                    if path.is_symlink() or path.stat().st_mtime<now-7*86400: continue
                    if str(path) not in result: result[str(path)]={'id':name[-42:-6],'title':'Untitled session','cwd':'','model':None,'reasoning_effort':None}
                except OSError: continue
    safe=[]
    for path,r in result.items():
        try:
            p=Path(path)
            if p.is_symlink() or not any(p.resolve().is_relative_to((home/f).resolve()) for f in ('sessions','archived_sessions')): continue
            stat=p.stat()
            if stat.st_mtime<now-7*86400: continue
            safe.append((stat.st_mtime,p,r))
        except OSError: continue
    return sorted(safe,key=lambda r:r[0],reverse=True)[:100]

def scan_file(db,path,info,budget):
    stat=path.stat();identity=f'{stat.st_dev}:{stat.st_ino}'
    row=db.execute('SELECT identity,offset,state,live,size,mtime FROM files WHERE path=?',(str(path),)).fetchone()
    if row and row[0]==identity and row[1]<=stat.st_size:
        offset=row[1];state=json.loads(row[2]);live=json.loads(row[3])
    else:
        offset=0;state=initial(info['id']);live=initial(info['id']);row=None
    # Tail gives immediate lifecycle/model visibility during the bounded historical import.
    if not row or row[4]!=stat.st_size or row[5]!=stat.st_mtime:
        with path.open('rb') as f:
            tail=initial(info['id'])
            consume(f.readline(1024*1024),tail)
            start=max(0,stat.st_size-2*1024*1024)
            f.seek(start)
            if start: f.readline()
            for line in f:
                if line.endswith(b'\n'):
                    # Recent complete turns can count immediately while the older
                    # file imports. The same event IDs deduplicate the later pass.
                    consume(line,tail,db if tail['turn'] and tail['model'] else None)
            if tail['turn']: live=tail
            else:
                live.update(session=tail['session'],created=tail['created'],provider=tail['provider'],at=max(live['at'],tail['at']))
                if tail['status']!='unknown': live['status']=tail['status']
    spent=0
    with path.open('rb') as f:
        f.seek(offset)
        while spent<budget:
            line=f.readline()
            if not line or not line.endswith(b'\n'): break
            spent+=len(line);offset=f.tell();consume(line,state,db)
    if offset==stat.st_size: live=dict(state)
    db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?)',(str(path),identity,offset,json.dumps(state),json.dumps(live),stat.st_size,stat.st_mtime))
    return live,stat.st_size-offset,spent

def metrics(db,sid,turn=None):
    q='SELECT model,usage,cost FROM events WHERE session=?';args=[sid]
    if turn is not None:q+=' AND turn=?';args.append(turn)
    totals={k:0 for k in FIELDS};cost=0;unpriced=0;requests=0;models={}
    for model,usage,price in db.execute(q,args):
        u=json.loads(usage);requests+=1
        for k in FIELDS:totals[k]+=u.get(k,0)
        if price is None:unpriced+=1
        else:cost+=price
        models[model or 'Unknown']=models.get(model or 'Unknown',0)+u.get('total_tokens',0)
    return dict(tokens=totals,cost=cost if requests>unpriced else None,unpricedRequests=unpriced,requests=requests,models=models)

def snapshot(db,home,root,now,budget=64*1024*1024):
    rows=[];pending=0;spent=0;ledger=None
    ledger_path=root/'local-tracking/local-usage.sqlite'
    if ledger_path.exists():
        try:ledger=sqlite3.connect(ledger_path.as_uri()+'?mode=ro',uri=True,timeout=2)
        except sqlite3.Error:pass
    for _,path,info in candidates(home,now):
        try:
            live,left,used=scan_file(db,path,info,max(0,min(8*1024*1024,budget-spent)))
            spent+=used;pending+=left;db.commit()
            status=live['status']
            if status=='active' and now-live['at']>120:status='stale'
            account=None
            if ledger and live.get('turnAt'):
                match=ledger.execute('SELECT account FROM intervals WHERE start<=? AND end>=? ORDER BY start DESC LIMIT 1',(live['turnAt'],live['turnAt'])).fetchone()
                account=match[0] if match else None
            rows.append(dict(id=live['session'],title=info.get('title') or 'Untitled session',project=Path(info.get('cwd') or '').name,model=live.get('model') or info.get('model'),reasoning=live.get('effort') or info.get('reasoning_effort'),status=status,updatedAt=live['at'] or path.stat().st_mtime,accountId=account,pendingBytes=left,usage=metrics(db,live['session']),turnUsage=metrics(db,live['session'],live['turn']) if live['turn'] else None))
        except OSError:continue
    if ledger:ledger.close()
    db.commit()
    unique={}
    for row in sorted(rows,key=lambda r:r['updatedAt'],reverse=True):
        unique.setdefault(row['id'],row) # Backup rollouts can have the same session identity.
    return dict(sessions=sorted(unique.values(),key=lambda r:(r['status']=='active',r['updatedAt']),reverse=True),scannedAt=now,pendingBytes=pending,pricing={k:PRICING[k] for k in ('checkedAt','source','basis')},scope='Up to 100 local sessions updated in the last 7 days. Usage totals cover each session’s imported history.',statusNote='Active means an open turn with a log signal within 2 minutes. Longer silent turns are shown as No recent signal. Counters update after a model request completes.')

def main():
    os.umask(0o077);data=json.load(sys.stdin);root=Path(data['root']);home=Path(data['codexHome']);db=connect(root/'live-sessions')
    print(json.dumps(snapshot(db,home,root,time.time())));db.close()
if __name__=='__main__':main()
