// 行単位の差分（LCS）。戻り値は { t: '=' | '+' | '-', s: 行 } の配列。

const LCS_LIMIT = 4_000_000;

export function diffLines(aText, bText) {
  const a = aText ? aText.split('\n') : [];
  const b = bText ? bText.split('\n') : [];

  // 先頭・末尾の共通部分を先に除く
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: '=', s: a[i] });

  const am = a.slice(start, endA);
  const bm = b.slice(start, endB);
  const n = am.length;
  const m = bm.length;

  if (n * m > LCS_LIMIT) {
    // 巨大な差分は精密に比較せず、全置換として扱う
    for (const s of am) ops.push({ t: '-', s });
    for (const s of bm) ops.push({ t: '+', s });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: '=', s: am[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ t: '-', s: am[i++] });
      } else {
        ops.push({ t: '+', s: bm[j++] });
      }
    }
    while (i < n) ops.push({ t: '-', s: am[i++] });
    while (j < m) ops.push({ t: '+', s: bm[j++] });
  }

  for (let i = endA; i < a.length; i++) ops.push({ t: '=', s: a[i] });
  return ops;
}

export function countChanges(ops) {
  let add = 0;
  let del = 0;
  for (const o of ops) {
    if (o.t === '+') add++;
    else if (o.t === '-') del++;
  }
  return { add, del };
}
