(function () {
  'use strict';
  if (globalThis.__pageAgent) { globalThis.__pageAgent.show(); return; }
  const C = globalThis.PageAgentCore;
  const host = document.createElement('div');
  host.setAttribute('data-page-agent', 'ui');
  host.style.cssText = 'all:initial!important;position:fixed!important;right:16px!important;top:16px!important;z-index:2147483647!important;display:block!important';
  const shadow = host.attachShadow({mode: 'closed'});
  function el(tag, text, parent = shadow) {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    parent.appendChild(n); return n;
  }
  el('style').textContent = 'section{width:340px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;background:#fff;color:#182331;border:1px solid #cbd5e1;border-radius:14px;padding:16px;font:14px/1.6 system-ui}button{padding:7px;margin:4px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}small{display:block}textarea{width:100%;min-height:65px}pre{white-space:pre-wrap;overflow-wrap:anywhere}';
  const panel = el('section');
  el('h2', 'Page Agent · 页面助手', panel);
  el('small', '点击翻译、摘要或生成建议，会将选中文字、文章片段或精简页面大纲发送至你配置的模型服务。请勿发送敏感信息。', panel);
  const status = el('p', '正在读取当前页修改…', panel);
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  let records = [], undos = [], enabled = false, busy = true, selection = null, pending = null;
  function pageURL() { const u = new URL(location.href); u.hash = ''; return u.href; }
  const initialURL = pageURL();
  async function send(message) {
    const r = await chrome.runtime.sendMessage(message);
    if (!r?.ok) throw new Error(r?.error || '扩展通信失败');
    return r.value;
  }
  function controls() { for (const b of panel.querySelectorAll('button')) b.disabled = busy; }
  async function run(fn) {
    busy = true; controls();
    try {
      if (pageURL() !== initialURL) throw new Error('页面地址已变化，请刷新后操作');
      await fn();
    } catch (e) { status.textContent = e.message || '操作失败'; }
    finally { busy = false; controls(); }
  }
  function button(id, label, fn) {
    const b = el('button', label, panel); b.id = id; b.type = 'button';
    b.addEventListener('click', e => { if (e.isTrusted && !busy) void run(fn); });
  }
  function render(next) {
    for (let i = undos.length - 1; i >= 0; i--) undos[i]?.();
    records = next;
    const result = C.restore(document, records); undos = result.undos;
    status.textContent = (enabled ? '此站点已启用持久保存。' : '临时模式：在设置中显式启用站点后刷新生效。') + ` 当前 ${records.length} 条修改。` + (result.skipped ? ` ${result.skipped} 条定位失效，已安全跳过。` : '');
  }
  function checkURL() {
    if (pageURL() !== initialURL) throw new Error('页面地址已变化，请刷新后操作');
  }
  async function commit(next) {
    checkURL();
    if (next.length > 30 || !next.every(C.validRecord) || C.byteSize(JSON.stringify(next)) > 120000) {
      throw new Error('修改超过 30 条 / 120 KB 上限，请先撤销或清除');
    }
    if (enabled || next.length === 0) await send({type: 'save', records: next});
    checkURL();
    render(next);
  }
  document.addEventListener('selectionchange', () => {
    try {
      const s = window.getSelection();
      if (!s?.rangeCount || !s.toString().trim()) return;
      const a = s.anchorNode?.nodeType === 1 ? s.anchorNode : s.anchorNode?.parentElement;
      const b = s.focusNode?.nodeType === 1 ? s.focusNode : s.focusNode?.parentElement;
      if (!C.safe(a) || !C.safe(b)) { selection = null; return; }
      const p = a.closest('p,h1,h2,h3,li,blockquote');
      const fragment = s.getRangeAt(0).cloneContents();
      if (!p || !p.contains(b) || fragment.querySelector?.('form,input,textarea,select,button,[contenteditable],script,style,a')) { selection = null; return; }
      const text = s.toString().trim();
      selection = text.length <= 6000 ? {text, target: C.describe(p)} : null;
    } catch { selection = null; }
  });
  button('summary', '发送文章并插入摘要', async () => {
    const snap = C.collect(document.querySelector('article,main') || document.body);
    if (!snap.outline.length) throw new Error('未找到可读文章段落');
    const target = C.describe(snap.nodes.get(snap.outline[0].id));
    status.textContent = '正在生成摘要…';
    const r = await send({type: 'model', task: 'summary', text: snap.outline.map(n => n.text).join('\n').slice(0, 12000)});
    if (!C.resolve(document, target)) throw new Error('文章已变化，未插入摘要');
    await commit(records.concat({kind: 'summary', target, text: r.text}));
  });
  button('translate', '发送选中文字翻译', async () => {
    if (!selection || !C.resolve(document, selection.target)) throw new Error('请先在同一个普通文章段落内选中文字（最多 6000 字符）');
    const captured = selection; status.textContent = '正在翻译选中文字…';
    const r = await send({type: 'model', task: 'translate', text: captured.text});
    if (!C.resolve(document, captured.target)) throw new Error('段落已变化，请重新选择');
    await commit(records.concat({kind: 'translation', target: captured.target, text: r.text}));
  });
  const label = el('label', '自然语言修改（只允许隐藏或安全样式）', panel); label.htmlFor = 'prompt';
  const prompt = el('textarea', null, panel); prompt.id = 'prompt'; prompt.maxLength = 1000;
  const preview = el('pre', '尚未生成建议。', panel); preview.id = 'preview';
  button('propose', '发送大纲并生成建议', async () => {
    pending = null; preview.textContent = '正在生成…';
    const instruction = prompt.value.trim();
    if (!instruction || instruction.length > 1000) throw new Error('请输入不超过 1000 字符的修改要求');
    const snap = C.collect(document);
    if (!snap.outline.length) throw new Error('未找到可修改段落');
    const text = JSON.stringify({instruction, outline: snap.outline});
    if (text.length > 12000) throw new Error('页面大纲过大，请在较短页面使用');
    const r = await send({type: 'model', task: 'edit', text});
    pending = C.proposal(r.text, snap).map(op => {
      const target = C.describe(snap.nodes.get(op.id));
      return op.action === 'hide' ? {kind: 'edit', target, action: 'hide'} : {kind: 'edit', target, action: 'style', property: op.property, value: op.value};
    });
    preview.textContent = pending.length ? pending.map((r, i) => `${i + 1}. 「${r.target.text.slice(0, 70)}」 → ${r.action === 'hide' ? '隐藏' : r.property + ': ' + r.value}`).join('\n') : '模型没有提出支持的修改。';
    status.textContent = '请检查预览，点击「应用预览修改」才会修改页面。';
  });
  button('apply', '应用预览修改', async () => {
    if (!pending?.length) throw new Error('请先生成有效修改建议');
    if (pending.some(r => !C.resolve(document, r.target))) throw new Error('页面已变化，请重新生成建议');
    await commit(records.concat(pending)); pending = null; preview.textContent = '已应用。';
  });
  button('undo', '撤销上一条', async () => {
    if (!records.length) throw new Error('没有可撤销的修改');
    await commit(records.slice(0, -1));
  });
  button('clear', '当前页全部撤销/清除保存', async () => {
    await commit([]); pending = null; preview.textContent = '已清除当前页全部修改。';
  });
  button('settings', 'API/站点持久化设置', async () => {
    await send({type: 'openOptions'}); status.textContent = '请分别授权 API 与站点，启用站点后刷新此页。';
  });
  button('close', '收起面板', () => host.style.setProperty('display', 'none', 'important'));
  globalThis.__pageAgent = {show: () => host.style.setProperty('display', 'block', 'important')};
  document.documentElement.appendChild(host);
  void run(async () => { const loaded = await send({type: 'load'}); enabled = loaded.enabled; render(loaded.records); });
})();
