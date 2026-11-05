// 管理画面。表示は storage / IndexedDB を直接読み、変更操作は background にメッセージで依頼する。
import { getItems, getSettings } from './lib/store.js';
import { listSnaps } from './lib/archive.js';
import { diffLines } from './lib/diff.js';
import { fmtDate } from './lib/util.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);

const METHOD_LABEL = { content: '内容', lastmod: '更新日時', size: 'サイズ', meta: 'METAタグ' };
const STATUS_LABEL = { ok: '更新なし', updated: '更新あり（未読）', new: '未チェック', error: 'エラー' };

let items = [];
let settings = {};
let editingId = null;
const selected = new Set();
const busy = new Set();

// ---------------------------------------------------------------- 小道具
// 外部ページ由来の文字列を扱うので、HTML ではなく必ず textContent で挿入する
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function call(msg) {
  try {
    const r = await send(msg);
    if (r && r.ok === false) throw new Error(r.error || '失敗しました');
    return r;
  } catch (e) {
    toast(`エラー: ${e.message}`);
    throw e;
  }
}

const fmtFull = (ts) => new Date(ts).toLocaleString('ja-JP', { hour12: false });

// ---------------------------------------------------------------- 一覧
function visibleItems() {
  const q = $('#q').value.trim().toLowerCase();
  const folder = $('#folderFilter').value;
  const unreadOnly = $('#onlyUnread').checked;
  const sort = $('#sort').value;

  const list = items.filter((it) => {
    if (unreadOnly && !it.unread) return false;
    if (folder === '__none__' && it.folder) return false;
    if (folder && folder !== '__none__' && !(it.folder === folder || it.folder.startsWith(`${folder}/`))) return false;
    if (q) {
      const hay = [it.title, it.url, it.message, it.error, it.folder].join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const by = {
    created: (a, b) => a.createdAt - b.createdAt,
    updated: (a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0),
    title: (a, b) => (a.title || a.url).localeCompare(b.title || b.url, 'ja'),
    folder: (a, b) => a.folder.localeCompare(b.folder, 'ja') || a.createdAt - b.createdAt,
  }[sort];
  return list.sort(by);
}

function rebuildFolderUi() {
  const folders = [...new Set(items.map((i) => i.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const sel = $('#folderFilter');
  const cur = sel.value;
  sel.replaceChildren(
    h('option', { value: '', text: 'すべてのフォルダ' }),
    h('option', { value: '__none__', text: '（フォルダなし）' }),
    ...folders.map((f) => h('option', { value: f, text: f })),
  );
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  $('#folderList').replaceChildren(...folders.map((f) => h('option', { value: f })));
}

function rowFor(it) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = selected.has(it.id);
  cb.addEventListener('change', () => {
    if (cb.checked) selected.add(it.id);
    else selected.delete(it.id);
    renderBulk();
  });

  const title = h('a', { class: 'ttl', href: it.url, text: it.title || it.url });
  title.addEventListener('click', (e) => {
    e.preventDefault();
    openItem(it);
  });

  const msg = it.status === 'error' ? h('span', { class: 'errtxt', text: it.error }) : h('span', { text: it.message || '' });
  const meth = `${METHOD_LABEL[it.method] || it.method} / ${it.interval ? `${it.interval}分` : '手動'}${it.enabled ? '' : '（停止）'}`;

  const actions = h(
    'td',
    { class: 'c-act' },
    h('button', { class: 'icon', text: busy.has(it.id) ? '確認中…' : 'チェック', disabled: busy.has(it.id), onclick: () => checkOne(it.id) }),
    ' ',
    h('button', { class: 'icon', text: '履歴', onclick: () => openHistory(it) }),
    ' ',
    h('button', { class: 'icon', text: '編集', onclick: () => openEdit(it) }),
    ' ',
    h('button', { class: 'icon danger', text: '削除', onclick: () => removeItems([it.id], it.title || it.url) }),
  );

  return h(
    'tr',
    { class: [it.unread && 'unread', !it.enabled && 'disabled', busy.has(it.id) && 'busy'].filter(Boolean).join(' ') },
    h('td', { class: 'c-sel' }, cb),
    h('td', { class: 'c-st' }, h('span', { class: `dot ${it.status}`, title: STATUS_LABEL[it.status] || '' })),
    h('td', { class: 'c-title' }, title, h('div', { class: 'url', title: it.url, text: it.url })),
    h('td', { class: 'c-folder', text: it.folder }),
    h('td', { class: 'c-msg' }, msg),
    h('td', { class: 'c-date', text: it.lastUpdate ? fmtDate(it.lastUpdate) : '—' }),
    h('td', { class: 'c-date', text: fmtDate(it.lastCheck) }),
    h('td', { class: 'c-meth', text: meth }),
    actions,
  );
}

function render() {
  rebuildFolderUi();
  const list = visibleItems();
  $('#rows').replaceChildren(...list.map(rowFor));
  $('#empty').hidden = items.length > 0;
  $('#tbl').hidden = items.length === 0;
  const unread = items.filter((i) => i.unread).length;
  $('#count').textContent = items.length ? `${list.length} / ${items.length}件（未読 ${unread}）` : '';
  $('#selAll').checked = list.length > 0 && list.every((i) => selected.has(i.id));
  renderBulk();
}

function renderBulk() {
  $('#bulk').hidden = selected.size === 0;
  $('#bulkCount').textContent = `${selected.size}件選択中`;
}

async function reload() {
  [items, settings] = await Promise.all([getItems(), getSettings()]);
  for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);
  render();
}

let reloadTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.items || changes.settings)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 150);
});

