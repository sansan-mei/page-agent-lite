'use strict';
importScripts('core.js', 'backend.js');
const service = PageAgentBackend.createService(chrome);
// Attach a rejection handler immediately; every entrypoint awaits the same gate.
const ready = Promise.resolve().then(() => service.init()).then(() => true, () => false);
function contentSender(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
  try {return ['https:', 'http:'].includes(new URL(sender.url).protocol);} catch {return false;}
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!await ready) return {ok: false, error: '安全存储初始化失败，请重启扩展后重试'};
    try {
      if (message?.type === 'openOptions') {
        if (!contentSender(sender)) throw new Error('消息来源无效');
        await chrome.runtime.openOptionsPage();
        return {ok: true, value: {opened: true}};
      }
      return {ok: true, value: await service.handle(message, sender)};
    } catch (error) {
      // No stack, request, key or server response is returned across the boundary.
      const text = typeof error?.message === 'string' ? error.message : '';
      return {ok: false, error: /^[\u3400-\u9fff]|^API (?:网络|响应|请求|权限|地址|\d{3}：)/u.test(text) && text.length < 180 ? text : '操作失败，请检查权限、设置或存储空间后重试'};
    }
  })().then(respond, () => respond({ok: false, error: '扩展操作失败，请重试'}));
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab?.id)) return;
  try {
    if (!await ready) throw new Error('init');
    if (!['http:', 'https:'].includes(new URL(tab.url).protocol)) throw new Error('restricted');
    await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['core.js', 'content.js'], world: 'ISOLATED'});
    await chrome.action.setBadgeText({tabId: tab.id, text: ''});
    await chrome.action.setTitle({tabId: tab.id, title: '打开 Page Agent 页面助手'});
  } catch {
    await Promise.allSettled([
      chrome.action.setBadgeText({tabId: tab.id, text: '!'}),
      chrome.action.setTitle({tabId: tab.id, title: '无法注入：请使用普通 HTTP/HTTPS 网页；浏览器内部页、商店页等受保护页面不支持。也可在扩展详情中打开设置。'})
    ]);
  }
});
