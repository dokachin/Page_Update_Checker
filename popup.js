import { getItems, getSettings } from './lib/store.js';
import { hostOf } from './lib/util.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);

const METHOD_LABEL = { content: '内容', lastmod: '更新日時', size: 'サイズ', meta: 'METAタグ' };

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let items = await getItems();
const settings = await getSettings();

function say(text) {
  const el = $('#msg');
  el.textContent = text;
  el.hidden = !text;
}

// ---------------------------------------------------------------- 表示中のページ
function renderCurrent() {
  const url = tab?.url || '';
  const ok = /^https?:\/\//i.test(url);
  $('#curTitle').textContent = tab?.title || hostOf(url) || '（タブなし）';
  $('#curUrl').textContent = url;
  $('#unsupported').hidden = ok;
  const reg = ok ? items.find((i) => i.url === url) : null;
  const note = $('#registered');
  if (reg) {
    note.hidden = false;
    note.textContent = `登録済み（${reg.folder ? `${reg.folder} / ` : ''}${METHOD_LABEL[reg.method] || reg.method}）`;
  } else {
    note.hidden = true;
  }
  $('#form').hidden = !ok || !!reg;
}

const folders = [...new Set(items.map((i) => i.folder).filter(Boolean))];
$('#folderList').replaceChildren(
  ...folders.map((f) => {
    const o = document.createElement('option');
    o.value = f;
    return o;
  }),
);
$('#fInterval').value = settings.defaultInterval;

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btnAdd');
  btn.disabled = true;
  try {
    const interval = $('#fInterval').value.trim();
    const r = await send({
      type: 'add',
      url: tab.url,
      title: tab.title || '',
      folder: $('#fFolder').value,
      method: $('#fMethod').value,
      interval: interval === '' ? settings.defaultInterval : Number(interval),
    });
    if (!r?.ok) throw new Error(r?.error || '追加に失敗しました');
    items = await getItems();
    renderCurrent();
    say('追加しました。初回チェックの結果は管理画面で確認できます。');
  } catch (err) {
    say(`エラー: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- 未読の更新
function renderUnread() {
  const unread = items.filter((i) => i.unread);
  $('#unreadCount').textContent = unread.length ? `（${unread.length}件）` : '';
  const ul = $('#unread');
  ul.replaceChildren();
  if (!unread.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = '未読の更新はありません';
    ul.append(li);
    return;
  }
  for (const it of unread.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0)).slice(0, 12)) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title || it.url;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = it.message || '';
    li.append(t, m);
    li.addEventListener('click', async () => {
      chrome.tabs.create({ url: it.url });
      await send({ type: 'read', ids: [it.id] });
      items = await getItems();
      renderUnread();
    });
    ul.append(li);
  }
}

// ---------------------------------------------------------------- フッターのボタン
$('#btnCheck').onclick = async () => {
  const b = $('#btnCheck');
  b.disabled = true;
  b.textContent = '確認中…';
  try {
    const r = await send({ type: 'check' });
    say(r?.ok ? `${r.checked}件をチェックしました（更新 ${r.updated}件）` : `エラー: ${r?.error}`);
  } catch (e) {
    say(`エラー: ${e.message}`);
  }
  items = await getItems();
  renderUnread();
  renderCurrent();
  b.disabled = false;
  b.textContent = 'すべてチェック';
};
$('#btnRead').onclick = async () => {
  await send({ type: 'read' });
  items = await getItems();
  renderUnread();
};
$('#btnOpen').onclick = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};

renderCurrent();
renderUnread();
