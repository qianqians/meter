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

世界状态的持有者与唯一写者的所在层。当前只到**运行时骨架**：帧头、RPC 三函数、实体 / 组 / global 逻辑
服、主动连入 gate 的链路、NATS 旁路封装。AOI、战斗判定、任务这些还没写。

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

## 协议映射（一次说清，schema 侧零新增）

`entity.rpcRequest` → `gate.forwardHubCallClient{REQUEST}`，回包 → `{RESPONSE, 原 callback_id}`；
`group.rpcNotify` → `gate.forwardHubCallGroup`；`global.rpcNotify` → `gate.forwardHubCallGlobal`。

## 还没接

持久化（PostgreSQL 存储模块，定稿但一行代码都没有）、断线重连（`gate.clientReconnect`）、跨服实体调用
（NATS `entity_{id}_logic_mq`，缺实体所有权表）、方法级内容鉴权（框架只转发，鉴权是每个可被客户端调用的
方法自己的责任）。
