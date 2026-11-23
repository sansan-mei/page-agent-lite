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
const outputDir  = process.env.PAGE_AGENT_SMOKE_OUTPUT ? path.resolve(process.env.PAGE_AGENT_SMOKE_OUTPUT) : path.join(root, 'tests', 'browser-output');

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

const COVERAGE_HTML=`<!doctype html><html><body style="margin:0"><div id="rows" aria-label="Scrollable rows" style="height:180px;width:300px;overflow:auto">${Array.from({length:135},(_,i)=>`<button style="display:block;height:30px;width:600px">Row ${i}</button>`).join('')}<div role="combobox" aria-label="Choose city" aria-expanded="false" onpointerdown="window.pointerReady=true" onmousedown="window.mouseReady=true" onclick="if(window.pointerReady&&window.mouseReady){this.setAttribute('aria-expanded','true');document.getElementById('feedback').textContent='Opened'}" style="height:40px">Choose city</div></div><section id="feedback" aria-label="Interaction feedback">Waiting</section><button id="covered" style="position:fixed;left:400px;top:30px;width:100px;height:40px" onclick="window.coveredClicks=(window.coveredClicks||0)+1">Covered save</button><div id="cover" style="position:fixed;left:390px;top:20px;width:130px;height:70px;background:gray"></div></body></html>`;

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
      if (req.method === 'GET' && ['/article','/task-one','/task-two','/judgment','/general','/dialog','/coverage'].includes(req.url)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        });
        res.end(req.url==='/coverage'?COVERAGE_HTML:req.url==='/dialog'?DIALOG_HTML:req.url==='/general'?GENERAL_HTML:req.url==='/judgment'?JUDGMENT_HTML:req.url==='/task-one'?'<html><body><h1>Task page one</h1><input aria-label="Answer" type="text"><a href="/task-two">Next page</a></body></html>':req.url==='/task-two'?'<html><body><h1>Task page two complete</h1></body></html>':FIXTURE_HTML); return;
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
        if(data.goal.startsWith('Global smoke')){
          let plan={reply:'global done',action:'done'};
          if(data.goal==='Global smoke save'&&!data.globalMemoryIndex.some(n=>n.id==='format'))plan={reply:'save preference',action:'global_memory_write',id:'format',value:'User preference: Chinese tables'};
          if(data.goal==='Global smoke recall'&&!data.results.some(r=>r.action==='global_memory_read')){
            assert.ok(data.globalMemoryIndex.some(n=>n.id==='format'));assert.ok(!input.includes('User preference: Chinese tables'));plan={reply:'read preference',action:'global_memory_read',id:'format'};
          }
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
        if(data.goal==='Navigate smoke'){
          const target=new URL('/task-two',data.page.url).href;
          const plan=data.page.url===target?{reply:'URL verified',action:'done',expected:[{kind:'url_equals',value:target}]}:{reply:'Navigate within current origin',action:'navigate',value:target};
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
      files: ['tool-protocol.js', 'conditions.js', 'core.js', 'content.js'],
      world: 'ISOLATED',
    }),
    tabId,
  );

  // Exercise production tools in the real isolated world on a clipped long list.
  const coveragePage=await context.newPage();await coveragePage.goto(origin+'/coverage');
  const coverageId=await sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/coverage');
  await sw.evaluate(id=>chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},files:['tool-protocol.js','conditions.js','core.js','content.js'],world:'ISOLATED'}),coverageId);
  const toolCall=message=>sw.evaluate(({id,message})=>chrome.tabs.sendMessage(id,message,{frameId:0}),{id:coverageId,message});
  let coverage=(await toolCall({type:'agent:observe'})).value;
  assert.equal(coverage.page.elements.length,120);assert.equal(coverage.page.coverage.elementsComplete,false);
  assert.ok(!coverage.page.elements.some(e=>e.label==='Choose city'));
  const rows=coverage.page.elements.find(e=>e.label==='Scrollable rows');assert.ok(rows.scroll.maxY>3000);
  for(const direction of ['right','left']){
    coverage=(await toolCall({type:'agent:observe'})).value;
    const container=coverage.page.elements.find(e=>e.label==='Scrollable rows');
    const horizontal=await toolCall({type:'agent:execute',snapshotId:coverage.snapshotId,documentId:coverage.documentId,url:coverage.url,plan:{reply:'Read columns',action:'scroll',id:container.id,value:direction}});
    assert.equal(horizontal.ok,true);assert.equal(horizontal.value.observed.axis,'x');
    assert.ok(direction==='right'?horizontal.value.observed.delta>0:horizontal.value.observed.delta<0);
  }
  pass('horizontal container scroll moves both directions and reports the correct axis');
  let scrolled;
  for(let i=0;i<7;i++){
    coverage=(await toolCall({type:'agent:observe'})).value;
    const container=coverage.page.elements.find(e=>e.label==='Scrollable rows');
    scrolled=await toolCall({type:'agent:execute',snapshotId:coverage.snapshotId,documentId:coverage.documentId,url:coverage.url,plan:{reply:'Read more rows',action:'scroll',id:container.id,value:'down'}});
    assert.equal(scrolled.ok,true);
  }
  assert.equal(scrolled.value.observed.atEnd,true);assert.equal(await coveragePage.evaluate(()=>window.scrollY),0);
  pass('container scroll reaches the list boundary, reports actual movement and leaves the document in place');
  coverage=(await toolCall({type:'agent:observe'})).value;
  const combo=coverage.page.elements.find(e=>e.label==='Choose city');assert.ok(combo?.inViewport);assert.equal(combo.expanded,false);
  assert.equal(coverage.page.coverage.elementsComplete,false);
  pass('viewport prioritization exposes a clipped control beyond 135 earlier rows without claiming complete coverage');
  const clicked=await toolCall({type:'agent:execute',snapshotId:coverage.snapshotId,documentId:coverage.documentId,url:coverage.url,plan:{reply:'Open city',action:'click',id:combo.id}});
  assert.equal(clicked.ok,true);assert.equal(await coveragePage.locator('#feedback').textContent(),'Opened');
  pass('pointerdown and mousedown dependent custom control receives the click sequence and opens');
  coverage=(await toolCall({type:'agent:observe'})).value;
  const blocked=await toolCall({type:'agent:execute',snapshotId:coverage.snapshotId,documentId:coverage.documentId,url:coverage.url,plan:{reply:'Save',action:'click',id:coverage.page.elements.find(e=>e.label==='Covered save').id}});
  assert.equal(blocked.code,'TARGET_BLOCKED');assert.equal(blocked.result.dispatch,'not_sent');assert.equal(await coveragePage.evaluate(()=>window.coveredClicks||0),0);
  pass('overlay blocks the underlying save before dispatch and reports TARGET_BLOCKED with zero save clicks');

  await coveragePage.evaluate(()=>{
    const n=document.createElement('button');n.textContent='Changing target';n.style.cssText='position:fixed;left:10px;top:300px';n.addEventListener('pointerdown',()=>n.remove());n.addEventListener('click',()=>window.changingClicks=(window.changingClicks||0)+1);document.body.append(n);
  });
  coverage=(await toolCall({type:'agent:observe'})).value;
  const changing=await toolCall({type:'agent:execute',snapshotId:coverage.snapshotId,documentId:coverage.documentId,url:coverage.url,plan:{reply:'Open',action:'click',id:coverage.page.elements.find(e=>e.label==='Changing target').id}});
  assert.equal(changing.code,'TARGET_CHANGED');assert.equal(changing.result.dispatch,'unknown');assert.equal(await coveragePage.evaluate(()=>window.changingClicks||0),0);
  pass('pointer handler removing a target prevents the final click and preserves unknown side-effect status');

  assert.equal(await page.locator('[data-page-agent="ui"]').count(),0);
  assert.equal(await optionsPage.locator('#article-settings, #article, #auto-click, #auto-fill').count(),0);
  assert.equal(await optionsPage.locator('#context-tokens').inputValue(),'100000');
  await optionsPage.locator('#agent-config button[type="submit"]').click();
  await poll(async()=>(await optionsPage.locator('#status').textContent()).includes('助手默认设置已保存'),'budget preferences saved without execution toggles');
  pass('settings default to 100000 tokens with no automation switches or article tools');

  // Recent PA1/PA3 changes through real isolated-world messaging.
  await coveragePage.evaluate(()=>{
    const host=document.createElement('article');
    host.innerHTML=Array.from({length:55},(_,i)=>`<section aria-label="PA result ${i}">${'x'.repeat(1000)}</section>`).join('')+'<div contenteditable="true" aria-label="PA editor">original</div>';
    document.body.append(host);
  });
  const late=(await toolCall({type:'agent:observe',textOffset:{regionQuery:'PA result 54'}})).value;
  assert.equal(late.page.regions.length,1);assert.equal(late.page.coverage.regionsComplete,false);
  const bound=await sw.evaluate(({id})=>chrome.tabs.sendMessage(id,{type:'agent:verify',expected:[{kind:'text_present',target:{category:'region',label:'PA result 54'},value:'Confirmed'}]},{frameId:0}),{id:coverageId});
  assert.equal(bound.value.status,'not_satisfied');
  await coveragePage.locator('[aria-label="PA result 54"]').evaluate(n=>n.textContent='Confirmed');
  const verified=await toolCall({type:'agent:verify',expected:[{kind:'text_present',target:{category:'region',label:'PA result 54'},value:'Confirmed'}]});
  assert.equal(verified.value.status,'success');
  const editable=(await toolCall({type:'agent:observe',textOffset:{query:'PA editor'}})).value;
  const text='<b>literal text</b>\nsecond line';
  const written=await toolCall({type:'agent:execute',snapshotId:editable.snapshotId,documentId:editable.documentId,url:editable.url,plan:{reply:'Write text',action:'fill',id:editable.page.elements[0].id,value:text}});
  assert.equal(written.value.status,'success');assert.equal(await coveragePage.locator('[aria-label="PA editor"]').textContent(),text);assert.equal(await coveragePage.locator('[aria-label="PA editor"] b').count(),0);
  pass('real MV3 isolated-world tools locate and verify a late region and fill plain editable content without interpreting HTML');

  await coveragePage.close();

  // Runtime integration: trusted extension sidepanel document, real content
  // messages, actual DOM events and same-origin document navigation.
  // Open its extension document in a test tab; native toolbar/sidepanel chrome
  // positioning is not simulated by this test.
  const panel=await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.goto(origin+'/task-one');await page.bringToFront();
  const command=(type,extra={})=>panel.evaluate(async ({type,tabId,extra})=>chrome.runtime.sendMessage({type,tabId,...extra}),{type,tabId,extra});
  const started=await command('task:start',{goal:'Fill answer 4 then go to the next page'});assert.equal(started.ok,true);
  const rootState=await sw.evaluate(async({tabId,taskId})=>{const all=await chrome.storage.session.get(null);return {binding:all.taskRegistry.bindings[tabId],root:all['taskRoot:'+taskId],legacy:all['task:'+tabId]};},{tabId,taskId:started.value.taskId});
  assert.equal(rootState.legacy,undefined);assert.equal(rootState.root.version,3);assert.equal(rootState.binding.taskId,started.value.taskId);assert.equal(rootState.root.scopeRevision,rootState.binding.revision);assert.deepEqual(rootState.root.allowedOrigins,[origin]);assert.equal(rootState.root.members.length,1);
  pass('real session storage publishes one authoritative task root and matching single-member registry without widening origin scope');

  await poll(async()=>((await command('task:get')).value?.status)==='completed','automatic fill and navigation complete',20000);
  const finished=(await command('task:get')).value;
  assert.equal(finished.taskId,started.value.taskId);assert.equal(finished.steps,3);assert.equal(finished.prefs.maxSteps,50);
  assert.equal(page.url(),origin+'/task-two');assert.equal(finished.events.some(e=>e.text.startsWith('等待确认')),false);
  await panel.waitForTimeout(300);
  assert.match(await panel.locator('#progress').textContent(),/已完成/);
  pass('default automatic fill and click navigate without approval and preserve task ID and cumulative budget');
  report.caveats.push('Sidepanel extension document is exercised in a test tab; native browser sidebar placement and toolbar gesture remain unverified.');
  await panel.screenshot({path:path.join(outputDir,'06-sidepanel.png'),fullPage:true});
  const taskCleared=await command('task:clear');assert.equal(taskCleared.ok,true);assert.equal((await command('task:get')).value,null);
  await page.goto(origin+'/task-one');await page.bringToFront();
  const automatic=await command('task:start',{goal:'Fill answer 4 then go to the next page automatically'});assert.equal(automatic.ok,true);
  const handoff=await command('task:takeover');assert.equal(handoff.ok,true);assert.equal(handoff.value.reason,'user_takeover');
  const budgetBefore=handoff.value.steps,identityBefore=handoff.value.taskId;
  await page.locator('[aria-label="Answer"]').fill('4');
  const continued=await command('task:resume');assert.equal(continued.ok,true);assert.equal(continued.value.taskId,identityBefore);assert.equal(continued.value.steps,budgetBefore);

  await poll(async()=>((await command('task:get')).value?.status)==='completed','automatic click navigates without approval',20000);
  const autoFinished=(await command('task:get')).value;
  assert.equal(autoFinished.prefs.autoClick,undefined);assert.equal(page.url(),origin+'/task-two');
  assert.equal(autoFinished.events.some(e=>e.text.startsWith('等待确认')),false);
  pass('real fill and same-origin navigation finish with built-in automation and no approval command');
  assert.equal(autoFinished.taskId,identityBefore);assert.equal(autoFinished.results.slice(handoff.value.results.length).filter(r=>r.action==='fill').length,0);
  pass('trusted user takeover pauses the real runtime, retains budget and task ID, and fresh observation respects the manually filled value');
  await command('task:clear');
  await page.goto(origin+'/task-one');await page.bringToFront();
  const navigationTask=await command('task:start',{goal:'Navigate smoke'});assert.equal(navigationTask.ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','trusted same-origin navigation completed',20000);
  const navigationResult=(await command('task:get')).value;
  assert.equal(page.url(),origin+'/task-two');assert.equal(navigationResult.taskId,navigationTask.value.taskId);assert.equal(navigationResult.results.filter(r=>r.action==='navigate').length,1);assert.ok(navigationResult.steps>=2);
  pass('trusted navigate consumes source snapshot, performs one same-origin tab update, preserves task budget and verifies the destination before completion');
  const diagnosticReport=await command('task:diagnostics',{taskId:navigationResult.taskId});assert.equal(diagnosticReport.ok,true);assert.equal(diagnosticReport.value.schema,'page-agent-diagnostics');assert.equal(diagnosticReport.value.outcomes.actions.navigate,1);assert.equal(diagnosticReport.value.steps,navigationResult.steps);assert.ok(diagnosticReport.value.timings.model.completed>=2);assert.ok(!JSON.stringify(diagnosticReport.value).includes(origin));assert.equal(diagnosticReport.value.taskId,undefined);
  pass('trusted statistics export exposes only fixed task counters, enum outcomes and reported timing without origin or task identifiers');

  await command('task:clear');
  await page.goto(origin+'/judgment');await page.bringToFront();
  const correction=await command('task:submit',{goal:'按指定答案更正：第一题对，第二题错，不提交评分'});assert.equal(correction.ok,true);
  await poll(async()=>((await command('task:get')).value?.status)==='completed','grouped judgment corrections verified',20000);
  assert.equal(await page.locator('input[name="q1"][value="yes"]').isChecked(),true);
  assert.equal(await page.locator('input[name="q2"][value="no"]').isChecked(),true);
  const corrected=(await command('task:get')).value;assert.equal(corrected.results.length,2);assert.ok(corrected.results.every(r=>r.verification.verified===true));
  await optionsPage.locator('#tabs-refresh').click();
  await optionsPage.locator('#managed-tab').selectOption(String(tabId));
  pass('repeated true/false labels map to question groups and real radio corrections verify their checked state');
  await command('task:clear');
  for(const goal of ['Memory smoke save','Memory smoke recall','Memory smoke forget']){
    assert.equal((await command('task:submit',{goal})).ok,true);
    await poll(async()=>((await command('task:get')).value?.status)==='completed','memory tool task completes: '+goal,20000);
    const notes=(await command('task:memory')).value;
    if(goal==='Memory smoke save'){
      assert.equal(notes[0].text,'用户更正：第一题对，第二题错');
      await poll(async()=>(await optionsPage.locator('#memories').textContent()).includes('用户更正'),'memory viewer receives storage updates');
    }
    if(goal==='Memory smoke recall')assert.ok((await command('task:get')).value.results.some(r=>r.action==='memory_read'&&r.result.entries[0].id==='answers'));
    if(goal==='Memory smoke forget')assert.equal(notes.length,0);
  }
  pass('model memory tools save, read across completed tasks, update settings viewer and clear temporary site notes');
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
  const taskAlarms=await panel.evaluate(async()=> (await chrome.alarms.getAll()).map(alarm=>alarm.name));
  assert.ok(taskAlarms.includes('task-id:'+beforeRestart.taskId));assert.ok(!taskAlarms.includes('task:'+tabId));
  pass('worker recovery alarm is keyed by task identity instead of the mutable tab association');

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
  contextTask.results=Array.from({length:13},(_,i)=>({action:'observe',result:'Earlier observation '+i+(i<7?'x'.repeat(90000):'')}));
  contextTask.lastOutcome={version:2,status:'unknown',code:'UNKNOWN_SAVE',dispatch:'sent',scope:'dispatch'};
  await panel.evaluate(async task=>{await import(chrome.runtime.getURL('task-store.js'));await PageAgentTaskStore.createTaskStore(chrome).set(task.tabId,task);},contextTask);
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
  await optionsPage.locator('#tabs-refresh').click();
  await optionsPage.locator('#managed-tab').selectOption(String(tabId));
  await optionsPage.locator('#site-memory-panel').evaluate(el=>el.open=true);
  await optionsPage.locator('#site-memory-refresh').click();
  await poll(async()=>await optionsPage.locator('#site-memories').textContent().then(t=>t.includes('Verified workflow')),'durable note viewer');
  await optionsPage.locator('#site-memory-id').fill('workflow');await optionsPage.locator('#site-memory-text').fill('User corrected workflow');await optionsPage.locator('#site-memory-save').click();
  await poll(async()=>((await command('task:site-memory')).value?.notes[0]?.text)==='User corrected workflow','manual durable edit saved',10000);
  await optionsPage.locator('#site-memory-refresh').click();
  await poll(async()=>await optionsPage.locator('#site-memories').textContent().then(t=>t.includes('User corrected')),'updated durable note viewer');
  const downloadEvent=optionsPage.waitForEvent('download');await optionsPage.locator('#site-memory-export').click();const download=await downloadEvent;
  const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(exported.origin,origin);assert.equal(exported.notes[0].text,'User corrected workflow');
  await optionsPage.locator('#site-memory-id').fill('temporary');await optionsPage.locator('#site-memory-text').fill('discard this note');await optionsPage.locator('#site-memory-save').click();
  await poll(async()=>((await command('task:site-memory')).value?.notes.length)===2,'second durable note saved');
  await optionsPage.locator('#site-memory-refresh').click();
  await optionsPage.locator('#site-memories > div').filter({hasText:'temporary'}).getByRole('button',{name:'删除',exact:true}).click();
  await poll(async()=>((await command('task:site-memory')).value?.notes.length)===1,'durable note deleted in settings');
  await optionsPage.screenshot({path:path.join(outputDir,'09-site-memory.png'),fullPage:true});
  pass('model saves and reads durable notes across tasks with index-only defaults; settings edits and exports real JSON');
  const globalDbChecks=await panel.evaluate(async()=>{
    const name='page-agent-upgrade-smoke';
    await new Promise((resolve,reject)=>{const req=indexedDB.open(name,1);req.onupgradeneeded=()=>req.result.createObjectStore('sites',{keyPath:'origin'});req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('sites','readwrite');tx.objectStore('sites').put({origin:'https://one.test',version:3,notes:[{id:'site',text:'retained'}]});tx.oncomplete=()=>{db.close();resolve();};};});
    const site=PageAgentSiteMemory.createSiteMemory({name}),global=PageAgentSiteMemory.createSiteMemory({name,scope:'global'});
    const before=await site.read('https://one.test');let current=await global.change(null,{action:'write',id:'pref',text:'tables',expectedVersion:0});
    const both=await Promise.allSettled([global.change(null,{action:'delete',id:'pref',expectedVersion:1}),global.change(null,{action:'clear',expectedVersion:1})]);
    current=await global.read(null);for(let i=0;i<32;i++)current=await global.change(null,{action:'write',id:'note'+i,text:'note',expectedVersion:current.version});
    let capacity=false;try{await global.change(null,{action:'write',id:'extra',text:'excess',expectedVersion:current.version});}catch{capacity=true;}
    const signal=AbortSignal.abort();let cancelled=false;try{await global.change(null,{action:'clear',expectedVersion:current.version,signal});}catch{cancelled=true;}
    const after=await global.read(null),retained=await site.read('https://one.test');await site.close();await global.close();
    return {site:before.notes[0].text,siteVersion:retained.version,successes:both.filter(x=>x.status==='fulfilled').length,conflict:both.find(x=>x.status==='rejected').reason.code,capacity,cancelled,count:after.notes.length,scope:after.scope};
  });
  assert.deepEqual(globalDbChecks,{site:'retained',siteVersion:3,successes:1,conflict:'MEMORY_CONFLICT',capacity:true,cancelled:true,count:32,scope:'global'});
  pass('database v1 upgrades without losing website notes; global store isolates scope, CAS, capacity rollback and cancelled writes');
  await command('task:clear');await command('task:submit',{goal:'Global smoke save'});
  await poll(async()=>((await command('task:get')).value?.status)==='completed','model global write',10000);
  await command('task:clear');await command('task:submit',{goal:'Global smoke recall'});
  await poll(async()=>((await command('task:get')).value?.status)==='completed','model global read',10000);
  assert.ok((await command('task:get')).value.results.some(r=>r.action==='global_memory_read'&&r.result.note.text==='User preference: Chinese tables'));
  await optionsPage.locator('#global-memory-panel').evaluate(el=>el.open=true);await optionsPage.locator('#global-memory-refresh').click();
  await poll(async()=>(await optionsPage.locator('#global-memories').textContent()).includes('Chinese tables'),'global viewer');
  await optionsPage.locator('#global-memories > div').filter({hasText:'format'}).getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await optionsPage.locator('#global-memory-text').inputValue(),'User preference: Chinese tables');
  await optionsPage.locator('#global-memory-text').fill('Edited global preference');await optionsPage.locator('#global-memory-save').click();
  await poll(async()=>((await command('task:global-memory')).value?.notes[0]?.text)==='Edited global preference','global edit saved');
  await poll(async()=>optionsPage.locator('#global-memory-export').isEnabled(),'global export enabled');
  const globalDownloadEvent=optionsPage.waitForEvent('download');await optionsPage.locator('#global-memory-export').click();const globalDownload=await globalDownloadEvent;
  const globalStream=await globalDownload.createReadStream(),globalChunks=[];for await(const chunk of globalStream)globalChunks.push(chunk);
  const globalExport=JSON.parse(Buffer.concat(globalChunks).toString());assert.equal(globalExport.scope,'global');assert.equal(globalExport.notes[0].text,'Edited global preference');
  await optionsPage.locator('#global-memories > div').getByRole('button',{name:'删除',exact:true}).click();await poll(async()=>((await command('task:global-memory')).value?.notes.length)===0,'global delete');
  await poll(async()=>optionsPage.locator('#global-memory-save').isEnabled(),'global save enabled');
  await optionsPage.locator('#global-memory-id').fill('retained');await optionsPage.locator('#global-memory-text').fill('Before clear');await optionsPage.locator('#global-memory-save').click();
  await poll(async()=>((await command('task:global-memory')).value?.notes.length)===1,'global recreated');await poll(async()=>optionsPage.locator('#global-memory-clear').isEnabled(),'global clear enabled');
  await optionsPage.locator('#global-memory-clear').click();await poll(async()=>((await command('task:global-memory')).value?.notes.length)===0,'global clear');await poll(async()=>optionsPage.locator('#global-memory-save').isEnabled(),'global ready');
  await optionsPage.locator('#global-memory-id').fill('retained');await optionsPage.locator('#global-memory-text').fill('Global survives restart');await optionsPage.locator('#global-memory-save').click();
  await poll(async()=>((await command('task:global-memory')).value?.notes[0]?.text)==='Global survives restart','global persistence seed');
  assert.equal((await command('task:site-memory')).value.notes[0].text,'User corrected workflow');
  await optionsPage.screenshot({path:path.join(outputDir,'10-global-memory.png'),fullPage:true});
  pass('global model read/write and settings view, edit, delete, clear and JSON export preserve separate website notes');
  await command('task:clear');await panel.close();
  await context.close();context=await chromium.launchPersistentContext(profileDir,launchOptions);
  const restartedPanel=await context.newPage();await restartedPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const retained=await restartedPanel.evaluate(async origin=>{
    await import(chrome.runtime.getURL('site-memory.js'));const store=PageAgentSiteMemory.createSiteMemory();const value=await store.read(origin);await store.close();return value;
  },origin);
  assert.equal(retained.notes[0].text,'User corrected workflow');
  const globalRetained=await restartedPanel.evaluate(async()=>{const store=PageAgentSiteMemory.createSiteMemory({scope:'global'});const data=await store.read(null);await store.close();return data;});
  assert.equal(globalRetained.notes[0].text,'Global survives restart');
  pass('global notes survive browser process relaunch independently of website notes');
  pass('durable website notes survive a real browser process close and relaunch using the same extension profile');
  const conversationCheck=await restartedPanel.evaluate(async origin=>{
    await import(chrome.runtime.getURL('task-store.js'));
    const store=PageAgentTaskStore.createTaskStore(chrome);
    const tab=await chrome.tabs.create({url:origin+'/article',active:false});
    for(let attempt=0;attempt<100;attempt++){const ready=await chrome.tabs.get(tab.id);if(ready.status==='complete'&&ready.url===origin+'/article')break;if(attempt===99)throw new Error('History fixture tab did not finish loading');await new Promise(resolve=>setTimeout(resolve,50));}
    const first={taskId:'history-first',origin,tabId:tab.id,goal:'First isolated conversation',status:'ended',phase:'idle',steps:1,prefs:{maxSteps:50},updatedAt:1,events:[{time:1,text:'First only'}],results:[],token:'not-for-history'};
    await store.set(tab.id,first);await store.set(tab.id,{...first,taskId:'history-second',goal:'Second isolated conversation',updatedAt:2,events:[]});
    const list=await chrome.runtime.sendMessage({type:'task:history',tabId:tab.id});
    const detail=await chrome.runtime.sendMessage({type:'task:history-get',tabId:tab.id,taskId:first.taskId});
    const current=await store.get(tab.id);
    const other=await chrome.tabs.create({url:origin+'/article',active:false});
    await store.set(other.id,{...first,tabId:other.id,taskId:'history-independent',status:'paused'});
    const independent=await store.get(other.id);
    await store.set(tab.id,{...current,status:'paused',phase:'executing',steps:37,pending:{plan:{action:'click'}},check:{kind:'action',deadline:12345,dispatch:'unknown'}});
    const beforeScope=await store.get(tab.id),extraOrigin='http://127.0.0.1:1';
    const scope=await chrome.runtime.sendMessage({type:'task:scope-change',tabId:tab.id,taskId:beforeScope.taskId,expectedRevision:beforeScope.scopeRevision,action:'add',origin:extraOrigin});
    if(!scope.ok)throw new Error('Scope fixture add failed: '+scope.error);
    const removedScope=await chrome.runtime.sendMessage({type:'task:scope-change',tabId:tab.id,taskId:beforeScope.taskId,expectedRevision:scope.value.scopeRevision,action:'remove',origin});
    const deniedResume=await chrome.runtime.sendMessage({type:'task:resume',tabId:tab.id});
    const restoredScope=await chrome.runtime.sendMessage({type:'task:scope-change',tabId:tab.id,taskId:beforeScope.taskId,expectedRevision:removedScope.value.scopeRevision,action:'add',origin});
    await store.setMemory(tab.id,origin,[{text:'Temporary close fixture'}]);
    await chrome.alarms.create('task-id:history-second',{delayInMinutes:1});
    await chrome.tabs.remove(tab.id);
    for(let attempt=0;attempt<100;attempt++){const state=await chrome.storage.session.get('taskRegistry');if(!state.taskRegistry.bindings[tab.id]&&!state.taskRegistry.pending)break;if(attempt===99)throw new Error('Member close did not release ownership');await new Promise(resolve=>setTimeout(resolve,50));}
    const all=await chrome.storage.session.get(null),closed=all['conversation:'+tab.id+':history-second'],alarm=await chrome.alarms.get('task-id:history-second');
    const after=await store.get(other.id);await chrome.tabs.remove(other.id);
    return {list,detail,currentId:current.taskId,scope,removedScope,deniedResume,restoredScope,closed,alarm:!!alarm,memory:!!all['memory:'+tab.id],independent,after};
  },origin);
  assert.equal(conversationCheck.list.ok,true);assert.equal(conversationCheck.list.value.length,2);
  assert.equal(conversationCheck.detail.value.goal,'First isolated conversation');
  assert.equal(conversationCheck.detail.value.token,undefined);assert.equal(conversationCheck.currentId,'history-second');
  pass('conversation history preserves separate tasks and reads old records through trusted messages without replacing the current task');
  assert.equal(conversationCheck.scope.value.status,'paused');assert.ok(conversationCheck.scope.value.allowedOrigins.includes('http://127.0.0.1:1'));assert.deepEqual(conversationCheck.removedScope.value.allowedOrigins,['http://127.0.0.1:1']);assert.equal(conversationCheck.deniedResume.ok,false);assert.equal(conversationCheck.restoredScope.value.check.deadline,12345);assert.equal(conversationCheck.restoredScope.value.steps,37);
  pass('trusted task scope changes remain separate from seeded browser grants and block a revoked current origin without dropping unknown checks');
  assert.equal(conversationCheck.closed.status,'ended');assert.equal(conversationCheck.closed.reason,'member_closed');assert.equal(conversationCheck.closed.steps,37);assert.equal(conversationCheck.closed.check.deadline,12345);assert.equal(conversationCheck.closed.check.dispatch,'unknown');assert.deepEqual(conversationCheck.closed.members,[]);assert.equal(conversationCheck.closed.token,undefined);assert.equal(conversationCheck.alarm,false);assert.equal(conversationCheck.memory,false);assert.deepEqual(conversationCheck.after,conversationCheck.independent);
  pass('real browser tab closure ends only its member task, clears alarms and temporary memory, and archives unknown operation evidence');
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
    JSON.stringify(report, null, 2) + '\r\n',
  );
  console.log(JSON.stringify({
    status: report.status,
    sourceSha: report.sourceSha,
    assertions: report.assertionCount,
    requests: report.requestCount,
    caveats: report.caveats,
  }, null, 2));
});
