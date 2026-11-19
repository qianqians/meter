// S2：flatbuffer vs protobuf —— TS 侧实测
//
// 同一份数据（1000 个实体状态 + 10 个头字段），四种序列化，量三件事：
//   encode / build   从同一份源数据到字节流
//   decode / read    从字节流到"程序能用的值"
//   bytes            字节流大小
//
// ⚠️ 两个刻意的公平性处理，必须一起读：
//   1. **AoS 语义不同**：protobuf 必须先造出消息对象图再 encode（这是它的模型），
//      FlatBuffers 直接从列式源数据写进 buffer（这是它的模型）。这个差异是**结论的一部分**，
//      不是测量误差 —— 但它意味着"encode 快"里有一部分是"不用造中间对象"。
//   2. **decode 语义不同**：protobuf 的 decode 会物化整个对象图；FlatBuffers 的
//      getRootAs 只是包一层 buffer，真正的成本在**读每个字段**时才付。所以这里把
//      FlatBuffers 分成 wrap（只包一层）与 readAll（读满所有字段）两列，并把
//      "protobuf decode + 读满所有字段"与"FlatBuffers wrap + 读满所有字段"配对比较。
//
// 生成链：
//   flatc   --ts -o gen/ts schema/state.fbs
//   pbjs    -t static-module -w commonjs -o gen/ts/pb_static.cjs schema/state.proto
//   esbuild gen/ts/fb-entry.ts --bundle --format=esm --platform=node --outfile=gen/js/fb.mjs
//
// 运行：node bench-ts.mjs [实体数] [重复次数]

import { createRequire } from 'node:module';
import { hrtime } from 'node:process';
import * as fb from './gen/js/fb.mjs';
import * as pbes from './gen/js/pbes.mjs';

const require = createRequire(import.meta.url);
const pb = require('./gen/ts/pb_static.cjs');

const N = Number(process.argv[2] ?? 1000);
const REPS = Number(process.argv[3] ?? 200);

// ---------- 源数据：列式（SoA），一次生成，所有实现共用 ----------
const id = new Uint32Array(N), kind = new Uint32Array(N);
const x = new Int32Array(N), y = new Int32Array(N), z = new Int32Array(N);
const vx = new Int32Array(N), vy = new Int32Array(N), dir = new Uint32Array(N);
const hp = new Int32Array(N), hpMax = new Int32Array(N), mp = new Int32Array(N);
const level = new Uint32Array(N), faction = new Uint32Array(N), stateFlags = new Uint32Array(N);
const buffMask = new Array(N);            // uint64 → bigint（FlatBuffers 要 bigint）
const buffMaskNum = new Array(N);         // uint64 → number（protobufjs 的 uint64 不认 bigint，会静默写 0；值都 < 2^53 所以安全）
// 与 bench-go/main.go 完全同一套确定性公式（不用 LCG：两门语言的位宽/浮点差异会让数据不同，
// 那就无法验证"两种实现产出的字节数一致"这件事）
const mod32 = (v) => v % 4294967296;
for (let i = 0; i < N; i++) {
  const k = i;
  id[i] = 1000000 + i; kind[i] = (i % 7) + 1;
  x[i] = ((k * 7919) % 200000) - 100000;
  y[i] = ((k * 104729 + 31) % 200000) - 100000;
  z[i] = ((k * 37) % 4000) - 2000;
  vx[i] = ((k * 13) % 800) - 400;
  vy[i] = ((k * 17 + 5) % 800) - 400;
  dir[i] = (k * 29) % 360;
  hp[i] = 1000 + ((k * 61) % 9000); hpMax[i] = 10000; mp[i] = (k * 23) % 500;
  level[i] = 1 + (i % 80); faction[i] = i & 0x03;
  stateFlags[i] = (k * 8191) % 65536;
  buffMaskNum[i] = mod32(k * 2654435761) * 4 + (i & 3);
  buffMask[i] = BigInt(buffMaskNum[i]);
}
// 注意：protobufjs 的 uint64 要 number/string/Long，bigint 会被静默当成 0 —— 这里用字符串
// HEADER 给 FlatBuffers（uint64 要 bigint）；HEADER_PB 给 protobufjs（uint64 要 number/string）
const HEADER = {
  tick: 123456, seq: 98765, sceneId: 42,
  playerId: 9007199254740993n, svrTimeMs: 1795000000000n,
  ackTick: 123400, ackSeq: 98700, protoVer: 3, flags: 0x1f, checksum: 0xdeadbeef,
};

const HEADER_PB = { ...HEADER, playerId: HEADER.playerId.toString(), svrTimeMs: HEADER.svrTimeMs.toString() };

