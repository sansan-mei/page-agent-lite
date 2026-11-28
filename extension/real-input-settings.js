'use strict';
// Options page "Real input & screenshots" row: one stored switch (storage.local debuggerEnabled, default off) that
// decides whether the extension may use chrome.debugger at all. No Chrome permission prompt: `debugger` is a required
// permission, so this is a product setting; turning it off detaches any live session (cdp-tools.js listens).
(() => {
  const $ = id => document.getElementById(id), t = PageAgentI18n.t, KEY = 'debuggerEnabled';
  let on = false;
  function show() {
    $('real-input-badge').setAttribute('data-state', on ? 'on' : 'off');
    $('real-input-badge').textContent = t(on ? 'optScriptsBadgeOn' : 'optScriptsBadgeOff');
    $('real-input-toggle').textContent = t(on ? 'optRealInputDisable' : 'optRealInputEnable');
    $('real-input-toggle').classList.toggle('link', on);
  }
  $('real-input-toggle').addEventListener('click', () => {
    const next = !on;
    $('real-input-status').textContent = '';
    void Promise.resolve(chrome.storage.local.set({[KEY]: next})).then(() => { on = next; show(); }, () => { $('real-input-status').textContent = t('optRealInputFailed'); });
  });
  // A side-panel "Turn on" or a second settings tab changes the same key.
  chrome.storage.onChanged?.addListener?.((changes, area) => { if (area === 'local' && changes[KEY]) { on = changes[KEY].newValue === true; show(); } });
  show();
  void (async () => { try { on = (await chrome.storage.local.get(KEY))[KEY] === true; } catch { on = false; } show(); })();
})();
