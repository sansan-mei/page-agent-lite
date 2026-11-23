'use strict';
(() => {
  const C = PageAgentCore;
  const $ = id => document.getElementById(id);
  const status = $('status');
  let busy = true;
  function controls() {for (const button of document.querySelectorAll('button')) button.disabled = busy;}
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '扩展通信失败');
    return result.value;
  }
  async function run(task) {
    if (busy) return;
    busy = true; controls();
    try {await task();} catch (error) {status.textContent = error.message || '操作失败';}
    finally {busy = false; controls();}
  }
  async function sites() {
    const origins = await send({type: 'sites'});
    $('sites').replaceChildren();
    for (const origin of origins) {
      const item = document.createElement('li');
      const text = document.createElement('span'); text.textContent = origin; item.append(text);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '停用';
      button.addEventListener('click', () => {void run(async () => {
        await send({type: 'disableSite', origin}); await sites();
        status.textContent = '已停用站点自动恢复，请刷新已有网页。';
      });});
      item.append(button); $('sites').append(item);
    }
    if (!origins.length) $('sites').textContent = '尚未启用任何站点。';
    controls();
  }
  $('config').addEventListener('submit', event => {
    event.preventDefault();
    // run invokes the callback synchronously up to the permission request, preserving user activation.
    void run(async () => {
      const config = {endpoint: C.endpoint($('endpoint').value.trim()), model: $('model').value.trim(), key: $('key').value.trim(), language: $('language').value.trim()};
      if (!config.model || config.model.length > 120 || !config.language || config.language.length > 60 || config.key.length > 4096 || /[\r\n]/.test(config.key)) throw new Error('请输入有效模型、密钥与语言');
      const granted = await chrome.permissions.request({origins: [new URL(config.endpoint).origin + '/*']});
      if (!granted) throw new Error('API 授权被拒绝，配置未保存');
      await send({type: 'configure', config});
      status.textContent = 'API 配置已保存；尚未执行模型调用。网页持久化请另行授权。';
    });
  });
  $('site-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const origin = C.siteOrigin($('origin').value.trim());
      if (!await chrome.permissions.request({origins: [origin + '/*']})) throw new Error('站点授权被拒绝，未启用');
      await send({type: 'enableSite', origin}); await sites();
      status.textContent = '站点已启用，请刷新对应网页。';
    });
  });
  $('agent-config').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const preferences={maxSteps:Number($('max-steps').value),autoFill:$('auto-fill').checked,autoClick:$('auto-click').checked,contextTokens:Number($('context-tokens').value),compressionThreshold:Number($('compression-threshold').value)};
      await send({type:'setAgentPreferences',preferences});
      status.textContent='助手默认设置已保存，新任务或点击「继续任务」后生效。';
    });
  });
  $('current-site').addEventListener('click', () => {void run(async () => {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    const url = tabs[0]?.url;
    if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('无法读取当前普通网页地址，请手动输入站点源。可在网页打开面板后进入设置。');
    $('origin').value = new URL(url).origin;
    status.textContent = '已填入网页源，点击授权按钮才会启用。';
  });});
  controls();
  (async () => {
    const config = await send({type: 'settings'});
    for (const id of ['endpoint', 'model', 'key', 'language']) if (typeof config[id] === 'string') $(id).value = config[id];
    const preferences=await send({type:'agentPreferences'});
    $('max-steps').value=preferences.maxSteps; $('auto-fill').checked=preferences.autoFill;
    $('auto-click').checked=preferences.autoClick===true;
    $('context-tokens').value=preferences.contextTokens??32768;$('compression-threshold').value=preferences.compressionThreshold??80;
    await sites(); status.textContent = '设置已读取。API 与站点需分别授权。';
  })().catch(() => {status.textContent = '无法读取设置，请重启扩展后重试。';})
    .finally(() => {busy = false; controls();});
})();
