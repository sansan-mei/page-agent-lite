'use strict';
// Settings page: card 1 "Save" and the "More settings" Save both submit #config and store the
// model connection + run budget together. The API host permission is requested synchronously
// inside the submit handler to keep the user gesture.
(() => {
  const C = PageAgentCore;
  const $ = id => document.getElementById(id), t = PageAgentI18n.t;
  const language = $('language'), choice = $('language-choice');
  const browserLanguage = PageAgentI18n.defaultReplyLanguage();
  const presets = ['简体中文', 'English', '繁體中文', '日本語'];
  let busy = true, status = $('status');
  function controls() { for (const id of ['save-settings', 'save-more', 'test-connection']) $(id).disabled = busy; }
  // The result shows next to the Save button that was used; the other line is cleared.
  function report(text, error = false) {
    for (const element of [$('status'), $('status-more')]) {
      const shown = element === status && Boolean(text);
      element.textContent = shown ? text : ''; element.hidden = !shown;
      element.classList.toggle('is-error', shown && error);
    }
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
  // Fields inside the collapsed "More settings" must be visible for the browser to point at them.
  $('config').addEventListener('invalid', event => { event.target.closest?.('details')?.setAttribute('open', ''); }, true);
  $('config').addEventListener('submit', event => {
    event.preventDefault();
    status = event.submitter?.id === 'save-more' ? $('status-more') : $('status');
    const testing = event.submitter?.id === 'test-connection';
    // run invokes the callback synchronously up to the permission request, preserving user activation.
    void run(async () => {
      const config = {apiFormat: $('apiFormat').value, endpoint: C.endpoint($('endpoint').value.trim()), model: $('model').value.trim(), key: $('key').value.trim(), language: language.value.trim(), reasoningEffort: $('reasoningEffort').value, toolMode: $('toolMode').value};
      if (!config.model || config.model.length > 120 || !config.language || config.language.length > 60 || config.key.length > 4096 || /[\r\n]/.test(config.key)) throw new Error(t('optInvalidConfig'));
      // Optional recognition model: saved only with a model name; its own address needs its own grant.
      const recognitionModel = $('rec-model').value.trim(), recognitionEndpoint = $('rec-endpoint').value.trim();
      if (recognitionModel) {
        config.recognition = {apiFormat: $('rec-format').value, model: recognitionModel, endpoint: recognitionEndpoint ? C.endpoint(recognitionEndpoint) : '', key: $('rec-key').value.trim()};
        if (recognitionModel.length > 120 || /[\r\n]/.test(config.recognition.key)) throw new Error(t('optInvalidConfig'));
      }
      const preferences = {maxSteps: Number($('max-steps').value), contextTokens: Number($('context-tokens').value), compressionThreshold: Number($('compression-threshold').value), inputChars: Number($('input-chars').value)};
      const origins = [new URL(config.endpoint).origin + '/*'];
      if (config.recognition?.endpoint) origins.push(new URL(config.recognition.endpoint).origin + '/*');
      const granted = await chrome.permissions.request({origins: [...new Set(origins)]});
      if (!granted) throw new Error(t('optApiDenied'));
      await send({type: 'configure', config});
      await send({type: 'setAgentPreferences', preferences});
      if (!testing) { report(t('optSaved')); return; }
      // Test = save, then one tiny-image request; the result is remembered for this model.
      report(t('optTesting'));
      const result = await send({type: 'testConnection'});
      report(t(result?.vision === 'supported' ? 'optTestVision' : 'optTestNoVision'));
    });
  });
  // Endpoint placeholder and hint follow the chosen API format; the saved address is never rewritten.
  function showApiFormat() {
    const claude = $('apiFormat').value === 'anthropic';
    $('endpoint').placeholder = claude ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
    $('connection-hint').textContent = t(claude ? 'optConnectionHintAnthropic' : 'optConnectionHint');
  }
  $('apiFormat').addEventListener('change', showApiFormat);
  choice.querySelector('option[value="browser"]').textContent = t('optLanguageBrowser', browserLanguage);
  showLanguage(browserLanguage, false);
  controls();
  (async () => {
    const config = await send({type: 'settings'});
    for (const id of ['endpoint', 'model', 'key']) if (typeof config[id] === 'string') $(id).value = config[id];
    for (const id of ['apiFormat', 'reasoningEffort', 'toolMode']) if (typeof config[id] === 'string') select($(id), config[id]);
    showApiFormat();
    const recognition = config.recognition;
    if (recognition && typeof recognition === 'object') {
      for (const [id, name] of [['rec-model', 'model'], ['rec-endpoint', 'endpoint'], ['rec-key', 'key']]) if (typeof recognition[name] === 'string') $(id).value = recognition[name];
      select($('rec-format'), recognition.apiFormat || 'openai');
    }
    if (typeof config.language === 'string' && config.language) showLanguage(config.language, true);
    const preferences = await send({type: 'agentPreferences'});
    if (preferences.maxSteps !== undefined) $('max-steps').value = preferences.maxSteps;
    $('context-tokens').value = preferences.contextTokens ?? 100000; $('compression-threshold').value = preferences.compressionThreshold ?? 80; $('input-chars').value = preferences.inputChars ?? 2000;
  })().catch(() => { report(t('optLoadFailed'), true); })
    .finally(() => { busy = false; controls(); });
})();
