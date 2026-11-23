'use strict';
/* Real Chromium extension end-to-end smoke test — CI or explicit --local.
 *
 * Runs inside xvfb-run so Playwright can drive headed Chromium with
 * --headless=new support via the 'chromium' channel.
 *
 * Strategy:
 *   1. Clone extension/ into a temp dir, inject host_permissions into the
 *      temporary manifest only (production manifest.json stays untouched).
 *   2. Start a small local HTTP server: /article serves a fixture page;
 *      POST /v1/chat/completions returns deterministic stub JSON responses
 *      (no live model API).
 *   3. Launch Chromium with the real extension unpacked (same flags used
 *      in the "Load unpacked" devflow).
 *   4. Walk through every supported feature chain and capture screenshots
 *      plus a structured JSON report.
 *
 * Limitations — documented for audit:
 *   • Temporary manifest seeds http://127.0.0.1/* host permission;
 *     production manifest.json is never modified or committed.
 *   • No native optional-host permission prompt scenarios are tested
 *     (prompt dismissal, retry, etc.). chrome.permissions.request
 *     returns immediately because the origin is already pre-granted.
 *   • Initial content-script injection uses real chrome.scripting.executeScript
 *     from the service worker — NOT the toolbar icon click action path.
 *     Toolbar-click unverified; blocked pages not tested beyond protocol check.
 *   • Model requests go to a deterministic loopback OpenAI-compatible stub,
 *     NOT a live third-party API endpoint.
 */

