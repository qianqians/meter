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
（Actor）、实体 / 组 / global 逻辑服、主动连入 gate 的链路、NATS 旁路封装。AOI、战斗判定、任务这些还没写。

## 边界

- **可以依赖**：`schema` 生成的 TS 消息、一个 `Transport` 接口、`node:*`。就这些。
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

## 协议映射（一次说清，schema 侧零新增）

`entity.rpcRequest` → `gate.forwardHubCallClient{REQUEST}`，回包 → `{RESPONSE, 原 callback_id}`；
`group.rpcNotify` → `gate.forwardHubCallGroup`；`global.rpcNotify` → `gate.forwardHubCallGlobal`。

## 还没接

持久化（PostgreSQL 存储模块，定稿但一行代码都没有）、迁移本身（`fence()` 已就位，切割 / 重建 /
接管未接，路线见 [差距清单](../docs/abelkhan-core-gap.md) §3）、断线重连（`gate.clientReconnect`）、
跨服实体调用（NATS `entity_{id}_logic_mq`，缺实体所有权表）、方法级内容鉴权（框架只转发，鉴权是每个
可被客户端调用的方法自己的责任）。
