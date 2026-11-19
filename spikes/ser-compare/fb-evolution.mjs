// FlatBuffers 的演进测试：schema 里给 struct 加一个字段，上线后到底会发生什么？
// 以及"改用 table 就能演进"这条替代路线要付多少读取成本？
//
// 三个问题：
//   ① 老字节（15 字段 struct）用新代码（16 字段 struct）解 —— 会报错吗？解出来对不对？
//   ② 老字节用"table 版本"的新代码解 —— 会报错吗？
//   ③ struct 数组 vs table 数组，读 1000 个实体的成本差多少？
//
// 运行：node fb-evolution.mjs

import { hrtime } from 'node:process';
import * as v1 from './gen/js/fb.mjs';   // schema/state.fbs：15 字段 struct
import * as v2 from './gen/js/fb2.mjs';  // schema/fb-evolution.fbs：16 字段 struct + table 版本

const N = 1000;
const v = (label, val) => console.log(label.padEnd(52), val);

// ---------- 数据（与 bench-ts.mjs 同一套公式） ----------
const id = new Uint32Array(N), kind = new Uint32Array(N);
const x = new Int32Array(N), y = new Int32Array(N), z = new Int32Array(N);
const vx = new Int32Array(N), vy = new Int32Array(N), dir = new Uint32Array(N);
const hp = new Int32Array(N), hpMax = new Int32Array(N), mp = new Int32Array(N);
const level = new Uint32Array(N), faction = new Uint32Array(N), stateFlags = new Uint32Array(N);
const buffMask = new Array(N);
for (let i = 0; i < N; i++) {
  const k = i;
  id[i] = 1000000 + i; kind[i] = (i % 7) + 1;
  x[i] = ((k * 7919) % 200000) - 100000; y[i] = ((k * 104729 + 31) % 200000) - 100000;
  z[i] = ((k * 37) % 4000) - 2000; vx[i] = ((k * 13) % 800) - 400; vy[i] = ((k * 17 + 5) % 800) - 400;
  dir[i] = (k * 29) % 360; hp[i] = 1000 + ((k * 61) % 9000); hpMax[i] = 10000; mp[i] = (k * 23) % 500;
  level[i] = 1 + (i % 80); faction[i] = i & 3; stateFlags[i] = (k * 8191) % 65536;
  buffMask[i] = BigInt((k % 4294967296) * 4 + (i & 3));
}

// ---------- 老版本（struct，15 字段）编码出"线上已有字节" ----------
function buildV1() {
  const b = new v1.Builder(1024 + N * 64 + 256);
  v1.StatePacket.startEntitiesVector(b, N);
  for (let i = 0; i < N; i++) {
    v1.EntityState.createEntityState(b, id[i], kind[i], x[i], y[i], z[i], vx[i], vy[i], dir[i],
      hp[i], hpMax[i], mp[i], level[i], faction[i], stateFlags[i], buffMask[i]);
  }
  const vec = b.endVector();
  const pkt = v1.StatePacket.createStatePacket(b, 1, 2, 3, 4n, 5n, 6, 7, 8, 9, 10, vec);
  v1.StatePacket.finishStatePacketBuffer(b, pkt);
  return b.asUint8Array();
}

const oldBytes = buildV1();
v('① 老字节大小（1000 实体，struct 64 B/实体）', oldBytes.length + ' B');

// ---------- ① 新 struct（16 字段）解老字节 ----------
try {
  const bb = new v2.ByteBuffer(oldBytes);
  const pkt = v2.StatePacketV2.getRootAsStatePacketV2(bb);
  const n = pkt.entitiesLength();
  const e = new v2.EntityStateV2();
  // 拿几个字段跟真值对比
  pkt.entities(0, e);
  const first = { id: e.id(), x: e.x(), hp: e.hp(), flags: e.stateFlags() };
  v('① 新 struct 解老字节：报错了吗', '没有报错');
  v('① 实体数读出来', n + '（正确应为 ' + N + '）');
  v('① 第 0 个实体 id / x / hp / flags',
    `${first.id} / ${first.x} / ${first.hp} / ${first.flags}`);
  v('① 真值应为', `${id[0]} / ${x[0]} / ${hp[0]} / ${stateFlags[0]}`);
  // 抽样对比前 5 个实体的 hp，看错了幾個
  let wrong = 0;
  for (let i = 0; i < Math.min(50, n); i++) {
    pkt.entities(i, e);
    if (e.id() !== id[i] || e.hp() !== hp[i]) wrong++;
  }
  v('① 前 50 个实体里 id/hp 不一致的数量', wrong + ' / 50');
} catch (err) {
  v('① 新 struct 解老字节', 'THROW: ' + err.message);
}