// ---------------------------------------------------------------- 操作
function openItem(it) {
  chrome.tabs.create({ url: it.url });
  if (it.unread) send({ type: 'read', ids: [it.id] });
}

async function checkIds(ids, label) {
  ids.forEach((id) => busy.add(id));
  render();
  try {
    const r = await call({ type: 'check', ids });
    toast(`${label}: ${r.checked}件チェック、${r.updated}件に更新あり`);
  } catch {
    /* call 内で通知済み */
  } finally {
    ids.forEach((id) => busy.delete(id));
    render();
  }
}

const checkOne = (id) => checkIds([id], 'チェック');

async function removeItems(ids, name) {
  const msg = ids.length === 1 ? `「${name}」を削除しますか？\n（アーカイブも削除されます）` : `${ids.length}件を削除しますか？\n（アーカイブも削除されます）`;
  if (!confirm(msg)) return;
  await call({ type: 'delete', ids }).catch(() => {});
  ids.forEach((id) => selected.delete(id));
}

$('#btnAdd').onclick = () => openEdit(null);
$('#btnCheckAll').onclick = async () => {
  const b = $('#btnCheckAll');
  b.disabled = true;
  b.textContent = '確認中…';
  const ids = items.filter((i) => i.enabled).map((i) => i.id);
  await checkIds(ids, 'すべてチェック');
  b.disabled = false;
  b.textContent = 'すべてチェック';
};
$('#btnReadAll').onclick = () => call({ type: 'read' }).catch(() => {});

$('#bulkCheck').onclick = () => checkIds([...selected], 'チェック');
$('#bulkRead').onclick = () => call({ type: 'read', ids: [...selected] }).catch(() => {});
$('#bulkDelete').onclick = () => removeItems([...selected]);
$('#bulkClear').onclick = () => {
  selected.clear();
  render();
};
$('#selAll').onchange = (e) => {
  for (const it of visibleItems()) {
    if (e.target.checked) selected.add(it.id);
    else selected.delete(it.id);
  }
  render();
};

for (const id of ['#q', '#folderFilter', '#sort', '#onlyUnread']) {
  $(id).addEventListener('input', render);
  $(id).addEventListener('change', render);
}

// ---------------------------------------------------------------- 追加・編集
const updateMethodUi = () => {
  $('#contentOpts').hidden = $('#fMethod').value !== 'content';
};
$('#fMethod').addEventListener('change', updateMethodUi);

function openEdit(it) {
  editingId = it?.id || null;
  $('#editTitle').textContent = it ? '編集' : '追加';
  $('#fUrl').value = it?.url || '';
  $('#fTitle').value = it?.title || '';
  $('#fFolder').value = it?.folder || ($('#folderFilter').value && !$('#folderFilter').value.startsWith('__') ? $('#folderFilter').value : '');
  $('#fInterval').value = it ? it.interval : settings.defaultInterval;
  $('#fMethod').value = it?.method || 'content';
  $('#fSelector').value = it?.selector || '';
  $('#fIgnore').value = it?.ignoreSelector || '';
  $('#fFilter').value = it?.filter || '';
  $('#fEnabled').checked = it ? it.enabled : true;
  $('#editErr').hidden = true;
  updateMethodUi();
  $('#dlgEdit').showModal();
  $('#fUrl').focus();
}

$('#editCancel').onclick = () => $('#dlgEdit').close();
$('#formEdit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const interval = $('#fInterval').value.trim();
  const data = {
    url: $('#fUrl').value,
    title: $('#fTitle').value,
    folder: $('#fFolder').value,
    interval: interval === '' ? settings.defaultInterval : Number(interval),
    method: $('#fMethod').value,
    selector: $('#fSelector').value,
    ignoreSelector: $('#fIgnore').value,
    filter: $('#fFilter').value,
    enabled: $('#fEnabled').checked,
  };
  const msg = editingId ? { type: 'update', id: editingId, patch: data } : { type: 'add', ...data };
  $('#editSave').disabled = true;
  try {
    const r = await send(msg);
    if (!r?.ok) throw new Error(r?.error || '保存に失敗しました');
    $('#dlgEdit').close();
    if (r.existed) toast('同じ設定のアイテムが既に登録されています');
  } catch (err) {
    $('#editErr').textContent = err.message;
    $('#editErr').hidden = false;
  } finally {
    $('#editSave').disabled = false;
  }
});

// ---------------------------------------------------------------- 履歴（アーカイブと差分）
const hist = { snaps: [], cur: 0 };

