// V8 侧基线：SoA + TypedArray 的最朴素写法，不做任何技巧。
// 运行：node node_bench.mjs
// 输出：ns / 实体·tick（越小越好）
import { hrtime } from 'node:process';

const N = 100_000;
const TICKS = 60;
const OPS = N * TICKS;

const X = new Float64Array(N), Y = new Float64Array(N);
const VX = new Float64Array(N), VY = new Float64Array(N);
for (let i = 0; i < N; i++) { X[i] = i; Y[i] = i; VX[i] = 1; VY[i] = 2; }

function run() {
  let s = 0;
  for (let t = 0; t < TICKS; t++)
    for (let i = 0; i < N; i++) { X[i] += VX[i]; Y[i] += VY[i]; s += X[i]; }
  return s;
}

run(); run(); run(); // warmup，让 TurboFan 完成优化

const times = [];
let sink = 0;
for (let r = 0; r < 7; r++) {
  const t0 = hrtime.bigint();
  sink += run();
  times.push(Number(hrtime.bigint() - t0));
}
times.sort((a, b) => a - b);
const med = times[Math.floor(times.length / 2)];
console.log(`node ${process.version}  N=${N} ticks=${TICKS}`);
console.log(`median ${(med / 1e6).toFixed(2)} ms  ->  ${(med / OPS).toFixed(3)} ns/op  (sink=${sink})`);
