// 共通ユーティリティ（background / options / popup / offscreen から利用）

export const uid = () => crypto.randomUUID();

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Content-Type ヘッダ → <meta charset> の順で文字コードを判定
export function detectCharset(contentType, bytes) {
  let m = /charset\s*=\s*["']?([\w\-:.]+)/i.exec(contentType || '');
  if (m) return m[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  m = /<meta[^>]+charset\s*=\s*["']?([\w\-:.]+)/i.exec(head);
  return m ? m[1] : 'utf-8';
}

export function decodeBody(buf, contentType) {
  const bytes = new Uint8Array(buf);
  const charset = detectCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// 空白を詰め、空行を除いて1行1項目のテキストにそろえる
export function normalizeLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t 　]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// 「#」で始まる行と空行を除いた正規表現パターン一覧
export function collectPatterns(...sources) {
  return sources
    .flatMap((s) => String(s || '').split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// 毎回変わる部分（カウンタ・日時など）を正規表現で取り除く
export function applyFilters(text, patterns) {
  let out = text;
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p, 'gm');
    } catch {
      continue; // 不正な正規表現は無視
    }
    out = out.replace(re, '');
  }
  return normalizeLines(out);
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
