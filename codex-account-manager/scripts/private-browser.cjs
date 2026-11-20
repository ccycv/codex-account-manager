'use strict';
// Opens a sign-in link in a browser window that does not share the user's normal
// session. Chromium-family browsers get a dedicated profile directory plus their
// private-mode flag; Firefox gets a private window. macOS only, like the app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

const CANDIDATES = [
  {name: 'Google Chrome', app: 'Google Chrome.app', flag: '--incognito'},
  {name: 'Chromium', app: 'Chromium.app', flag: '--incognito'},
  {name: 'Brave Browser', app: 'Brave Browser.app', flag: '--incognito'},
  {name: 'Microsoft Edge', app: 'Microsoft Edge.app', flag: '--inprivate'},
  {name: 'Vivaldi', app: 'Vivaldi.app', flag: '--incognito'},
  {name: 'Firefox', app: 'Firefox.app', privateFlag: '-private-window', firefox: true}
];

function appDirs(home = os.homedir()) {
  return ['/Applications', path.join(home, 'Applications')];
}
function defaultProfileDir(home = os.homedir()) {
  return path.join(home, '.codex-account-manager', 'browser-profile');
}
function configuredBrowser(env = process.env, exists = fs.existsSync) {
  let value = String(env.CODEX_ACCOUNT_PRIVATE_BROWSER || '').trim();
  if (!value) return null;
  if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(1));
  const app = path.resolve(value);
  try {if (!exists(app)) return null;} catch {return null;}
  const base = path.basename(app);
  const firefox = /^firefox/i.test(base);
  return {name: base.replace(/\.app$/i, ''), app, firefox, flag: firefox ? undefined : '--incognito'};
}
function findBrowser({platform = process.platform, exists = fs.existsSync, dirs = appDirs(), env = process.env} = {}) {
  if (platform !== 'darwin') return null;
  const configured = configuredBrowser(env, exists);
  if (configured) return configured;
  for (const candidate of CANDIDATES) {
    for (const dir of dirs) {
      const app = path.join(dir, candidate.app);
      try {if (exists(app)) return {...candidate, app};} catch {}
    }
  }
  return null;
}
function buildPrivateCommand(browser, url, profileDir) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('The sign-in link must use HTTPS.');
  if (browser.firefox) return {command: '/usr/bin/open', args: ['-na', browser.app, '--args', browser.privateFlag, url]};
  if (!profileDir) throw new Error('A private browser profile directory is required.');
  return {command: '/usr/bin/open', args: ['-na', browser.app, '--args',
    `--user-data-dir=${profileDir}`, browser.flag || '--incognito', '--no-first-run', '--no-default-browser-check', url]};
}
async function openPrivate(url, {profileDir = defaultProfileDir(), browser, runner = execFileAsync,
  platform = process.platform, exists = fs.existsSync, dirs = appDirs(), env = process.env} = {}) {
  if (platform !== 'darwin') return {opened: false, reason: 'Private sign-in windows currently support macOS only.'};
  const selected = browser === undefined ? findBrowser({platform, exists, dirs, env}) : browser;
  if (!selected) return {opened: false, reason: 'No private-mode browser was found. Install Chrome, Chromium, Brave, Edge, Vivaldi, or Firefox.'};
  let launch;
  try {launch = buildPrivateCommand(selected, url, profileDir);}
  catch {return {opened: false, browser: selected.name, reason: 'The sign-in link is not valid.'};}
  if (!selected.firefox) {
    try {fs.mkdirSync(profileDir, {recursive: true, mode: 0o700}); fs.chmodSync(profileDir, 0o700);}
    catch {return {opened: false, browser: selected.name, reason: 'The private browser profile could not be prepared.'};}
  }
  try {
    await runner(launch.command, launch.args, {timeout: 10000});
    return {opened: true, browser: selected.name};
  } catch {
    return {opened: false, browser: selected.name, reason: 'The private browser window could not be opened.'};
  }
}
module.exports = {findBrowser, buildPrivateCommand, openPrivate, defaultProfileDir, appDirs, configuredBrowser};