const assert = require('node:assert/strict');
const fs     = require('node:fs/promises');
const path   = require('node:path');
const os     = require('node:os');
const http   = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ── Guard: CI-only ───────────────────────────────────────────────────────
const localSmoke=process.argv.includes('--local');
if (!localSmoke && (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true')) {
  throw new Error(
    'Real Chromium smoke test requires CI environment variables; do not run locally.'
  );
}

// ── Imports ──────────────────────────────────────────────────────────────
const { chromium } = require('playwright');

// ── Paths ────────────────────────────────────────────────────────────────
const root       = path.resolve(__dirname, '..');
const outputDir  = path.join(root, 'tests', 'browser-output');

// ── Test constants (deterministic, no secrets) ───────────────────────────
const TEST_TRANSLATION =
  'STUB_TRANSLATION <img src=x onerror="window.__modelExecuted=true">';
const TEST_SUMMARY     = 'STUB_SUMMARY <script>window.__modelExecuted=true</script>';
const FAKE_SECRET      = 'FAKE_SERVER_SECRET_DO_NOT_DISPLAY';
const FAKE_KEY         = 'FAKE_CI_KEY_NOT_A_CREDENTIAL';

const PARAGRAPH  = 'The selected paragraph is deterministic browser smoke test data.';
const EDIT_TEXT  = 'A separate paragraph receives the previewed style.';

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page Agent smoke fixture</title></head>
<body><main><article>
  <h1>Chromium smoke article</h1>
  <p id="selected">${PARAGRAPH}</p>
  <p id="editable">${EDIT_TEXT}</p>
</article></main></body></html>`;
const JUDGMENT_HTML='<html><body><h1>Judgment fixture</h1><fieldset><legend>Q1: first question</legend><label><input type="radio" name="q1" value="yes">对</label><label><input type="radio" name="q1" value="no" checked>错</label></fieldset><fieldset><legend>Q2: second question</legend><label><input type="radio" name="q2" value="yes" checked>对</label><label><input type="radio" name="q2" value="no">错</label></fieldset></body></html>';
const DIALOG_HTML=`<html><body><button id="start" onclick="window.openCount=(window.openCount||0)+1;document.getElementById('confirm').hidden=false;this.remove()">Submit</button>${'<button>Background</button>'.repeat(130)}<div id="confirm" role="dialog" aria-label="Confirm changes" hidden><button onclick="window.confirmCount=(window.confirmCount||0)+1;document.getElementById('result').textContent='Saved';document.getElementById('confirm').hidden=true">Submit</button></div><section id="result" aria-label="Confirmation result">Waiting</section></body></html>`;
const GENERAL_HTML=`<html><body><h1>General workflow</h1><form aria-label="Profile"><label>Name<input name="name" type="text" value="old" onchange="this.replaceWith(this.cloneNode(true))"></label></form><button onclick="window.filterCount=(window.filterCount||0)+1;setTimeout(()=>document.getElementById('rows').textContent='Filtered rows',3000)">Filter</button><section id="rows" aria-label="Results">Waiting</section><button onclick="fetch('/persist',{method:'POST'}).then(()=>document.getElementById('save-status').textContent='Saved')">Save</button><section id="save-status" role="status" aria-label="Save status">Not saved</section><section aria-label="Advertisement">Saved</section><section id="delayed" aria-label="Delayed">Waiting</section><script>setTimeout(()=>document.getElementById('delayed').textContent='Ready',5000)</script></body></html>`;

// ── Report accumulator ──────────────────────────────────────────────────
const report = {
  status:        'running',
  assertions:    [],
  requests:      [],
  fixtureFiles:  [],
  caveats: [
    'Temporary manifest fixture seeds host permission; production manifest is untouched.',
    'Native optional-host permission prompt scenarios (grant/deny/retry) are NOT verified.',
    'Initial injection uses chrome.scripting.executeScript from the worker, NOT toolbar icon click.',
    'Model calls go to a deterministic loopback HTTP stub, NOT a live third-party API.',
    'Closed Shadow DOM stays closed; inspected via CDP DOM.getDocument(pierce:true).',
    'Worker termination during wait is tested; natural idle suspension and termination during side-effect dispatch are NOT tested.',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────
function pass(name) {
  report.assertions.push(name);
  console.log(`PASS ${name}`);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Poll until predicate returns truthy or timeout. */
async function poll(fn, label, ms = 12000) {
  const deadline = Date.now() + ms;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (err) { lastErr = err; }
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Collect relative file paths from a directory tree (sorted). */
async function listFiles(dir, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(dir, entry.name), rel));
    else {
      assert.ok(entry.isFile(), `${rel} is not a regular file`);
      result.push(rel);
    }
  }
  return result.sort();
}

// ── Helper: inspect closed-shadow DOM via CDP ────────────────────────────
// Traverse pierce tree → find [data-page-agent='ui'] node → verify
// shadowRootType === 'closed' → querySelector on that shadowRoot.

/** Find nodeId for a selector inside the closed shadow UI root. */
async function shadowFind(cdp, selector) {
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  function find(node) {
    const attrs = node.attributes || [];
    if (attrs.some((v, i) => i % 2 === 0 && v === 'data-page-agent' && attrs[i + 1] === 'ui')) {
      assert.equal(node.shadowRoots?.[0]?.shadowRootType, 'closed');
      return node.shadowRoots[0];
    }
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  }
  const root = find(doc.root);
  if (!root) return null;
  return (await cdp.send('DOM.querySelector', {nodeId: root.nodeId, selector})).nodeId || null;
}

/** Evaluate function on a shadow-root-descended element (returnByValue). */
async function shadowEval(cdp, selector, fnDecl, args = []) {
  const nodeId = await shadowFind(cdp, selector);
  assert.ok(nodeId, `Shadow DOM element found: ${selector}`);
  const resolved = await cdp.send('DOM.resolveNode', { nodeId });
  try {
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: fnDecl,
      arguments: args.map(v => ({ value: v })),
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined,
      `Shadow evaluation succeeded: ${selector}`);
    return result.result.value;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: resolved.object.objectId });
  }
}

function shadowText(sel)  { return shadowEval(cdpSession, sel, 'function(){return this.textContent;}'); }
function shadowDisabled(sel) { return shadowEval(cdpSession, sel, 'function(){return this.disabled;}'); }

/** Trusted click inside the shadow UI via bounding-box mouse event. */
async function shadowClick(cdp, selector) {
  // Wait for button to be visible (not disabled).
  await poll(async () => !await shadowDisabled(selector), `button ready: ${selector}`);

  const nodeId = await shadowFind(cdp, selector);
  const box = await cdp.send('DOM.getBoxModel', { nodeId });
  const border = box.model.border;
  const cx = (border[0] + border[2] + border[4] + border[6]) / 4;
  const cy = (border[1] + border[3] + border[5] + border[7]) / 4;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();
  // Ensure buttons re-enabled.
  await poll(async () => !await shadowDisabled('#summary'), 'buttons enabled after click', 6000);
}

/** Take screenshot into output dir. */
async function snap(name) {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true });
}

/** Assert no script/img from model HTML actually executed in page DOM. */
async function assertNoModelExec() {
  const exec = await page.evaluate(() => window.__modelExecuted);
  assert.equal(exec, undefined, 'No __modelExecuted flag fired');
  const leakedImg = await page.locator('[data-page-agent="translation"] img[src]').count();
  assert.equal(leakedImg, 0, 'No <img> from stub HTML in translation area');
  const leakedScript = await page.locator('[data-page-agent="summary"] script').count();
  assert.equal(leakedScript, 0, 'No <script> from stub HTML in summary area');
}

// ── Server: stub page + deterministic model response ─────────────────────
let server, serverPid, failNext = false, invalidEdit = false;
let persistedCount=0;
const serverErrors = [];

async function startServer() {
  const svc = http.createServer((req, res) => {
    void (async () => {
      if(req.method==='POST'&&req.url==='/persist'){persistedCount++;res.writeHead(200);res.end('ok');return;}
      if (req.method === 'GET' && ['/article','/task-one','/task-two','/judgment','/general','/dialog'].includes(req.url)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        });
        res.end(req.url==='/dialog'?DIALOG_HTML:req.url==='/general'?GENERAL_HTML:req.url==='/judgment'?JUDGMENT_HTML:req.url==='/task-one'?'<html><body><h1>Task page one</h1><input aria-label="Answer" type="text"><a href="/task-two">Next page</a></body></html>':req.url==='/task-two'?'<html><body><h1>Task page two complete</h1></body></html>':FIXTURE_HTML); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404); res.end(); return;
      }
      // Read body.
      const chunks = []; let total = 0;
      for await (const ch of req) { total += ch.length; assert.ok(total < 6100000, 'stub body bounded'); chunks.push(ch); }
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Verify auth header matches configured key.
      assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`, 'stub bearer auth');
      assert.equal(body.model, 'ci-deterministic-stub');
      assert.equal(body.stream, false);
      assert.equal(body.messages?.length, 2);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'user');

      // Derive task from system prompt (matches production prompt construction).
      const sysPrompt = body.messages[0].content;
      const task = sysPrompt.startsWith('Translate ')  ? 'translate'
                 : sysPrompt.startsWith('Summarize browser task history') ? 'context-summary'
                 : sysPrompt.startsWith('Summarize ')    ? 'summary'
                 : sysPrompt.startsWith('You are a browser') ? 'agent'
                 : sysPrompt.startsWith('You are a')      ? 'edit'
                 : null;
      assert.ok(task, 'Stub recognized production system prompt');

      const input = body.messages[1].content;

      if (task === 'translate') {
        assert.equal(input, PARAGRAPH, 'Full selection text sent');
      } else if (task === 'summary') {
        assert.ok(input.includes(PARAGRAPH), 'Summary request contains article text');
      }

      const entry = { task, status: failNext ? 503 : 200 };
      report.requests.push(entry);

      res.setHeader('Content-Type', 'application/json');

      if (failNext) { failNext = false;
        res.writeHead(503);
        res.end(JSON.stringify({ error: { message: FAKE_SECRET } }));
        return;
      }

      if(task==='context-summary'){
        const data=JSON.parse(input);assert.equal(data.olderResults.length,7);assert.ok(data.instructions[0].text.includes('correction'));
        res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({completed:['Opened the page, observed only'],remaining:['Check current status'],facts:['User correction preserved'],failed:[],uncertain:['Previous save unverified; do not replay']})}}]}));return;
      }
      if (task === 'edit') {
        const parsed = JSON.parse(input);
        assert.equal(parsed.instruction, 'Make the separate paragraph blue.');
        const target = parsed.outline.find(n => n.text === EDIT_TEXT);
        assert.ok(target, 'Outline includes edit target');
        const op = { id: target.id, action: 'style', property: 'color', value: '#112233' };
        if (invalidEdit) Object.assign(op, { extra: 'reject-me' });
        res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({operations:[op]})}}]}));
        return;
      }
      if(task==='agent'){
        const data=JSON.parse(input),field=data.page.elements.find(e=>e.tag==='input'),link=data.page.elements.find(e=>e.tag==='a');
        if(data.goal==='Dialog recovery'){
          const result=data.page.regions.find(r=>r.label==='Confirmation result');
          const dialog=data.page.groups.find(g=>g.label==='Confirm changes');
          let plan;
          if(result?.text==='Saved')plan={reply:'Verified saved',action:'done',expected:[{kind:'text_present',id:result.id,value:'Saved'}]};
          else if(dialog){assert.equal(data.lastOutcome.code,'CONDITION_TIMEOUT');plan={reply:'Confirm distinct dialog control',action:'click',id:dialog.optionIds[0]};}
          else{const button=data.page.elements.find(e=>e.label==='Submit');plan={reply:'Open confirmation',action:'click',id:button.id,expected:[{kind:'element_visible',id:button.id}],timeoutMs:100};}
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
        }
        if(data.goal.startsWith('Durable smoke')){
          let plan={reply:'durable done',action:'done'};
          if(data.goal==='Durable smoke save'&&!data.siteMemoryIndex.some(n=>n.id==='workflow'))plan={reply:'save durable',action:'site_memory_write',id:'workflow',value:'Verified workflow: review before saving'};
          if(data.goal==='Durable smoke recall'&&!data.results.some(r=>r.action==='site_memory_read')){
            assert.ok(data.siteMemoryIndex.some(n=>n.id==='workflow'));assert.ok(!input.includes('Verified workflow: review before saving'));plan={reply:'read durable',action:'site_memory_read',id:'workflow'};
          }
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
        }
        if(data.goal==='Context smoke'){
          assert.equal(data.historyIndex[0].to,7);assert.equal(data.results.length,6);assert.equal(data.instructions[0].text,'User correction preserved');assert.equal(data.lastOutcome.code,'UNKNOWN_SAVE');
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({reply:'Context received; current page inspected',action:'done'})}}]}));return;
        }
        if(data.goal.startsWith('General')){
          const region=label=>data.page.regions.find(r=>r.label===label);
          const condition=(label,value)=>({kind:'text_present',id:region(label).id,value});
          let plan;
          if(data.goal==='General wait'){
            plan=data.results.some(r=>r.action==='wait')?{reply:'结果就绪',action:'done',expected:[condition('Delayed','Ready')]}:{reply:'等待异步区域',action:'wait',expected:[condition('Delayed','Ready')],timeoutMs:10000};
          }else if(data.goal==='General unmet completion'){
            plan={reply:'保存完成',action:'done',expected:[condition('Save status','Impossible confirmation')]};
          }else if(field.value!=='Alice'){
            plan={reply:'填写资料',action:'fill',id:field.id,value:'Alice'};
          }else if(!region('Results').text.includes('Filtered rows')){
            plan={reply:'筛选列表',action:'click',id:data.page.elements.find(e=>e.label==='Filter').id,expected:[condition('Results','Filtered rows')],timeoutMs:10000};
          }else if(region('Save status').text!=='Saved'){
            plan={reply:'保存资料',action:'click',id:data.page.elements.find(e=>e.label==='Save').id,expected:[condition('Save status','Saved')]};
          }else plan={reply:'已按页面反馈核实填写、筛选与保存',action:'done',expected:[{kind:'field_equals',id:field.id,value:'Alice'},condition('Results','Filtered rows'),condition('Save status','Saved')]};
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
        }
        if(data.goal.startsWith('Memory smoke')){
          let plan={reply:'临时记忆操作完成',action:'done'};
          if(data.goal==='Memory smoke save'&&!data.memoryIndex.length)plan={reply:'保存用户更正',action:'memory_write',id:'answers',value:'用户更正：第一题对，第二题错'};
          if(data.goal==='Memory smoke recall'&&!data.results.some(r=>r.action==='memory_read'))plan={reply:'按需读取',action:'memory_read'};
          if(data.goal==='Memory smoke forget'&&data.memoryIndex.length)plan={reply:'清除已过期答案',action:'memory_clear'};
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
        }
        if(data.page.text.includes('Judgment fixture')){
          let plan={reply:'当前选中状态已核对：第一题对，第二题错；未提交评分',action:'done'};
          for(const [question,label] of [['Q1','对'],['Q2','错']]){
            const group=data.page.groups.find(g=>g.context.includes(question));assert.ok(group,'question group supplied');
            const option=data.page.elements.find(e=>group.optionIds.includes(e.id)&&e.label===label);assert.ok(option,'option label mapped within group');
            if(!option.checked){plan={reply:'更正 '+question,action:'check',id:option.id,value:true};break;}
          }
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
        }
        const plan=data.page.text.includes('Task page two')?{reply:'已到达第二页，任务完成',action:'done'}:field?.value!=='4'?{reply:'填写答案',action:'fill',id:field.id,value:'4'}:{reply:'前往下一页',action:'click',id:link.id};
        res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));return;
      }

      const content = task === 'translate' ? TEST_TRANSLATION : TEST_SUMMARY;
      res.end(JSON.stringify({
        id: 'loopback-stub-' + Date.now(),
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }));
    })().catch(err => { serverErrors.push(err.message); res.writeHead(500); res.end('{}'); });
  });
  await new Promise((ok, bad) => { svc.once('error', bad); svc.listen(0, '127.0.0.1', ok); });
  server = svc;
  const port = server.address().port;
  return `http://127.0.0.1:${port}`;
}