const ns = (a, b) => Number(b - a);
function best(fn) {
  fn(); fn();                                  // warmup
  let bestNs = Infinity, out;
  for (let r = 0; r < REPS; r++) {
    const t0 = hrtime.bigint();
    out = fn();
    const dt = ns(t0, hrtime.bigint());
    if (dt < bestNs) bestNs = dt;
  }
  return { ns: bestNs, out };
}
let sink = 0;

// ---------- 1. protobuf AoS ----------
function pbAosEncode() {
  // ⚠️ 这里必须"跳过零值"，否则和 Go 的字节流对不上：
  // protobufjs 的静态编码器会把"显式设成 0"的字段也写出来（`if (message.x != null)`），
  // 而 protoc-gen-go 按 proto3 规范省略默认值。为了两边可比，这里在建对象时就不写零值字段。
  // ——这个分支本身就是 protobufjs 的额外成本，如实计入 encode 时间。
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    const o = { id: id[i], kind: kind[i], hp: hp[i], hpMax: hpMax[i], level: level[i] };
    if (x[i]) o.x = x[i];
    if (y[i]) o.y = y[i];
    if (z[i]) o.z = z[i];
    if (vx[i]) o.vx = vx[i];
    if (vy[i]) o.vy = vy[i];
    if (dir[i]) o.dir = dir[i];
    if (mp[i]) o.mp = mp[i];
    if (faction[i]) o.faction = faction[i];
    if (stateFlags[i]) o.stateFlags = stateFlags[i];
    if (buffMaskNum[i]) o.buffMask = buffMaskNum[i];
    rows[i] = o;
  }
  return pb.s2.StatePacket.encode({ ...HEADER_PB, entities: rows }).finish();
}
function pbAosDecodeRead(buf) {
  const m = pb.s2.StatePacket.decode(buf);
  let s = 0;
  for (let i = 0; i < m.entities.length; i++) {
    const e = m.entities[i];
    s += e.id + e.x + e.hp + e.stateFlags + Number(e.buffMask);
  }
  sink += s;
}
function pbAosDecodeOnly(buf) {
  const m = pb.s2.StatePacket.decode(buf);
  sink += m.entities.length;
}

// ---------- 2. FlatBuffers AoS（struct 数组） ----------
function fbAosBuild() {
  const b = new fb.Builder(1024 + N * 64 + 256);
  fb.StatePacket.startEntitiesVector(b, N);
  for (let i = 0; i < N; i++) {
    fb.EntityState.createEntityState(b, id[i], kind[i], x[i], y[i], z[i], vx[i], vy[i], dir[i],
      hp[i], hpMax[i], mp[i], level[i], faction[i], stateFlags[i], buffMask[i]);
  }
  const vec = b.endVector();
  const pkt = fb.StatePacket.createStatePacket(b, HEADER.tick, HEADER.seq, HEADER.sceneId,
    HEADER.playerId, HEADER.svrTimeMs, HEADER.ackTick, HEADER.ackSeq, HEADER.protoVer,
    HEADER.flags, HEADER.checksum, vec);
  fb.StatePacket.finishStatePacketBuffer(b, pkt);
  return b.asUint8Array();
}
function fbAosWrap(buf) {
  return fb.StatePacket.getRootAsStatePacket(new fb.ByteBuffer(buf));
}
function fbAosReadAll(p) {
  const n = p.entitiesLength();
  const e = new fb.EntityState();
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (p.entities(i, e)) s += e.id() + e.x() + e.hp() + e.stateFlags() + Number(e.buffMask());
  }
  sink += s;
}

// ---------- 3. protobuf SoA（packed 数组） ----------
function pbSoaEncode() {
  return pb.s2.StatePacketSoA.encode({
    ...HEADER_PB,
    id: Array.from(id), kind: Array.from(kind),
    x: Array.from(x), y: Array.from(y), z: Array.from(z),
    vx: Array.from(vx), vy: Array.from(vy), dir: Array.from(dir),
    hp: Array.from(hp), hpMax: Array.from(hpMax), mp: Array.from(mp),
    level: Array.from(level), faction: Array.from(faction), stateFlags: Array.from(stateFlags),
    buffMask: buffMaskNum.slice(),
  }).finish();
}
function pbSoaDecodeRead(buf) {
  const m = pb.s2.StatePacketSoA.decode(buf);
  let s = 0;
  for (let i = 0; i < m.id.length; i++) {
    s += m.id[i] + m.x[i] + m.hp[i] + m.stateFlags[i] + Number(m.buffMask[i]);
  }
  sink += s;
}

