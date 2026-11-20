// 长跑稳态测试（soak）：跑满一小时，看 RSS / GC / tick 延迟是否收敛。
//
// 回答的问题不是"多快"，而是：**一小时后它还稳不稳。**
//   · RSS 会不会一直往上爬（泄漏）
//   · tick 延迟会不会随运行时间漂移（GC 停顿/堆碎片）
//   · heapUsed 是否在 GC 后回到同一水平（分配速率 vs 回收能力）
//
// 每个 tick 做的是"一条真实的逻辑服 tick + 一次网络往返"：
//   ① 场景：积分 → 网格重建 → AOI 查询 → 列式打包（与 aoi-tick/bench.mjs 同一套算法）
//   ② 序列化：把可见实体编成 protobuf SoA 的 Envelope → (可选 zstd) → 解回对象
//   ② 是**故意加进来的分配源**：纯 SoA tick 是零分配的，测不出 GC 问题。
//
// 运行：
//   bun  soak.mjs --minutes=60 --hz=20 --scenes=2 --entities=400
//   node soak.mjs --minutes=1  --hz=10                 # 冒烟
//
// 判据（先写死，再看结果——这是这份脚本唯一诚实的地方）：
//   A. RSS 收敛：最后 20% 采样与前 20% 采样的中位数相比，增长 < 10% 且绝对值 < 32 MB
//   B. 延迟不漂移：最后 20% 的 p99 ≤ 前 20% 的 p99 × 1.5
//   C. 无持续爬升：最后 10 分钟的 RSS 线性斜率 < 0.5 MB/min
//   D. 兜底：RSS > 1.5 GB 立即中止（判定泄漏，不等到跑完）

import { writeFileSync, mkdirSync } from 'node:fs';
import { hrtime } from 'node:process';

// ---------- 参数 ----------
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const MINUTES = Number(arg('minutes', 60));
const HZ = Number(arg('hz', 20));
const SCENES = Number(arg('scenes', 2));
const ENTITIES = Number(arg('entities', 400));
const SAMPLE_SEC = Number(arg('sample', 5));
const USE_ZSTD = arg('zstd', '1') !== '0';
const OUT_DIR = '.soak';
const MAX_RSS_MB = 1536;

// ---------- 可选依赖：protobuf-es（已打包的 ESM）与 zstd ----------
const pbes = await import('../ser-compare/gen/js/pbes.mjs');

const zstd = await (async () => {
  if (!USE_ZSTD) return null;
  if (typeof Bun !== 'undefined' && typeof Bun.zstdCompressSync === 'function') {
    return {
      name: 'Bun.zstd',
      compress: (u8) => new Uint8Array(Bun.zstdCompressSync(u8)),
      decompress: (u8) => new Uint8Array(Bun.zstdDecompressSync(u8)),
    };
  }
  try {
    const zlib = await import('node:zlib');
    if (typeof zlib.zstdCompressSync === 'function') {
      return {
        name: 'node:zlib zstd',
        compress: (u8) => new Uint8Array(zlib.zstdCompressSync(u8)),
        decompress: (u8) => new Uint8Array(zlib.zstdDecompressSync(u8)),
      };
    }
  } catch { /* 忽略 */ }
  return null;
})();

// Bun 的 JSC 堆统计（Node 没有等价物）——拿不到就退化成 process.memoryUsage
const jsc = await (async () => {
  if (typeof Bun === 'undefined') return null;
  try { return await import('bun:jsc'); } catch { return null; }
})();

// ---------- 场景（与 aoi-tick/bench.mjs 同一套算法） ----------
const CELL = 40, RANGE2 = 60 * 60, REC_BYTES = 12;

function makeScene(N) {
  const density = 36 / (9 * CELL * CELL);
  const side = Math.ceil(Math.sqrt(N / density) / CELL) * CELL;
  const gw = side / CELL, nc = gw * gw;
  const s = {
    N, side, gw,
    X: new Float64Array(N), Y: new Float64Array(N), VX: new Float64Array(N), VY: new Float64Array(N),
    HP: new Int32Array(N), FLAGS: new Uint8Array(N), FACTION: new Uint8Array(N),
    count: new Int32Array(nc + 1), cursor: new Int32Array(nc + 1), cellStart: new Int32Array(nc + 1),
    order: new Int32Array(N), cellOf: new Int32Array(N),
    visFlat: new Int32Array(N * 128), visCount: new Int32Array(N),
  };
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < N; i++) {
    s.X[i] = rnd() * side; s.Y[i] = rnd() * side;
    s.VX[i] = (rnd() - 0.5) * 4; s.VY[i] = (rnd() - 0.5) * 4;
    s.HP[i] = 100 + (i % 900); s.FLAGS[i] = i & 0x0f; s.FACTION[i] = i & 0x03;
  }
  return s;
}

