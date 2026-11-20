// soak 采样分析：把 .soak/*.jsonl 变成"每 5 分钟一档 + 全程线性拟合"的可读报表，
// 用来判断 RSS / 延迟 / 活对象集合是否收敛。
//
// 用法：node soak-analyze.mjs .soak/soak-*.jsonl [更多文件...]

import { readFileSync, existsSync } from 'node:fs';

const med = (arr) => { const v = arr.slice().sort((a, b) => a - b); return v[v.length >> 1]; };
const num = (r, k) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? r[k] : null);

for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const n = rows.length;
  // 元信息在同名 .summary.json 里（soak.mjs 写的）
  const metaFile = file.replace(/\.jsonl$/, '.summary.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const rt = meta.runtime ?? '(未标注)';
  console.log(`
===== ${file}`);
  console.log(`      ${n} 个采样 / ${((rows[n - 1].t - rows[0].t) / 60).toFixed(1)} 分钟 / ${rt}`);
  console.log(`      ${meta.hz ?? '?'} Hz × ${meta.scenes ?? '?'} 场景 × ${meta.entities ?? '?'} 实体（${meta.scenes} 场景合计），压缩 ${meta.zstd ?? '关'}`);
  console.log();
  // ---- 每 5 分钟一档 ----
  const BUCKET = 300;
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.t / BUCKET);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const hasJsc = rows.some((r) => num(r, 'jscObjects') !== null);
  console.log('分钟段    RSS中位   RSS峰谷        heapUsed   p50      p99       活对象集合');
  for (const [b, rs] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    const rss = rs.map((r) => r.rssMB);
    const objs = rs.map((r) => num(r, 'jscObjects')).filter((v) => v !== null);
    console.log(
      `${String(b * 5).padStart(4)}–${String(b * 5 + 5).padStart(4)}` +
      `${med(rs.map((r) => r.rssMB)).toFixed(1).padStart(9)}` +
      `${Math.min(...rss).toFixed(1).padStart(7)}–${Math.max(...rss).toFixed(1).padStart(5)}` +
      `${med(rs.map((r) => r.heapUsedMB)).toFixed(2).padStart(11)}` +
      `${med(rs.map((r) => r.p50)).toFixed(3).padStart(8)}` +
      `${med(rs.map((r) => r.p99)).toFixed(3).padStart(9)}` +
      (hasJsc && objs.length ? `${Math.round(med(objs)).toLocaleString().padStart(12)}` : ''.padStart(12)),
    );
  }

  // ---- 全程线性拟合 ----
  const slope = (key) => {
    const pts = rows.map((r) => [r.t, num(r, key)]).filter(([, v]) => v !== null);
    if (pts.length < 3) return null;
    const xm = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const ym = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let num2 = 0, den = 0;
    for (const [x, y] of pts) { num2 += (x - xm) * (y - ym); den += (x - xm) ** 2; }
    return { slopePerMin: den === 0 ? 0 : (num2 / den) * 60, mean: ym, count: pts.length };
  };

  const rss = slope('rssMB'), heap = slope('heapUsedMB'), obj = slope('jscObjects'), cap = slope('jscHeapMB');
  const maxRss = Math.max(...rows.map((r) => r.rssMB));
  console.log(`\n全程斜率：RSS ${rss.slopePerMin.toFixed(4)} MB/min（均值 ${rss.mean.toFixed(1)}，峰值 ${maxRss} MB）`);
  console.log(`          heapUsed ${heap.slopePerMin.toFixed(5)} MB/min`);
  if (obj) console.log(`          objects ${obj.slopePerMin.toFixed(1)} 个/min（**注意：这里含未回收垃圾，用 gc-settle.mjs 判定活对象**）`);
  if (cap) console.log(`          jscHeap ${cap.slopePerMin.toFixed(5)} MB/min`);

  // ---- 前/后半段对比：真正的泄漏会让后半段不减速 ----
  const half = Math.floor(n / 2);
  const d = (k) => (num(rows[n - 1], k) ?? 0) - (num(rows[half], k) ?? 0);
  const e = (k) => (num(rows[half], k) ?? 0) - (num(rows[0], k) ?? 0);
  console.log(`\n前半段 vs 后半段：RSS ${e('rssMB').toFixed(1)} / ${d('rssMB').toFixed(1)} MB` +
    (obj ? `，objects ${Math.round(e('jscObjects')).toLocaleString()} / ${Math.round(d('jscObjects')).toLocaleString()}` : ''));

  // ---- 判据（与 soak.mjs 一致）----
  const early = rows.slice(0, Math.max(3, Math.floor(n * 0.2)));
  const late = rows.slice(-Math.max(3, Math.floor(n * 0.2)));
  const rssEarly = med(early.map((r) => r.rssMB)), rssLate = med(late.map((r) => r.rssMB));
  const p99Early = med(early.map((r) => r.p99)), p99Late = med(late.map((r) => r.p99));
  const A = (rssLate - rssEarly) / rssEarly < 0.1 && rssLate - rssEarly < 32;
  const B = p99Early === 0 || p99Late <= p99Early * 1.5;
  const C = rss.slopePerMin < 0.5;
  console.log(`\nA RSS 收敛: ${A ? '✅' : '❌'} (${rssEarly} → ${rssLate} MB)`);
  console.log(`B 延迟不漂移: ${B ? '✅' : '❌'} (p99 ${p99Early} → ${p99Late} ms)`);
  console.log(`C 全程斜率 <0.5 MB/min: ${C ? '✅' : '❌'} (${rss.slopePerMin.toFixed(4)})`);
}
