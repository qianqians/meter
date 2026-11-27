---
id: task-ts-logic-server
title: TS 逻辑服：entity/group/global + RPC 接口
type: task-spec
status: done
parent: task-redis-mq-to-nats
---

# TS 逻辑服：entity / group / global + RPC

## Request

实现 TS 端游戏逻辑服（放 core，参考 abelkhan 的框架结构——`hub/BaseEntity.cs`、`hub/Group.cs`、`hub/Client.cs`，只参考结构不抄实现）：
1. entity 管理（玩家 + 怪）
2. group（一组 entity）
3. RPC 接口：
   - `entity.rpcRequest<rsp>("method", req) -> rsp`
   - `entity.rpcNotify(ntf)`
   - `group.rpcNotify(ntf)`（广播给 group 内所有玩家）
   - `global.rpcNotify(ntf)`（广播给整个服所有玩家）

## Product（用户已定）

- gate 回包路径这次一起补齐（客户端 REQUEST → 逻辑 → 回包的闭环）。
- entity RPC 只做**本服玩家**（远程实体走 NATS 留到跨服阶段）。
- 参考框架：abelkhan（hub 结构：BaseEntity{id,type,clients,gates} + Request/Notify/Register*；Group{clients,entities,players} Join/Leave + 视图同步）。

## Design

### gate（Go）补丁

`hub.go OnLogic "gate.forwardHubCallClient"`：msgType 不再只由 callbackID 推导——
`MSG_RESPONSE 原样透传`（逻辑层对客户端 REQUEST 的回包），其余维持原语义（callback≠0→REQUEST，=0→NOTIFY）。
`sendCallEntity` 改为接收显式 msgType。group/global 调用点固定 NOTIFY。

### core（TS）新增

- **`entity.ts`**：Entity{id, type, connId?（玩家才有）}。
  - `register(method, ReqSchema, RspSchema, handler)`——客户端→entity 的调用入口（怪/NPC 也走这）；
  - `rpcRequest(method, req, RspSchema) -> Promise<rsp>`——服务端→客户端 REQUEST（gate.forwardHubCallClient），配对靠 callbackId，回包走 gate.clientResponse；
  - `rpcNotify(method, ntf)`——服务端→客户端 NOTIFY；
  - `createRemoteTo(player)/deleteRemoteFrom(player)/refreshTo(player)`——hub.createRemote/delete/refreshEntity（组视图同步原语）。
  - 类型规则与 rpc.ts 相同：schema 值推出返回类型，调用处零泛型参数。
- **`group.ts`**：Group{members: player entities}，join/leave（join 时把成员实体视图同步给新客户端，仿 abelkhan Group.Join）+ `rpcNotify`（gate.forwardHubCallGroup，conn 列表由成员推出、去重）。
- **`server.ts`**：LogicServer。
  - 接 Transport（envelope 字节，同 rpc.ts 的形状，离线可测）；
  - 分派上行：gate.clientLogin（→onLogin 回调→hub.createPlayerEntity+建实体 / 失败 hub.kickOffClient）、
    gate.clientRequest（REQUEST/NOTIFY 按 msgType 区分，按 entity_id 找实体分派）、
    gate.clientResponse（→实体在途请求配对）、gate.clientDisconnect（→销毁玩家、退组）、gate.clientUplink（logout/heartbeat 框架消息钩子）；
  - `global.rpcNotify`（gate.forwardHubCallGlobal）；
  - 实体表 / 组表管理。
- **`gatelink.ts`**：真连接——node net TCP + frame.ts 帧编解码 + 首帧 `logic.hello`（body=nodeId）握手，包成 rpc.ts 的 Transport。
- **e2e**：`core/scripts/e2e.ts`——起真 gate（Go 二进制）+ 逻辑服 + node WS 客户端（Node 22 全局 WebSocket），全链路验收（登录/建实体/callEntity 回包/group 广播/global 广播）。

### 协议映射（不新增 proto）

| 用户 API | 线上形状 |
|---|---|
| entity.rpcRequest | Envelope{REQUEST, gate.forwardHubCallClient, cb} → 客户端 |
| entity.rpcNotify | Envelope{NOTIFY, gate.forwardHubCallClient} |
| entity.register 的回包 | Envelope{RESPONSE, gate.forwardHubCallClient, 原cb}（依赖 gate 补丁） |
| group.rpcNotify | Envelope{NOTIFY, gate.forwardHubCallGroup, conn 列表} |
| global.rpcNotify | Envelope{NOTIFY, gate.forwardHubCallGlobal} |

## 明确推迟

- 跨服 entity 调用（entity_{id}_logic_mq 的路由/所有权表）
- 视图增量同步（refreshEntity 的 diff 策略）、断线重连恢复（Reconnect 分支）
- Redis/Mongo 持久化

## 验证

- gate：`go build/vet/test`（含 forwardHubCallClient RESPONSE 透传新用例）
- core：`tsc --noEmit` + vitest（entity/group/server 离线用例 + gatelink 本机 TCP 握手用例）
- e2e：跑 core/scripts/e2e.ts 对真 gate 全链路
