// 压缩实验：§8.2 的"protobuf 比 FlatBuffers 小 21–47%"是**未压缩**数字。
// 压缩之后差距还剩多少？以及压缩/解压本身在 tick 里要付多少钱？
//
// 两个尺度都要测，因为结论完全不同：
//   · 快照（1000 实体，几十 KB）—— 压缩几乎肯定划算
//   · 每 tick 增量（60 实体，几 KB）—— 压缩可能不划算，且 CPU 每 tick 都要付
//
// 运行：node compress-bench.mjs

import { gzipSync, brotliCompressSync, brotliDecompressSync, constants as zconst } from 'node:zlib';
import { hrtime } from 'node:process';
import zstd from '@mongodb-js/zstd';

import * as fb from './gen/js/fb.mjs';
import * as pbes from './gen/js/pbes.mjs';

const SIZES = [1000, 60];

// ---------- 数据（与 bench-ts.mjs 同一套公式） ----------
function makeData(N) {
  const d = {
    N,
    id: new Uint32Array(N), kind: new Uint32Array(N),
    x: new Int32Array(N), y: new Int32Array(N), z: new Int32Array(N),
    vx: new Int32Array(N), vy: new Int32Array(N), dir: new Uint32Array(N),
    hp: new Int32Array(N), hpMax: new Int32Array(N), mp: new Int32Array(N),
    level: new Uint32Array(N), faction: new Uint32Array(N), stateFlags: new Uint32Array(N),
    buffMask: new Array(N),
  };
  for (let i = 0; i < N; i++) {
    const k = i;
    d.id[i] = 1000000 + i; d.kind[i] = (i % 7) + 1;
    d.x[i] = ((k * 7919) % 200000) - 100000; d.y[i] = ((k * 104729 + 31) % 200000) - 100000;
    d.z[i] = ((k * 37) % 4000) - 2000; d.vx[i] = ((k * 13) % 800) - 400; d.vy[i] = ((k * 17 + 5) % 800) - 400;
    d.dir[i] = (k * 29) % 360; d.hp[i] = 1000 + ((k * 61) % 9000); d.hpMax[i] = 10000; d.mp[i] = (k * 23) % 500;
    d.level[i] = 1 + (i % 80); d.faction[i] = i & 3; d.stateFlags[i] = (k * 8191) % 65536;
    d.buffMask[i] = BigInt((k % 4294967296) * 4 + (i & 3));
  }
  return d;
}

const HEADER = { tick: 123456, seq: 98765, sceneId: 42, playerId: 9007199254740993n, svrTimeMs: 1795000000000n,
  ackTick: 123400, ackSeq: 98700, protoVer: 3, flags: 0x1f, checksum: 0xdeadbeef };

// ---------- 三种编码 ----------
function pbSoa(d) {
  return pbes.toBinary(pbes.StatePacketSoASchema, pbes.create(pbes.StatePacketSoASchema, {
    ...HEADER, id: d.id, kind: d.kind, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, dir: d.dir,
    hp: d.hp, hpMax: d.hpMax, mp: d.mp, level: d.level, faction: d.faction, stateFlags: d.stateFlags, buffMask: d.buffMask,
  }));
}
function pbAos(d) {
  const rows = new Array(d.N);
  for (let i = 0; i < d.N; i++) {
    const o = { id: d.id[i], kind: d.kind[i], hp: d.hp[i], hpMax: d.hpMax[i], level: d.level[i] };
    if (d.x[i]) o.x = d.x[i];
    if (d.y[i]) o.y = d.y[i];
    if (d.z[i]) o.z = d.z[i];
    if (d.vx[i]) o.vx = d.vx[i];
    if (d.vy[i]) o.vy = d.vy[i];
    if (d.dir[i]) o.dir = d.dir[i];
    if (d.mp[i]) o.mp = d.mp[i];
    if (d.faction[i]) o.faction = d.faction[i];
    if (d.stateFlags[i]) o.stateFlags = d.stateFlags[i];
    if (d.buffMask[i]) o.buffMask = d.buffMask[i];
    rows[i] = o;
  }
  return pbes.toBinary(pbes.StatePacketSchema, pbes.create(pbes.StatePacketSchema, { ...HEADER, entities: rows }));
}
function fbAos(d) {
  const N = d.N;
  const b = new fb.Builder(1024 + N * 64 + 256);
  fb.StatePacket.startEntitiesVector(b, N);
  for (let i = 0; i < N; i++) {
    fb.EntityState.createEntityState(b, d.id[i], d.kind[i], d.x[i], d.y[i], d.z[i], d.vx[i], d.vy[i],
      d.dir[i], d.hp[i], d.hpMax[i], d.mp[i], d.level[i], d.faction[i], d.stateFlags[i], d.buffMask[i]);
  }
  const vec = b.endVector();
  const pkt = fb.StatePacket.createStatePacket(b, HEADER.tick, HEADER.seq, HEADER.sceneId, HEADER.playerId,
    HEADER.svrTimeMs, HEADER.ackTick, HEADER.ackSeq, HEADER.protoVer, HEADER.flags, HEADER.checksum, vec);
  fb.StatePacket.finishStatePacketBuffer(b, pkt);
  return b.asUint8Array();
}

