// 运行时性能对比：TS 编译后就是 JS，所以这些手法全部作用在 JS 引擎上
// 运行：node --max-old-space-size=4096 bench-ts-perf.mjs
import { hrtime } from 'node:process';

const N = 1_000_000;
const TICKS = 60;

// ---------- 预置数据 ----------
const AOS = Array.from({ length: N }, (_, i) => ({ x: i, y: i, vx: 1, vy: 2 }));
const SOA_X = new Float64Array(N), SOA_Y = new Float64Array(N);
const SOA_VX = new Float64Array(N), SOA_VY = new Float64Array(N);
for (let i = 0; i < N; i++) { SOA_X[i] = i; SOA_Y[i] = i; SOA_VX[i] = 1; SOA_VY[i] = 2; }

const I32 = new Int32Array(N);
const PLAIN = new Array(N);
for (let i = 0; i < N; i++) { I32[i] = i; PLAIN[i] = i; }

const POOL = Array.from({ length: 1024 }, () => ({ x: 0, y: 0, z: 0 }));
const HOLDER = new Array(1_000_000);

const ENTS = Array.from({ length: 10_000 }, (_, i) => ({ id: i, x: i * 0.5, y: i * 0.25, hp: 100 }));
const BUF = new ArrayBuffer(10_000 * 20);
const VIEW = new DataView(BUF);

class A { get() { return 1; } }
class B { get() { return 2; } }
class C { get() { return 3; } }
class D { get() { return 4; } }
class E { get() { return 5; } }
const VARIANTS = [A, B, C, D, E];
const ONLY_A = Array.from({ length: 1e6 }, () => new A());
const MIXED = Array.from({ length: 1e6 }, (_, i) => new VARIANTS[i % 5]());

// ---------- 计时器 ----------
let sink = 0;
function bench(name, fn, runs = 5) {
  fn(); fn(); // warmup
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = hrtime.bigint();
    sink += fn();
    const t1 = hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`${name.padEnd(42)} ${med.toFixed(1).padStart(8)} ms`);
  return med;
}

console.log('\n[1] 数据布局：1e6 实体 × 60 次积分');
const tAos = bench('AoS（对象数组）', () => {
  let s = 0;
  for (let t = 0; t < TICKS; t++) {
    for (let i = 0; i < N; i++) {
      const e = AOS[i];
      e.x += e.vx; e.y += e.vy;
      s += e.x;
    }
  }
  return s;
});
const tSoa = bench('SoA（Float64Array）', () => {
  let s = 0;
  for (let t = 0; t < TICKS; t++) {
    for (let i = 0; i < N; i++) {
      SOA_X[i] += SOA_VX[i];
      SOA_Y[i] += SOA_VY[i];
      s += SOA_X[i];
    }
  }
  return s;
});
console.log(`    -> SoA 快 ${(tAos / tSoa).toFixed(2)}x`);

console.log('\n[2] 遍历方式：1e6 求和 × 20 轮');
const tFor = bench('for (i++) over TypedArray', () => {
  let s = 0;
  for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += I32[i];
  return s;
});
const tForOf = bench('for...of over TypedArray', () => {
  let s = 0;
  for (let r = 0; r < 20; r++) for (const v of I32) s += v;
  return s;
});
const tForPlain = bench('for (i++) over 普通 Array', () => {
  let s = 0;
  for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += PLAIN[i];
  return s;
});
const tForOfPlain = bench('for...of over 普通 Array', () => {
  let s = 0;
  for (let r = 0; r < 20; r++) for (const v of PLAIN) s += v;
  return s;
});
const tReduce = bench('reduce over 普通 Array', () => {
  let s = 0;
  for (let r = 0; r < 20; r++) s += PLAIN.reduce((a, b) => a + b, 0);
  return s;
});
console.log(`    -> for 比 for...of(TypedArray) 快 ${(tForOf / tFor).toFixed(1)}x，比 reduce 快 ${(tReduce / tFor).toFixed(1)}x`);

console.log('\n[3] 分配：1e6 次对象创建');
bench('不逃逸（V8 标量替换，零成本）', () => {
  let s = 0;
  for (let i = 0; i < 1_000_000; i++) {
    const o = { x: i, y: i, z: 0 };
    s += o.x;
  }
  return s;
});
const tEsc = bench('逃逸并保留（真实分配 + GC）', () => {
  let s = 0;
  for (let i = 0; i < 1_000_000; i++) {
    HOLDER[i] = { x: i, y: i, z: 0 };
    s += HOLDER[i].x;
  }
  return s;
});
const tPool = bench('对象池 1024 槽（零分配）', () => {
  let s = 0;
  for (let i = 0; i < 1_000_000; i++) {
    const o = POOL[i & 1023];
    o.x = i; o.y = i; o.z = 0;
    HOLDER[i] = o;
    s += o.x;
  }
  return s;
});
console.log(`    -> 逃逸分配 vs 对象池：${(tEsc / tPool).toFixed(2)}x`);

console.log('\n[4] 序列化：1e4 实体 × 20 轮');
const tJson = bench('JSON.stringify', () => {
  let n = 0;
  for (let r = 0; r < 20; r++) n += JSON.stringify(ENTS).length;
  return n;
});
const tDv = bench('DataView 定长二进制打包', () => {
  let n = 0;
  for (let r = 0; r < 20; r++) {
    let off = 0;
    for (let i = 0; i < 10_000; i++) {
      const e = ENTS[i];
      VIEW.setInt32(off, e.id); off += 4;
      VIEW.setFloat64(off, e.x); off += 8;
      VIEW.setFloat64(off, e.y); off += 8;
    }
    n += off;
  }
  return n;
});
console.log(`    -> 二进制比 JSON 快 ${(tJson / tDv).toFixed(0)}x`);

console.log('\n[5] 调用点形态：1e6 × 10 次方法调用');
const tMono = bench('monomorphic（全部 A）', () => {
  let s = 0;
  for (let r = 0; r < 10; r++) for (let i = 0; i < ONLY_A.length; i++) s += ONLY_A[i].get();
  return s;
});
const tMega = bench('megamorphic（A..E 混合）', () => {
  let s = 0;
  for (let r = 0; r < 10; r++) for (let i = 0; i < MIXED.length; i++) s += MIXED[i].get();
  return s;
});
console.log(`    -> megamorphic 慢 ${(tMega / tMono).toFixed(2)}x`);

console.log(`\nheapUsed ≈ ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB  (sink=${sink})`);