async function openHistory(it) {
  $('#histTitle').textContent = `履歴: ${it.title || it.url}`;
  $('#histFull').checked = false;
  hist.snaps = await listSnaps(it.id);
  hist.cur = hist.snaps.length - 1;
  const ul = $('#histList');
  ul.replaceChildren();
  if (!hist.snaps.length) {
    $('#histInfo').textContent = '';
    $('#histBody').replaceChildren(h('span', { class: 'ln skip', text: 'アーカイブはまだありません（チェックが完了すると保存されます）' }));
  } else {
    hist.snaps
      .map((s, idx) => ({ s, idx }))
      .reverse()
      .forEach(({ s, idx }) => {
        ul.append(
          h('li', {
            'data-idx': idx,
            text: `${fmtFull(s.ts)}${idx === 0 ? '（基準）' : ''}`,
            onclick: () => {
              hist.cur = idx;
              renderHist();
            },
          }),
        );
      });
    renderHist();
  }
  $('#dlgHistory').showModal();
}

function renderHist() {
  const { snaps, cur } = hist;
  const s = snaps[cur];
  const prev = snaps[cur - 1];
  const body = $('#histBody');
  body.replaceChildren();
  for (const li of $('#histList').children) li.classList.toggle('sel', Number(li.dataset.idx) === cur);
  $('#histInfo').textContent = prev ? `${fmtFull(prev.ts)} → ${fmtFull(s.ts)} の差分` : '基準（最初のアーカイブ）';

  if ($('#histFull').checked || !prev) {
    for (const line of s.text.split('\n')) body.append(h('span', { class: 'ln same', text: line }));
    return;
  }

  const ops = diffLines(prev.text, s.text);
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === '=') return;
    for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) show[k] = true;
  });
  let skipped = 0;
  const flush = () => {
    if (skipped) body.append(h('span', { class: 'ln skip', text: `… ${skipped}行 変更なし …` }));
    skipped = 0;
  };
  ops.forEach((o, i) => {
    if (!show[i]) {
      skipped++;
      return;
    }
    flush();
    body.append(h('span', { class: `ln ${o.t === '+' ? 'add' : o.t === '-' ? 'del' : 'same'}`, text: o.s }));
  });
  flush();
  if (!ops.some((o) => o.t !== '=')) body.append(h('span', { class: 'ln skip', text: '差分なし' }));
}

$('#histFull').onchange = () => hist.snaps.length && renderHist();
$('#histClose').onclick = () => $('#dlgHistory').close();

// ---------------------------------------------------------------- 設定
$('#btnSettings').onclick = () => {
  $('#sInterval').value = settings.defaultInterval;
  $('#sConc').value = settings.concurrency;
  $('#sKeep').value = settings.archiveKeep;
  $('#sTimeout').value = settings.timeoutSec;
  $('#sNotify').checked = settings.notify;
  $('#sFilter').value = settings.globalFilter;
  $('#dlgSettings').showModal();
};
$('#setCancel').onclick = () => $('#dlgSettings').close();
$('#formSettings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {
    defaultInterval: Number($('#sInterval').value),
    concurrency: Number($('#sConc').value),
    archiveKeep: Number($('#sKeep').value),
    timeoutSec: Number($('#sTimeout').value),
    notify: $('#sNotify').checked,
    globalFilter: $('#sFilter').value,
  };
  if (next.globalFilter !== settings.globalFilter && items.some((i) => i.method === 'content')) {
    if (!confirm('共通フィルタを変更すると、「内容」方式の全ページで基準を取り直します。\n（取り直し中は更新通知は出ません）\n続けますか？')) return;
  }
  try {
    await call({ type: 'settings', settings: next });
    $('#dlgSettings').close();
  } catch {
    /* call 内で通知済み */
  }
});

// ---------------------------------------------------------------- インポート / エクスポート
$('#btnExport').onclick = async () => {
  const data = {
    format: 'page-update-checker',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: items.map(({ url, title, folder, method, selector, ignoreSelector, filter, interval, enabled }) => ({
      url, title, folder, method, selector, ignoreSelector, filter, interval, enabled,
    })),
    settings,
  };
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = h('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
    download: `page-update-checker-${ymd}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`${items.length}件をエクスポートしました`);
};

$('#btnImport').onclick = () => $('#file').click();
$('#file').addEventListener('change', async () => {
  const f = $('#file').files[0];
  $('#file').value = '';
  if (!f) return;
  const text = await f.text();
  let msg;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.items)) msg = { type: 'import', data: parsed };
  } catch {
    /* JSON ではない → URL一覧として扱う */
  }
  if (!msg) {
    const urls = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    msg = { type: 'import', urls };
  }
  const r = await call(msg).catch(() => null);
  if (r) toast(`インポート: ${r.added}件追加、${r.skipped}件は登録済み${r.errors?.length ? `、${r.errors.length}件エラー` : ''}`);
});

// ---------------------------------------------------------------- ドラッグ＆ドロップでURL追加
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  const text = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
  const urls = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!urls.length) return toast('URLを取得できませんでした');
  const r = await call({ type: 'import', urls }).catch(() => null);
  if (r) toast(`${r.added}件を追加しました${r.skipped ? `（${r.skipped}件は登録済み）` : ''}`);
});

reload();
