# core —— 逻辑层的运行时骨架（第一行真代码）

目前只有两个文件，但它们把协议落到了可执行的形状上：

| 文件 | 内容 |
|---|---|
| [`src/frame.ts`](src/frame.ts) | **8 字节帧头**编解码（`flags:zstd | len:u24 | ts:u32`）、半包处理、`oneWayDelayMs()`（有符号差值处理 49.7 天回绕 + 异常时钟 clamp） |
| [`src/rpc.ts`](src/rpc.ts) | **RPC 三函数**：`callEntity` / `callGroup` / `register`，信封装配、`callback_id` 配对、超时、未知方法丢弃+计数 |
| [`src/rpc.test.ts`](src/rpc.test.ts) | 10 条验收测试（内存传输，无网络） |

## 跑

```bash
cd schema && ./check.sh    # 先出 codegen（生成到 core/src/gen/，已 gitignore）
cd ../core
npm install                # 首次
npm test                   # vitest：10 条
npm run typecheck          # tsc --noEmit
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

## 还没做的

- 接真传输（WebSocket / 裸 TCP）：现在只有 `Transport` 接口 + 内存实现
- 压缩（帧头 `flags` 的 zstd 位还没接）
- 权限：`CallEntity` 的 `entity_id` 鉴权在逻辑层，这里只转发
- 与 `gate` 的实现联动：gate 的 Go 侧帧头还没写
