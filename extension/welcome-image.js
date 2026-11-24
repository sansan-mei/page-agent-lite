'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const image = $('welcome-image-preview') || document.querySelector('.welcome-art');
  if (!image) return;
  const fallback = 'icons/welcome-assistant.webp';
  const storage = chrome.storage.local;
  const file = $('welcome-image-file'), reset = $('welcome-image-reset'), status = $('welcome-image-status');
  const limit = 2 * 1024 * 1024;
  let revision = 0, busy = true;
  function valid(value) { return typeof value === 'string' && value.length <= limit && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value); }
  function show(value) { image.src = valid(value) ? value : fallback; }
  function controls() { if (file) file.disabled = busy; if (reset) reset.disabled = busy; }
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
    } catch { if (status) status.textContent = '无法读取主图设置，暂时显示默认图片。'; }
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
      status.textContent = value ? '主图已保存，侧栏同步生效。图片仅保存在本机。' : '已恢复默认主图。';
    } catch (error) { status.textContent = error.message || '主图保存失败，请重试。'; }
    finally { busy = false; controls(); if (file) file.value = ''; }
  }
  async function readFile(selected) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    if (selected.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB。');
    const url = URL.createObjectURL(selected), decoded = new Image();
    try {
      await new Promise((resolve, reject) => { decoded.onload = resolve; decoded.onerror = () => reject(new Error('无法读取这张图片，请换一张。')); decoded.src = url; });
      if (!decoded.naturalWidth || !decoded.naturalHeight || decoded.naturalWidth > 8192 || decoded.naturalHeight > 8192) throw new Error('图片边长不能超过 8192 像素。');
      const scale = Math.min(1, 1024 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(decoded.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
      canvas.getContext('2d').drawImage(decoded, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/png');
      if (!valid(data)) throw new Error('图片保存后超过 2 MB，请选择更小或更简洁的图片。');
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  file?.addEventListener('change', () => { const selected = file.files?.[0]; if (selected) void save(() => readFile(selected)); });
  reset?.addEventListener('click', () => void save(async () => null));
})();
