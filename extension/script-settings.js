'use strict';
// Options page "Script execution" row: one action at a time walks the user through enabling
// run_script — request the optional userScripts permission from a click (user gesture), then
// send them to the extension details page for the browser toggle the extension cannot flip.
(() => {
  const $ = id => document.getElementById(id), t = PageAgentI18n.t, S = PageAgentScriptTools;
  let version = 0;
  // off: permission missing · toggle: browser toggle off · on: ready.
  function stateName(state) { return state.available ? 'on' : state.permission ? 'toggle' : 'off'; }
  const badges = {off: 'optScriptsBadgeOff', toggle: 'optScriptsBadgeToggle', on: 'optScriptsBadgeOn'};
  async function refresh() {
    const current = ++version;
    let state = {permission: false, api: false, available: false};
    try { state = await S.status(chrome); } catch { /* treated as unavailable */ }
    if (current !== version) return state;
    const name = stateName(state);
    $('script-badge').setAttribute('data-state', name); $('script-badge').textContent = t(badges[name]);
    $('script-status').textContent = name === 'toggle' ? t('optScriptsNeedToggle') : '';
    $('script-grant').hidden = name !== 'off';
    $('script-details').hidden = name !== 'toggle';
    $('script-revoke').hidden = !state.permission;
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
