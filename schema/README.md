# 框架协议（底层协议先行，业务协议暂不生成）

本目录是本仓库**第一批真正的工程产物**：`schema/pb/*.proto` 是服务端框架面的协议定义，
`.proto` **只描述消息**——方法名不在 schema 里，类型绑定在业务侧的 `RpcMap`（见 §4）。

**状态：框架协议 v1 定稿（2026-11-20）**。**7 个 proto**、`./check.sh` **11 条断言全绿**；业务消息按需求暂不生成。

范围纪律（按需求："先生成底层框架上的协议，功能相关的先不生成"）：

- ✅ 连接、会话、路由、投递、存储访问（**在 hub 内部，不是独立进程**）、节点发现、实体迁移、频道扇出
- ❌ 背包 / 任务 / 战斗 / 商城 / 社交 / 排行 等**业务消息一律不在本目录**

业务域以后按 `schema/pb/<域>.proto` 往上加，只管消息。

---

## 1. 与 abelkhan 的对照（2026-11 抓取原文核对）

abelkhan（`qianqians/abelkhan`，C#、LGPL-2.1）的 `proto/` 实际有 **16 个文件**：

- **框架面 6 个**：`common.proto` / `client.proto` / `gate_client.proto` / `hub_gate.proto` / `gate_hub.proto` / `hub_hub.proto`
- **业务面 8 个**：`bag.proto` / `mail.proto` / `shop.proto` / `leaderboard.proto` / `friend.proto` / `chat.proto` / `guild.proto` / `quest.proto`
- **codegen 脚本 2 个**：`codegen.sh` / `codegen.bat`（**只有 `--csharp_out`，没有任何 rpc 插件**）

### 1.1 它的线上协议本体（`common.proto` 全文）

```proto
message CallRpc { string proto_name = 1; bytes content = 2; }
message HeartBeats {}
message Request  { string msg_id = 1; CallRpc event = 2; }
message Response { string msg_id = 1; string err_msg = 2; CallRpc event = 3; }
message Notify   { CallRpc event = 1; }
message Msg { oneof payload { Request req = 1; Response rsp = 2; Notify notify = 3; HeartBeats heart_beats = 4; } }
```

**四条与我们相同的决定**（算是外部佐证）：
方法名是**字符串**、业务体是 **bytes**、外层有独立**信封**、帧边界靠传输（所以包头只需要长度）。

### 1.2 四条链路的分工

| 链路 | 文件 | 内容 |
|---|---|---|
| 客户端 ⇄ gate | `gate_client.proto` | `GateForwardClientRequestHub` / `…ResponseHub` / `…NotifyHub`、`ClientRequestReconnect`、`ClientRequestService`、`VersionHandshake`、`AckReliabilityMsg` |
| gate ⇄ hub | `gate_client.proto`（回程）+ `hub_gate.proto` | `ClientRequestHub` / `ClientResponseHub` / `ClientNotifyHub`、`ClientDisconnect` |
| hub ⇄ gate | `gate_hub.proto` | `GateForwardHubRequestClient` / `…ResponseClient` / `…NotifyClient` / **`…NotifyClientMq`（带 seq）**、实体生命周期 `HubCreatePlayerEntity` / `HubCreateRemoteEntity` / `HubDeleteRemoteEntity` / `HubRefreshEntity`、`HubKickOffClient`、`GateForwardHubCallGlobal` |
| hub ⇄ hub | `hub_hub.proto` | **`TakeOverUser`（同账号抢连接）**、`FriendConfirmAdd` / `…Result`（跨服好友确认）、`ChatBroadcast`（Redis pub/sub） |

实体生命周期另有客户端侧的一半在 `client.proto`：`CreatePlayerEntity` / `CreateRemoteEntity` / `DeleteRemoteEntity` / `RefreshEntity` / `NotifyConnID`。

### 1.3 我们该偷的三件事（当前 `schema/pb/` 缺）

