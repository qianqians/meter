// 校验候选 Envelope 的线上形态：每种消息到底多少字节、status=0 是否真的不占空间
import * as e from './gen/js/envelope.mjs';

const hex = (u8) => Buffer.from(u8).toString('hex');
const size = (u8) => u8.length;
let fail = 0;
const chk = (label, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

const body100 = new Uint8Array(100).fill(0xAB);

const mk = (over) => e.create(e.EnvelopeSchema, {
  msgType: e.MsgType.Msg_Request, method: 0x0204, callbackId: 42, body: body100, ...over,
});

const req = e.toBinary(e.EnvelopeSchema, mk({}));
const rspOk = e.toBinary(e.EnvelopeSchema, mk({ msgType: e.MsgType.Msg_Response }));
const rspOkExplicitZero = e.toBinary(e.EnvelopeSchema, mk({ msgType: e.MsgType.Msg_Response, status: 0 }));
const rspErr = e.toBinary(e.EnvelopeSchema, mk({ msgType: e.MsgType.Msg_Response, status: 403 }));
const notify = e.toBinary(e.EnvelopeSchema, mk({ msgType: e.MsgType.Msg_Notify, callbackId: 0 }));
const none = e.toBinary(e.EnvelopeSchema, mk({ msgType: e.MsgType.Msg_None, callbackId: 0 }));

console.log('消息                     字节   信封开销(不含 100 B body)   十六进制前缀');
const row = (n, b) => console.log(`${n.padEnd(22)}${String(size(b)).padStart(6)}${String(size(b) - 100).padStart(24)}   ${hex(b.slice(0, 14))}…`);
row('Request', req); row('Response (ok)', rspOk); row('Response (ok, 显式 0)', rspOkExplicitZero);
row('Response (status=403)', rspErr); row('Notify', notify); row('Msg_None', none);
console.log();

chk('status = 0 时完全不占字节（与显式写 0 的字节完全相同）', hex(rspOk) === hex(rspOkExplicitZero));
chk('错误响应的额外开销 = 3 字节（tag + 2 字节 varint）', size(rspErr) - size(rspOk) === 3, `${size(rspErr) - size(rspOk)} B`);
chk('Notify 不占 callback_id（=0 被省略，省 2 字节）', size(req) - size(notify) === 2, `Notify ${size(notify)} B vs Request ${size(req)} B`);
chk('Msg_None(=0) 时 msg_type 整个字段被省略（再省 2 字节）', size(notify) - size(none) === 2, `None ${size(none)} B vs Notify ${size(notify)} B`);

// 往返
const back = e.fromBinary(e.EnvelopeSchema, req);
chk('往返字段一致', back.msgType === e.MsgType.Msg_Request && back.method === 0x0204 && back.callbackId === 42 && back.body.length === 100);
chk('body 是独立的 Uint8Array（会被复制，不是视图）', back.body !== body100 && back.body.length === 100);

// 未知 enum 值（新服务端 → 老客户端）会怎样
const unknownType = Uint8Array.from([0x08, 0x63 /* msg_type=99 */, 0x10, 0x04]);
const u = e.fromBinary(e.EnvelopeSchema, unknownType);
chk('未知 msg_type 不被当成错误，数字原样保留', u.msgType === 99, `msgType=${u.msgType} → 接收端必须靠 default 分支丢弃`);

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 条失败'}`);
process.exit(fail === 0 ? 0 : 1);