// ---------- 4. FlatBuffers SoA（字段 vector） ----------
function fbSoaBuild() {
  const b = new fb.Builder(1024 + N * 64 + 256);
  const vid = fb.StatePacketSoA.createIdVector(b, id);
  const vkind = fb.StatePacketSoA.createKindVector(b, kind);
  const vx_ = fb.StatePacketSoA.createXVector(b, x);
  const vy_ = fb.StatePacketSoA.createYVector(b, y);
  const vz_ = fb.StatePacketSoA.createZVector(b, z);
  const vvx = fb.StatePacketSoA.createVxVector(b, vx);
  const vvy = fb.StatePacketSoA.createVyVector(b, vy);
  const vdir = fb.StatePacketSoA.createDirVector(b, dir);
  const vhp = fb.StatePacketSoA.createHpVector(b, hp);
  const vhpmax = fb.StatePacketSoA.createHpMaxVector(b, hpMax);
  const vmp = fb.StatePacketSoA.createMpVector(b, mp);
  const vlevel = fb.StatePacketSoA.createLevelVector(b, level);
  const vfaction = fb.StatePacketSoA.createFactionVector(b, faction);
  const vflags = fb.StatePacketSoA.createStateFlagsVector(b, stateFlags);
  const vbuff = fb.StatePacketSoA.createBuffMaskVector(b, buffMask);   // uint64 vector 要 bigint[]
  fb.StatePacketSoA.startStatePacketSoA(b);
  fb.StatePacketSoA.addTick(b, HEADER.tick);
  fb.StatePacketSoA.addSeq(b, HEADER.seq);
  fb.StatePacketSoA.addSceneId(b, HEADER.sceneId);
  fb.StatePacketSoA.addPlayerId(b, HEADER.playerId);
  fb.StatePacketSoA.addSvrTimeMs(b, HEADER.svrTimeMs);
  fb.StatePacketSoA.addAckTick(b, HEADER.ackTick);
  fb.StatePacketSoA.addAckSeq(b, HEADER.ackSeq);
  fb.StatePacketSoA.addProtoVer(b, HEADER.protoVer);
  fb.StatePacketSoA.addFlags(b, HEADER.flags);
  fb.StatePacketSoA.addChecksum(b, HEADER.checksum);
  fb.StatePacketSoA.addId(b, vid);
  fb.StatePacketSoA.addKind(b, vkind);
  fb.StatePacketSoA.addX(b, vx_); fb.StatePacketSoA.addY(b, vy_); fb.StatePacketSoA.addZ(b, vz_);
  fb.StatePacketSoA.addVx(b, vvx); fb.StatePacketSoA.addVy(b, vvy); fb.StatePacketSoA.addDir(b, vdir);
  fb.StatePacketSoA.addHp(b, vhp); fb.StatePacketSoA.addHpMax(b, vhpmax); fb.StatePacketSoA.addMp(b, vmp);
  fb.StatePacketSoA.addLevel(b, vlevel); fb.StatePacketSoA.addFaction(b, vfaction);
  fb.StatePacketSoA.addStateFlags(b, vflags); fb.StatePacketSoA.addBuffMask(b, vbuff);
  const pkt = fb.StatePacketSoA.endStatePacketSoA(b);
  b.finish(pkt);   // StatePacketSoA 不是 root_type，没有生成 finish* helper
  return b.asUint8Array();
}
function fbSoaWrap(buf) {
  return fb.StatePacketSoA.getRootAsStatePacketSoA(new fb.ByteBuffer(buf));
}
function fbSoaReadAll(p) {
  const n = p.idLength();
  let s = 0;
  for (let i = 0; i < n; i++) s += p.id(i) + p.x(i) + p.hp(i) + p.stateFlags(i) + Number(p.buffMask(i));
  sink += s;
}

// ---------- 5. JSON 基线（同一份数据） ----------
function jsonEncode() {
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = { id: id[i], kind: kind[i], x: x[i], y: y[i], z: z[i], vx: vx[i], vy: vy[i], dir: dir[i],
      hp: hp[i], hpMax: hpMax[i], mp: mp[i], level: level[i], faction: faction[i],
      stateFlags: stateFlags[i], buffMask: Number(buffMask[i]) };
  }
  return Buffer.from(JSON.stringify({ ...HEADER, playerId: Number(HEADER.playerId), svrTimeMs: Number(HEADER.svrTimeMs), entities: rows }));
}
function jsonDecodeRead(buf) {
  const m = JSON.parse(buf.toString());
  let s = 0;
  for (let i = 0; i < m.entities.length; i++) {
    const e = m.entities[i];
    s += e.id + e.x + e.hp + e.stateFlags + e.buffMask;
  }
  sink += s;
}