| # | 机制 | 为什么必须补 |
|---|---|---|
| 1 | **可靠投递 + ack**：`HubNotifyClientMq{seq}` + 客户端回 `AckReliabilityMsg{seq}`，gate 按 seq 校验"这条 ack 对应的是不是队列头" | 聊天/邮件/好友确认这类**跨服、可离线**的消息需要"至少一次 + 去重"。我们现在只有 `DeliverDownstream`，没有投递保证 |
| 2 | **实体生命周期控制面**：`CreatePlayerEntity` / `CreateRemoteEntity` / `DeleteRemoteEntity` / `RefreshEntity` | 我们在 `gate_logic.proto` 只有会话绑定/解绑，没有"进入视野的远程实体如何创建/销毁"这层；这是 AOI 之外的第二条同步通道 |
| 3 | **`TakeOverUser`（抢人）** | 同账号在新 gate 登录时，让旧 gate 让位并清理会话。我们只有 `DUPLICATE_LOGIN` 错误码 + `KickSession`，缺少"接管"这条原子路径 |

### 1.4 我们比它强的地方（不改）

| 点 | abelkhan | 我们 |
|---|---|---|
| 方法名怎么保证不错 | `proto_name` 是裸字符串，改名消息**不会报错** | 方法名由调用方给，但**类型绑定写在 `RpcMap`**：它引用具体的 message 类型，改名即编译失败（比裸字符串强，比 proto `service` 少一层校验） |
| 错误 | 只有 `err_msg` 字符串（`FriendConfirmAddResult.code` 也是 `"ok"`/`"target_full"` 这种文本） | `status` = int32 错误码 + `detail` 文本，客户端可以可靠分支 |
| 心跳 | `HeartBeats{}` 消息（占一格 oneof + protobuf 包装） | **`len == 0` 的帧**，零字节 |
| 帧头 | 无时间戳 | `ts`（单调毫秒，逐跳覆盖，只做诊断） |
| 关联 id | `msg_id` 是 **string** | `callback_id` 是 **uint32**（每包省 ~10 字节） |
| 实体/会话 id | 全是 `string`（`entity_id` / `user_id` / `conn_id`） | `uint64`（varint 更省；代价是需要一个全局 id 分配器） |

## 2. 目录

```
schema/
  pb/
    common.proto          标识 / 错误码 / 通用包装 / **CallEntity（两方向共用）**
    envelope.proto        Envelope（唯一信封）+ MsgType enum
    gate.proto            客户端发出的请求（Login / Reconnect / Logout / HeartBeat / AckReliable）
    client.proto          客户端消费的：NotifyConnID/LoginResult/实体/踢人/公告 + CallGlobal（CallEntity 在 common）
    gate_logic.proto      logic → gate（Hub* 维护状态 / GateForwardHub* 转发给客户端）
    logic_gate.proto      gate → logic（客户端上行投递 / 断线 / 重连 / 服务级请求）
    logic_logic.proto     logic ⇄ logic（迁移 / 跨调用 / 频道；**服务发现交给 consul**）
  check.sh                codegen + 结构校验（一条命令）
  verify.mjs              11 条结构断言
```

文件命名沿用 abelkhan 的 `<dst>_<src>` 约定：`logic_gate.proto` = 发往 logic、来自 gate；
`gate_logic.proto` = 发往 gate、来自 logic。

生成物去向（都在 .gitignore 里）：**`gate/internal/pb/`**（Go 消息，gate 直接编译）、**`core/src/gen/`**（TS 消息，逻辑层直接 import）、**`.build/`**（中间产物：descriptor set + 校验用 bundle）。

---

## 3. 怎么跑

```bash
cd schema
./check.sh
```

它做五件事：`protoc` 编译（顺带出 descriptor set）→ `protoc-gen-go` → `protoc-gen-es`
（经 `spikes/ser-compare/gen-es.mjs`，绕开 Windows 上 npm 只给 `.cmd`、protoc/buf 不能直接调用的问题）
→ 打一份 bundle 后跑 `verify.mjs`。

**11 条结构断言**（`./check.sh` 全绿）：

| # | 断言 | 实测 |
|---|---|---|
| 1 | 请求信封可往返 | |
| 2 | status=0 时该字段被省略（响应字节里不含 status） | `响应 35 B` |
| 3 | 错误响应可往返且带 detail | |
| 4 | NOTIFY 的 callback_id 必须为 0（=省略） | `17 B` |
| 5 | Envelope 解出再编码，字节完全一致（零转码） | `66 B` |
| 6 | content 原样透传后仍可直接解析（gate 不需要懂它的类型） | |
| 7 | 业务消息可往返（含不透明 content） | |
| 8 | 方法名可以任意字符串（schema 不约束命名，只约束消息） | |
| 9 | 空方法名也能编解码（框架不做假设，由业务侧拒绝） | |
| 10 | MsgType 由 proto enum 生成（不再是手写常量） | `MSG_REQUEST=1` |
| 11 | 未知 msg_type 数字原样保留（开放枚举）⇒ 接收端必须 default 丢弃 | `msgType=99` |

