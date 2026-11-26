// e2e：真 gate（Go）+ TS 逻辑服（server.ts + gatelink.ts）+ WS 客户端，全链路验收。
//
//   客户端(ws) ──WS──► gate(Go) ──TCP──► 逻辑服(TS, 本脚本)
//
// 验收清单：
//   ① Login → hub.createPlayerEntity → 客户端收到 create_player（登录闭环）
//   ② 客户端 callEntity('entity.attack') REQUEST → 逻辑分派 → RESPONSE 原样回包（依赖 gate 的透传补丁）
//   ③ 逻辑服 entity.rpcRequest('entity.query') → 客户端回包 → 配对 resolve（服务端调客户端闭环）
//   ④ group.rpcNotify('scene.chat') → 客户端收到 NOTIFY
//   ⑤ global.rpcNotify('server.notice') → 客户端收到 NOTIFY
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
import { ClientUplinkSchema, LoginSchema } from '../src/gen/gate_pb';
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

class WsClient {
  private readonly ws: WebSocket;
  private buf = new Uint8Array(0);
  private readonly inbox: { env: ReturnType<typeof fromBinary<typeof EnvelopeSchema>>; down: ReturnType<typeof fromBinary<typeof ClientDownlinkSchema>> }[] = [];

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${CLIENT_PORT}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data) => {
      const chunk = new Uint8Array(data as ArrayBuffer);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      const consumed = decodeFrames(merged, (f: Frame) => {
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

  /** 等一条满足条件的下行（method 匹配 + msgType 匹配）。 */
  async recv(method: string, msgType: MsgType, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(({ env }) => env.method === method && env.msgType === msgType);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) fail(`等 ${method}(${msgType}) 超时`);
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

    // ② 逻辑服连 gate（logic.hello 握手）
    const transport = await connectGate({ host: '127.0.0.1', port: LOGIC_PORT, nodeId: 'n-e2e-logic' });

    let player: Entity | undefined;
    let serverRsp: { entityId: string } | undefined;
    const server = createLogicServer({
      transport,
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

    const loginBody = toBinary(ClientUplinkSchema, create(ClientUplinkSchema, {
      body: { case: 'login', value: create(LoginSchema, { token: 'e2e-token', serverId: 's1' }) },
    }));
    client.send(MsgType.MSG_REQUEST, 'client.login', 1, loginBody);

    const created = await client.recv('', MsgType.MSG_NOTIFY); // create_player 的 method 为空
    const cp = created.down.body?.case === 'createPlayer' ? created.down.body.value : undefined;
    if (cp?.entityId !== ENTITY_ID) fail(`create_player 的实体不对: ${cp?.entityId}`);
    if (server.entityOf(ENTITY_ID) !== player) fail('逻辑服没建玩家实体');
    log(`① 登录闭环 ✅  entity=${ENTITY_ID}`);

    // ④ 客户端 callEntity：REQUEST → 逻辑 → RESPONSE（走 gate 的透传补丁）
    const atkReq = create(RefreshEntitySchema, { entityId: 'm1', entityType: 'monster', reason: 2 });
    client.send(MsgType.MSG_REQUEST, 'entity.attack', 7, uplinkCall(ENTITY_ID, toBinary(RefreshEntitySchema, atkReq)));
    const rsp = await client.recv('entity.attack', MsgType.MSG_RESPONSE);
    if (rsp.env.callbackId !== 7) fail(`回包 callback 不对: ${rsp.env.callbackId}`);
    const rspCall = rsp.down.body?.case === 'call' ? rsp.down.body.value : undefined;
    const rspBody = fromBinary(RefreshEntitySchema, rspCall?.content ?? new Uint8Array());
    if (rspBody.entityId !== 'hit-m1') fail(`回包内容不对: ${rspBody.entityId}`);
    log(`② callEntity 闭环 ✅  attack(m1) → hit-m1（callback ${rsp.env.callbackId}）`);

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
    log(`③ entity.rpcRequest 闭环 ✅  query → ${queried.entityId}`);

    // ⑥ 组广播
    const group = server.createGroup('scene-e2e');
    group.join(player!);
    group.rpcNotify('scene.chat', toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'scene' })), { from: ENTITY_ID });
    const g = await client.recv('scene.chat', MsgType.MSG_NOTIFY);
    if (g.down.body?.case !== 'call') fail('组广播应走 ClientDownlink.call');
    log('④ group.rpcNotify ✅');

    // ⑦ 全服广播
    server.global.rpcNotify('server.notice', new Uint8Array([1, 2]), ENTITY_ID);
    await client.recv('server.notice', MsgType.MSG_NOTIFY);
    log('⑤ global.rpcNotify ✅');

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
