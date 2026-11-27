# core —— 逻辑层的运行时骨架（第一行真代码）

协议与执行模型落在几个小文件上：

| 文件 | 内容 |
|---|---|
| [`src/frame.ts`](src/frame.ts) | **8 字节帧头**编解码（`flags:zstd | len:u24 | ts:u32`）、半包处理、`oneWayDelayMs()`（有符号差值处理 49.7 天回绕 + 异常时钟 clamp） |
| [`src/rpc.ts`](src/rpc.ts) | **RPC 三函数**：`callEntity` / `callGroup` / `register`，信封装配、`callback_id` 配对、超时、未知方法丢弃+计数 |
| [`src/actor.ts`](src/actor.ts) | **每实体串行队列**：`post` / `call` / `fence` / `close`。同一实体严格串行，`fence()` 是顶号/迁移的切割点（见 [`SPEC.md`](SPEC.md)「执行模型」） |

## 跑

```bash
cd schema && ./check.sh    # 先出 codegen（生成到 core/src/gen/，已 gitignore）
cd ../core
npm install                # 首次
npm test                   # vitest：73 条
npm run typecheck          # tsc --noEmit
npm run e2e                # 全链路：先 cd ../gate && go build -o ../core/scripts/gate-e2e.exe ./cmd/gate
```

## API（就是那三个函数）

```ts
const rpc = createRpc({ transport });           // transport 只搬字节

// 发：要回包。返回类型由 RspSchema 推出，不用写泛型
const rsp = await rpc.callEntity(
  'entity.attack',
  toBinary(AttackRequestSchema, req),
  AttackResultSchema,
);

// 发：组播/广播，不回包
rpc.callGroup('scene.sync', toBinary(SceneSyncSchema, req));

// 收：同一个 handler 既处理单播也处理广播
rpc.register('entity.attack', AttackRequestSchema, AttackResultSchema,
  (req) => ({ damage: 42, crit: false }));
```

**为什么不是 `callEntity<Rsp>(method, req)`**：`<Rsp>` 是编译期的，运行时被擦除；回包是一段字节，必须有一个 **schema 值**才知道拿谁去解。类型从 schema 参数推断，效果一样，而且类型与 schema 不可能对不上。

## 已验证的行为（测试里就是这些）

- 帧头：往返、**半包只消费完整帧**、未知 flags 位抛错、`ts` 跨 32 位回绕算对、异常时钟 clamp
- `callEntity`：REQUEST→RESPONSE 按 `callback_id` 配对，服务端改过的字段能回到客户端
- `callGroup`：NOTIFY 无 `callback_id`，服务端执行但**不回包**
- 未知方法：服务端丢弃 + 计数，要回包的调用收到 `NOT_FOUND`
- handler 抛错：回 `UNKNOWN` 且错误文案带回
- 超时：按配置抛 `TIMEOUT` 并清掉在途记录
- 迟到响应（回调 id 已不存在）：静默丢弃，不炸
- Actor：同一实体的调用严格串行（第一个在等外部事件时第二个不开始）、job 抛错不影响后续、
  并发恰好一次、`fence()` 只覆盖调用那一刻已入队的调用、`close()` 丢弃排队中的并把等待方 reject
- 实体销毁：排队中的调用被丢弃（不回包），之后到达的调用计入 `stats.closed`

## 还没做的

- 接真传输（WebSocket / 裸 TCP）：现在只有 `Transport` 接口 + 内存实现
- 压缩（帧头 `flags` 的 zstd 位还没接）
- 权限：`CallEntity` 的 `entity_id` 鉴权在逻辑层，这里只转发
- 与 `gate` 的实现联动：gate 的 Go 侧帧头还没写

## 逻辑服 API（entity / group / global）

```ts
import { connectGate } from './src/gatelink';
import { createLogicServer } from './src/server';

// 一台 gate 一条链路；名字来自 gate 的握手回包（logic.hello.ack）
const gateLink = await connectGate({ host: '127.0.0.1', port: 9002, nodeId: 'logic-a' });
const server = createLogicServer({
  gates: [gateLink], nodeId: 'logic-a',
  // 跨节点顶号需要节点总线（NATS hub_{nodeId}_mq）；单节点部署可以不给
  // bus: createBus(mq),
  onLogin: (login, { connId }) => ({
    ok: true, userId: login.token, entityId: `e-${connId}`,
    entityType: 'player', content: toBinary(PlayerInfoSchema, info),
  }),
  onPlayerDestroy: (player, reason) => {
    // reason: 'disconnect'（掉线）| 'replaced'（被顶号）
  },
  onPlayerCreate: (player) => {
    // 客户端 → 实体：与 rpc.register 同形状
    player.register('entity.attack', AtkReqSchema, AtkRspSchema,
      (req) => ({ damage: calcDamage(req) }));

    // 实体 → 客户端（要回包 / 不回包）
    const rsp = await player.rpcRequest('entity.query', toBinary(QrySchema, q), RspSchema);
    player.rpcNotify('entity.buff', toBinary(BuffSchema, buff));
  },
});

// 怪（无连接：只收客户端调用，不能主动发）
const wolf = server.createEntity('e-wolf-1', 'monster');
wolf.register('entity.attack', AtkReqSchema, AtkRspSchema, handler);

// 组（join 时双向视图同步；广播给组内所有玩家）
const scene = server.createGroup('scene-1');
scene.join(player);
scene.join(wolf);
scene.rpcNotify('scene.chat', toBinary(ChatSchema, msg), { from: player.id });

// 全服广播
server.global.rpcNotify('server.notice', toBinary(NoticeSchema, n));

// 切割点：这一刻已入队的调用全部跑完后 resolve（顶号/迁移用；不要在 handler 里 fence 自己）
await player.fence();

// 顶号：把实体重新绑到新连接（同一个对象，内存状态不丢；旧连接的在途请求被 reject）
player.rebind(newConnId, gateName);
```

**上行分派表**（gate → 逻辑服，server.ts 内部）：
`gate.clientLogin` → onLogin 决策 → `hub.createPlayerEntity` / `hub.kickOffClient`；
`gate.clientRequest`（REQUEST/NOTIFY 按 msgType 区分）→ 按 entity_id 分派；
`gate.clientResponse` → 配对实体的在途 `rpcRequest`；
`gate.clientDisconnect` → 销毁实体 + 退组；
`gate.clientUplink` → 只认 logout / ack（心跳由 gate 直接答，登录回包也由 gate 发）；
`hub.claimUser` → gate 回 `gate.ownerInfo`（会话目录占位，登录路径上先做这一步）。

**顶号**：同 `userId` + 同 `entityId` → `rebind` 复用旧对象；换了实体 id 或被别的账号占着 → 旧的以
`replaced` 退役再建。旧主人在别的节点时，经 `hub_{node}_mq` 发 `HubSessionReplaced` 让它退役
（`seq` 比本地小就丢弃）。见 [`SPEC.md`](SPEC.md)「会话与顶号」。

**协议映射**：`entity.rpcRequest`→`gate.forwardHubCallClient{REQUEST}`，
回包→`{RESPONSE, 原 callback_id}`（gate 侧透传）；`group.rpcNotify`→`gate.forwardHubCallGroup`；
`global.rpcNotify`→`gate.forwardHubCallGlobal`。零新增 proto。

已知缺口：clientUplink 透传不带 conn_id（logout 只给 reason）；断线重连（gate.clientReconnect）未处理；
跨服 entity 调用（NATS entity_{id}_logic_mq）留待实体所有权表；持久化（所以跨节点顶号只能"退役 + 重建"，
内存状态不跟着走）。
