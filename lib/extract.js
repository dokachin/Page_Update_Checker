// HTML ドキュメントから「更新チェック対象のテキスト」を取り出す。
// DOM が必要なので offscreen ドキュメントから呼ぶ（テストでは jsdom の Document を渡す）。

import { normalizeLines } from './util.js';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'thead', 'tfoot', 'tr', 'ul',
]);
const CELL = new Set(['td', 'th']);

function walk(node, out) {
  if (node.nodeType === 3) {
    out.push(node.nodeValue);
    return;
  }
  if (node.nodeType !== 1) return;
  const name = node.localName;
  if (SKIP.has(name)) return;
  if (name === 'br') {
    out.push('\n');
    return;
  }
  if (name === 'img') {
    const alt = node.getAttribute('alt');
    if (alt) out.push(` ${alt} `);
    return;
  }
  const block = BLOCK.has(name);
  if (block) out.push('\n');
  for (const child of node.childNodes) walk(child, out);
  if (CELL.has(name)) out.push(' ');
  if (block) out.push('\n');
}

export function parseDocument(doc, selector, ignoreSelector) {
  const title = (doc.title || '').replace(/\s+/g, ' ').trim();
  const metaEl = doc.querySelector('meta[name="WWWC" i]');
  const meta = metaEl ? metaEl.getAttribute('content') : null;

  if (ignoreSelector) {
    let targets;
    try {
      targets = doc.querySelectorAll(ignoreSelector);
    } catch {
      throw new Error(`除外セレクタが不正です: ${ignoreSelector}`);
    }
    targets.forEach((e) => e.remove());
  }

  let roots;
  if (selector) {
    try {
      roots = [...doc.querySelectorAll(selector)];
    } catch {
      throw new Error(`範囲セレクタが不正です: ${selector}`);
    }
    if (!roots.length) throw new Error(`範囲セレクタに一致する要素がありません: ${selector}`);
  } else {
    roots = [doc.body || doc.documentElement];
  }

  const out = [];
  for (const root of roots) {
    walk(root, out);
    out.push('\n');
  }
  return { title, meta, text: normalizeLines(out.join('')) };
}