// ---------- ② table 版本解老字节 ----------
try {
  const bb = new v2.ByteBuffer(oldBytes);
  const pkt = v2.StatePacketT.getRootAsStatePacketT(bb);
  v('② 新 table 解老字节：报错了吗', '没有报错，entitiesLength=' + pkt.entitiesLength());
} catch (err) {
  v('② 新 table 解老字节', 'THROW: ' + err.message.slice(0, 70));
}

// ---------- ③ struct 数组 vs table 数组：读 1000 实体的成本 ----------
function buildTable() {
  const b = new v2.Builder(1024 + N * 160 + 256);
  const offs = new Array(N);
  for (let i = 0; i < N; i++) {
    v2.EntityStateT.startEntityStateT(b);
    v2.EntityStateT.addId(b, id[i]);
    v2.EntityStateT.addKind(b, kind[i]);
    v2.EntityStateT.addX(b, x[i]);
    v2.EntityStateT.addY(b, y[i]);
    v2.EntityStateT.addZ(b, z[i]);
    v2.EntityStateT.addVx(b, vx[i]);
    v2.EntityStateT.addVy(b, vy[i]);
    v2.EntityStateT.addDir(b, dir[i]);
    v2.EntityStateT.addHp(b, hp[i]);
    v2.EntityStateT.addHpMax(b, hpMax[i]);
    v2.EntityStateT.addMp(b, mp[i]);
    v2.EntityStateT.addLevel(b, level[i]);
    v2.EntityStateT.addFaction(b, faction[i]);
    v2.EntityStateT.addStateFlags(b, stateFlags[i]);
    v2.EntityStateT.addBuffMask(b, buffMask[i]);
    offs[i] = v2.EntityStateT.endEntityStateT(b);
  }
  v2.StatePacketT.startEntitiesVector(b, N);
  for (let i = N - 1; i >= 0; i--) b.addOffset(offs[i]);
  const vec = b.endVector();
  v2.StatePacketT.startStatePacketT(b);
  v2.StatePacketT.addEntities(b, vec);
  const pkt = v2.StatePacketT.endStatePacketT(b);
  b.finish(pkt);   // StatePacketT 不是 root_type，没有生成 finish*Buffer helper
  return b.asUint8Array();
}

const tableBytes = buildTable();
v('③ table 数组的字节大小', tableBytes.length + ' B（struct 版 ' + oldBytes.length + ' B）');

let sink = 0;
const best = (fn, reps = 200) => {
  fn(); fn();
  let min = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = hrtime.bigint();
    fn();
    const dt = Number(hrtime.bigint() - t0);
    if (dt < min) min = dt;
  }
  return min;
};

const readStruct = (buf) => {
  const pkt = v1.StatePacket.getRootAsStatePacket(new v1.ByteBuffer(buf));
  const n = pkt.entitiesLength();
  const e = new v1.EntityState();
  let s = 0;
  for (let i = 0; i < n; i++) { if (pkt.entities(i, e)) s += e.id() + e.x() + e.hp() + e.stateFlags(); }
  sink += s;
};
const readTable = (buf) => {
  const pkt = v2.StatePacketT.getRootAsStatePacketT(new v2.ByteBuffer(buf));
  const n = pkt.entitiesLength();
  const e = new v2.EntityStateT();
  let s = 0;
  for (let i = 0; i < n; i++) { if (pkt.entities(i, e)) s += e.id() + e.x() + e.hp() + e.stateFlags(); }
  sink += s;
};

// 两条路径都先充分预热，否则先跑的那条会被 JIT 拖慢，比值失真（第一版就踩了：3.45× vs 稳定的 2.0×）
for (let i = 0; i < 300; i++) { readStruct(oldBytes); readTable(tableBytes); }
const nsStruct = best(() => readStruct(oldBytes));
const nsTable = best(() => readTable(tableBytes));
v('③ 读 1000 实体：struct 数组', (nsStruct / 1000).toFixed(0) + ' ns/实体（' + (nsStruct / 1000).toFixed(1) + ' µs 总计）');
v('③ 读 1000 实体：table 数组', (nsTable / 1000).toFixed(0) + ' ns/实体（' + (nsTable / 1000).toFixed(1) + ' µs 总计）');
v('③ table / struct 读取成本比', (nsTable / nsStruct).toFixed(2) + '×');
v('③ 字节比（table / struct）', (tableBytes.length / oldBytes.length).toFixed(2) + '×');

console.log(`\n(sink=${sink.toExponential(3)})`);
