#!/usr/bin/env node
'use strict';
const {execFile}=require('node:child_process');
const {dashboard}=require('./account-manager.cjs');
dashboard().then(({url})=>{
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
  execFile(command,[url],error=>{if(error){console.error('Could not open the browser. Run account-manager.cjs open to get the dashboard link.');process.exitCode=1;}});
}).catch(e=>{console.error(e.message);process.exitCode=1;});
