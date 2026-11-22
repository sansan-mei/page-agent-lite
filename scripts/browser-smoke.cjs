'use strict';
/* Real Chromium extension end-to-end smoke test — GitHub Actions CI only.
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
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
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
    'Service-worker idle suspension (auto-restart) is NOT tested.',
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
const serverErrors = [];

async function startServer() {
  const svc = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/article') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        });
        res.end(FIXTURE_HTML); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404); res.end(); return;
      }
      // Read body.
      const chunks = []; let total = 0;
      for await (const ch of req) { total += ch.length; assert.ok(total < 65536, 'stub body bounded'); chunks.push(ch); }
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
                 : sysPrompt.startsWith('Summarize ')    ? 'summary'
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
  assert.equal(dirty, '', 'Git checkout must be clean');

  // 1. Start stub server.
  const origin = await startServer();
  report.serverOrigin = origin;

  // 2. Create fixture with seeded grant.
  fixtureBase = await makeFixture(origin);
  const fixturePath = path.join(fixtureBase, 'extension');

  // 3. Launch Chromium + real extension.
  const profileDir = path.join(fixtureBase, 'profile');
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: false,                          // xvfb provides virtual display.
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${fixturePath}`,
      `--load-extension=${fixturePath}`,
    ],
  });

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
      files: ['core.js', 'content.js'],
      world: 'ISOLATED',
    }),
    tabId,
  );

  // Connect CDP session to page for shadow DOM inspection.
  cdpSession = await context.newCDPSession(page);

  // Wait for panel to appear.
  await poll(() => shadowText('[role="status"]'), 'panel appeared in isolated world', 8000);
  assert.match(await shadowText('[role="status"]'), /临时模式/,
    'Status shows temporary-mode message');
  pass('chrome.scripting.executeScript injected unmodified content.js in ISOLATED world');

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
