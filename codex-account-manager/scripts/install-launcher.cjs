#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
if(process.platform!=='darwin') throw new Error('This launcher installer targets macOS.');
const root=path.join(os.homedir(),'Applications','Codex Account Manager.app');
const binary=path.join(root,'Contents','MacOS','AccountManager');
fs.mkdirSync(path.dirname(binary),{recursive:true});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
fs.writeFileSync(binary,'#!/bin/zsh\nexec '+quote(process.execPath)+' '+quote(path.join(__dirname,'open-dashboard.cjs'))+'\n',{mode:0o755});
fs.chmodSync(binary,0o755);
fs.writeFileSync(path.join(root,'Contents','Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Codex Account Manager</string>
<key>CFBundleDisplayName</key><string>Codex Account Manager</string>
<key>CFBundleIdentifier</key><string>local.codex.account-manager</string>
<key>CFBundleVersion</key><string>1.0.0</string>
<key>CFBundleExecutable</key><string>AccountManager</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
console.log('Installed launcher: '+root);
