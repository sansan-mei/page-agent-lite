'use strict';
// UI strings come from _locales/<locale>/messages.json via chrome.i18n (browser UI language,
// falling back to default_locale zh_CN). Placeholders use {1}..{9}; never put "$" in messages.
(() => {
  const api = globalThis.chrome?.i18n;
  function t(key, ...subs) {
    let text = '';
    try { text = api?.getMessage?.(key) || ''; } catch {}
    if (!text) return key;
    return text.replace(/\{([1-9])\}/g, (match, n) => subs[n - 1] === undefined ? match : String(subs[n - 1]));
  }
  function uiLanguage() {
    try { return api?.getUILanguage?.() || ''; } catch { return ''; }
  }
  // Model reply language used when the user has not saved one yet.
  function defaultReplyLanguage(language = uiLanguage()) {
    const tag = String(language || '').replace('_', '-');
    if (/^zh\b/i.test(tag)) return /^zh-(TW|HK|MO)\b|Hant/i.test(tag) ? '繁體中文' : '简体中文';
    if (!tag || /^en\b/i.test(tag)) return 'English';
    try { const name = new Intl.DisplayNames([tag], {type: 'language'}).of(tag); if (name && name !== tag) return name.slice(0, 60); } catch {}
    return 'English';
  }
  const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
  function apply(root = globalThis.document) {
    if (!root) return;
    for (const node of root.querySelectorAll('[data-i18n]')) { const key = node.getAttribute('data-i18n'), text = t(key); if (text !== key) node.textContent = text; }
    for (const attribute of attributes) for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      const key = node.getAttribute('data-i18n-' + attribute), text = t(key);
      if (text !== key) node.setAttribute(attribute, text);
    }
    const lang = t('htmlLang');
    if (lang !== 'htmlLang' && root.documentElement) root.documentElement.lang = lang;
  }
  globalThis.PageAgentI18n = Object.freeze({t, apply, defaultReplyLanguage, uiLanguage});
  apply();
})();
