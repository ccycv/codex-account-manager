"""Line streaming for Codex rollouts that Codex compressed to .jsonl.zst.

Python 3.9 has no zstd module, so decompression runs in Node's built-in zlib zstd
(Node 22.15+). CODEX_ACCOUNT_NODE names the Node binary; the dashboard passes its own.
"""
import os
import subprocess

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

