const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const dir = path.join(__dirname, '../extension');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('MV3 manifest uses optional hosts and all entrypoint files exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  for (const file of [manifest.background.service_worker, manifest.options_page, 'core.js', 'backend.js', 'content.js', 'options.js', 'options.css']) {
    assert.ok(fs.statSync(path.join(dir, file)).isFile(), file);
  }
});

function background(init = Promise.resolve()) {
  let message, action;
  const calls = [];
  const chrome = {
    runtime: {id: 'test', getURL: p => 'chrome-extension://test/' + p,
      onMessage: {addListener(fn) {message = fn;}}, async openOptionsPage() {calls.push('options');}},
    action: {onClicked: {addListener(fn) {action = fn;}}, async setBadgeText(v) {calls.push(v);}, async setTitle(v) {calls.push(v);}},
    scripting: {async executeScript(v) {calls.push(v);}}
  };
  const service = {init: () => init, async handle(m) {calls.push(m.type); return {records: []};}};
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), {
    chrome, importScripts() {}, PageAgentBackend: {createService: () => service}, URL
  });
  return {calls, action: tab => action(tab), send: (m, sender) => new Promise(resolve => message(m, sender, resolve))};
}
const page = {id: 'test', url: 'https://news.test/a', frameId: 0, tab: {id: 4}};
test('background waits for trusted storage initialization and validates openOptions sender', async () => {
  let resolve;
  const f = background(new Promise(r => {resolve = r;}));
  const pending = f.send({type: 'load'}, page);
  await flush(); assert.equal(f.calls.length, 0);
  resolve(); assert.equal((await pending).ok, true);
  assert.equal((await f.send({type: 'openOptions'}, {...page, frameId: 1})).ok, false);
  assert.equal((await f.send({type: 'openOptions'}, page)).ok, true);
  assert.ok(f.calls.includes('options'));
});
test('background fails closed on initialization failure and reports restricted tabs', async () => {
  const f = background(Promise.reject(Error('private storage detail')));
  const result = await f.send({type: 'load'}, page);
  assert.equal(result.ok, false); assert.ok(!result.error.includes('private storage'));
  assert.equal(f.calls.includes('load'), false);
  await f.action({id: 4, url: 'chrome://settings'});
  assert.ok(f.calls.some(v => v.text === '!'));
});
test('action injection is isolated and top-frame only', async () => {
  const f = background(); await f.action({id: 4, url: 'https://news.test'});
  const injection = f.calls.find(v => v.files);
  assert.deepEqual(Array.from(injection.files), ['core.js', 'content.js']);
  assert.deepEqual(Array.from(injection.target.frameIds), [0]);
  assert.equal(injection.world, 'ISOLATED');
});

test('options requests API permission from submit gesture and refuses unsafe endpoint before granting', async () => {
  const {document, window} = parseHTML(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'));
  const sent = [], grants = [];
  const chrome = {runtime: {async sendMessage(m) {sent.push(m); return {ok: true, value: m.type === 'sites' ? [] : {}};}},
    permissions: {async request(p) {grants.push(p); return true;}}, tabs: {async query() {return [];}}};
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'core.js'), 'utf8'), {document, URL});
  const core = require('../extension/core.js');
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'options.js'), 'utf8'), {document, chrome, URL, PageAgentCore: core});
  await flush();
  const input = (id, value) => {document.getElementById(id).value = value;};
  input('endpoint', 'http://evil.test/v1'); input('model', 'm'); input('key', 'secret'); input('language', '中文');
  const submit = () => document.getElementById('config').dispatchEvent(new window.Event('submit', {cancelable: true}));
  submit(); await flush(); assert.equal(grants.length, 0);
  input('endpoint', 'https://api.test/v1'); submit(); await flush(); await flush();
  assert.equal(grants[0].origins[0], 'https://api.test/*');
  assert.equal(sent.find(m => m.type === 'configure').config.endpoint, 'https://api.test/v1');
  assert.equal(sent.some(m => m.type === 'enableSite'), false);
});

// ── Sender semantics under realistic MV3 conditions ──────────────────────
const extDir = require('node:path').join(__dirname, '..', 'extension');
const optionsJs = require('node:fs').readFileSync(path.join(extDir, 'options.js'), 'utf8');

test('background rejects wrong-extension and non-tab openOptions messages', async () => {
  const f = background();
  for (const sender of [{...page,id:'other'}, {...page,frameId:2}, {id:'test',url:'chrome-extension://test/options.html'}, {...page,url:'chrome-extension://test/popup.html'}]) {
    assert.equal((await f.send({type:'openOptions'},sender)).ok,false);
  }
  assert.equal(f.calls.includes('options'),false);
});

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
  assert.ok(ps.has('activeTab')); assert.ok(ps.has('scripting')); assert.ok(ps.has('storage'));
  assert.ok(!ps.has('tabs'));
});