---

## 4. 三条必须守住的规矩

1. **schema 里没有 `service`，也没有外置方法表。** 方法名由调用方给（点分隔短名，如 `"client.auth"`），
   **类型绑定写在业务侧的 `RpcMap`**：它引用具体的 message 类型，所以改消息名会编译失败。
   不要退回"yaml 方法表"——那张表的 `req`/`rsp` 是没法校验的字符串，改名时只会静默漂移。
2. **`fmt`/`msgId` 不进帧头。** 帧头只有 **8 字节**（压缩位 + 长度 + 单调时间戳），任何新语义都加 `Envelope` 字段
   （`reserved 6 to 15` 就是留给它的）。
3. **gate 只解自己那一层。** 客户端上行是 `Envelope{..., body=CallEntity{entity_id, content}}`，
   gate 只读 `entity_id` 做路由、**不看 `content`**——第 6 条断言（透传零转码）就是在守这条。
4. **协议层没有"取消在途请求"。** 顺序链路上 `CancelCall` 必然排在它要取消的请求之后，
   服务端那时多半已经处理完了；能取消的窗口极窄，却多一个攻击面。需要取消的业务（取消匹配/读条/寻路）
   各自带 `operation_id`，是**普通业务方法**。配套的三条要求（迟到响应按 `callback_id` 丢弃、
   客户端超时 ≠ 服务端未执行、有副作用的请求要有业务幂等键）见 `docs/protocol-map.md` §4.6.2。

---

## 5. 还没做的

| 项 | 状态 |
|---|---|
| 8 字节帧头的 TS/Go 实现 + 15 条帧头验收测试（`docs/protocol-map.md` §8.1） | **未做**（下一步） |
| 业务域 proto（背包/任务/战斗/…） | 按需求**暂不生成** |
| CI 生成物一致性检查（`./check.sh && git diff --exit-code`） | 需接进 CI |
| abelkhan 的 `hub_hub` 里那些社交/跨服业务消息 | 属业务域，不在此处 |

---

## 6. 定稿时**明确没做**的（记在这里，别让它们变成隐性债务）

| # | 事项 | 状态 / 暂定做法 |
|---|---|---|
| 1 | `CrossCallRequest{dst_entity, method, content, trace_id}` 与 `Envelope.method` 重复（同一个方法写两遍） | 暂留。若将来要瘦身，缩成 `{dst_entity, trace_id}` 即可 |
| 2 | `ClientResponseHub` 缺 `conn_id` | 暂不加。配对靠 `Envelope.callback_id`；只有需要"按连接统计 RTT"时才需要它 |
| 3 | 状态上报（连接数 / rps / pps / tick 延迟 / 节点健康） | **不做消息，交给 consul + 指标系统**。原 `NodeLoadReport` / `SessionRateHint` / `NodeHeartbeat` 已删除 |
| 4 | `HubKickOffClient` 发出去之后的**关闭结果回执** | 未做。gate 关连接失败（连接已消失）目前只打日志 |
| 5 | 服务端 → 客户端调用（`CallEntity` 的 REQUEST 形态）的**超时兜底** | 暂定"超时当失败"，不做自动重试；真要可靠就用"重连后拉待办" |
| 6 | 客户端上行的 `entity_id` **鉴权** | 在逻辑层做，不在 gate。每个可被客户端调用的方法必须自己校验距离/视野/阵营 |
| 7 | 实体 id 不可枚举 | 靠 id 生成策略保证（string + 随机段），框架不强制 |
| 8 | HTTP/JSON 运维面（GM、后台） | 不在 proto 里，用 pb 的 `toJson` |

---

## 7. 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-20 | **删除 `logic_dbproxy.proto`（17 条存储原语）** | **数据落地放 hub**：逻辑层直接写存储，不再有独立的 dbproxy 进程。存储原语的语义（不透明 key/value、`expect_version` 乐观锁、批量非事务）下沉为 hub 内部的一个存储模块，不再是跨进程协议 |
