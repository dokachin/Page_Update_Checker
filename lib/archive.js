// チェック時点のテキストを IndexedDB にアーカイブ（差分表示用）

const DB_NAME = 'page-update-checker';
const STORE = 'snaps';
const MAX_TEXT = 500_000;

// アーカイブに保存できる長さへ切り詰める。差分比較にも同じ切り詰めを使い、保存済みの前回テキストと条件をそろえる
export const clipText = (text) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);

let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('itemId', 'itemId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

// 古い順に並べたスナップショット一覧
export async function listSnaps(itemId) {
  const db = await openDb();
  const rows = await wrap(db.transaction(STORE).objectStore(STORE).index('itemId').getAll(itemId));
  return rows.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

// 最新の1件だけをカーソルで読む（全件の本文を読み込まない）。主キーは追加順に増える
export async function latestSnap(itemId) {
  const db = await openDb();
  const cursor = await wrap(
    db.transaction(STORE).objectStore(STORE).index('itemId').openCursor(IDBKeyRange.only(itemId), 'prev'),
  );
  return cursor ? cursor.value : undefined;
}

// アイテムのスナップショットの主キー（追加順＝古い順）。本文は読み込まない
async function snapKeys(db, itemId) {
  return wrap(db.transaction(STORE).objectStore(STORE).index('itemId').getAllKeys(itemId));
}

export async function addSnap(itemId, snap, keep = 20) {
  const db = await openDb();
  const text = clipText(snap.text);
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).add({ itemId, ts: snap.ts, text, signature: snap.signature });
  await txDone(tx);

  const keys = await snapKeys(db, itemId);
  const extra = keys.length - Math.max(1, keep);
  if (extra > 0) {
    const tx2 = db.transaction(STORE, 'readwrite');
    for (const k of keys.slice(0, extra)) tx2.objectStore(STORE).delete(k);
    await txDone(tx2);
  }
}

export async function deleteSnaps(itemId) {
  const db = await openDb();
  const keys = await snapKeys(db, itemId);
  if (!keys.length) return;
  const tx = db.transaction(STORE, 'readwrite');
  for (const k of keys) tx.objectStore(STORE).delete(k);
  await txDone(tx);
}