// ---------- 6. protobuf-es（@bufbuild/protobuf v2）----------
// 64 位用原生 bigint —— 不需要 protobufjs 那套 string 转换。
function pbesAosEncode() {
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    const o = { id: id[i], kind: kind[i], hp: hp[i], hpMax: hpMax[i], level: level[i] };
    if (x[i]) o.x = x[i];
    if (y[i]) o.y = y[i];
    if (z[i]) o.z = z[i];
    if (vx[i]) o.vx = vx[i];
    if (vy[i]) o.vy = vy[i];
    if (dir[i]) o.dir = dir[i];
    if (mp[i]) o.mp = mp[i];
    if (faction[i]) o.faction = faction[i];
    if (stateFlags[i]) o.stateFlags = stateFlags[i];
    if (buffMask[i]) o.buffMask = buffMask[i];
    rows[i] = o;
  }
  const msg = pbes.create(pbes.StatePacketSchema, { ...HEADER, entities: rows });
  return pbes.toBinary(pbes.StatePacketSchema, msg);
}
function pbesAosDecodeRead(buf) {
  const m = pbes.fromBinary(pbes.StatePacketSchema, buf);
  let s = 0;
  for (let i = 0; i < m.entities.length; i++) {
    const e = m.entities[i];
    s += e.id + e.x + e.hp + e.stateFlags + Number(e.buffMask);
  }
  sink += s;
}
function pbesAosDecodeOnly(buf) {
  sink += pbes.fromBinary(pbes.StatePacketSchema, buf).entities.length;
}

function pbesSoaEncode() {
  return pbes.toBinary(pbes.StatePacketSoASchema, pbes.create(pbes.StatePacketSoASchema, {
    ...HEADER,
    id: id, kind: kind, x: x, y: y, z: z, vx: vx, vy: vy, dir: dir,
    hp: hp, hpMax: hpMax, mp: mp, level: level, faction: faction, stateFlags: stateFlags,
    buffMask: buffMask,
  }));
}
function pbesSoaDecodeRead(buf) {
  const m = pbes.fromBinary(pbes.StatePacketSoASchema, buf);
  let s = 0;
  for (let i = 0; i < m.id.length; i++) {
    s += m.id[i] + m.x[i] + m.hp[i] + m.stateFlags[i] + Number(m.buffMask[i]);
  }
  sink += s;
}

const us = (v) => (v / 1000).toFixed(1);
const enc = (v) => ((v / N) ).toFixed(0);

console.log(`node ${process.version}  实体数=${N}  重复=${REPS}（取最快一次）\n`);

const rows = [];
function line(name, buildFn, decodeOnlyFn, readFn) {
  const b = best(buildFn);
  const buf = b.out;
  const bytes = buf.length;
  const d = decodeOnlyFn ? best(() => decodeOnlyFn(buf)) : null;
  const r = best(() => readFn(buf));
  rows.push({ name, buildUs: b.ns / 1000, bytes, decodeUs: d ? d.ns / 1000 : null, readUs: r.ns / 1000, perEntityNs: (r.ns / N) });
}

line('protobufjs AoS', pbAosEncode, pbAosDecodeOnly, (buf) => pbAosDecodeRead(buf));
line('FlatBuffers AoS（struct 数组）', fbAosBuild, (buf) => { fbAosWrap(buf); }, (buf) => fbAosReadAll(fbAosWrap(buf)));
line('protobufjs SoA（packed 数组）', pbSoaEncode, null, (buf) => pbSoaDecodeRead(buf));
line('FlatBuffers SoA（字段 vector）', fbSoaBuild, (buf) => { fbSoaWrap(buf); }, (buf) => fbSoaReadAll(fbSoaWrap(buf)));
line('protobuf-es AoS', pbesAosEncode, pbesAosDecodeOnly, (buf) => pbesAosDecodeRead(buf));
line('protobuf-es SoA（packed 数组）', pbesSoaEncode, null, (buf) => pbesSoaDecodeRead(buf));
line('JSON（基线）', jsonEncode, null, (buf) => jsonDecodeRead(buf));

console.log('实现                              encode µs   bytes   每实体 B   wrap µs   read+decode µs   每实体 ns');
for (const r of rows) {
  console.log(
    r.name.padEnd(32) +
    r.buildUs.toFixed(1).padStart(9) +
    String(r.bytes).padStart(9) +
    (r.bytes / N).toFixed(1).padStart(10) +
    (r.decodeUs === null ? '        —' : r.decodeUs.toFixed(1).padStart(9)) +
    r.readUs.toFixed(1).padStart(16) +
    r.perEntityNs.toFixed(0).padStart(12),
  );
}
console.log(`\n(sink=${sink.toExponential(3)}，用于防止 DCE)`);