function integrate(s) {
  const { N, X, Y, VX, VY, side } = s;
  const hi = side - 1;
  for (let i = 0; i < N; i++) {
    let x = X[i] + VX[i], y = Y[i] + VY[i];
    if (x < 0) { x = 0; VX[i] = -VX[i]; } else if (x >= side) { x = hi; VX[i] = -VX[i]; }
    if (y < 0) { y = 0; VY[i] = -VY[i]; } else if (y >= side) { y = hi; VY[i] = -VY[i]; }
    X[i] = x; Y[i] = y;
  }
}

function rebuildGrid(s) {
  const { N, X, Y, gw, count, cursor, cellStart, order, cellOf } = s;
  const nc = gw * gw;
  count.fill(0);
  for (let i = 0; i < N; i++) {
    const c = ((Y[i] / CELL) | 0) * gw + ((X[i] / CELL) | 0);
    cellOf[i] = c; count[c]++;
  }
  let acc = 0;
  for (let c = 0; c < nc; c++) { cellStart[c] = acc; cursor[c] = acc; acc += count[c]; }
  cellStart[nc] = acc;
  for (let i = 0; i < N; i++) order[cursor[cellOf[i]]++] = i;
}

function query(s) {
  const { N, X, Y, gw, cellStart, order, visFlat, visCount } = s;
  let pairs = 0;
  for (let o = 0; o < N; o++) {
    const ox = X[o], oy = Y[o];
    const cx = (ox / CELL) | 0, cy = (oy / CELL) | 0;
    const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gw - 1 ? cx + 1 : gw - 1;
    const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gw - 1 ? cy + 1 : gw - 1;
    const base = o * 128;
    let n = 0;
    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * gw;
      for (let gx = x0; gx <= x1; gx++) {
        const c = rowBase + gx;
        const to = cellStart[c + 1];
        for (let k = cellStart[c]; k < to; k++) {
          const e = order[k];
          if (e === o) continue;
          const dx = X[e] - ox, dy = Y[e] - oy;
          if (dx * dx + dy * dy <= RANGE2 && n < 128) visFlat[base + n++] = e;
        }
      }
    }
    visCount[o] = n; pairs += n;
  }
  return pairs;
}

// ---------- 序列化往返（分配的来源） ----------
const PACKET_HEADER = { tick: 0, seq: 0, sceneId: 0, playerId: 1n, svrTimeMs: 0n,
  ackTick: 0, ackSeq: 0, protoVer: 3, flags: 1, checksum: 0 };

let wireBytes = 0, compressedBytes = 0, decodedCount = 0;

function wireRoundTrip(s, tickNo) {
  // 取前 60 个观察者各自可见的实体，拼成一份 SoA 包（模拟一次广播）
  const M = Math.min(60, s.N);
  const id = new Uint32Array(M), kind = new Uint32Array(M);
  const x = new Int32Array(M), y = new Int32Array(M), z = new Int32Array(M);
  const vx = new Int32Array(M), vy = new Int32Array(M), dir = new Uint32Array(M);
  const hp = new Int32Array(M), hpMax = new Int32Array(M), mp = new Int32Array(M);
  const level = new Uint32Array(M), faction = new Uint32Array(M);
  const stateFlags = new Uint32Array(M), buffMask = new Array(M);
  for (let i = 0; i < M; i++) {
    id[i] = 1000000 + i; kind[i] = (i % 7) + 1;
    x[i] = (s.X[i] * 4) | 0; y[i] = (s.Y[i] * 4) | 0; z[i] = 0;
    vx[i] = (s.VX[i] * 4) | 0; vy[i] = (s.VY[i] * 4) | 0; dir[i] = (tickNo + i) % 360;
    hp[i] = s.HP[i]; hpMax[i] = 10000; mp[i] = i * 3;
    level[i] = 1 + (i % 80); faction[i] = s.FACTION[i]; stateFlags[i] = s.FLAGS[i];
    buffMask[i] = BigInt((i * 2654435761) % 4294967296);
  }
  const msg = pbes.create(pbes.StatePacketSoASchema, {
    ...PACKET_HEADER, tick: tickNo,
    id, kind, x, y, z, vx, vy, dir, hp, hpMax, mp, level, faction, stateFlags, buffMask,
  });
  let buf = pbes.toBinary(pbes.StatePacketSoASchema, msg);
  wireBytes = buf.length;
  if (zstd) { buf = zstd.compress(buf); compressedBytes = buf.length; }
  const raw = zstd ? zstd.decompress(buf) : buf;
  const back = pbes.fromBinary(pbes.StatePacketSoASchema, raw);
  decodedCount = back.id.length;
  return back.id.length;
}

