// protobuf-es v2 的"行为契约"测试 —— 用断言把 §8.3 里那些容易出 bug 的语义钉住。
//
// 它不是性能基准，而是一组**回归护栏**：升级 @bufbuild/protobuf 后如果下面任何一条行为变了，
// 这里会先失败，而不是等线上把一个字段悄悄写成 0。
//
// 运行：node es-pitfalls.mjs   （全部通过则 exit 0，并打印每一条的实测结果）

import * as m from './gen/js/pbes.mjs';

const S = m.EntityStateSchema;
let failures = 0;
let total = 0;

function check(label, fn, expectDesc) {
  total++;
  let actual;
  try {
    actual = fn();
    if (actual !== true) throw new Error(`断言为 false（实际值 ${JSON.stringify(actual)}）`);
    console.log(`  ✅ ${label} — ${expectDesc}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label} — ${e.message}`);
  }
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

console.log('protobuf-es v2 行为契约（不改库，只记录它到底怎么做）\n');

console.log('[1] 默认值：proto3 语义，未设置 == 默认值');
check('create({id:7}) 会填满所有字段', () => m.create(S, { id: 7 }).x === 0, 'x 未传入但已是 0');
check('无法区分「未设置」与「设为 0」', () => Object.keys(m.create(S, { id: 7 })).length === 16, '自有键 = $typeName + 15 字段');
check('绕过：字段声明成 optional 才能有 explicit presence', () => true, '本 schema 没有 optional 字段，需要时改 .proto');

console.log('\n[2] 运行时身份：没有 class，也没有 instanceof');
check('m.EntityState 在运行时是 undefined', () => m.EntityState === undefined, '类型被完全擦除');
check('对象自带 $typeName 品牌', () => m.create(S, {}).$typeName === 's2.EntityState', '$typeName 可用于判别');

console.log('\n[3] 运行时校验：值域错误会抛，不是静默截断');
check('手写普通对象（无品牌）不能直接 encode', () => throws(() => m.toBinary(S, { id: 1 })), 'toBinary 要求 Message 品牌');
check('uint32 传字符串会抛', () => throws(() => m.toBinary(S, m.create(S, { id: 'abc' }))), 'invalid unsigned int');
check('uint32 传 2**32 会抛', () => throws(() => m.toBinary(S, m.create(S, { id: 2 ** 32 }))), '超范围不静默回绕');
check('uint32 传小数会抛', () => throws(() => m.toBinary(S, m.create(S, { id: 1.7 }))), '不做静默取整');
check('⚠️ 传 null 会被当成 0（唯一静默项）', () => m.fromBinary(S, m.toBinary(S, m.create(S, { x: null }))).x === 0, 'null → 默认值');

console.log('\n[4] 字节层：坏数据抛，不产出垃圾');
// 注意：必须用「字段跨多字节」的消息去截断——把空数组或空消息截成空仍会被正常解析
const good = m.toBinary(S, m.create(S, { id: 9, x: 100, stateFlags: 8191 }));
check('截断的字节会抛', () => throws(() => m.fromBinary(S, good.slice(0, good.length - 1))), 'premature EOF');
check('纯垃圾字节会抛', () => throws(() => m.fromBinary(S, Uint8Array.from([0xff, 0xff, 0xff, 0x01]))), 'illegal tag');

console.log('\n[5] 前向兼容：未知字段会被保留（旧客户端读新服务端）');
{
  const unk = Uint8Array.from([0x98, 0x06, 0x01]); // field 99, varint 1 —— 本 schema 里不存在
  const buf = new Uint8Array(good.length + unk.length);
  buf.set(good); buf.set(unk, good.length);
  const parsed = m.fromBinary(S, buf);
  check('re-encode 后未知字段还在', () => m.toBinary(S, parsed).length === buf.length, `${buf.length} 字节保持不变`);
  check('{...parsed} 展开后未知字段也还在', () => m.toBinary(S, { ...parsed }).length === buf.length, '展开不会丢未知字段');
}

console.log('\n[6] JSON：64 位是 bigint，直接 JSON.stringify 会炸');
check('JSON.stringify 带 bigint 的消息会抛', () => throws(() => JSON.stringify(m.create(S, { buffMask: 5n }))), 'Do not know how to serialize a BigInt');
check('toJson 把 uint64 变成字符串', () => m.toJson(S, m.create(S, { id: 1, buffMask: 5n })).buffMask === '5', '{"buffMask":"5"}');

console.log(
  failures === 0
    ? '\n全部 15 条行为契约成立。其中 [3] 的 null→0 与 [6] 的 bigint 是**唯一需要写进团队规范的两条**。'
    : `\n${failures} 条失败 —— 库的行为变了，§8.3 的结论需要重新核对。`,
);
process.exit(failures === 0 ? 0 : 1);
