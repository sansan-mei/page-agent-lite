// Render Chrome Web Store screenshots and promo tiles from site/index.html?shot=<section>.
// Usage: PAGE_AGENT_CHROMIUM=/path/to/chrome node scripts/store-shots.cjs  → dist/store/*.png
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs/promises');
const shots=[['hero',1280,800],['how',1280,800],['verify',1280,800],['memory',1280,800],['privacy',1280,800],['promo',440,280],['promo',1400,560]];
(async()=>{
 const root=path.resolve(__dirname,'..'),out=path.join(root,'dist/store'),assets=path.join(root,'site/assets');
 await fs.mkdir(out,{recursive:true});await fs.mkdir(assets,{recursive:true});
 // Same copy step as .github/workflows/pages.yml.
 for(const f of ['extension/icons/icon-48.png','extension/icons/icon-128.png','extension/icons/welcome-assistant.webp','docs/assets/sidepanel-preview.png'])await fs.copyFile(path.join(root,f),path.join(assets,path.basename(f)));
 const url=pathToFileURL(path.join(root,'site/index.html')).href;
 const browser=await chromium.launch({executablePath:process.env.PAGE_AGENT_CHROMIUM,headless:true});
 const errors=[];
 try{
  for(const lang of ['zh','en'])for(const [shot,width,height] of shots){
   const page=await browser.newPage({viewport:{width,height}});
   page.on('pageerror',e=>errors.push(`${lang}/${shot}: ${e.message}`));
   await page.goto(`${url}?lang=${lang}&shot=${shot}`);
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);
   const overflow=await page.evaluate(()=>{const s=document.querySelector('.shot-on');return s?s.scrollHeight-s.clientHeight:-1;});
   if(overflow!==0)errors.push(`${lang}/${shot} ${width}x${height}: content overflow ${overflow}px`);
   await page.screenshot({path:path.join(out,`${lang}-${shot}-${width}x${height}.png`)});
   await page.close();
  }
 }finally{await browser.close();}
 if(errors.length){console.error(errors.join('\n'));process.exit(1);}
 console.log('Wrote',shots.length*2,'images to',path.relative(root,out));
})();