// ---------- 采样与输出 ----------
const scenes = Array.from({ length: SCENES }, () => makeScene(ENTITIES));
const samples = [];
const startedAt = Date.now();
const deadline = startedAt + MINUTES * 60_000;
const tickNs = [];
let ticks = 0, sink = 0;

const now = () => hrtime.bigint();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mem = () => process.memoryUsage();
const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
};

function sample() {
  const m = mem();
  const row = {
    t: Math.round((Date.now() - startedAt) / 1000),
    ticks,
    p50: +(pct(tickNs, 50) / 1e6).toFixed(3),
    p99: +(pct(tickNs, 99) / 1e6).toFixed(3),
    max: +(Math.max(...tickNs, 0) / 1e6).toFixed(3),
    rssMB: +(m.rss / 1048576).toFixed(1),
    heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
    heapTotalMB: +(m.heapTotal / 1048576).toFixed(1),
    externalMB: +(m.external / 1048576).toFixed(1),
    arrayBuffersMB: +((m.arrayBuffers ?? 0) / 1048576).toFixed(1),
    wireB: wireBytes,
    zstdB: compressedBytes,
    visible: decodedCount,
  };
  if (jsc) {
    try {
      const h = jsc.heapStats();
      row.jscHeapMB = +(h.heapSize / 1048576).toFixed(1);
      row.jscObjects = h.objectCount;
    } catch { /* 忽略 */ }
  }
  samples.push(row);
  tickNs.length = 0;
  return row;
}

const head = () => {
  const base = 't(s)  ticks  p50ms  p99ms  maxms  rssMB  heapUsed  heapTotal  external  arrBuf';
  return jsc ? `${base}  jscHeap  objects` : base;
};
const line = (r) => {
  const base = `${String(r.t).padStart(5)}${String(r.ticks).padStart(7)}${String(r.p50).padStart(7)}${String(r.p99).padStart(7)}` +
    `${String(r.max).padStart(7)}${String(r.rssMB).padStart(7)}${String(r.heapUsedMB).padStart(10)}` +
    `${String(r.heapTotalMB).padStart(11)}${String(r.externalMB).padStart(10)}${String(r.arrayBuffersMB).padStart(9)}`;
  return jsc ? `${base}${String(r.jscHeapMB ?? '-').padStart(10)}${String(r.jscObjects ?? '-').padStart(9)}` : base;
};

function verdict(rows) {
  if (rows.length < 10) return { ok: false, why: '样本太少（<10），无法判定' };
  const n = rows.length;
  const early = rows.slice(0, Math.max(3, Math.floor(n * 0.2)));
  const late = rows.slice(Math.max(0, n - Math.max(3, Math.floor(n * 0.2))));
  const med = (a, k) => { const v = a.map((r) => r[k]).sort((x, y) => x - y); return v[v.length >> 1]; };

  const rssEarly = med(early, 'rssMB'), rssLate = med(late, 'rssMB');
  const rssGrowth = (rssLate - rssEarly) / rssEarly;
  const A = rssGrowth < 0.10 && rssLate - rssEarly < 32;

  const p99Early = med(early, 'p99'), p99Late = med(late, 'p99');
  const B = p99Early === 0 ? true : p99Late <= p99Early * 1.5;

  const tail = rows.slice(-Math.min(rows.length, Math.ceil(600 / SAMPLE_SEC)));
  const xm = tail.reduce((a, r) => a + r.t, 0) / tail.length;
  const ym = tail.reduce((a, r) => a + r.rssMB, 0) / tail.length;
  let num = 0, den = 0;
  for (const r of tail) { num += (r.t - xm) * (r.rssMB - ym); den += (r.t - xm) ** 2; }
  const slope = den === 0 ? 0 : (num / den) * 60;
  const C = slope < 0.5;

  return {
    ok: A && B && C, rssEarly, rssLate, rssGrowth, p99Early, p99Late, slope, A, B, C,
    why: `RSS ${rssEarly}→${rssLate} MB (${(rssGrowth * 100).toFixed(1)}%) | p99 ${p99Early}→${p99Late} ms | 末段斜率 ${slope.toFixed(3)} MB/min`,
  };
}

