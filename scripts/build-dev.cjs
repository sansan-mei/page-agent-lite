#!/usr/bin/env node
// Local developer build: copy extension/ unchanged and overlay dev/ into dist/extension-dev/.
// The store package is still extension/ zipped as-is; this output is never uploaded.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

function build(out=path.join(root,'dist','extension-dev')){
  fs.rmSync(out,{recursive:true,force:true});
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.cpSync(path.join(root,'extension'),out,{recursive:true});
  for(const file of ['dev-tools.js','background-dev.js'])fs.copyFileSync(path.join(root,'dev',file),path.join(out,file));
  const manifestPath=path.join(out,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.name=manifest.name+' (Dev)';
  manifest.permissions=[...new Set([...(manifest.permissions||[]),'userScripts'])];
  manifest.background={...manifest.background,service_worker:'background-dev.js'};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return out;
}

if(require.main===module){
  const out=build(process.argv[2]?path.resolve(process.argv[2]):undefined);
  console.log('开发版已生成：'+out);
  console.log('在 chrome://extensions 加载该目录，并在扩展详情页打开「允许用户脚本」（Chrome 135+）。');
}
module.exports={build};
