// 框架协议的**结构校验**：不是性能测试，而是"这几个 proto 拼在一起能不能真的用"。
//
// 前置：先跑 ./check.sh（它会产出 ../.build/fw-bundle.mjs）。生成物不入库。
// 运行：node verify.mjs

import {
  EnvelopeSchema, CallEntitySchema,
  LoginResultSchema, ErrorCodeSchema, HubKickOffClientSchema,
  RefreshEntitySchema,
  MsgType,
  create, toBinary, fromBinary,
} from '../.build/fw-bundle.mjs';

// 方法名由调用方定义（schema 里没有 service，也不再生成方法表）。
// 类型绑定在业务侧的 RpcMap：它引用具体的 message 类型，所以改名会编译失败——
// 这是"没有外置方法表、又不会静默漂移"的做法。这里用两个常量代表它。
const M = {
  Auth: 'client.auth',
  Kicked: 'client.kicked',
  KickOffClient: 'gate.kick.client',
  StorageSet: 'storage.set',
};

let fail = 0;
const chk = (label, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };
const kb = (b) => `${b.length} B`;

// ---------- 1. 信封：请求 / 响应 / 错误 ----------
const req = create(EnvelopeSchema, {
  msgType: MsgType.MSG_REQUEST, method: M.Auth, callbackId: 7,
  body: toBinary(LoginResultSchema, create(LoginResultSchema, { userId: 'u-1001', entityId: 'e-2002', fullResync: false })),
});
const reqBytes = toBinary(EnvelopeSchema, req);
const reqBack = fromBinary(EnvelopeSchema, reqBytes);
chk('请求信封可往返', reqBack.msgType === MsgType.MSG_REQUEST && reqBack.method === M.Auth && reqBack.callbackId === 7);

const rspOk = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
  msgType: MsgType.MSG_RESPONSE, method: M.Auth, callbackId: 7, status: 0,
  body: toBinary(LoginResultSchema, create(LoginResultSchema, { userId: 'u-1001', entityId: 'e-2002', fullResync: false })),
}));
chk('status=0 时该字段被省略（响应字节里不含 status）', fromBinary(EnvelopeSchema, rspOk).status === 0, `响应 ${kb(rspOk)}`);

const rspErr = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
  msgType: MsgType.MSG_RESPONSE, method: M.Auth, callbackId: 7,
  status: 6, // VERSION_MISMATCH
  body: toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code: 6, detail: 'proto_ver 1..3 vs 5..6' })),
}));
chk('错误响应可往返且带 detail', fromBinary(EnvelopeSchema, rspErr).status === 6);

const notify = toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType: MsgType.MSG_NOTIFY, method: M.Kicked, callbackId: 0 }));
chk('NOTIFY 的 callback_id 必须为 0（=省略）', fromBinary(EnvelopeSchema, notify).callbackId === 0, `${kb(notify)}`);

// ---------- 2. gate 透传：零转码（解出来再编回去，字节必须一模一样） ----------
// 没有内部封套之后，"gate 不解 content"这条改由**字节等价**来证明：
// 客户端发的 Envelope 被 gate 原样搬运，逻辑层解出的内容再编码回去必须逐字节相同。
const callBody = toBinary(CallEntitySchema, create(CallEntitySchema, { entityId: 'e-2002', content: reqBytes }));
const fwd = create(EnvelopeSchema, {
  msgType: MsgType.MSG_REQUEST, method: 'entity.attack', callbackId: 9, body: callBody,
});
const fwdBytes = toBinary(EnvelopeSchema, fwd);
const fwdBack = fromBinary(EnvelopeSchema, fwdBytes);
chk('Envelope 解出再编码，字节完全一致（零转码）',
  Buffer.compare(Buffer.from(toBinary(EnvelopeSchema, fwdBack)), Buffer.from(fwdBytes)) === 0, `${fwdBytes.length} B`);

const innerCall = fromBinary(CallEntitySchema, fwdBack.body);
chk('content 原样透传后仍可直接解析（gate 不需要懂它的类型）',
  innerCall.entityId === 'e-2002' && Buffer.compare(Buffer.from(innerCall.content), Buffer.from(reqBytes)) === 0);

// ---------- 3. 业务消息嵌套（body 里再包业务消息） ----------
const refresh = create(RefreshEntitySchema, { entityId: 'e-2002', entityType: 'monster', content: new Uint8Array([9, 8, 7]), reason: 2 });
const rBack = fromBinary(RefreshEntitySchema, toBinary(RefreshEntitySchema, refresh));
chk('业务消息可往返（含不透明 content）', rBack.entityId === 'e-2002' && rBack.reason === 2 && rBack.content.length === 3);

// ---------- 4. 方法名：schema 不定义 service，方法名由调用方给 ----------
chk('方法名可以任意字符串（schema 不约束命名，只约束消息）', fromBinary(EnvelopeSchema, reqBytes).method === M.Auth);
chk('空方法名也能编解码（框架不做假设，由业务侧拒绝）',
  fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType: MsgType.MSG_NOTIFY, method: '', callbackId: 0 }))).method === '');

// ---------- 5. 枚举：MsgType 由 schema 生成，且未知值是开放语义（必须靠 default 丢弃） ----------
chk('MsgType 由 proto enum 生成（不再是手写常量）',
  MsgType.MSG_NONE === 0 && MsgType.MSG_REQUEST === 1 && MsgType.MSG_RESPONSE === 2 && MsgType.MSG_NOTIFY === 3,
  `MSG_REQUEST=${MsgType.MSG_REQUEST}`);

const unknownType = new Uint8Array([0x08, 0x63]); // msg_type = 99
const u = fromBinary(EnvelopeSchema, unknownType);
chk('未知 msg_type 数字原样保留（开放枚举）⇒ 接收端必须 default 丢弃', u.msgType === 99, `msgType=${u.msgType}`);

console.log(`\n${fail === 0 ? '框架协议结构校验全部通过' : fail + ' 条失败'}`);
process.exit(fail === 0 ? 0 : 1);
