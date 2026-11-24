'use strict';
(() => {
  const C = PageAgentCore;
  const $ = id => document.getElementById(id), t = PageAgentI18n.t;
  const status = $('status');
  let busy = true;
  function controls() {for (const button of document.querySelectorAll('section:not(#management):not(#appearance) button')) button.disabled = busy;}
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || t('commonMessagingFailed'));
    return result.value;
  }
  async function run(task) {
    if (busy) return;
    busy = true; controls();
    try {await task();} catch (error) {status.textContent = error.message || t('optFailed');}
    finally {busy = false; controls();}
  }
  $('config').addEventListener('submit', event => {
    event.preventDefault();
    // run invokes the callback synchronously up to the permission request, preserving user activation.
    void run(async () => {
      const config = {endpoint: C.endpoint($('endpoint').value.trim()), model: $('model').value.trim(), key: $('key').value.trim(), language: $('language').value.trim(), reasoningEffort: $('reasoningEffort').value, toolMode: $('toolMode').value};
      if (!config.model || config.model.length > 120 || !config.language || config.language.length > 60 || config.key.length > 4096 || /[\r\n]/.test(config.key)) throw new Error(t('optInvalidConfig'));
      const granted = await chrome.permissions.request({origins: [new URL(config.endpoint).origin + '/*']});
      if (!granted) throw new Error(t('optApiDenied'));
      await send({type: 'configure', config});
      status.textContent = t('optApiSaved');
    });
  });
  $('agent-config').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const preferences={maxSteps:Number($('max-steps').value),contextTokens:Number($('context-tokens').value),compressionThreshold:Number($('compression-threshold').value),inputChars:Number($('input-chars').value)};
      await send({type:'setAgentPreferences',preferences});
      status.textContent=t('optBehaviorSaved');
    });
  });
  // Keep the extension document URL stable: backend trust checks use its exact URL.
  for (const link of document.querySelectorAll('.settings-nav a')) link.addEventListener('click', event => {
    event.preventDefault();
    const target = document.getElementById(link.getAttribute('href').slice(1));
    target?.scrollIntoView({block: 'start'});
  });
  $('language').value = PageAgentI18n.defaultReplyLanguage();
  controls();
  (async () => {
    const config = await send({type: 'settings'});
    for (const id of ['endpoint', 'model', 'key', 'language', 'reasoningEffort', 'toolMode']) if (typeof config[id] === 'string') $(id).value = config[id];
    const preferences=await send({type:'agentPreferences'});
    $('max-steps').value=preferences.maxSteps;
    $('context-tokens').value=preferences.contextTokens??100000;$('compression-threshold').value=preferences.compressionThreshold??80;$('input-chars').value=preferences.inputChars??2000;
    status.textContent = t('optLoaded');
  })().catch(() => {status.textContent = t('optLoadFailed');})
    .finally(() => {busy = false; controls();});
})();
