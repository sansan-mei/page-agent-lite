'use strict';
// Side-panel task images: check, compress and store drafts in IndexedDB. Only ids reach the background;
// it claims them for the task on submit. Loaded by the side panel only (needs DOM canvas).
(function (root) {
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const MAX_BYTES = 5 * 1024 * 1024, LONG_EDGE = 1568, PER_TASK = 4;
  // Returns an i18n key for a rejected file, or null. SVG and anything not a local raster file is refused.
  function check(file) {
    if (!file || typeof file.type !== 'string' || !TYPES.includes(file.type)) return 'spImageType';
    if (!Number.isFinite(file.size) || file.size > MAX_BYTES) return 'spImageSize';
    return null;
  }
  // Files from paste or drop. A drop that carries only a link or HTML (an image dragged from a web page)
  // is a network address: reported as such, never fetched.
  function fromTransfer(transfer) {
    const files = Array.from(transfer?.files || []);
    const types = Array.from(transfer?.types || []);
    return {files, url: !files.length && types.some(type => ['text/uri-list', 'text/html'].includes(type))};
  }
  // Decodes the file, scales the long edge to at most 1568 px and re-encodes as JPEG on white
  // (transparent PNG/GIF would turn black). GIF keeps its first frame.
  async function compress(file, {document = root.document, URL = root.URL, Image = root.Image} = {}) {
    const url = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('decode')); image.src = url; });
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height) throw new Error('decode');
      const scale = Math.min(1, LONG_EDGE / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.85);
      if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,')) throw new Error('decode');
      return {data, width: canvas.width, height: canvas.height, size: file.size};
    } finally { URL.revokeObjectURL(url); }
  }
  function newId() { return 'img_' + root.crypto.randomUUID().replace(/-/g, '').slice(0, 24); }
  let store = null;
  const imageStore = () => store || (store = root.PageAgentSiteMemory.createAttachmentStore());
  root.PageAgentAttachments = {TYPES, MAX_BYTES, LONG_EDGE, PER_TASK, check, fromTransfer, compress, newId, store: imageStore};
  if (typeof module !== 'undefined') module.exports = root.PageAgentAttachments;
})(globalThis);