function finish(reason) {
  const v = verdict(samples);
  const rt = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`;
  const summary = {
    runtime: rt,
    minutes: MINUTES, hz: HZ, scenes: SCENES,
    entitiesPerScene: ENTITIES, entities: SCENES * ENTITIES,
    zstd: zstd ? zstd.name : null,
    reason,
    samples: samples.length,
    verdict: v,
    last: samples[samples.length - 1] ?? null,
  };
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${OUT_DIR}/soak-${stamp}.jsonl`, samples.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(`${OUT_DIR}/soak-${stamp}.summary.json`, JSON.stringify(summary, null, 2));
    console.log(`\n采样已写入 ${OUT_DIR}/soak-${stamp}.jsonl`);
  } catch (e) {
    console.log('写文件失败:', e.message);
  }
  console.log(`\n===== 结论（${rt}）=====`);
  console.log(`停止原因: ${reason}`);
  console.log(`A  RSS 收敛（<10% 且 <32MB）: ${v.A ? '通过' : '不通过'}`);
  console.log(`B  延迟不漂移（p99 ≤ 1.5×）: ${v.B ? '通过' : '不通过'}`);
  console.log(`C  末段无爬升（<0.5 MB/min）: ${v.C ? '通过' : '不通过'}`);
  console.log(`明细: ${v.why}`);
  console.log(`总计 ${ticks} tick，平均 ${(ticks / ((Date.now() - startedAt) / 1000)).toFixed(1)} tick/s，sink=${sink.toExponential(2)}`);
  console.log(v.ok ? '\n✅ 长跑稳态通过' : '\n❌ 长跑稳态不通过 —— 见上面的 A/B/C 明细');
  process.exit(v.ok ? 0 : 1);
}

process.on('SIGINT', () => finish('SIGINT（手动中止，按已采样数据判定）'));

// ---------- 主循环 ----------
console.log(`长跑稳态测试  ${typeof Bun !== 'undefined' ? 'Bun ' + Bun.version : 'Node ' + process.version}`);
console.log(`${SCENES} 场景 × ${ENTITIES} 实体，${HZ} Hz，压缩=${zstd ? zstd.name : '关'}，每 ${SAMPLE_SEC}s 采样，计划 ${MINUTES} 分钟`);
console.log('判据: A RSS 收敛(<10% 且 <32MB) | B p99 不漂移(≤1.5×) | C 末段斜率 <0.5 MB/min | D RSS >1.5GB 立即中止\n');
console.log(head());

const tickIntervalNs = BigInt(Math.round(1e9 / HZ));
let nextAt = now();
let sceneIdx = 0;
let lastSampleAt = Date.now();

for (;;) {
  const t0 = now();
  const s = scenes[sceneIdx++ % SCENES];
  integrate(s);
  rebuildGrid(s);
  sink += query(s);
  sink += wireRoundTrip(s, ticks);
  const t1 = now();
  tickNs.push(Number(t1 - t0));
  ticks++;

  if (Date.now() - lastSampleAt >= SAMPLE_SEC * 1000) {
    const r = sample();
    console.log(line(r));
    if (r.rssMB > MAX_RSS_MB) finish(`RSS 超过 ${MAX_RSS_MB} MB（疑似泄漏，立即中止）`);
    lastSampleAt = Date.now();
  }
  if (Date.now() >= deadline) break;

  // 限速：按绝对时间推进，避免累计漂移；落后太多就重置基准
  nextAt += tickIntervalNs;
  const waitMs = Number(nextAt - now()) / 1e6;
  if (waitMs > 1) await sleep(Math.floor(waitMs));
  else if (waitMs <= 0) nextAt = now();
}

finish('跑满计划时长');
