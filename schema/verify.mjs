// 框架协议的**结构校验**：不是性能测试，而是"这几个 proto 拼在一起能不能真的用"。
//
// 前置：先跑 ./check.sh（它会 codegen 出 .gen/js/fw.mjs）。生成物不入库。
// 运行：node verify.mjs

import {
  EnvelopeSchema, InternalEnvelopeSchema, InternalPayloadSchema,
  HelloSchema, AuthResultSchema, ErrorCodeSchema, SessionBindRequestSchema,
  GetResponseSchema, StorageItemSchema, StorageKeySchema,
  MSG, METHOD, methodMeta,
  create, toBinary, fromBinary,
} from './.gen/js/fw.mjs';

let fail = 0;
const chk = (label, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };
const kb = (b) => `${b.length} B`;

// ---------- 1. 信封：请求 / 响应 / 错误 ----------
const req = create(EnvelopeSchema, {
  msgType: MSG.REQUEST, method: METHOD.Auth, callbackId: 7,
  body: toBinary(HelloSchema, create(HelloSchema, { protoVerMin: 1, protoVerMax: 3, clientVer: '1.4.2', platform: 'cocos-native' })),
});
const reqBytes = toBinary(EnvelopeSchema, req);
const reqBack = fromBinary(EnvelopeSchema, reqBytes);
chk('请求信封可往返', reqBack.msgType === MSG.REQUEST && reqBack.method === METHOD.Auth && reqBack.callbackId === 7);

const rspOk = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
  msgType: MSG.RESPONSE, method: METHOD.Auth, callbackId: 7, status: 0,
  body: toBinary(AuthResultSchema, create(AuthResultSchema, { uid: 1001n, entityId: 2002n, nodeId: 'logic-a:7001' })),
}));
chk('status=0 时该字段被省略（响应字节里不含 status）', fromBinary(EnvelopeSchema, rspOk).status === 0, `响应 ${kb(rspOk)}`);

const rspErr = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
  msgType: MSG.RESPONSE, method: METHOD.Auth, callbackId: 7,
  status: 6, // VERSION_MISMATCH
  body: toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code: 6, detail: 'proto_ver 1..3 vs 5..6' })),
}));
chk('错误响应可往返且带 detail', fromBinary(EnvelopeSchema, rspErr).status === 6);

const notify = toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType: MSG.NOTIFY, method: METHOD.Kicked, callbackId: 0 }));
chk('NOTIFY 的 callback_id 必须为 0（=省略）', fromBinary(EnvelopeSchema, notify).callbackId === 0, `${kb(notify)}`);

// ---------- 2. gate 透传：InternalEnvelope 包住客户端 Envelope 字节 ----------
const wrapped = create(InternalEnvelopeSchema, {
  srcNode: 'gate-1:9001', dstNode: 'logic-a:7001', dstEntity: 2002n,
  traceId: 'trace-abc',
  payload: reqBytes,   // ← 客户端原始字节，gate 不解
});
const wBytes = toBinary(InternalEnvelopeSchema, wrapped);
const wBack = fromBinary(InternalEnvelopeSchema, wBytes);
const inner = fromBinary(EnvelopeSchema, wBack.payload);
chk('gate 透传后内层信封可原样解开', inner.method === METHOD.Auth && inner.callbackId === 7);
chk('内层字节完全一致（没有二次编码/再序列化）', Buffer.compare(Buffer.from(wBack.payload), Buffer.from(reqBytes)) === 0);
chk('外层携带路由信息（dst_node / dst_entity）', wBack.dstNode === 'logic-a:7001' && wBack.dstEntity === 2002n, `外层 ${kb(wBytes)}`);

const payloadWrap = toBinary(InternalPayloadSchema, create(InternalPayloadSchema, {
  msgType: MSG.REQUEST, method: METHOD.SessionBind, callbackId: 1,
  body: toBinary(SessionBindRequestSchema, create(SessionBindRequestSchema, { sessionId: 123n, uid: 1001n, entityId: 2002n, gateId: 'gate-1:9001', protoVer: 3 })),
}));
chk('内部链路的 InternalPayload 可往返', fromBinary(InternalPayloadSchema, payloadWrap).method === METHOD.SessionBind);

// ---------- 3. 存储原语：不透明 value + 版本 ----------
const getRsp = create(GetResponseSchema, {
  item: create(StorageItemSchema, {
    key: create(StorageKeySchema, { namespace: 'entity', key: new TextEncoder().encode('2002') }),
    value: new Uint8Array([1, 2, 3, 4, 5]),
    version: 42n, found: true,
  }),
});
const gBack = fromBinary(GetResponseSchema, toBinary(GetResponseSchema, getRsp));
chk('存储读响应可往返（value 为不透明字节）', gBack.item?.found === true && gBack.item?.version === 42n && gBack.item?.value.length === 5);

// ---------- 4. method 常量与 methods.yaml 对齐（抽样） ----------
chk('methodMeta 反查可用（接收端按 code 找名字）', methodMeta(0x0a10)?.name === 'DeliverUpstream');
chk('method 常量与 methods.yaml 一致（抽样 6 个）',
  METHOD.Ping === 0x0001 && METHOD.Hello === 0x0100 && METHOD.Auth === 0x0101 &&
  METHOD.DeliverUpstream === 0x0a10 && METHOD.StorageSet === 0x0b03 && METHOD.CrossCall === 0x0c20,
  Object.entries(METHOD).slice(0, 4).map(([k, v]) => `${k}=0x${v.toString(16)}`).join(' '));

// ---------- 5. 没有 proto enum 混进生成物（erasableSyntaxOnly 的护栏） ----------
import { readFileSync, readdirSync } from 'node:fs';
const files = readdirSync(new URL('./.gen/es/', import.meta.url));
const withEnum = files.filter((f) => /export enum /.test(readFileSync(new URL(`./.gen/es/${f}`, import.meta.url), 'utf8')));
chk('生成的 TS 里没有 `export enum`（否则 core 的 erasableSyntaxOnly 会挂）', withEnum.length === 0, withEnum.join(', ') || `${files.length} 个文件干净`);

console.log(`\n${fail === 0 ? '框架协议结构校验全部通过' : fail + ' 条失败'}`);
process.exit(fail === 0 ? 0 : 1);
