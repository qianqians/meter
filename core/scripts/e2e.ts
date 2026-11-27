// e2e：真 gate（Go）+ TS 逻辑服（server.ts + gatelink.ts）+ WS 客户端，全链路验收。
//
//   客户端(ws) ──WS──► gate(Go) ──TCP──► 逻辑服(TS, 本脚本)
//
// 验收清单：
//   ① 连上就收到 NotifyConnID（conn_id / proto_ver / 心跳间隔 / 帧上限）
//   ② Login → hub.createPlayerEntity（create_player）+ 登录 RESPONSE（LoginResult，原 callback_id）
//   ③ 客户端 callEntity('entity.attack') REQUEST → 逻辑分派 → RESPONSE 原样回包（依赖 gate 的透传补丁）
//   ④ 逻辑服 entity.rpcRequest('entity.query') → 客户端回包 → 配对 resolve（服务端调客户端闭环）
//   ⑤ group.rpcNotify('scene.chat') → 客户端收到 NOTIFY
//   ⑥ global.rpcNotify('server.notice') → 客户端收到 NOTIFY
//   ⑦ 心跳：HeartBeat → HeartBeatResult；空帧 ping → 空帧 pong
//
// 跑法（在仓库根）：
//   cd gate && go build -o ../core/scripts/gate-e2e.exe ./cmd/gate
//   cd ../core && npm run e2e
// 环境变量 GATE_BIN 可指定 gate 二进制路径。

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { EnvelopeSchema, MsgType } from '../src/gen/envelope_pb';
import { ClientUplinkSchema, HeartBeatSchema, LoginSchema } from '../src/gen/gate_pb';
import { CallEntitySchema } from '../src/gen/common_pb';
import { ClientDownlinkSchema } from '../src/gen/client_pb';
import { RefreshEntitySchema } from '../src/gen/client_pb';
import { encodeFrame, decodeFrames, type Frame } from '../src/frame';
import { connectGate } from '../src/gatelink';
import { createLogicServer } from '../src/server';
import type { Entity } from '../src/entity';

const LOGIC_PORT = 19501;
const CLIENT_PORT = 19502;
const ENTITY_ID = 'e-e2e-player';
const GATE_BIN = process.env.GATE_BIN ?? join(fileURLToPath(new URL('.', import.meta.url)), 'gate-e2e.exe');

const log = (...a: unknown[]) => console.log('[e2e]', ...a);
const fail = (msg: string): never => {
  console.error('[e2e] ✗ ' + msg);
  process.exitCode = 1;
  throw new Error(msg);
};

async function waitPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(); });
        s.on('error', reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) fail(`端口 ${port} 等不到 gate 起来`);
      await sleep(150);
    }
  }
}

// ---------------- 客户端（ws + 帧 + 信封 + ClientUplink/Downlink） ----------------

function uplinkCall(entityId: string, content: Uint8Array): Uint8Array {
  return toBinary(ClientUplinkSchema, create(ClientUplinkSchema, {
    body: { case: 'call', value: create(CallEntitySchema, { entityId, content }) },
  }));
}

type Env = ReturnType<typeof fromBinary<typeof EnvelopeSchema>>;
type Down = ReturnType<typeof fromBinary<typeof ClientDownlinkSchema>>;

class WsClient {
  private readonly ws: WebSocket;
  private buf = new Uint8Array(0);
  /** 收到的空帧（pong）数：len==0 的帧不是 Envelope，解析不了。 */
  pongs = 0;
  private readonly inbox: { env: Env; down: Down }[] = [];

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${CLIENT_PORT}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data) => {
      const chunk = new Uint8Array(data as ArrayBuffer);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      const consumed = decodeFrames(merged, (f: Frame) => {
        if (f.payload.length === 0) { this.pongs++; return; }
        const env = fromBinary(EnvelopeSchema, f.payload);
        this.inbox.push({ env, down: fromBinary(ClientDownlinkSchema, env.body) });
      });
      this.buf = merged.slice(consumed);
    });
  }

  get opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(msgType: MsgType, method: string, callbackId: number, body: Uint8Array): void {
    this.ws.send(encodeFrame({
      flags: 0, ts: Date.now() & 0xffffffff,
      payload: toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType, method, callbackId, body })),
    }));
  }

  /** 等一条满足条件的下行（method + msgType，可选再按 body 的 oneof 成员筛）。 */
  async recv(method: string, msgType: MsgType, timeoutMs = 5000, match?: (down: Down) => boolean) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(({ env, down }) =>
        env.method === method && env.msgType === msgType && (!match || match(down)));
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) fail(`等 ${method}(${msgType}) 超时`);
      await sleep(20);
    }
  }

  /** len==0 的帧 = 保活帧（协议里的最省 ping）。 */
  ping(): void {
    this.ws.send(encodeFrame({ flags: 0, ts: Date.now() & 0xffffffff, payload: new Uint8Array(0) }));
  }

  async waitPong(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pongs === 0) {
      if (Date.now() > deadline) fail('等 pong 超时');
      await sleep(20);
    }
  }
}

