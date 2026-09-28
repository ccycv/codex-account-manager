'use strict';
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function appPath() {
  if(process.platform!=='darwin') throw new Error('Safe app reopening currently supports macOS.');
  const paths=['/Applications/ChatGPT.app','/Applications/Codex.app'];
  const p=paths.find(p=>fs.existsSync(p));if(!p) throw new Error('Could not locate the Codex desktop app.');return p;
}
async function isRunning(app) {
  const {stdout}=await exec('/usr/bin/osascript',['-e',`application "${app}" is running`],{timeout:5000});
  return stdout.trim()==='true';
}
function desktopLifecycle() {
  const app=appPath();
  return {
    async quitApp(){
      if(!await isRunning(app)) return;
      try {await exec('/usr/bin/osascript',['-e',`tell application "${app}" to quit`],{timeout:20000});}
      catch {throw new Error('The app did not close normally. Finish active work and retry. Your login was not switched.');}
      for(let i=0;i<40;i++){if(!await isRunning(app)) return;await sleep(250);}
      throw new Error('The app is still running. Finish active work and retry. Your login was not switched.');
    },
    async reopenApp(){await exec('/usr/bin/open',['-a',app],{timeout:10000});}
  };
}
module.exports={desktopLifecycle};
