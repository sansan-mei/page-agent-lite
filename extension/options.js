'use strict';
// Settings page: one Save bar stores model connection + run budget together. The API host
// permission is requested synchronously inside the submit handler to keep the user gesture.
(() => {
  const C = PageAgentCore;
  const $ = id => document.getElementById(id), t = PageAgentI18n.t;
  const status = $('status'), language = $('language'), choice = $('language-choice');
  const browserLanguage = PageAgentI18n.defaultReplyLanguage();
  const presets = ['简体中文', 'English', '繁體中文', '日本語'];
  let busy = true;
  function controls() { $('save-settings').disabled = busy; }
  function report(text, error = false) {
    status.textContent = text; status.hidden = !text;
    status.classList.toggle('is-error', Boolean(text) && error);
    $('save-hint').hidden = Boolean(text);
  }
  function select(element, value) {
    for (const option of element.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value);
    try { element.value = value; } catch { /* linkedom: select.value has no setter */ }
  }
  // Show the saved reply language: a preset maps to its option, anything else to "Other…".
  function showLanguage(value, saved) {
    const preset = saved ? presets.find(name => name === value) : null;
    const mode = preset || (saved ? 'other' : 'browser');
    select(choice, mode);
    language.value = value;
    language.hidden = mode !== 'other';
  }
  choice.addEventListener('change', () => {
    const mode = choice.value;
    language.hidden = mode !== 'other';
    if (mode === 'browser') language.value = browserLanguage;
    else if (mode === 'other') { if (presets.includes(language.value) || language.value === browserLanguage) language.value = ''; language.focus(); }
    else language.value = mode;
  });
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || t('commonMessagingFailed'));
    return result.value;
  }
  async function run(task) {
    if (busy) return;
    busy = true; controls(); report('');
    try { await task(); } catch (error) { report(error.message || t('optFailed'), true); }
    finally { busy = false; controls(); }
  }
  // Fields inside a collapsed "Advanced" block must be visible for the browser to point at them.
  $('config').addEventListener('invalid', event => { event.target.closest?.('details')?.setAttribute('open', ''); }, true);
  $('config').addEventListener('submit', event => {
    event.preventDefault();
    // run invokes the callback synchronously up to the permission request, preserving user activation.
    void run(async () => {
      const config = {endpoint: C.endpoint($('endpoint').value.trim()), model: $('model').value.trim(), key: $('key').value.trim(), language: language.value.trim(), reasoningEffort: $('reasoningEffort').value, toolMode: $('toolMode').value};
      if (!config.model || config.model.length > 120 || !config.language || config.language.length > 60 || config.key.length > 4096 || /[\r\n]/.test(config.key)) throw new Error(t('optInvalidConfig'));
      const preferences = {maxSteps: Number($('max-steps').value), contextTokens: Number($('context-tokens').value), compressionThreshold: Number($('compression-threshold').value), inputChars: Number($('input-chars').value)};
      const granted = await chrome.permissions.request({origins: [new URL(config.endpoint).origin + '/*']});
      if (!granted) throw new Error(t('optApiDenied'));
      await send({type: 'configure', config});
      await send({type: 'setAgentPreferences', preferences});
      report(t('optSaved'));
    });
  });
  // Keep the extension document URL stable: backend trust checks use its exact URL.
  for (const link of document.querySelectorAll('.settings-nav a')) link.addEventListener('click', event => {
    event.preventDefault();
    const target = document.getElementById(link.getAttribute('href').slice(1));
    target?.scrollIntoView({block: 'start'});
  });
  choice.querySelector('option[value="browser"]').textContent = t('optLanguageBrowser', browserLanguage);
  showLanguage(browserLanguage, false);
  controls();
  (async () => {
    const config = await send({type: 'settings'});
    for (const id of ['endpoint', 'model', 'key']) if (typeof config[id] === 'string') $(id).value = config[id];
    for (const id of ['reasoningEffort', 'toolMode']) if (typeof config[id] === 'string') select($(id), config[id]);
    if (typeof config.language === 'string' && config.language) showLanguage(config.language, true);
    const preferences = await send({type: 'agentPreferences'});
    if (preferences.maxSteps !== undefined) $('max-steps').value = preferences.maxSteps;
    $('context-tokens').value = preferences.contextTokens ?? 100000; $('compression-threshold').value = preferences.compressionThreshold ?? 80; $('input-chars').value = preferences.inputChars ?? 2000;
  })().catch(() => { report(t('optLoadFailed'), true); })
    .finally(() => { busy = false; controls(); });
})();
