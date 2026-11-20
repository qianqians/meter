// 判定工具：soak 里 `objects` 缓慢上升，到底是"真活对象泄漏"还是"还没被回收的垃圾"。
//
// 做法：跑 30s → 记计数 → Bun.gc(true) → 再记 → 再跑 30s → 再记……
//   · 每次强制 GC 后计数回到同一个值  ⇒ 活对象集合恒定，上升只是回收滞后（健康）
//   · 强制 GC 后仍逐轮抬升            ⇒ 才是真的活对象增长，要挖引用链
//
// 实测（Bun 1.4.5）：14,942 → GC 后 14,510 → 再跑 30s 14,673 → GC 后 **14,510** → 第三个 30s + GC **14,509**。
// 即长跑里那 +7k 的 objects 增长是 GC 滞后的垃圾，不是泄漏。heapCapacity 也一样：
// 两次 GC 之间从 2.6 MB 涨到 10.5 MB，GC 后回落 —— RSS 的 ±2 MB 波动就来自这里。
import { heapStats } from 'bun:jsc';
import * as pbes from '../ser-compare/gen/js/pbes.mjs';

const N = 60;
const msg = pbes.create(pbes.StatePacketSoASchema, {
  tick: 1, seq: 1, sceneId: 1, playerId: 1n, svrTimeMs: 1n,
  ackTick: 0, ackSeq: 0, protoVer: 3, flags: 1, checksum: 0,
  id: new Uint32Array(N), kind: new Uint32Array(N), x: new Int32Array(N), y: new Int32Array(N), z: new Int32Array(N),
  vx: new Int32Array(N), vy: new Int32Array(N), dir: new Uint32Array(N), hp: new Int32Array(N), hpMax: new Int32Array(N),
  mp: new Int32Array(N), level: new Uint32Array(N), faction: new Uint32Array(N), stateFlags: new Uint32Array(N),
  buffMask: new Array(N).fill(1n),
});

const show = (tag) => {
  const h = heapStats();
  console.log(`${tag.padEnd(20)} objects=${h.objectCount.toLocaleString().padStart(8)}  heapSize=${(h.heapSize / 1048576).toFixed(2)}MB  capacity=${(h.heapCapacity / 1048576).toFixed(2)}MB  rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB`);
};

function burst(seconds) {
  const n = Math.round(seconds * 20);
  let sink = 0;
  for (let i = 0; i < n; i++) {
    const buf = pbes.toBinary(pbes.StatePacketSoASchema, msg);
    const back = pbes.fromBinary(pbes.StatePacketSoASchema, buf);
    sink += back.id.length;
  }
  return sink;
}

show('初始');
burst(30); show('跑 30s');
Bun.gc(true); show('强制 GC');
burst(30); show('再跑 30s');
Bun.gc(true); show('再强制 GC');
burst(30); Bun.gc(true); show('第三个 30s + GC');
