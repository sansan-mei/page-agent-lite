'use strict';
(() => {
  const $ = id => document.getElementById(id), t = PageAgentI18n.t;
  const image = $('welcome-image-preview') || document.querySelector('.welcome-art');
  if (!image) return;
  const fallback = 'icons/welcome-assistant.webp';
  const storage = chrome.storage.local;
  const file = $('welcome-image-file'), pick = $('welcome-image-pick'), reset = $('welcome-image-reset'), status = $('welcome-image-status');
  const limit = 2 * 1024 * 1024;
  let revision = 0, busy = true;
  function valid(value) { return typeof value === 'string' && value.length <= limit && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value); }
  function show(value) { image.src = valid(value) ? value : fallback; }
  function controls() { for (const control of [file, pick, reset]) if (control) control.disabled = busy; }
  image.addEventListener('error', () => { if (image.getAttribute('src') !== fallback) image.src = fallback; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, 'welcomeImage')) { revision++; show(changes.welcomeImage.newValue); }
  });
  controls();
  const initialRevision = revision;
  (async () => {
    try {
      const saved = await storage.get('welcomeImage');
      if (revision === initialRevision) show(saved.welcomeImage);
    } catch { if (status) status.textContent = t('wiReadFailed'); }
    finally { busy = false; controls(); }
  })();
  async function save(makeImage) {
    if (busy) return;
    busy = true; controls();
    try {
      const value = await makeImage();
      const savingRevision = revision;
      await storage.set({welcomeImage: value});
      if (revision === savingRevision) { revision++; show(value); }
      status.textContent = value ? t('wiSaved') : t('wiReset');
    } catch (error) { status.textContent = error.message || t('wiSaveFailed'); }
    finally { busy = false; controls(); if (file) file.value = ''; }
  }
  async function readFile(selected) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) throw new Error(t('wiType'));
    if (selected.size > 5 * 1024 * 1024) throw new Error(t('wiSize'));
    const url = URL.createObjectURL(selected), decoded = new Image();
    try {
      await new Promise((resolve, reject) => { decoded.onload = resolve; decoded.onerror = () => reject(new Error(t('wiDecode'))); decoded.src = url; });
      if (!decoded.naturalWidth || !decoded.naturalHeight || decoded.naturalWidth > 8192 || decoded.naturalHeight > 8192) throw new Error(t('wiDimensions'));
      const scale = Math.min(1, 1024 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(decoded.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
      canvas.getContext('2d').drawImage(decoded, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/png');
      if (!valid(data)) throw new Error(t('wiTooLarge'));
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  // The native file input is hidden: its "Choose File" text follows the browser, not the extension locale.
  pick?.addEventListener('click', () => file?.click());
  file?.addEventListener('change', () => { const selected = file.files?.[0]; if (!selected) return; if (status) status.textContent = t('wiSelected', selected.name || ''); void save(() => readFile(selected)); });
  reset?.addEventListener('click', () => void save(async () => null));
})();
