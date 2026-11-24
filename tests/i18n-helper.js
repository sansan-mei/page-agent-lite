'use strict';
// Test helper: chrome.i18n stub backed by the real _locales files, and a loader that runs
// extension/i18n.js before a UI script in the same global, like the page's <script defer> order.
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const locales=path.join(__dirname,'../extension/_locales');
function messages(locale){return JSON.parse(fs.readFileSync(path.join(locales,locale,'messages.json'),'utf8'));}
function chromeI18n(locale='zh_CN',uiLanguage=locale.replace('_','-')){
  const data=messages(locale);
  return {getMessage:key=>data[key]?.message||'',getUILanguage:()=>uiLanguage};
}
function runUi(file,globals,locale='zh_CN'){
  const chrome=globals.chrome||{};if(!chrome.i18n)chrome.i18n=chromeI18n(locale);
  const context=vm.createContext({...globals,chrome});
  for(const name of ['extension/i18n.js',file])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),context,{filename:name});
  return context;
}
module.exports={messages,chromeI18n,runUi};
