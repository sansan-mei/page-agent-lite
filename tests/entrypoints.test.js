const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const {runUi} = require('./i18n-helper.js');
const dir = path.join(__dirname, '../extension');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('MV3 manifest uses optional hosts and all entrypoint files exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'scripting', 'sidePanel', 'storage', 'tabs']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  // run_script needs userScripts; it is optional so installing shows no extra warning.
  assert.deepEqual(manifest.optional_permissions, ['userScripts']);assert.ok(!manifest.permissions.includes('userScripts'));
  for (const file of [manifest.background.service_worker, manifest.options_page, 'core.js', 'backend.js', 'content.js', 'options.js', 'options.css', 'sidepanel.html', 'sidepanel.js', 'runtime.js', 'task-store.js', 'browser-tools.js', 'article-tools.js', 'conditions.js', 'tool-protocol.js', 'script-tools.js', 'script-settings.js']) {
    assert.ok(fs.statSync(path.join(dir, file)).isFile(), file);
  }
});

test('options requests API permission from submit gesture and refuses unsafe endpoint before granting', async () => {
  const {document, window} = parseHTML(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'));
  const sent = [], grants = [];
  const chrome = {runtime: {async sendMessage(m) {sent.push(m); return {ok: true, value: m.type === 'sites' ? [] : {}};}},
    permissions: {async request(p) {grants.push(p); return true;}}, tabs: {async query() {return [];}}};
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'core.js'), 'utf8'), {document, URL});
  const core = require('../extension/core.js');
  runUi('extension/options.js', {document, chrome, URL, PageAgentCore: core});
  await flush();
  const input = (id, value) => {document.getElementById(id).value = value;};
  input('endpoint', 'http://evil.test/v1'); input('model', 'm'); input('key', 'secret'); input('language', '中文');
  const submit = () => document.getElementById('config').dispatchEvent(new window.Event('submit', {cancelable: true}));
  submit(); await flush(); assert.equal(grants.length, 0);
  input('endpoint', 'https://api.test/v1'); submit();
  // Save stores connection and run budget together; the host permission is requested before any await.
  assert.equal(grants.length, 1);
  await flush(); await flush(); await flush();
  assert.equal(grants[0].origins[0], 'https://api.test/*');
  assert.deepEqual({...sent.find(m => m.type === 'setAgentPreferences').preferences}, {maxSteps: 100, contextTokens: 100000, compressionThreshold: 80, inputChars: 2000});
  assert.equal(document.getElementById('status').hidden, false);
  assert.equal(sent.find(m => m.type === 'configure').config.endpoint, 'https://api.test/v1');
  assert.equal(sent.some(m => m.type === 'enableSite'), false);
});

test('options script section requests the optional userScripts permission from the click and shows status',async()=>{
 const {document, window} = parseHTML(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'));
 assert.match(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'), /src="script-tools\.js"[\s\S]*src="script-settings\.js"/);
 let granted=false,api=false;const requests=[],opened=[];
 const chrome={runtime:{id:'ext',getManifest:()=>JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'))},tabs:{async create(p){opened.push(p.url);}},
  permissions:{async contains(q){return q.permissions?granted:true;},request(p){requests.push(p);granted=true;return Promise.resolve(true);},async remove(){granted=false;return true;},onAdded:{addListener(){}},onRemoved:{addListener(){}}}};
 Object.defineProperty(chrome,'userScripts',{get(){return granted&&api?{getScripts:async()=>[],execute:async()=>[]}:undefined;}});
 runUi('extension/script-settings.js',{document,window,chrome,PageAgentScriptTools:require('../extension/script-tools.js')});
 await flush();await flush();
 const status=()=>document.getElementById('script-status').textContent,hidden=id=>document.getElementById(id).hidden;
 const badge=()=>document.getElementById('script-badge').getAttribute('data-state');
 // One action at a time: Allow -> Open extension details -> On (+ Turn off link).
 assert.equal(status(),'');assert.equal(badge(),'off');assert.deepEqual(['script-grant','script-details','script-revoke'].map(hidden),[false,true,true]);
 document.getElementById('script-grant').click();
 // The request happens synchronously inside the click handler (user gesture).
 assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{permissions:['userScripts']}]);
 await flush();await flush();
 assert.match(status(),/允许用户脚本/);assert.equal(badge(),'toggle');assert.deepEqual(['script-grant','script-details','script-revoke'].map(hidden),[true,false,false]);
 document.getElementById('script-details').click();await flush();assert.deepEqual(opened,['chrome://extensions/?id=ext']);
 api=true;document.dispatchEvent(new window.Event('visibilitychange'));await flush();await flush();
 assert.equal(status(),'');assert.equal(badge(),'on');assert.deepEqual(['script-grant','script-details','script-revoke'].map(hidden),[true,true,false]);
 document.getElementById('script-revoke').click();await flush();await flush();await flush();assert.equal(badge(),'off');assert.equal(hidden('script-grant'),false);
});

test('lite options hide power tools by default and both saves use the same form',()=>{
 const {document}=parseHTML(fs.readFileSync(path.join(dir,'options.html'),'utf8'));
 assert.equal(document.querySelector('.settings-nav'),null);
 assert.equal(document.getElementById('more').hasAttribute('open'),false);
 assert.equal(document.getElementById('management').hasAttribute('open'),false);
 for(const id of ['save-settings','save-more'])assert.equal(document.getElementById(id).closest('form').id,'config');
 for(const id of ['language-choice','max-steps','reasoningEffort','grant-all','welcome-image-pick'])assert.equal(document.getElementById(id).closest('details').id,'more');
 assert.equal(document.querySelectorAll('form form').length,0);
});

// ── Sender semantics under realistic MV3 conditions ──────────────────────
const extDir = require('node:path').join(__dirname, '..', 'extension');
const optionsJs = require('node:fs').readFileSync(path.join(extDir, 'options.js'), 'utf8');

test('options.js must call chrome.permissions.request before sending config', () => {
  assert.ok(optionsJs.includes("chrome.permissions.request"), 'options.js calls permissions.request');
  const idxReq = optionsJs.indexOf("chrome.permissions.request");
  const idxSend = optionsJs.indexOf("send({type: 'configure'");
  assert.ok(idxReq >= 0 && idxSend > idxReq, 'Config send after permissions.request');
});

test('production manifest has no host_permissions and minimal declared permissions', () => {
  const m = JSON.parse(require('node:fs').readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  assert.equal(m.host_permissions, undefined, 'No pre-granted hosts');
  const ps = new Set(m.permissions);
  assert.equal(ps.has('activeTab'), false, 'Host access comes only from optional host permissions'); assert.ok(ps.has('scripting')); assert.ok(ps.has('storage'));
  assert.ok(ps.has('tabs'), 'Read target metadata to request only its optional origin');
});
