// chrome.storage.local の読み書き。
// 書き込みは競合を避けるため background.js のロック経由でのみ行う（ここは読み取り中心）。

export const DEFAULT_SETTINGS = {
  defaultInterval: 60, // 新規アイテムの既定チェック間隔（分）
  notify: true, // 更新時にデスクトップ通知
  concurrency: 4, // 同時チェック数
  archiveKeep: 20, // アイテムごとに残すアーカイブ数
  timeoutSec: 30, // 1ページあたりのタイムアウト
  globalFilter: '', // 全アイテム共通のフィルタ（正規表現を1行1つ）
};

export async function getItems() {
  const { items } = await chrome.storage.local.get('items');
  return Array.isArray(items) ? items : [];
}

export async function setItems(items) {
  await chrome.storage.local.set({ items });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ settings });
}
