#!/usr/bin/env node
// Local developer build: copy extension/ unchanged and overlay dev/ into dist/extension-dev/.
// The store package is still extension/ zipped as-is; this output is never uploaded.
// Differences from the store build: userScripts is a required permission (no optional request)
// and dev-flags.js auto-approves run_script, so scripts run without side-panel confirmation.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

function build(out=path.join(root,'dist','extension-dev')){
  fs.rmSync(out,{recursive:true,force:true});
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.cpSync(path.join(root,'extension'),out,{recursive:true});
  for(const file of ['dev-flags.js','background-dev.js'])fs.copyFileSync(path.join(root,'dev',file),path.join(out,file));
  const manifestPath=path.join(out,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const localized=/^__MSG_(\w+)__$/.exec(manifest.name);
  if(localized){
    // Localized name: suffix the referenced message in every locale so each UI language shows "(Dev)".
    const locales=path.join(out,'_locales');
    for(const locale of fs.readdirSync(locales)){
      const file=path.join(locales,locale,'messages.json'),messages=JSON.parse(fs.readFileSync(file,'utf8'));
      const entry=Object.entries(messages).find(([key])=>key.toLowerCase()===localized[1].toLowerCase());
      if(!entry)throw new Error(`${locale} 缺少 ${localized[1]}`);
      entry[1].message+=' (Dev)';fs.writeFileSync(file,JSON.stringify(messages,null,2)+'\n');
    }
  }else manifest.name=manifest.name+' (Dev)';
  manifest.permissions=[...new Set([...(manifest.permissions||[]),'userScripts'])];
  manifest.optional_permissions=(manifest.optional_permissions||[]).filter(name=>name!=='userScripts');
  if(!manifest.optional_permissions.length)delete manifest.optional_permissions;
  manifest.background={...manifest.background,service_worker:'background-dev.js'};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return out;
}

if(require.main===module){
  const out=build(process.argv[2]?path.resolve(process.argv[2]):undefined);
  console.log('开发版已生成：'+out);
  console.log('在 chrome://extensions 加载该目录，并在扩展详情页打开「允许用户脚本」（Chrome 135+）；开发版 run_script 不经确认直接执行。');
}
module.exports={build};
