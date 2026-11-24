'use strict';
// Options page "Script execution": request the optional userScripts permission from a click
// (user gesture) and show whether run_script can run. The toggle itself lives on the
// extension details page and cannot be changed by the extension.
(() => {
  const $ = id => document.getElementById(id), t = PageAgentI18n.t, S = PageAgentScriptTools;
  const required = (chrome.runtime?.getManifest?.().permissions || []).includes(S.permission);
  let version = 0;
  // Badge: off / permission granted but browser toggle off / on / developer build auto-approves.
  function badge(state) {
    const [name, key] = required && state.available ? ['dev', 'optScriptsBadgeDev'] : state.available ? ['on', 'optScriptsBadgeOn'] : required || state.permission ? ['toggle', 'optScriptsBadgeToggle'] : ['off', 'optScriptsBadgeOff'];
    $('script-badge').setAttribute('data-state', name); $('script-badge').textContent = t(key);
  }
  async function refresh() {
    const current = ++version;
    let state = {permission: false, api: false, available: false};
    try { state = await S.status(chrome); } catch { /* treated as unavailable */ }
    if (current !== version) return state;
    $('script-status').textContent = required ? t(state.available ? 'optScriptsDevReady' : 'optScriptsDevToggle') : t(state.available ? 'optScriptsReady' : state.permission ? 'optScriptsNeedToggle' : 'optScriptsOff');
    badge(state);
    $('script-step-permission').setAttribute('data-done', String(required || state.permission));
    $('script-step-toggle').setAttribute('data-done', String(state.available));
    $('script-grant').hidden = required || state.permission;
    $('script-revoke').hidden = required || !state.permission;
    return state;
  }
  $('script-grant').addEventListener('click', () => {
    // Call request synchronously inside the click handler so Chrome keeps the user gesture.
    let request;
    try { request = chrome.permissions.request({permissions: [S.permission]}); } catch (error) { request = Promise.reject(error); }
    void Promise.resolve(request).then(granted => granted ? refresh() : void ($('script-status').textContent = t('optScriptsDenied')), () => { $('script-status').textContent = t('optScriptsDenied'); });
  });
  $('script-revoke').addEventListener('click', () => {
    void Promise.resolve(chrome.permissions.remove({permissions: [S.permission]})).then(() => refresh(), () => { $('script-status').textContent = t('optScriptsRevokeFailed'); });
  });
  $('script-details').addEventListener('click', () => {
    void Promise.resolve(chrome.tabs.create({url: 'chrome://extensions/?id=' + chrome.runtime.id})).catch(() => { $('script-status').textContent = t('optScriptsDetailsFailed'); });
  });
  // The toggle is flipped in another tab: re-check when the user comes back.
  globalThis.addEventListener?.('focus', () => void refresh());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void refresh(); });
  chrome.permissions?.onAdded?.addListener?.(() => void refresh());
  chrome.permissions?.onRemoved?.addListener?.(() => void refresh());
  void refresh();
})();
