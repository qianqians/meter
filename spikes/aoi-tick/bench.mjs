// S1：TS `core` 的真实形状 —— 一个场景的一 tick 到底花多少毫秒
//
// 与 spikes/ts-vs-python/ 的差别：那边测"一次积分循环的原料成本"，这边测
// **一整个 tick 的四段流水**，每段都是 MMO 逻辑层真实会做的事：
//   ① 积分        所有实体 pos += vel（+ 伪边界反弹，让实体长期留在场景内）
//   ② 网格重建    计数排序（counting sort）：清计数 → 计数 → 前缀和 → 散列
//   ③ AOI 查询    每个观察者查 3×3 邻居格 + 半径过滤（平方距离，不开根号），
//                 结果写进"可见列表"（每观察者一段，供 ④ 使用）
//   ④ diff + 打包  把可见实体的属性按列式布局量化写进字节流
//
// 计时纪律（与 spikes/README 的教训一致）：
//   - 所有缓冲区在 tick 循环外分配，循环内**零分配**（无对象/数组字面量）
//   - 四段各自计时，中位数取样；另有"整体 span"一列用于校验四段之和没有漏算
//   - **世界尺寸随实体数按比例放大**，让"3×3 邻居 ≈ 36 个可见实体"在所有规模下一致，
//     否则大场景只是被测成了更高的密度，规模对比会假性超线性
//
// 运行：node bench.mjs            # 默认 4 组实体规模
//       node bench.mjs 10000      # 只跑 1 万实体

import { hrtime } from 'node:process';

const CELL = 40;           // 网格边长
const RANGE = 60;          // 兴趣半径
const RANGE2 = RANGE * RANGE;
const REC_BYTES = 12;      // 每个可见实体打包后的字节数（见 ④）
const MAX_VISIBLE = 128;   // 单观察者可见上限（正常密度下约 36，溢出计入 dropped）

const TICKS = Number(process.argv[3] ?? 200);
const WARMUP = 20;

function makeScene(N) {
  // 让 3×3 邻居的期望可见数 ≈ 36：世界面积 = N / 密度，密度 = 36 / (9 × CELL²)
  const density = 36 / (9 * CELL * CELL);
  const side = Math.ceil(Math.sqrt(N / density) / CELL) * CELL;

  const X = new Float64Array(N), Y = new Float64Array(N);
  const VX = new Float64Array(N), VY = new Float64Array(N);
  const HP = new Int32Array(N), FLAGS = new Uint8Array(N), FACTION = new Uint8Array(N);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < N; i++) {
    X[i] = rnd() * side; Y[i] = rnd() * side;
    VX[i] = (rnd() - 0.5) * 4; VY[i] = (rnd() - 0.5) * 4;
    HP[i] = 100 + (i % 900); FLAGS[i] = i & 0x0f; FACTION[i] = i & 0x03;
  }

  const gw = side / CELL;
  const nc = gw * gw;
  const count = new Int32Array(nc + 1);
  const cursor = new Int32Array(nc + 1);
  const cellStart = new Int32Array(nc + 1);
  const order = new Int32Array(N);
  const cellOf = new Int32Array(N);

  // ③ 的输出：每观察者一段可见列表
  const visFlat = new Int32Array(N * MAX_VISIBLE);
  const visCount = new Int32Array(N);

  // ④ 的输出：一个 tick 的全部打包结果写在同一块连续缓冲里（= 发给客户端的字节流）
  const out = new Uint8Array(24 << 20);
  const dv = new DataView(out.buffer);

  return { N, side, gw, X, Y, VX, VY, HP, FLAGS, FACTION,
           count, cursor, cellStart, order, cellOf, visFlat, visCount, dv, out };
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
    cellOf[i] = c;
    count[c]++;
  }
  let acc = 0;
  for (let c = 0; c < nc; c++) { cellStart[c] = acc; cursor[c] = acc; acc += count[c]; }
  cellStart[nc] = acc;
  for (let i = 0; i < N; i++) order[cursor[cellOf[i]]++] = i;
}

function query(s) {
  const { N, X, Y, gw, cellStart, order, visFlat, visCount } = s;
  let pairs = 0, dropped = 0;
  for (let o = 0; o < N; o++) {
    const ox = X[o], oy = Y[o];
    const cx = (ox / CELL) | 0, cy = (oy / CELL) | 0;
    const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gw - 1 ? cx + 1 : gw - 1;
    const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gw - 1 ? cy + 1 : gw - 1;
    const base = o * MAX_VISIBLE;
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
          if (dx * dx + dy * dy <= RANGE2) {
            if (n < MAX_VISIBLE) visFlat[base + n++] = e; else dropped++;
          }
        }
      }
    }
    visCount[o] = n;
    pairs += n;
  }
  s.dropped = dropped;
  return pairs;
}