// ---------------- 主流程 ----------------

async function main() {
  // ① 起 gate
  const dir = mkdtempSync(join(tmpdir(), 'gate-e2e-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ listen: { logic_port: LOGIC_PORT, client_port: CLIENT_PORT } }));
  const gate = spawn(GATE_BIN, ['-config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  gate.on('error', (e) => fail(`起不了 gate（${GATE_BIN}）: ${e.message}`));
  try {
    await waitPort(LOGIC_PORT);
    await waitPort(CLIENT_PORT);
    log(`gate 起来了（logic :${LOGIC_PORT} / client :${CLIENT_PORT}）`);

    // ② 逻辑服连 gate（logic.hello → logic.hello.ack，拿到 gate 名字）
    const gateLink = await connectGate({ host: '127.0.0.1', port: LOGIC_PORT, nodeId: 'n-e2e-logic' });
    log(`逻辑服已连上 gate：${gateLink.name}`);

    let player: Entity | undefined;
    let serverRsp: { entityId: string } | undefined;
    const server = createLogicServer({
      gates: [gateLink],
      nodeId: 'n-e2e-logic',
      onLogin: (login) => {
        if (!login.token) return { ok: false, code: 4, detail: 'no token' };
        return { ok: true, userId: 'u-e2e', entityId: ENTITY_ID, entityType: 'player', content: new Uint8Array([9]) };
      },
      onPlayerCreate: (p) => {
        player = p;
        p.register('entity.attack', RefreshEntitySchema, RefreshEntitySchema, (req) =>
          create(RefreshEntitySchema, { entityId: `hit-${req.entityId}`, entityType: 'player', reason: 1 }));
      },
    });

    // ③ 客户端接入 + 登录
    const client = new WsClient();
    await client.opened;
    log('客户端 WS 已连');

    // ① 连上第一条必须是 NotifyConnID
    const hello = await client.recv('', MsgType.MSG_NOTIFY, 5000, (d) => d.body?.case === 'connId');
    const hb = hello.down.body?.case === 'connId' ? hello.down.body.value : fail('下行不是 NotifyConnID');
    if (!hb.connId) fail('NotifyConnID 没有 conn_id');
    if (hb.protoVer === 0) fail('NotifyConnID 没有 proto_ver');
    if (hb.heartbeatMs === 0) fail('NotifyConnID 没有 heartbeat_ms');
    if (hb.maxFrameBytes === 0) fail('NotifyConnID 没有 max_frame_bytes');
    log(`① NotifyConnID ✅  conn=${hb.connId} proto_ver=${hb.protoVer} heartbeat=${hb.heartbeatMs}ms frame≤${hb.maxFrameBytes}B`);

    const loginBody = toBinary(ClientUplinkSchema, create(ClientUplinkSchema, {
      body: { case: 'login', value: create(LoginSchema, { token: 'e2e-token', serverId: 's1' }) },
    }));
    client.send(MsgType.MSG_REQUEST, 'client.login', 1, loginBody);

    const created = await client.recv('', MsgType.MSG_NOTIFY, 5000, (d) => d.body?.case === 'createPlayer');
    const cp = created.down.body?.case === 'createPlayer' ? created.down.body.value : undefined;
    if (cp?.entityId !== ENTITY_ID) fail(`create_player 的实体不对: ${cp?.entityId}`);
    if (server.entityOf(ENTITY_ID) !== player) fail('逻辑服没建玩家实体');

    // 登录是 REQUEST：必须收到原 callback_id 的 RESPONSE，body 是 LoginResult
    const loginRsp = await client.recv('client.login', MsgType.MSG_RESPONSE);
    if (loginRsp.env.status !== 0) fail(`登录回包 status=${loginRsp.env.status}`);
    if (loginRsp.env.callbackId !== 1) fail(`登录回包 callback_id 不对: ${loginRsp.env.callbackId}`);
    const lr = loginRsp.down.body?.case === 'login' ? loginRsp.down.body.value : fail('登录回包不是 LoginResult');
    if (lr.userId !== 'u-e2e' || lr.entityId !== ENTITY_ID) {
      fail(`LoginResult 字段不对: user=${lr.userId} entity=${lr.entityId}`);
    }
    log(`② 登录闭环 ✅  LoginResult{u=${lr.userId}, e=${lr.entityId}, token=${lr.resumeToken.length}B}`);

    // ④ 客户端 callEntity：REQUEST → 逻辑 → RESPONSE（走 gate 的透传补丁）
    const atkReq = create(RefreshEntitySchema, { entityId: 'm1', entityType: 'monster', reason: 2 });
    client.send(MsgType.MSG_REQUEST, 'entity.attack', 7, uplinkCall(ENTITY_ID, toBinary(RefreshEntitySchema, atkReq)));
    const rsp = await client.recv('entity.attack', MsgType.MSG_RESPONSE);
    if (rsp.env.callbackId !== 7) fail(`回包 callback 不对: ${rsp.env.callbackId}`);
    const rspCall = rsp.down.body?.case === 'call' ? rsp.down.body.value : undefined;
    const rspBody = fromBinary(RefreshEntitySchema, rspCall?.content ?? new Uint8Array());
    if (rspBody.entityId !== 'hit-m1') fail(`回包内容不对: ${rspBody.entityId}`);
    log(`③ callEntity 闭环 ✅  attack(m1) → hit-m1（callback ${rsp.env.callbackId}）`);

    // ⑤ 服务端调客户端：entity.rpcRequest → 客户端回包 → 配对 resolve
    //    客户端在收到 query REQUEST 时应答
    void (async () => {
      const q = await client.recv('entity.query', MsgType.MSG_REQUEST);
      const answer = create(RefreshEntitySchema, { entityId: 'client-side', entityType: 'player' });
      client.send(MsgType.MSG_RESPONSE, 'entity.query', q.env.callbackId,
        uplinkCall(ENTITY_ID, toBinary(RefreshEntitySchema, answer)));
    })();
    const queried = await player!.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema);
    serverRsp = { entityId: queried.entityId };
    if (queried.entityId !== 'client-side') fail(`rpcRequest 回包不对: ${queried.entityId}`);
    log(`④ entity.rpcRequest 闭环 ✅  query → ${queried.entityId}`);

    // ⑥ 组广播
    const group = server.createGroup('scene-e2e');
    group.join(player!);
    group.rpcNotify('scene.chat', toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'scene' })), { from: ENTITY_ID });
    const g = await client.recv('scene.chat', MsgType.MSG_NOTIFY);
    if (g.down.body?.case !== 'call') fail('组广播应走 ClientDownlink.call');
    log('⑤ group.rpcNotify ✅');

    // ⑦ 全服广播
    server.global.rpcNotify('server.notice', new Uint8Array([1, 2]), ENTITY_ID);
    await client.recv('server.notice', MsgType.MSG_NOTIFY);
    log('⑥ global.rpcNotify ✅');

    // ⑦ 心跳：HeartBeat → HeartBeatResult（gate 直接答，不过逻辑层）
    const hbReq = toBinary(ClientUplinkSchema, create(ClientUplinkSchema, {
      body: { case: 'heartbeat', value: create(HeartBeatSchema, { clientTimeMs: 1234n }) },
    }));
    client.send(MsgType.MSG_REQUEST, 'client.heartbeat', 11, hbReq);
    const hbRsp = await client.recv('client.heartbeat', MsgType.MSG_RESPONSE);
    if (hbRsp.env.callbackId !== 11) fail(`心跳回包 callback 不对: ${hbRsp.env.callbackId}`);
    const hbRes = hbRsp.down.body?.case === 'heartbeat' ? hbRsp.down.body.value : fail('心跳回包不是 HeartBeatResult');
    if (hbRes.clientTimeMs !== 1234n) fail(`client_time_ms 应原样回传: ${hbRes.clientTimeMs}`);
    log(`⑦ 心跳回包 ✅  server_time=${hbRes.serverTimeMs}ms`);

    // ⑦b 空帧 ping → 空帧 pong
    client.ping();
    await client.waitPong();
    log('⑦b 空帧 pong ✅');

    void serverRsp;
    console.log('\ne2e 全链路通过 ✅');
  } finally {
    gate.kill();
    await sleep(100);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows 句柄未释放，无妨 */ }
  }
}

main().catch((e) => {
  console.error('[e2e] 失败:', e);
  process.exit(1);
});