const kb = (n) => (n / 1024).toFixed(2);
const ns1 = (a, b) => Number(b - a);

function bestSync(fn, reps = 30) {
  fn();
  let min = Infinity;
  for (let r = 0; r < reps; r++) { const t0 = hrtime.bigint(); fn(); const dt = ns1(t0, hrtime.bigint()); if (dt < min) min = dt; }
  return min;
}
async function bestAsync(fn, reps = 30) {
  await fn();
  let min = Infinity;
  for (let r = 0; r < reps; r++) { const t0 = hrtime.bigint(); await fn(); const dt = ns1(t0, hrtime.bigint()); if (dt < min) min = dt; }
  return min;
}

console.log('压缩实验（同一份 1000 / 60 实体数据，# 为"每实体字节"）\n');

for (const N of SIZES) {
  const d = makeData(N);
  const raw = { 'protobuf SoA': pbSoa(d), 'protobuf AoS': pbAos(d), 'FlatBuffers AoS': fbAos(d) };

  console.log(`===== N = ${N} 实体（约 ${kb(raw['protobuf SoA'].length)}–${kb(raw['FlatBuffers AoS'].length)} KB）=====`);
  console.log('编码                 原始 B   每实体   zstd-3        zstd-19        gzip-9        brotli-11');
  for (const [name, buf] of Object.entries(raw)) {
    const z3 = await zstd.compress(Buffer.from(buf), 3);
    const z19 = await zstd.compress(Buffer.from(buf), 19);
    const gz = gzipSync(buf, { level: 9 });
    const br = brotliCompressSync(buf, { params: { [zconst.BROTLI_PARAM_QUALITY]: 11 } });
    const cell = (b) => `${kb(b.length)}KB(${(b.length / buf.length * 100).toFixed(0)}%)`;
    console.log(
      name.padEnd(18) + String(buf.length).padStart(8) + (buf.length / N).toFixed(1).padStart(8) +
      cell(z3).padStart(15) + cell(z19).padStart(15) + cell(gz).padStart(15) + cell(br).padStart(15),
    );
  }

  // 压缩/解压的时间成本（zstd-3 是"每 tick 也能接受"的那一档）
  console.log('\n时间成本（µs，zstd-3，越多实体越摊薄）：');
  for (const [name, buf] of Object.entries(raw)) {
    const src = Buffer.from(buf);
    const z = await zstd.compress(src, 3);
    const c = await bestAsync(() => zstd.compress(src, 3));
    const dcp = await bestAsync(() => zstd.decompress(z, src.length));
    console.log(`  ${name.padEnd(16)} 压缩 ${(c / 1000).toFixed(1).padStart(6)} µs   解压 ${(dcp / 1000).toFixed(1).padStart(6)} µs   合计 ${((c + dcp) / 1000).toFixed(1)} µs`);
  }
  console.log();
}

// ---------- brotli-11 的时间成本（它的压缩率明显更好，但压缩 CPU 是 zstd 的两个数量级）----------
console.log('brotli-11 的时间成本（同一个 zstd-3 预算对比）：');
for (const N of SIZES) {
  const d = makeData(N);
  const src = Buffer.from(pbSoa(d));
  const c = bestSync(() => brotliCompressSync(src, { params: { [zconst.BROTLI_PARAM_QUALITY]: 11 } }), 10);
  const br = brotliCompressSync(src, { params: { [zconst.BROTLI_PARAM_QUALITY]: 11 } });
  const dc = bestSync(() => brotliDecompressSync(br), 10);
  console.log(`  N=${String(N).padStart(4)}  protobuf SoA  压缩 ${(c / 1000).toFixed(1).padStart(8)} µs   解压 ${(dc / 1000).toFixed(1).padStart(6)} µs`);
}
console.log();

// ---------- 只看结论：压缩后 谁更小 ----------
console.log('===== 压缩后的体积对比（相对 protobuf SoA）=====');
for (const N of SIZES) {
  const d = makeData(N);
  const raw = { pbSoA: pbSoa(d), pbAos: pbAos(d), fbAos: fbAos(d) };
  const z = {};
  for (const [k, v] of Object.entries(raw)) z[k] = (await zstd.compress(Buffer.from(v), 19)).length;
  const base = z.pbSoA;
  console.log(`N=${String(N).padStart(4)}  zstd-19: pbSoA ${kb(z.pbSoA)} KB | pbAoS ${kb(z.pbAos)} KB (${((z.pbAos / base - 1) * 100).toFixed(1)}%) | fbAoS ${kb(z.fbAos)} KB (${((z.fbAos / base - 1) * 100).toFixed(1)}%)`);
}
