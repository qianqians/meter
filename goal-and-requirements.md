---
id: meter-goal
type: goal-and-requirements
title: meter —— 面向 Cocos 的 MMORPG 服务器引擎
status: draft
---

# meter —— 面向 Cocos 的 MMORPG 服务器引擎

## 目标

给一款 **Cocos Creator 为一等客户端**的 MMORPG 提供自己的服务器引擎：Go 写的接入层、TypeScript
写的逻辑层、protobuf 写的框架协议。它要把客户端接进来、把上行请求送到实体所在的逻辑节点、把回包与
推送投回去——**业务逻辑不属于它，框架属于它**。

定稿的技术栈：gate = Go，逻辑层 = TypeScript，数据库 = PostgreSQL，服务治理 = consul，传输 = 对内
TCP（内网）/ 对外 WebSocket（客户端走 WSS 接入）。

## 问题

既有方案里同时成立不了三件事（收敛史见 [`docs/server-engine-stack.md`](docs/server-engine-stack.md) §1）：

1. **客户端是 Cocos，脚本层是 TS。** 于是"客户端与服务端同语言"这条唯一净收益只能发生在
   Cocos ↔ 逻辑层之间，拿不到它就不值得引入第二个运行时（这正是 C# / Orleans / abelkhan 被淘汰的
   理由，不是性能）。
2. **目标是持久世界的 MMORPG，不是开房间。** 判定在服务端、需要 AOI 与"同一实体只有一个写者"。
   帧同步那一整条路线因此作废。
3. **现成框架把上面两条钉死。** abelkhan 的客户端绑定只有 C#，而前端是 TS——复用它就得把客户端换成
   .NET 引擎。这套引擎存在的理由就是不被这个绑定绑住。

## 使用者

写这套引擎的人（`core/README.md`、`gate/README.md`、`schema/README.md` 是它的操作手册），以及以后按
业务域往上接的逻辑（背包、任务、战斗、社交……）。

## 能力（代码已经做到的）

- **框架协议**（`schema/`）：7 个 proto / 43 条消息，只描述消息、不描述方法；双端 codegen（Go 与 TS）
  + 11 条结构断言。见 [schema 模块](schema/SPEC.md)，线上形状由 [协议契约](docs/protocol-map.md) 决定。
- **逻辑层运行时**（`core/`）：8 字节帧头、RPC 三函数、每实体串行队列（Actor）+ `fence()` 切割点、
  实体 / 组 / global 逻辑服、主动连入 gate 的 TCP 链路、NATS 旁路封装；63 条 vitest + 一条真 gate 的
  全链路 e2e。见 [core 模块](core/SPEC.md)。
- **接入层**（`gate/`）：对外 WebSocket 与对内 TCP 两个监听端口、帧头切分、`conn ⇄ entity` 会话表、
  客户端 ⇄ 逻辑层双向路由（含组播去重与广播）、JSON 配置（可导出带注释的默认值）、consul 注册与
  TTL 状态上报；51 条 Go 测试 + 零依赖冒烟脚本。见 [gate 模块](gate/SPEC.md)。
- **端到端已通**：WS 客户端 → gate → TS 逻辑服 → 回包 / 广播。
- **可复现的实测**（`spikes/`）：tick 成本、序列化格式对照、RPC 类型安全等六组脚本。见
  [spikes](spikes/SPEC.md)。

## 非目标（按决定排除）

- **AI 生成内容与"引擎里的 agent"不在当前范围。** [`docs/ai-native-game-engine.md`](docs/ai-native-game-engine.md)、
  [`docs/embedded-game-agent.md`](docs/embedded-game-agent.md)、
  [`docs/ai-content-pipeline.md`](docs/ai-content-pipeline.md) 记录的是这套引擎**为什么长成这样**的
  研究与长期愿景，不是计划中的工作。当前代码里没有任何一行 AI。
- **客户端引擎不自研，也不选 Stride / Godot(.NET)。** 客户端定稿为 Cocos Creator，见
  [引擎选型](docs/mmorpg-engine-choice.md)。
- **业务消息不进框架协议。** 背包、任务、战斗、商城、社交、排行等按业务域另开
  `schema/pb/<域>.proto`；框架面当前一条业务消息都没有。
- **不设 dbproxy 进程。** 存储访问下沉为 hub 内的一个模块，不是跨进程协议。
- **不引入 FlatBuffers。** 量化触发条件写在 [协议契约](docs/protocol-map.md) §9，触发之前不引入。
- **协议层不做"取消在途请求"。** 取消是业务方法（各带 `operation_id`），不是协议原语。

## 原则

1. **唯一写者。** 世界状态只有逻辑层写；客户端、gate、脚本机器人都只能提议。这条纪律在每一层都投影
   成一条"不许做什么"，比任何一层"做什么"更重要。
2. **gate 只搬字节。** 接入层只读 8 字节帧头与自己的路由字段，永不解析业务 `content`。
3. **协议先行，业务后加。** 先定框架面（连接 / 会话 / 路由 / 投递 / 存储原语），业务按域往上加；
   `.proto` 只描述消息，方法名的类型绑定留在业务侧。
4. **数字必须实测。** 性能主张走 `spikes/` 的可复现脚本，一个数字只支撑它测的那一件事；测不出来就
   标"未核实"，不凭记忆填。
5. **类型系统当约束用。** TS 类型不是注解：方法名决定请求/响应类型、schema 当值传、枚举由 codegen
   生成——让拼错在编译期挂掉，而不是在线上变成"未知方法丢弃 + 计数"。
