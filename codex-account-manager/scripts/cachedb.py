"""Recovery for derived SQLite caches (Live sessions, Usage index).

These databases are rebuilt from Codex and Claude Code logs, so a corrupt file is moved
aside and rebuilt instead of failing every scan. Never use this for the durable ledger,
whose counts can outlive the logs they came from.
"""
import os
import sqlite3


def is_corrupt(path):
    """True only when the file itself fails SQLite's own check, not for locks or other databases."""
    if not os.path.exists(path): return False
    try:
        db = sqlite3.connect(path, timeout=20)
        try: return db.execute('PRAGMA quick_check').fetchone()[0] != 'ok'
        finally: db.close()
    except sqlite3.OperationalError as e:
        return 'malformed' in str(e) or 'not a database' in str(e)
    except sqlite3.DatabaseError:
        return True


def quarantine(path):
    """Move a corrupt cache and its journal files aside; one previous copy is kept for inspection."""
    for suffix in ('', '-journal', '-wal', '-shm'):
        if os.path.exists(path + suffix):
            os.replace(path + suffix, path + '.corrupt' + suffix)


def recovering(path, run):
    """Run, and if the cache at path proves corrupt, move it aside and run once more on a fresh one."""
    try:
        return run()
    except sqlite3.DatabaseError:
        if not is_corrupt(path): raise
        quarantine(path)
        return run()
