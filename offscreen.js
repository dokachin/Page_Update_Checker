// Service Worker には DOM がないため、HTML の解析はこの offscreen ドキュメントで行う。
import { parseDocument } from './lib/extract.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'parse') return false;
  try {
    // DOMParser で作った文書は不活性（スクリプト実行・画像読み込みなし）
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    sendResponse({ ok: true, ...parseDocument(doc, msg.selector, msg.ignoreSelector) });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return false;
});
