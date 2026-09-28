'use strict';
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');

function codexBinary() {
  const choices = [process.env.CODEX_ACCOUNT_BINARY,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex'];
  return choices.find(p => p && fs.existsSync(p)) || 'codex';
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function safeRpcError(error) {
  // Never return arbitrary subprocess/backend messages: they may contain auth material.
  const message = String(error?.message || '').toLowerCase();
  if (/refresh|expired|unauthorized|401|login|log in|sign in|authentication/.test(message))
    return new RpcError('reconnect', 'This saved login needs reconnecting.');
  if (/429|rate limit/.test(message)) return new RpcError('rate_limited', 'Usage service is busy. Try again later.');
  if (/unknown|unsupported|not found/.test(message)) return new RpcError('unsupported', 'This Codex version does not expose this account operation.');
  return new RpcError('unavailable', 'Could not read the account service. Try refreshing again.');
}

class CodexRpc {
  constructor(home, {binary = codexBinary(), timeout = 25000, onNotification = () => {}} = {}) {
    this.pending = new Map(); this.id = 0; this.timeout = timeout; this.closed = false;
    const env = {...process.env, CODEX_HOME: home};
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    this.child = spawn(binary, ['app-server', '-c', 'cli_auth_credentials_store="file"'],
      {cwd: home, env, stdio: ['pipe', 'pipe', 'ignore']});
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => {this.failAll(new RpcError('unavailable', 'Account service stopped.')); resolve();});
      this.child.once('error', () => {this.failAll(new RpcError('unavailable', 'Could not start the Codex account service.')); resolve();});
    });
    this.child.stdin.on('error', () => {});
    this.lines = readline.createInterface({input: this.child.stdout});
    this.lines.on('line', line => {
      let m; try {m = JSON.parse(line);} catch {return;}
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(safeRpcError(m.error)) : p.resolve(m.result);
      } else if (m.method && m.id === undefined) onNotification(m);
      else if (m.id !== undefined && m.method) {
        this.child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Unsupported request'}})+'\n');
      }
    });
  }
  failAll(error) {
    this.closed = true;
    for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(error);}
    this.pending.clear();
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new RpcError('unavailable', 'Account service is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {this.pending.delete(id); reject(new RpcError('timeout', 'Account check timed out. Try again.'));}, this.timeout);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  async init() {
    await this.request('initialize', {clientInfo:{name:'codex-account-manager',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.child.stdin.write('{"method":"initialized"}\n');
    return this;
  }
  async close() {
    if (!this.closed) this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exited; clearTimeout(timer); this.lines.close();
  }
}
module.exports = {CodexRpc, RpcError, codexBinary};
