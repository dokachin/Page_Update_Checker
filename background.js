// Service Worker: 定期チェック・更新判定・通知・バッジ・各画面からの操作受付
import { getItems, setItems, getSettings, setSettings, DEFAULT_SETTINGS } from './lib/store.js';
import { sha256Hex, decodeBody, applyFilters, collectPatterns, normalizeLines, uid } from './lib/util.js';
import { addSnap, latestSnap, deleteSnaps, clipText } from './lib/archive.js';
import { diffLines, countChanges } from './lib/diff.js';

const ALARM = 'tick';
const METHODS = ['content', 'lastmod', 'size', 'meta'];

// ---------------------------------------------------------------- 排他制御
// items 配列の「読む→書く」が並列チェックで競合しないよう、書き込みは1本ずつ実行する
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

// 同時取得数の上限は「呼び出し単位」ではなく全体で守る（定期チェックと手動・インポートが重なっても超えない）
let running = 0;
const waiters = [];
async function withSlot(limit, fn) {
  const max = Math.max(1, limit | 0);
  while (running >= max) await new Promise((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

const inFlight = new Set(); // チェック中のアイテムID
const recheck = new Set(); // チェック中に設定が変わり、完了後に取り直すアイテムID

// 設定変更（基準リセット）のたびに rev を進める。チェック開始時の rev と一致しない結果は破棄する
const bumpRev = (it) => {
  it.rev = (it.rev || 0) + 1;
};

// ---------------------------------------------------------------- エラー整形
function errMsg(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'タイムアウトしました';
  // ネットワーク失敗は doFetch が NetworkError に変換する。それ以外の TypeError はコード不具合なので原文を表示
  return e?.message || String(e);
}

function httpError(res) {
  let m = `HTTP ${res.status} ${res.statusText}`.trim();
  if (res.status === 401 || res.status === 403) m += '（ログインが必要な場合は、ブラウザでログインしてください）';
  return new Error(m);
}

// ---------------------------------------------------------------- HTML 解析（offscreen）
let creatingOffscreen;
const hasOffscreen = async () =>
  (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'HTMLを解析して更新チェック対象のテキストを取り出すため',
      })
      .catch(async (e) => {
        // 並列呼び出しの競合で、他方が先に作成済みなら成功扱い
        if (await hasOffscreen()) return;
        throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function parseHtml(html, selector, ignoreSelector) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse', html, selector, ignoreSelector });
  if (!res?.ok) throw new Error(res?.error || 'HTMLの解析に失敗しました');
  return res;
}

// ---------------------------------------------------------------- 取得
const MAX_BYTES = 20 * 1024 * 1024; // 本文の取得上限（メモリ保護）

async function doFetch(url, method, timeoutSec) {
  const signal = AbortSignal.timeout(timeoutSec * 1000); // 不正な値の TypeError はここで素通しさせる
  try {
    return await fetch(url, {
      method,
      credentials: 'include', // ブラウザのログイン状態（Cookie）を使う
      cache: 'no-store',
      redirect: 'follow',
      signal,
    });
  } catch (e) {
    if (e?.name === 'TypeError') {
      const ne = new Error('ネットワークエラー（接続できません）');
      ne.name = 'NetworkError';
      ne.cause = e;
      throw ne;
    }
    throw e;
  }
}

// 本文を上限付きで取得（超えたら中断）
async function readCapped(res, max) {
  if (!res.body) return res.arrayBuffer();
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new Error(`ページが大きすぎます（上限 ${max / 1024 / 1024}MB）`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

// サイズ方式用: 本文を保持せずバイト数だけ数える（従来と同じ値）
async function countBytes(res) {
  if (!res.body) return (await res.arrayBuffer()).byteLength;
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

// 方式ごとに「現在の状態」を取得 → { signature, text, title? }
async function measure(item, settings) {
  const timeout = settings.timeoutSec;

  if (item.method === 'lastmod') {
    let lm = null;
    try {
      const head = await doFetch(item.url, 'HEAD', timeout);
      if (head.ok) lm = head.headers.get('last-modified');
    } catch {
      /* HEAD 非対応サーバーは GET にフォールバック */
    }
    if (!lm) {
      const res = await doFetch(item.url, 'GET', timeout);
      if (!res.ok) throw httpError(res);
      lm = res.headers.get('last-modified');
      res.body?.cancel();
    }
    if (!lm) throw new Error('Last-Modified ヘッダーが取得できません（方式を「内容」に変更してください）');
    return { signature: lm, text: `更新日時: ${lm}` };
  }

  const res = await doFetch(item.url, 'GET', timeout);
  if (!res.ok) throw httpError(res);
  const contentType = res.headers.get('content-type') || '';

  if (item.method === 'size') {
    const bytes = await countBytes(res);
    return { signature: String(bytes), text: `サイズ: ${bytes} bytes` };
  }
  const buf = await readCapped(res, MAX_BYTES);

  const isHtml = /html/i.test(contentType) || !contentType;
  const isText = /^text\/|json|javascript|xml|csv/i.test(contentType);

  // PDF・画像などのバイナリは中身のハッシュで比較
  if (!isHtml && !isText) {
    if (item.method === 'meta') throw new Error('HTMLではないため METAタグ方式は使えません');
    const hash = await sha256Hex(buf);
    return { signature: hash, text: `バイナリ (${buf.byteLength} bytes) SHA-256: ${hash.slice(0, 16)}` };
  }

  const body = decodeBody(buf, contentType);
  let text;
  let title;
  let meta = null;
  if (isHtml) {
    const forContent = item.method === 'content';
    const parsed = await parseHtml(body, forContent ? item.selector : '', forContent ? item.ignoreSelector : '');
    ({ text, title, meta } = parsed);
  } else {
    text = normalizeLines(body);
  }

  if (item.method === 'meta') {
    if (meta == null) throw new Error('<meta name="WWWC"> がありません（方式を「内容」に変更してください）');
    return { signature: meta, text: `WWWC META: ${meta}`, title };
  }

  text = applyFilters(text, collectPatterns(settings.globalFilter, item.filter));
  if (!text) {
    throw new Error('チェック対象のテキストを取得できませんでした（JavaScriptで描画されるページ、または全文がフィルタで除かれています）');
  }
  return { signature: await sha256Hex(text), text, title };
}

// ---------------------------------------------------------------- 更新メッセージ
function buildMessage(item, result, prev) {
  switch (item.method) {
    case 'lastmod':
      return `更新日時が変わりました: ${result.signature}`;
    case 'size':
      return `サイズが変わりました: ${item.signature} → ${result.signature} bytes`;
    case 'meta':
      return `META: ${result.signature}`;
    default: {
      if (!prev?.text) return '内容が変わりました';
      const ops = diffLines(prev.text, result.text);
      const { add, del } = countChanges(ops);
      const firstAdd = ops.find((o) => o.t === '+')?.s;
      let m = `追加${add}行・削除${del}行`;
      if (firstAdd) m += `：${firstAdd.slice(0, 60)}`;
      return m;
    }
  }
}

// ---------------------------------------------------------------- 1件チェック
// force: 設定変更による基準の取り直し。チェック中だった場合は完了後にもう一度実行する
async function checkItem(id, { force = false } = {}) {
  if (inFlight.has(id)) {
    if (force) recheck.add(id);
    return null;
  }
  inFlight.add(id);
  try {
    let r;
    do {
      r = await checkItemOnce(id);
    } while (recheck.delete(id));
    return r;
  } finally {
    inFlight.delete(id);
  }
}

async function checkItemOnce(id) {
  {
    const settings = await getSettings();
    const item = (await getItems()).find((i) => i.id === id);
    if (!item) return null;
    const rev = item.rev || 0;

    let result;
    try {
      result = await withSlot(settings.concurrency, () => measure(item, settings));
    } catch (e) {
      await patchItem(id, (it) => {
        if ((it.rev || 0) !== rev) return; // 測定中に設定が変わった → 古い設定のエラーは破棄
        it.status = 'error';
        it.error = errMsg(e);
        it.lastCheck = Date.now();
      });
      return { id, error: true };
    }

    // 保存・差分に使うテキストは同じ長さに切り詰める（判定用の signature は全文から計算済み）
    result.text = clipText(result.text);
    const prev = await latestSnap(id);
    let outcome = { id, changed: false };

    await withLock(async () => {
      const items = await getItems();
      const it = items.find((i) => i.id === id);
      if (!it) return;
      if ((it.rev || 0) !== rev) return; // 測定中に設定が変わった → 古い設定の結果は破棄（recheck で取り直す）
      const now = Date.now();
      it.lastCheck = now;
      it.error = '';
      if (!it.title && result.title) it.title = result.title;

      if (it.signature == null) {
        // 初回（または設定変更後）: 基準を保存するだけで通知しない
        it.signature = result.signature;
        it.status = it.unread ? 'updated' : 'ok';
        it.message = it.unread ? it.message : '基準を保存しました';
        await addSnap(id, { ts: now, text: result.text, signature: result.signature }, settings.archiveKeep);
      } else if (it.signature !== result.signature) {
        const message = buildMessage(it, result, prev);
        it.signature = result.signature;
        it.status = 'updated';
        it.unread = true;
        it.lastUpdate = now;
        it.message = message;
        await addSnap(id, { ts: now, text: result.text, signature: result.signature }, settings.archiveKeep);
        outcome = { id, changed: true, title: it.title, url: it.url, message };
      } else if (it.status === 'error' || it.status === 'new') {
        it.status = it.unread ? 'updated' : 'ok';
      }
      await setItems(items);
    });
    return outcome;
  }
}

// 複数件を並列数を絞ってチェック
async function checkMany(ids, opts) {
  const settings = await getSettings();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const r = await checkItem(id, opts).catch((e) => ({ id, error: true, detail: errMsg(e) }));
      if (r) results.push(r);
    }
  };
  const n = Math.min(Math.max(1, settings.concurrency), ids.length);
  await Promise.all(Array.from({ length: n }, worker));
  await updateBadge();
  const updated = results.filter((r) => r.changed);
  if (updated.length && settings.notify) await notifyUpdates(updated);
  return results;
}

// ---------------------------------------------------------------- アイテム更新ヘルパ
function patchItem(id, fn) {
  return withLock(async () => {
    const items = await getItems();
    const it = items.find((i) => i.id === id);
    if (!it) return;
    fn(it);
    await setItems(items);
  });
}

// ---------------------------------------------------------------- バッジ・通知
async function updateBadge() {
  const items = await getItems();
  const n = items.filter((i) => i.unread).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setTitle({ title: n ? `ページ更新チェッカー（未読の更新 ${n}件）` : 'ページ更新チェッカー' });
}

async function notifyUpdates(list) {
  const base = { type: 'basic', iconUrl: 'icons/icon128.png' };
  if (list.length <= 3) {
    for (const u of list) {
      chrome.notifications.create(`item:${u.id}`, {
        ...base,
        title: `更新あり: ${u.title || u.url}`.slice(0, 80),
        message: u.message || '更新されました',
      });
    }
  } else {
    chrome.notifications.create(`summary:${Date.now()}`, {
      ...base,
      title: `${list.length}件のページが更新されました`,
      message: list.slice(0, 3).map((u) => u.title || u.url).join(' / '),
    });
  }
}

chrome.notifications.onClicked.addListener(async (nid) => {
  chrome.notifications.clear(nid);
  if (nid.startsWith('item:')) {
    const id = nid.slice(5);
    const it = (await getItems()).find((i) => i.id === id);
    if (it) {
      chrome.tabs.create({ url: it.url });
      await markRead([id]);
    }
  } else {
    chrome.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------- 操作（各画面からのメッセージ）
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`URLが不正です: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http / https のURLのみ登録できます');
  return u.href;
}

function cleanInterval(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0; // 0 = 手動のみ
  return Math.max(1, Math.round(n));
}

// check: false のときは初回チェックを起動しない（インポートなど、呼び出し側でまとめてチェックする場合）
async function addItem(data, { check = true } = {}) {
  const settings = await getSettings();
  const url = normalizeUrl(data.url);
  const method = METHODS.includes(data.method) ? data.method : 'content';
  const selector = (data.selector || '').trim();

  let created;
  let existed = false;
  await withLock(async () => {
    const items = await getItems();
    const dup = items.find((i) => i.url === url && (i.selector || '') === selector && i.method === method);
    if (dup) {
      created = dup;
      existed = true;
      return;
    }
    created = {
      id: uid(),
      url,
      title: (data.title || '').trim(),
      folder: (data.folder || '').trim(),
      method,
      selector,
      ignoreSelector: (data.ignoreSelector || '').trim(),
      filter: data.filter || '',
      interval: cleanInterval(data.interval, settings.defaultInterval),
      enabled: data.enabled !== false,
      createdAt: Date.now(),
      rev: 0,
      lastCheck: 0,
      lastUpdate: 0,
      signature: null,
      status: 'new',
      unread: false,
      message: '',
      error: '',
    };
    items.push(created);
    await setItems(items);
  });
  if (!existed && check && created.enabled) checkItem(created.id).then(updateBadge).catch(() => {});
  return { ok: true, item: created, existed };
}

const RESET_FIELDS = ['url', 'method', 'selector', 'ignoreSelector', 'filter'];

async function updateItem(id, patch) {
  let resetNeeded = false;
  await withLock(async () => {
    const items = await getItems();
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error('アイテムが見つかりません');
    if (patch.url != null) patch.url = normalizeUrl(patch.url);
    if (patch.method != null && !METHODS.includes(patch.method)) throw new Error('方式が不正です');
    for (const k of ['url', 'title', 'folder', 'method', 'selector', 'ignoreSelector', 'filter', 'enabled']) {
      if (patch[k] === undefined) continue;
      const v = typeof patch[k] === 'string' && k !== 'filter' ? patch[k].trim() : patch[k];
      if (RESET_FIELDS.includes(k) && (it[k] ?? '') !== v) resetNeeded = true;
      it[k] = v;
    }
    if (patch.interval !== undefined) it.interval = cleanInterval(patch.interval, it.interval);
    if (resetNeeded) {
      bumpRev(it);
      it.signature = null; // 基準を取り直す（誤検知を防ぐ）
      it.status = 'new';
      it.unread = false;
      it.error = '';
      it.message = '設定を変更したため、基準を取り直します';
    }
    await setItems(items);
  });
  if (resetNeeded) checkItem(id, { force: true }).then(updateBadge).catch(() => {});
  await updateBadge();
  return { ok: true };
}

async function deleteItems(ids) {
  await withLock(async () => {
    const set = new Set(ids);
    const items = await getItems();
    await setItems(items.filter((i) => !set.has(i.id)));
  });
  await Promise.all(ids.map((id) => deleteSnaps(id).catch(() => {})));
  await updateBadge();
  return { ok: true };
}

async function markRead(ids) {
  await withLock(async () => {
    const items = await getItems();
    const set = ids ? new Set(ids) : null;
    for (const it of items) {
      if (set && !set.has(it.id)) continue;
      it.unread = false;
      if (it.status === 'updated') it.status = 'ok';
    }
    await setItems(items);
  });
  await updateBadge();
  return { ok: true };
}

async function importData({ data, urls }) {
  const list = [];
  if (Array.isArray(data?.items)) {
    for (const i of data.items) if (i?.url) list.push(i);
  }
  for (const u of urls || []) list.push({ url: u });

  let added = 0;
  let skipped = 0;
  const errors = [];
  // 設定は手動保存と同じ経路（値の検証・共通フィルタ変更時の基準取り直し）で先に反映する
  if (data?.settings && typeof data.settings === 'object') {
    try {
      await saveSettings(data.settings);
    } catch (e) {
      errors.push(`設定: ${errMsg(e)}`);
    }
  }
  const newIds = [];
  for (const i of list) {
    try {
      const r = await addItem(i, { check: false });
      if (r.existed) skipped++;
      else {
        added++;
        if (r.item.enabled) newIds.push(r.item.id);
      }
    } catch (e) {
      errors.push(errMsg(e));
    }
  }
  // 初回チェックは同時実行数を守ってまとめて行う（完了を待たずに応答する）
  if (newIds.length) checkMany(newIds).catch(() => {});
  return { ok: true, added, skipped, errors };
}

function pickSettings(s) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

async function saveSettings(input) {
  const old = await getSettings();
  const next = { ...old, ...pickSettings(input) };
  next.defaultInterval = cleanInterval(next.defaultInterval, old.defaultInterval);
  next.concurrency = Math.min(10, Math.max(1, Math.round(Number(next.concurrency)) || old.concurrency));
  next.archiveKeep = Math.min(200, Math.max(1, Math.round(Number(next.archiveKeep)) || old.archiveKeep));
  next.timeoutSec = Math.min(120, Math.max(5, Math.round(Number(next.timeoutSec)) || old.timeoutSec));
  next.notify = !!next.notify;
  next.globalFilter = String(next.globalFilter || '');
  await setSettings(next);

  // 共通フィルタが変わると全ページの比較結果が変わるため、基準を取り直す
  if (old.globalFilter !== next.globalFilter) {
    await withLock(async () => {
      const items = await getItems();
      for (const it of items) {
        if (it.method !== 'content') continue;
        bumpRev(it);
        it.signature = null;
        it.status = 'new';
        // 未読の更新は保持する（取り直し完了時に checkItem が unread を見て状態を復元する）
        if (!it.unread) it.message = '共通フィルタを変更したため、基準を取り直します';
      }
      await setItems(items);
    });
    const ids = (await getItems()).filter((i) => i.method === 'content').map((i) => i.id);
    checkMany(ids, { force: true }).catch(() => {});
  }
  return { ok: true };
}

async function handle(msg) {
  switch (msg.type) {
    case 'add':
      return addItem(msg);
    case 'update':
      return updateItem(msg.id, msg.patch || {});
    case 'delete':
      return deleteItems(msg.ids || []);
    case 'read':
      return markRead(msg.ids || null);
    case 'check': {
      const items = await getItems();
      const ids = msg.ids?.length ? msg.ids : items.filter((i) => i.enabled).map((i) => i.id);
      const results = await checkMany(ids);
      return { ok: true, checked: results.length, updated: results.filter((r) => r.changed).length };
    }
    case 'import':
      return importData(msg);
    case 'settings':
      return saveSettings(msg.settings || {});
    default:
      return { ok: false, error: `不明な操作: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
  return true; // 非同期で応答
});

// ---------------------------------------------------------------- 定期実行
async function tick() {
  const items = await getItems();
  const now = Date.now();
  const due = items
    .filter((i) => i.enabled && i.interval > 0 && now - (i.lastCheck || 0) >= i.interval * 60_000 - 5_000)
    .map((i) => i.id);
  if (due.length) await checkMany(due);
}

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  chrome.contextMenus.create({
    id: 'add-page',
    title: 'このページを更新チェックに追加',
    contexts: ['page', 'link'],
  });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'add-page') return;
  const url = info.linkUrl || info.pageUrl || tab?.url;
  try {
    const r = await addItem({ url, title: info.linkUrl ? '' : tab?.title || '' });
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: r.existed ? '登録済みです' : '更新チェックに追加しました',
      message: r.item.title || r.item.url,
    });
  } catch (e) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: '追加できません', message: errMsg(e) });
  }
});

ensureAlarm();