function pack(s) {
  const { N, X, Y, HP, FLAGS, FACTION, visFlat, visCount, dv, out } = s;
  let off = 0;
  for (let o = 0; o < N; o++) {
    const n = visCount[o], base = o * MAX_VISIBLE;
    for (let k = 0; k < n; k++) {
      if (off + REC_BYTES > out.length) return off;
      const e = visFlat[base + k];
      dv.setInt32(off, e); off += 4;                              // id
      dv.setInt16(off, (X[e] * 4) | 0); off += 2;                 // x 量化 1/4 单位
      dv.setInt16(off, (Y[e] * 4) | 0); off += 2;                 // y 量化 1/4 单位
      dv.setInt16(off, HP[e]); off += 2;                          // hp
      dv.setUint8(off, FLAGS[e]); off += 1;                       // flags
      dv.setUint8(off, FACTION[e]); off += 1;                     // faction
    }
  }
  return off;
}

const ms = (a, b) => Number(b - a) / 1e6;
const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
const p95 = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)]; };

function bench(N) {
  const s = makeScene(N);
  for (let t = 0; t < WARMUP; t++) { integrate(s); rebuildGrid(s); query(s); pack(s); }

  const tot = [], p1 = [], p2 = [], p3 = [], p4 = [];
  let pairs = 0, bytes = 0;
  for (let t = 0; t < TICKS; t++) {
    const t0 = hrtime.bigint();
    integrate(s);
    const t1 = hrtime.bigint();
    rebuildGrid(s);
    const t2 = hrtime.bigint();
    pairs = query(s);
    const t3 = hrtime.bigint();
    bytes = pack(s);
    const t4 = hrtime.bigint();
    tot.push(ms(t0, t4)); p1.push(ms(t0, t1)); p2.push(ms(t1, t2)); p3.push(ms(t2, t3)); p4.push(ms(t3, t4));
  }
  return {
    N, side: s.side, total: med(tot), totalP95: p95(tot),
    integrate: med(p1), grid: med(p2), query: med(p3), pack: med(p4),
    pairs, bytes, dropped: s.dropped ?? 0,
  };
}

const sizes = process.argv[2] ? [Number(process.argv[2])] : [400, 1000, 5000, 10000, 30000];
console.log(`node ${process.version}  格=${CELL} 半径=${RANGE}  tick=${TICKS}（中位数，跳过 ${WARMUP} 预热 tick）`);
console.log('世界尺寸随实体数放大，密度固定 ⇒ 3×3 邻居恒为 ~36 个可见实体\n');
console.log('实体数  世界边长  中位 tick   P95      ① 积分  ② 网格   ③ 查询   ④ 打包   AOI对数  dropped  字节/tick');
const results = [];
for (const N of sizes) {
  const r = bench(N);
  results.push(r);
  console.log(
    `${String(r.N).padStart(6)} ${String(r.side).padStart(8)} ${r.total.toFixed(2).padStart(8)}ms ${r.totalP95.toFixed(2).padStart(7)}ms ` +
    `${r.integrate.toFixed(2).padStart(6)} ${r.grid.toFixed(2).padStart(7)} ${r.query.toFixed(2).padStart(7)} ${r.pack.toFixed(2).padStart(7)} ` +
    `${String(r.pairs).padStart(9)} ${String(r.dropped).padStart(7)} ${String(r.bytes).padStart(10)}`,
  );
}

console.log('\n预算换算（单进程单场景；10Hz ⇒ 100 ms/tick，20Hz ⇒ 50 ms/tick；只算逻辑，不含网络与 DB）：');
for (const r of results) {
  const per10 = r.total / 100, per20 = r.total / 50;
  console.log(
    `  ${String(r.N).padStart(6)} 实体 | 10Hz 占单核 ${(per10 * 100).toFixed(1).padStart(5)}% ⇒ 每核 ${String(Math.floor(1 / per10)).padStart(4)} 场景` +
    ` | 20Hz 占 ${(per20 * 100).toFixed(1).padStart(5)}% ⇒ 每核 ${String(Math.floor(1 / per20)).padStart(3)} 场景`,
  );
}
