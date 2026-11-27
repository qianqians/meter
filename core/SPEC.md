---
id: meter-core
type: module-design
status: draft
title: core —— 逻辑层运行时
parent: meter-architecture
depends-on: [meter-protocol]
tags: [typescript, logic-layer]
---

# core —— 逻辑层运行时

## 职责

世界状态的持有者与唯一写者的所在层。当前只到**运行时骨架**：帧头、RPC 三函数、每实体串行队列
（Actor）、实体 / 组 / global 逻辑服、**多 gate 链路与跨 gate 寻址**、会话目录占位与**跨节点顶号**、
主动连入 gate 的链路、NATS 旁路封装。AOI、战斗判定、任务这些还没写。

## 边界

- **可以依赖**：`schema` 生成的 TS 消息、一个 `Transport` 接口、`node:*`。
- **可选注入**：一个 `NodeBus`（节点→节点的通知，目前只有顶号）。和 `Transport` 一样是为了能离线单测
  ——本模块**不直接连 Redis / NATS**：会话目录在 gate 侧，节点只通过 `hub.claimUser` 问它。
- **禁止依赖**：引擎（`import 'cc'`）、socket 细节、渲染态。字节只能经 `Transport` 进出，所以同一份逻辑
  能在 Node 里被单测、被 e2e、被压测驱动。
- **不许变成第二套规则**：以后才有的 Cython `kernel` 只做被 profile 证明的热点；规则出现在那里，
  `core` 就不再是唯一写者。
- ⚠️ `import 'cc'` 这条**目前没有 CI 强制**（仓库里没有 ESLint 配置），见
  [架构](../docs/server-engine-stack.md) §2.1 的现状注。

## 不变量（都在测试里钉着）

- **三函数 API**：`callEntity(method, reqBytes, RspSchema)` / `callGroup(method, reqBytes)` /
  `register(method, ReqSchema, RspSchema, handler)`。调用点**不写泛型参数**——响应类型由 schema **值**推断。
  原因写在 [`README.md`](README.md)：泛型在运行时被擦除，而回包只是一段字节，没有一个运行时能拿到的
  schema 值就解不出来。
- **同一个 handler 同时服务单播与组播**；每实体一张分派表，无连接的实体（怪）只收不主动发。
- **失败一律有确定行为**：未知方法丢弃 + 计数（要回包的调用收 `NOT_FOUND`）；handler 抛错回 `UNKNOWN`
  并带回文案；超时抛 `TIMEOUT` 并清掉在途记录；迟到响应静默丢弃。
- **帧头行为归** [协议契约](../docs/protocol-map.md) 所有；本模块只是它的 TS 实现（`src/frame.ts`）。

## 执行模型：唯一写者怎么落地

上面那条「唯一写者」不是文档纪律，是 `src/actor.ts` 的队列语义：

- **每实体串行**：客户端调用先进入本实体的队列，同一实体严格串行（FIFO、异常隔离、并发恰好一次），
  不同实体互不等待；`dispatch` 只入队、不当场执行。**不需要 abelkhan 的 CAS claim + 释放后复查**：
  那是 C# 多线程的要求；JS 单线程下「队列空 → 释放 draining」之间没有 await，post 插不进来。
- **客户端回包不入队**：`onClientResponse` 直接 resolve 在途 Promise。入队会与「drain 逐个 await
  handler」互锁——handler 在等回包，回包却排在队尾（abelkhan 有这个潜在死锁）。
- **`fence()` 是切割点**：排在调用这一刻已入队的调用之后，全部完成后 resolve；只能在队列外调用
  （在 job 内 fence 自己会自锁）。顶号 / 迁移的「切割前的工作已完成」靠它定义，时序见
  [差距清单](../docs/abelkhan-core-gap.md) §3。
- **`destroy()` 关队列**：丢弃排队中的调用（`fence`/等待方收到 `ActorClosedError`），之后到达的调用
  计入 `stats.closed`；正在执行的那一条不打断（JS 没有取消）。
- 队列**无上限**，只暴露 `pending`。上限必须连带拒绝/重试契约，属于背压，不在本模块当前范围。

## 会话与顶号

一个账号只能有一个写者。三条规则都在 `src/server.ts` 的 `gate.clientLogin` 里，顺序不能变：

1. **先占位**：`onLogin` 拿到 `userId/entityId` 后，先向**这条连接所在的那台 gate** 发
   `hub.claimUser`，等 `gate.ownerInfo`（占位前的旧主人 + 本次的 `seq`）。占位失败就拒绝登录——
   目录是“不能有两个写者”的前提，宁登不上也不猜。
2. **旧主人在别的节点**：向 `hub_{旧节点}_mq` 发 `HubSessionReplaced{user_id, entity_id, gate_name,
   conn_id, seq}`，然后本地照常建。旧节点收到后**用自己那条 gate 链路**踢旧连接、把旧实体以
   `replaced` 退役。状态不搬（存储模块还没写），所以跨节点是“退役 + 重建”。
3. **旧主人就在本节点**：同 `userId` + 同 `entityId` → `Entity.rebind(connId, gateName)`，
   **复用同一个对象**（内存状态不丢），只换连接并重发 `CreatePlayerEntity`；换了 `entityId`，
   或者 `entityId` 被另一个账号占着 → 先退役旧的（`replaced`）再建。

**`seq` 是幂等键**：迟到的 `HubSessionReplaced`（`seq` 不大于本地记的）直接丢弃，
否则会把刚建好的新会话又踢一次。

**退役钩子带原因**：`onPlayerDestroy(player, 'disconnect' | 'replaced')`——掉线要做离线处理，
被顶号通常要结算并提示“你已在别处登录”。复用旧对象时**不会**触发本钩子（对象还在）。

## 协议映射（一次说清）

`entity.rpcRequest` → `gate.forwardHubCallClient{REQUEST}`，回包 → `{RESPONSE, 原 callback_id}`；
`group.rpcNotify` → `gate.forwardHubCallGroup`（按 gate 分组，每个 gate 一条）；
`global.rpcNotify` → `gate.forwardHubCallGlobal`（每台 gate 各一条）。
**每条下行都带自己的 `gateName`**：`conn_id` 只在所属 gate 内有意义，发错链路客户端就收不到回包。

`hub.claimUser` → gate 回 `gate.ownerInfo`；跨节点顶号 → `hub_{node}_mq` 上的 `hub.sessionReplaced`。

**登录与心跳不经过本模块**：`client.login` 由 gate 在 `hub.createPlayerEntity` 时回 `LoginResult`，
`HeartBeat` 与空帧 ping 由 gate 直接答。逻辑层只在 `gate.clientUplink` 里看到 logout 与 ack。

## 还没接

持久化（PostgreSQL 存储模块，定稿但一行代码都没有，所以顶号只能做到“复用在同节点、跨节点重建”）、
断线重连（`gate.clientReconnect`）、跨服实体调用（NATS `entity_{id}_logic_mq`，缺实体所有权表）、
方法级内容鉴权（框架只转发，鉴权是每个可被客户端调用的方法自己的责任）。