// ── Fixture factory: clone extension/, inject host_permissions ───────────
async function makeFixture(origin) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'page-agent-chromium-'));
  const src      = path.join(root, 'extension');
  const fixture  = path.join(tmpDir, 'extension');
  await fs.cp(src, fixture, { recursive: true, verbatimSymlinks: false });

  // Read production manifest — MUST NOT have host_permissions.
  const prodManifest = JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8'));
  assert.equal(prodManifest.host_permissions, undefined,
    'Production manifest must not pre-grant hosts');

  // Inject temporary host grant.
  const grant = `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;
  const fixtureManifest = { ...prodManifest, host_permissions: [grant] };
  await fs.writeFile(
    path.join(fixture, 'manifest.json'),
    JSON.stringify(fixtureManifest, null, 2),
  );

  // Verify byte-exact copy except manifest.host_permissions.
  const prodFiles = await listFiles(src);
  const fixFiles  = await listFiles(fixture);
  assert.deepEqual(fixFiles, prodFiles, 'Fixture has identical file set');

  for (const f of prodFiles) {
    const orig = await fs.readFile(path.join(src, f));
    const copy = await fs.readFile(path.join(fixture, f));
    if (f === 'manifest.json') {
      const copied = JSON.parse(copy.toString());
      assert.deepEqual(copied.host_permissions, [grant]);
      delete copied.host_permissions;
      assert.deepEqual(copied, prodManifest,
        `manifest differs only in host_permissions (${f})`);
    } else {
      assert.ok(orig.equals(copy), `byte-identical: ${f}`);
    }
    report.fixtureFiles.push({
      file: f,
      sourceSha256: sha256(orig),
      fixtureSha256: sha256(copy),
    });
  }

  pass('permission-seeded fixture is byte-identical to production except manifest host_permissions');

  return tmpDir;
}

// ── Main test sequence ───────────────────────────────────────────────────
let context, page, optionsPage, cdpSession, fixtureBase;

(async () => {
  // 0. Prepare output dir.
  await fs.mkdir(outputDir, { recursive: true });

  // Capture Git info.
  report.sourceSha = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' }).trim();
  report.dirtyCheckout=!!dirty;
  if(!localSmoke)assert.equal(dirty, '', 'Git checkout must be clean');

  // 1. Start stub server.
  const origin = await startServer();
  report.serverOrigin = origin;

  // 2. Create fixture with seeded grant.
  fixtureBase = await makeFixture(origin);
  const fixturePath = path.join(fixtureBase, 'extension');

  // 3. Launch Chromium + real extension.
  const profileDir = path.join(fixtureBase, 'profile');
  const launchOptions={
    channel: 'chromium',
    executablePath: localSmoke ? process.env.PAGE_AGENT_CHROMIUM : undefined,
    headless: localSmoke,                     // Local checks run without desktop windows.
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${fixturePath}`,
      `--load-extension=${fixturePath}`,
    ],
  };
  context = await chromium.launchPersistentContext(profileDir,launchOptions);

  report.browserVersion = context.browser()?.version() ?? 'persistent-context';

  // 4. Wait for service worker.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', {
      predicate: w => w.url().startsWith('chrome-extension://'),
      timeout: 20000,
    });
  }
  const extensionId = new URL(sw.url()).hostname;
  report.extensionId = extensionId;
  assert.match(extensionId, /^[a-z]{32}$/, 'Valid MV3 extension UUID');
  pass('real unpacked Manifest V3 extension loaded, service worker active');

  // 5. Options page — configure API, verify saved.
  optionsPage = await context.newPage();
  optionsPage.on('pageerror', error => console.log('OPTIONS_PAGE_ERROR', error.message));
  await sw.evaluate(() => chrome.runtime.onMessage.addListener((m,s) => {globalThis.__smokeSender = {type:m.type,id:s.id,url:s.url,tabId:s.tab?.id,frameId:s.frameId};}));
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.waitForTimeout(1000);
  console.log('OPTIONS_DIAGNOSTIC', await optionsPage.locator('#status').textContent(), await sw.evaluate(() => globalThis.__smokeSender));
  await poll(
    async () => (await optionsPage.locator('#status').textContent()).includes('设置已读取'),
    'options page settings initialized',
  );

  await optionsPage.locator('#endpoint').fill(origin + '/v1');
  await optionsPage.locator('#model').fill('ci-deterministic-stub');
  await optionsPage.locator('#key').fill(FAKE_KEY);
  await optionsPage.locator('#language').fill('简体中文');
  await optionsPage.locator('#config button[type="submit"]').click();

  await poll(
    async () => (await optionsPage.locator('#status').textContent()).includes('API 配置已保存'),
    'options submitted & API config saved',
  );

  // Verify storage contents (from service worker scope).
  const storedConfig = await sw.evaluate(() => chrome.storage.local.get('config'));
  assert.deepEqual(storedConfig.config.endpoint, origin + '/v1');
  assert.deepEqual(storedConfig.config.model, 'ci-deterministic-stub');
  assert.deepEqual(storedConfig.config.language, '简体中文');
  assert.equal(report.requests.length, 0, 'Saving config does not call model');
  pass('options page form saves real configuration via runtime.sender/storage');

  // 6. Load test page, inject via scripting.
  page = await context.newPage();
  await page.goto(origin + '/article');

  // Panel should NOT be present yet.
  assert.equal(await page.locator('[data-page-agent="ui"]').count(), 0,
    'Panel not injected until scripted');

  // Discover tab via service worker, inject via chrome.scripting.executeScript.
  const tabId = await sw.evaluate(
    async url => ((await chrome.tabs.query({})).find(t => t.url === url))?.id ?? -1,
    origin + '/article',
  );
  assert.ok(Number.isInteger(tabId), 'Tab discovered through real tabs API');
  await sw.evaluate(
    (id) => chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      files: ['tool-protocol.js', 'conditions.js', 'core.js', 'content.js', 'article-tools.js'],
      world: 'ISOLATED',
    }),
    tabId,
  );

  // Connect CDP session to page for shadow DOM inspection.
  cdpSession = await context.newCDPSession(page);

  // Wait for panel to appear.
  await poll(() => shadowText('[role="status"]'), 'panel appeared in isolated world', 8000);
  async function showArticle(){await sw.evaluate(id=>chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:'ISOLATED',func:()=>globalThis.__pageAgent?.show()}),tabId);}
  await showArticle();
  assert.match(await shadowText('[role="status"]'), /临时模式/,
    'Status shows temporary-mode message');
  pass('chrome.scripting.executeScript injected unmodified page tools and article tools in ISOLATED world');

  // 7. Enable site via options form.
  await optionsPage.bringToFront();
  await optionsPage.locator('#origin').fill(origin);
  await optionsPage.locator('#site-form button[type="submit"]').click();

  await poll(
    async () => (await optionsPage.locator('#status').textContent()).includes('站点已启用'),
    'site form submitted and accepted',
  );

  const sitesResult = await sw.evaluate(() => chrome.storage.local.get('sites'));
  assert.deepEqual(sitesResult.sites, [origin]);
  const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.ok(regs.length >= 1, 'Site registration triggered real content script registration');
  pass('site form registers content script, refresh restores records without model calls');

  // 8. Refresh test page — panel auto-injects, records restored.
  await page.bringToFront();
  await page.reload();
  await poll(() => shadowText('[role="status"]'), 'panel restored on reload', 8000);
  await showArticle();
  assert.match(await shadowText('[role="status"]'), /此站点已启用持久保存/,
    'Status confirms persisted site enabled');
  assert.equal(report.requests.length, 0, 'Restore does not call model');
  pass('refresh restores content script and reads saved records from storage');

  // 9. TRANSLATE — select text → click → verify.
  await page.evaluate(() => {
    const el = document.getElementById('selected');
    const range = document.createRange();
    range.setStart(el.firstChild, 0);
    range.setEnd(el.firstChild, el.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });

  await shadowClick(cdpSession, '#translate');

  // Translation appears in shadow DOM.
  await poll(
    async () => (await page.locator('[data-page-agent="translation"]').textContent()) === TEST_TRANSLATION,
    'translation rendered in page DOM',
  );

  assert.equal(report.requests.length, 1, 'Exactly one translate request');
  assert.equal(report.requests[0].task, 'translate');

  // Stub HTML did NOT execute.
  await assertNoModelExec();
  pass('trusted click translates selection, renders model HTML literally');

  // 10. SUMMARY — click → verify.
  await shadowClick(cdpSession, '#summary');

  await poll(
    async () => (await page.locator('[data-page-agent="summary"]').textContent()) === TEST_SUMMARY,
    'summary rendered in page DOM',
  );
  await assertNoModelExec();
  assert.equal(report.requests.length, 2);
  pass('summary inserts plain text, no script execution');
  await snap('01-translate-summary');

  // 11. EDIT — propose (invalid) → reject.
  await shadowEval(cdpSession, '#prompt', 'function(v){this.value=v;}',
    ['Make the separate paragraph blue.']);
  invalidEdit = true;
  await shadowClick(cdpSession, '#propose');

  assert.match(await shadowText('[role="status"]'), /拒绝不安全的修改/,
    'Strict schema rejected extra keys');
  assert.equal(await page.locator('#editable').getAttribute('style'), null,
    'No style applied on rejection');

  // Apply with no pending should fail.
  await shadowClick(cdpSession, '#apply');
  assert.match(await shadowText('[role="status"]'), /请先生成有效修改建议/,
    'Apply failed when nothing pending');
  pass('strict edit schema rejects proposals with extra keys');

  // 12. EDIT — propose (valid) → preview → apply.
  invalidEdit = false;
  await shadowClick(cdpSession, '#propose');

  const previewText = await shadowText('#preview');
  assert.match(previewText, /#112233/, 'Preview shows the proposed color change');
  // Preview does NOT mutate the page.
  assert.equal(await page.locator('#editable').getAttribute('style'), null,
    'Preview does not apply to page');
  pass('edit preview renders before applying');
  await snap('02-edit-preview');

  await shadowClick(cdpSession, '#apply');
  const computedColor = await page.locator('#editable').evaluate(el =>
    getComputedStyle(el).getPropertyValue('color'));
  assert.equal(computedColor, 'rgb(17, 34, 51)', 'Computed color matches proposal');
  assert.equal(await page.locator('#editable').evaluate(el =>
    el.style.getPropertyPriority('color')), 'important',
    'Style priority is !important');

  // Three records saved.
  const savedData = await sw.evaluate(() => chrome.storage.local.get('savedPages'));
  const recordKeys = savedData.savedPages[origin + '/article']?.map(r => r.kind) || [];
  assert.deepEqual(recordKeys, ['translation', 'summary', 'edit']);
  assert.equal(report.requests.length, 4,
    'Two edit attempts counted (invalid rejected, valid accepted)');
  pass('validated edit applies, persists in chrome.storage.local');

  // 13. REFRESH — records restored, zero new model calls.
  const preReloadReqs = report.requests.length;
  await page.reload();
  await poll(() => shadowText('[role="status"]'), 'panel restored post-reload', 8000);
  await showArticle();
  assert.equal(
    await page.locator('[data-page-agent="translation"]').textContent(),
    TEST_TRANSLATION,
  );
  assert.equal(
    await page.locator('[data-page-agent="summary"]').textContent(),
    TEST_SUMMARY,
  );
  assert.equal(
    await page.locator('#editable').evaluate(el => getComputedStyle(el).color),
    'rgb(17, 34, 51)',
  );
  await assertNoModelExec();
  assert.equal(report.requests.length, preReloadReqs, 'Zero model calls on restore');
  pass('restore replays translation, summary and style with no new model requests');
  await snap('03-restored');

  // 14. UNDO — remove last edit, persist, verify reload.
  await shadowClick(cdpSession, '#undo');
  assert.equal(await page.locator('#editable').getAttribute('style'), null,
    'Undo removed style from page');

  await page.reload();
  await poll(() => shadowText('[role="status"]'), 'panel restored after undo+reload', 8000);
  await showArticle();
  assert.equal(await page.locator('#editable').getAttribute('style'), null,
    'Undo persists across reload');
  const postUndoRecords = await sw.evaluate(() =>
    chrome.storage.local.get('savedPages'));
  assert.equal(postUndoRecords.savedPages[origin + '/article'].length, 2,
    'Storage reflects undo (2 records remain)');
  assert.equal(report.requests.length, preReloadReqs, 'Undo/reload no model calls');
  pass('undo removes last edit from DOM and storage, survives reload');

  // 15. SERVER ERROR — sanitized response.
  failNext = true;
  await shadowClick(cdpSession, '#summary');
  assert.match(await shadowText('[role="status"]'), /API 503/,
    'Raw error displayed for failed request');
  const panelText = await shadowText('section');
  assert.ok(!panelText.includes(FAKE_SECRET), 'Secret not leaked in panel');
  assert.ok(!panelText.includes(FAKE_KEY),    'Key not leaked in panel');
  // Existing translations/summaries preserved.
  assert.equal(await page.locator('[data-page-agent="translation"]').count(), 1);
  assert.equal(await page.locator('[data-page-agent="summary"]').count(), 1);
  const errRecords = await sw.evaluate(() =>
    chrome.storage.local.get('savedPages'));
  assert.equal(errRecords.savedPages[origin + '/article'].length, 2,
    'Failed request did not add partial records');
  pass('API failure displays sanitized error, no raw response/key leak');
  await snap('04-sanitized-error');

  // 16. CLEAR — wipe everything.
  await shadowClick(cdpSession, '#clear');
  await poll(async () =>
    await page.locator('[data-page-agent="translation"], [data-page-agent="summary"]').count() === 0,
    'all modifications cleared',
  );
  const cleared = await sw.evaluate(() => chrome.storage.local.get('savedPages'));
  assert.equal(cleared.savedPages[origin + '/article'], undefined,
    'Page cleared from storage');

  await page.reload();
  await poll(() => shadowText('[role="status"]'), 'empty panel after clear+reload', 8000);
  assert.equal(await page.locator('[data-page-agent="translation"]').count(), 0);
  assert.equal(await page.locator('#editable').getAttribute('style'), null);
  pass('clear deletes storage entries, all modifications absent after reload');

  // 17. DISABLE SITE — unregister content script, no injection on reload.
  await optionsPage.bringToFront();
  const disableBtn = optionsPage.locator('#sites li button');
  assert.ok(await disableBtn.isVisible(), 'Disable button visible');
  await disableBtn.click();

  await poll(
    async () => (await optionsPage.locator('#status').textContent()).includes('已停用'),
    'site disabled',
  );
  const afterDisableSites = await sw.evaluate(() => chrome.storage.local.get('sites'));
  assert.deepEqual(afterDisableSites.sites, []);
  const afterDisableRegs = await sw.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts());
  assert.equal(afterDisableRegs.length, 0, 'Content script unregistered');

  await page.bringToFront();
  await page.reload();
  await page.waitForTimeout(2000); // Extra margin for delayed document_idle.
  assert.equal(await page.locator('[data-page-agent="ui"]').count(), 0,
    'Disabled site does not inject content script');
  assert.equal(report.requests.length, 5, 'Disable flow no model calls');
  pass('disable unregisters content script, reload does not inject or call model');
  await snap('05-disabled');

  // Runtime integration: trusted extension sidepanel document, real content
  // messages, actual DOM events and same-origin document navigation.
  // Open its extension document in a test tab; native toolbar/sidepanel chrome
  // positioning is not simulated by this test.
  const panel=await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.goto(origin+'/task-one');await page.bringToFront();
  const command=(type,extra={})=>panel.evaluate(async ({type,tabId,extra})=>chrome.runtime.sendMessage({type,tabId,...extra}),{type,tabId,extra});
  const started=await command('task:start',{goal:'Fill answer 4 then go to the next page'});assert.equal(started.ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='waiting_confirmation','runtime fills and waits for click confirmation',20000);
  assert.equal(await page.locator('input').inputValue(),'4');
  let beforeNav=(await command('task:get')).value;
  assert.equal(beforeNav.steps,2);assert.equal(beforeNav.prefs.maxSteps,50);
  const firstTaskId=beforeNav.taskId;
  await panel.evaluate(()=>{document.getElementById('instruction').value='Keep the current task, continue to the next page.';document.getElementById('chat').requestSubmit();});
  await poll(async()=>await panel.locator('#instruction').inputValue()==='','successful followup clears composer');
  await poll(async()=>((await command('task:get')).value?.status)==='waiting_confirmation','supplement replans the same task',20000);
  beforeNav=(await command('task:get')).value;assert.equal(beforeNav.taskId,firstTaskId);assert.equal(beforeNav.instructions.length,1);assert.equal(beforeNav.steps,3);
  const approved=await command('task:approve',{taskId:beforeNav.taskId});assert.equal(approved.ok,true);
  await page.waitForURL(origin+'/task-two');
  await poll(async()=>((await command('task:get')).value?.status)==='completed','runtime continues after document replacement',20000);
  const finished=(await command('task:get')).value;assert.equal(finished.taskId,beforeNav.taskId);assert.equal(finished.steps,4);
  await panel.waitForTimeout(300);
  assert.match(await panel.locator('#goal').textContent(),/Fill answer/);
  assert.match(await panel.locator('#progress').textContent(),/已完成/);
  pass('sidepanel document starts task; real page fill, click confirmation, same-origin navigation and completion preserve task ID and budget');
  pass('successful sidepanel followup clears composer and keeps original task ID, goal and cumulative budget');
  report.caveats.push('Sidepanel extension document is exercised in a test tab; native browser sidebar placement and toolbar gesture remain unverified.');
  await panel.screenshot({path:path.join(outputDir,'06-sidepanel.png'),fullPage:true});
  const taskCleared=await command('task:clear');assert.equal(taskCleared.ok,true);assert.equal((await command('task:get')).value,null);
  await optionsPage.locator('#auto-click').check();
  await optionsPage.locator('#agent-config button[type="submit"]').click();
  await poll(async()=>(await optionsPage.locator('#status').textContent()).includes('助手默认设置已保存'),'auto click setting saved');
  await page.goto(origin+'/task-one');await page.bringToFront();
  const automatic=await command('task:start',{goal:'Fill answer 4 then go to the next page automatically'});assert.equal(automatic.ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','automatic click navigates without approval',20000);
  const autoFinished=(await command('task:get')).value;
  assert.equal(autoFinished.prefs.autoClick,true);assert.equal(page.url(),origin+'/task-two');
  assert.equal(autoFinished.events.some(e=>e.text.startsWith('等待确认')),false);
  pass('options enables auto click; real fill and same-origin navigation finish without an approval command');
  await command('task:clear');
  await page.goto(origin+'/judgment');await page.bringToFront();
  const correction=await command('task:submit',{goal:'按指定答案更正：第一题对，第二题错，不提交评分'});assert.equal(correction.ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','grouped judgment corrections verified',20000);
  assert.equal(await page.locator('input[name="q1"][value="yes"]').isChecked(),true);
  assert.equal(await page.locator('input[name="q2"][value="no"]').isChecked(),true);
  const corrected=(await command('task:get')).value;assert.equal(corrected.results.length,2);assert.ok(corrected.results.every(r=>r.verification.verified===true));
  pass('repeated true/false labels map to question groups and real radio corrections verify their checked state');
  await command('task:clear');
  for(const goal of ['Memory smoke save','Memory smoke recall','Memory smoke forget']){
    assert.equal((await command('task:submit',{goal})).ok,true);
    await poll(async()=>((await command('task:get')).value?.status)==='completed','memory tool task completes: '+goal,20000);
    const notes=(await command('task:memory')).value;
    if(goal==='Memory smoke save'){
      assert.equal(notes[0].text,'用户更正：第一题对，第二题错');
      await poll(async()=>(await panel.locator('#memories').textContent()).includes('用户更正'),'memory viewer receives storage updates');
    }
    if(goal==='Memory smoke recall')assert.ok((await command('task:get')).value.results.some(r=>r.action==='memory_read'&&r.result.entries[0].id==='answers'));
    if(goal==='Memory smoke forget')assert.equal(notes.length,0);
  }
  pass('model memory tools save, read across completed tasks, update sidepanel viewer and clear temporary site notes');
  await command('task:clear');
  await page.goto(origin+'/general');await page.bringToFront();
  await sw.evaluate(()=>{
    const send=chrome.tabs.sendMessage.bind(chrome.tabs);let dropped=false;
    chrome.tabs.sendMessage=async(...args)=>{
      const reply=await send(...args);
      if(!dropped&&args[1]?.type==='agent:execute'&&args[1]?.label==='Save'){dropped=true;throw new Error('synthetic lost reply after actual side effect');}
      return reply;
    };
  });
  assert.equal((await command('task:submit',{goal:'General workflow'})).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','general form/filter/save conditions complete',25000);
  const general=(await command('task:get')).value;
  assert.equal(general.completionEvidence,'verified');assert.equal(general.steps,4);
  assert.equal(await page.locator('input[name="name"]').inputValue(),'Alice');
  assert.equal(await page.evaluate(()=>window.filterCount),1);assert.equal(persistedCount,1);
  assert.ok(general.results.some(r=>r.outcome?.code==='PORT_RECONNECTED'));
  assert.ok(general.metrics.verifications>=2);
  pass('general named-field DOM replacement, delayed filtering and scoped save feedback verify without duplicate filter/save after lost reply');
  report.caveats.push('Lost-save-reply test drops a real successful response in a test-only Chrome messaging wrapper; it is not an actual browser process crash.');
  await command('task:clear');
  await page.goto(origin+'/dialog');await page.bringToFront();
  assert.equal((await command('task:submit',{goal:'Dialog recovery'})).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','unknown expectation recovers into confirmation dialog',15000);
  assert.deepEqual(await page.evaluate(()=>[window.openCount,window.confirmCount]),[1,1]);
  const dialogTask=(await command('task:get')).value;assert.equal(dialogTask.completionEvidence,'verified');
  assert.ok(dialogTask.results.some(r=>r.outcome?.code==='CONDITION_TIMEOUT'&&r.outcome.recovery==='replan'));
  pass('unknown click expectation automatically rereads a late dialog beyond 120 background controls and confirms once without user continuation');
  await command('task:clear');
  await page.goto(origin+'/general');await page.bringToFront();
  assert.equal((await command('task:submit',{goal:'General wait'})).ok,true);
  await poll(async()=>!!((await command('task:get')).value?.check),'wait checkpoint persisted',10000);
  const beforeRestart=(await command('task:get')).value;
  const lifecycle=await context.newCDPSession(panel);
  await lifecycle.send('ServiceWorker.enable');await lifecycle.send('ServiceWorker.stopAllWorkers');
  const afterRestart=(await command('task:get')).value;
  assert.equal(afterRestart.taskId,beforeRestart.taskId);assert.equal(afterRestart.check.deadline,beforeRestart.check.deadline);
  await lifecycle.detach();
  await poll(async()=>((await command('task:get')).value?.status)==='completed','explicit wait tool observes delayed content',20000);
  const waited=(await command('task:get')).value;assert.equal(waited.steps,2);assert.ok(waited.metrics.verifications>=2);
  pass('explicit wait polls conditions without consuming extra model rounds and completion checks evidence');
  pass('actual worker termination during condition wait preserves task identity and deadline, resumes without replaying an action');
  await command('task:clear');
  assert.equal((await command('task:submit',{goal:'General unmet completion'})).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='paused','unmet completion is paused',10000);
  assert.equal((await command('task:get')).value.lastOutcome.status,'not_satisfied');
  assert.equal(persistedCount,1);
  pass('unrelated success text cannot satisfy scoped completion and incomplete task is never marked completed');
  await panel.screenshot({path:path.join(outputDir,'07-verification.png'),fullPage:true});
  const contextTask=(await command('task:get')).value;
  contextTask.goal='Context smoke';contextTask.status='stopped';contextTask.phase='observe';contextTask.steps=0;contextTask.completionChecks=null;contextTask.check=null;contextTask.pending=null;
  contextTask.instructions=[{text:'User correction preserved',time:Date.now()}];
  contextTask.results=Array.from({length:13},(_,i)=>({action:'observe',result:'Earlier observation '+i+(i<7?'x'.repeat(25000):'')}));
  contextTask.lastOutcome={version:2,status:'unknown',code:'UNKNOWN_SAVE',dispatch:'sent',scope:'dispatch'};
  await panel.evaluate(async task=>chrome.storage.session.set({['task:'+task.tabId]:task}),contextTask);
  assert.equal((await command('task:resume')).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','context summary saved and passed to execution model',10000);
  const compacted=(await command('task:get')).value;assert.equal(compacted.steps,2);assert.equal(compacted.contextSummary.through,7);assert.equal(compacted.contextArchive[0].results.length,7);
  await poll(async()=>await panel.locator('#context-summary').textContent().then(t=>t.includes('do not replay')),'summary visible in panel');
  pass('real extension compacts older results via separate model request, preserves user correction and uncertain outcome, and shows summary');
  await panel.screenshot({path:path.join(outputDir,'08-context-summary.png'),fullPage:true});
  await command('task:clear');
  // Real IndexedDB transactions: isolation, CAS, rollback and reconnect.
  const dbChecks=await panel.evaluate(async()=>{
    await import(chrome.runtime.getURL('site-memory.js'));
    const service=PageAgentSiteMemory.createSiteMemory({name:'page-agent-memory-smoke'}),origin='https://one.test';
    const first=await service.change(origin,{action:'write',id:'first',text:'original',expectedVersion:0});
    const both=await Promise.allSettled([service.change(origin,{action:'write',id:'a',text:'A',expectedVersion:1}),service.change(origin,{action:'clear',expectedVersion:1})]);
    const successes=both.filter(x=>x.status==='fulfilled').length;const conflict=both.find(x=>x.status==='rejected')?.reason.code;
    let current=await service.read(origin);await service.change(origin,{action:'clear',expectedVersion:current.version});current=await service.read(origin);
    for(let i=0;i<32;i++)current=await service.change(origin,{action:'write',id:'note'+i,text:'note',expectedVersion:current.version});
    let capacityRejected=false;try{await service.change(origin,{action:'write',id:'extra',text:'excess',expectedVersion:current.version});}catch{capacityRejected=true;}
    const after=await service.read(origin),other=await service.read('https://sub.one.test');
    const controller=new AbortController();controller.abort();let abortRejected=false;try{await service.change(origin,{action:'clear',expectedVersion:after.version,signal:controller.signal});}catch{abortRejected=true;}
    await service.close();const reopened=PageAgentSiteMemory.createSiteMemory({name:'page-agent-memory-smoke'});const retained=await reopened.read(origin);await reopened.close();
    return {successes,conflict,capacityRejected,count:after.notes.length,unchangedVersion:current.version===after.version,isolated:other.notes.length===0,abortRejected,reopenedCount:retained.notes.length};
  });
  assert.deepEqual(dbChecks,{successes:1,conflict:'MEMORY_CONFLICT',capacityRejected:true,count:32,unchangedVersion:true,isolated:true,abortRejected:true,reopenedCount:32});
  pass('real IndexedDB transactions isolate origins, reject stale writes and capacity overflow atomically, cancel aborted writes and reopen persisted notes');
  assert.equal((await command('task:submit',{goal:'Durable smoke save'})).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','model writes durable website note',10000);
  const durable=(await command('task:site-memory')).value;assert.equal(durable.notes[0].id,'workflow');
  await command('task:clear');
  assert.equal((await command('task:submit',{goal:'Durable smoke recall'})).ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','model recalls durable note across tasks',10000);
  assert.ok((await command('task:get')).value.results.some(r=>r.action==='site_memory_read'&&r.result.note.text.includes('Verified workflow')));
  await panel.locator('#site-memory-panel').evaluate(el=>el.open=true);
  await panel.locator('#site-memory-refresh').click();
  await poll(async()=>await panel.locator('#site-memories').textContent().then(t=>t.includes('Verified workflow')),'durable note viewer');
  await panel.locator('#site-memory-id').fill('workflow');await panel.locator('#site-memory-text').fill('User corrected workflow');await panel.locator('#site-memory-save').click();
  await poll(async()=>((await command('task:site-memory')).value?.notes[0]?.text)==='User corrected workflow','manual durable edit saved',10000);
  await panel.locator('#site-memory-refresh').click();
  await poll(async()=>await panel.locator('#site-memories').textContent().then(t=>t.includes('User corrected')),'updated durable note viewer');
  const downloadEvent=panel.waitForEvent('download');await panel.locator('#site-memory-export').click();const download=await downloadEvent;
  const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(exported.origin,origin);assert.equal(exported.notes[0].text,'User corrected workflow');
  await panel.locator('#site-memory-id').fill('temporary');await panel.locator('#site-memory-text').fill('discard this note');await panel.locator('#site-memory-save').click();
  await poll(async()=>((await command('task:site-memory')).value?.notes.length)===2,'second durable note saved');
  await panel.locator('#site-memory-refresh').click();
  await panel.locator('#site-memories > div').filter({hasText:'temporary'}).getByRole('button',{name:'删除',exact:true}).click();
  await poll(async()=>((await command('task:site-memory')).value?.notes.length)===1,'durable note deleted in sidepanel');
  await panel.screenshot({path:path.join(outputDir,'09-site-memory.png'),fullPage:true});
  pass('model saves and reads durable notes across tasks with index-only defaults; sidepanel edits and exports real JSON');
  await command('task:clear');await panel.close();
  await context.close();context=await chromium.launchPersistentContext(profileDir,launchOptions);
  const restartedPanel=await context.newPage();await restartedPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const retained=await restartedPanel.evaluate(async origin=>{
    await import(chrome.runtime.getURL('site-memory.js'));const store=PageAgentSiteMemory.createSiteMemory();const value=await store.read(origin);await store.close();return value;
  },origin);
  assert.equal(retained.notes[0].text,'User corrected workflow');
  pass('durable website notes survive a real browser process close and relaunch using the same extension profile');
  await restartedPanel.close();

  // ── Finalize report ──────────────────────────────────────────────────
  report.status = 'passed';
  report.requestCount = report.requests.length;
  report.assertionCount = report.assertions.length;
  report.serverErrors = serverErrors;
  report.totalAssertions = report.assertions.length;
})()
.catch(async err => {
  report.status = 'failed';
  report.error = { message: err.message, stack: err.stack };
  console.error(err);
  try { await snap('failure'); } catch {}
  try {
    if (optionsPage && !optionsPage.isClosed())
      await optionsPage.screenshot({ path: path.join(outputDir, 'failure-options.png'), fullPage: true });
  } catch (e) { report.cleanupError = e.message; }
  report.requestCount = report.requests.length;
  report.assertionCount = report.assertions.length;
  report.serverErrors = serverErrors;
  report.totalAssertions = report.assertions.length;
  process.exitCode = 1;
})
.finally(async () => {
  // Cleanup.
  try { if (context) await context.close(); }
  catch (e) { report.cleanupError = e.message; if (report.status !== 'failed') { report.status = 'failed'; process.exitCode = 1; } }
  try { if(server){server.closeAllConnections?.(); await new Promise(ok => server.close(ok));} } catch {}
  try { await fs.rm(fixtureBase ?? '', { recursive: true, force: true }); } catch {}

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({
    status: report.status,
    sourceSha: report.sourceSha,
    assertions: report.assertionCount,
    requests: report.requestCount,
    caveats: report.caveats,
  }, null, 2));
});
