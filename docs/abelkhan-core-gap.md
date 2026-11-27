# meter ⇄ abelkhan：核心框架层差距清单（剔除周边业务）

> **口径**：只比**框架层**。abelkhan 的 `bag / chat / friend / guild / leaderboard / mail / quest / shop`
> 以及 `hub/{Inventory,Chat,Friend,Guild,Leaderboard,Mail,Quest,Shop}/`、`admin` 里的商城/邮件页面
> **全部剔除**，一条不计。剩下的比较对象是：传输、接入、会话、路由、实体生命周期、调用语义、
> 跨节点、顶号/重连/迁移、持久化、服务发现、可观测性、客户端 SDK、基础设施。
>
> **快照**：abelkhan `bc70034`（2026-11-24「迁移和顶号」），meter `aba35b0`（2026-11-27）。
> 结论都给了文件位置，可逐条复核。**abelkhan 侧只看能力有无，不评价其质量**——它的已知质量问题
> 单列在 §5，免得把"它做错了"误读成"我们不用做"。
>
> **已落地**：§4 的 P0-1（每实体串行队列 + `fence()`，见 [`../core/SPEC.md`](../core/SPEC.md)
> 「执行模型」）、P0-2（`NotifyConnID` / `LoginResult` / 心跳回包 / 空帧 pong，见
> [`../gate/SPEC.md`](../gate/SPEC.md) 的不变量）、P0-3（同节点复用旧实体、跨 gate 会话目录与跨节点
> 退役，见 [`../core/SPEC.md`](../core/SPEC.md)「会话与顶号」）。下面描述 meter 现状的句子按快照读，
> 这三项以模块 SPEC 为准。

---

## 0. 结论

**差的是四个子系统，不是消息条数。**

| 缺口 | 权重 | 一句话 |
|---|---|---|
| 实体串行调度（Actor / mailbox） | **架构级** | 现在一条实体上的两个并发请求会交错执行，`唯一写者` 只在协议文档里成立，代码里不成立 |
| 可靠投递 + ack | 高 | 协议留了 `AckReliable`，链路上**一条实现都没有**；abelkhan 有完整 seq→ack→队头比对→超时重投 |
| 会话生命周期（顶号 / 重连 / 迁移） | 高 | meter 只有 gate 层的"挤掉旧连接"；逻辑层的旧实体没人退役，且旧连接的 `ClientDisconnect` 丢掉了 user/entity |
| 持久化 | 高 | 定稿 PostgreSQL，**零行代码**；abelkhan 至少有一条（虽然很烂的）存档路径 |
| 观测 + GM 后台 + 客户端 SDK | 中 | 三项都是 abelkhan 有、meter 一行没有 |
| 跨节点通道 | 中 | `logic_logic.proto` 只有一条 `CrossCallNotify`，没有传输、没有所有权表 |

反过来的：**RPC 语义（错误码 / 超时 / 未知方法）、帧头、配置、NATS 旁路、e2e 与协议结构断言，meter 比
abelkhan 整齐**，这五项不用补，补了是倒退。

体量上：框架面 abelkhan ≈ 10.2k 行（含 C# 客户端 SDK 与监控），meter ≈ 4.5k 行（不含测试与 codegen）。
要补齐上述缺口，估算 **+3.5k ~ 5k 行**（含测试），其中调度与持久化占一半。

---

## 1. 总表

| # | 能力 | abelkhan | meter | 判定 |
|---|---|---|---|---|
| 1 | 对外 WS / 对内 TCP | Kestrel `UseHttps(pfx)`（**有 TLS**）；对内明文 TCP | 对外 WS（`tls_cert_file` 只校验不监听）；对内 TCP；逻辑层**主动连入** | 🟡 缺 WSS 监听 |
| 2 | 分帧 | 4 字节小端长度前缀，64 KB 硬上限，WebSocket 里又套一层 | 8 字节帧头 `flags｜len:u24｜ts:u32`，两端逐字节一致 + 黄金向量 | ⭐ meter |
| 3 | 心跳 / 空闲清理 | `HeartBeats{}` + gate 10s / hub 8s 超时扫描 | `HeartBeat` 只透传（逻辑层忽略）；WS 固定 90s 读超时 | ❌ |
| 4 | 会话表 | gate `_clients`（userId 线性查）+ `Client._dictEntityNetwork` | `conn ⇄ (user, entity, node)` 双向 O(1) + `Rebind` | ✅（meter 略好） |
| 5 | 服务级路由 | `service_name` → `_services` 字典，请求按服务分发 | `service_name` 字段有，gate 写死 `"auth"`，逻辑层无服务表 | 🟡 |
| 6 | 实体生命周期下行 | create / createRemote / deleteRemote / refresh / kickOff | 同左，`gate/internal/hub/logic.go` 全部实现 | ✅ |
| 7 | 组播 / 广播 | `Group`（clients + entities + players），global 全服扇出 | `Group`（按 conn 去重）+ `global.rpcNotify`，Envelope 只 marshal 一次 | ✅ |
| 8 | **实体串行调度** | `Actor`：每实体一条串行队列，自调度 claim 协议，异常隔离 | 无。`server.dispatch` 直接 `await e.dispatch(...)` | ❌ **架构级** |
| 9 | 调用语义 | `WRpc` + 委托字典；**无超时清理**，`err_msg` 是字符串 | 三函数 + `callback_id` 配对 + `TIMEOUT`/`NOT_FOUND`/`UNKNOWN` + 错误码 | ⭐ meter |
| 10 | **可靠投递 + ack** | hub 赋 `seq` → Redis list → gate 队头比对 + 64 桶串行 ack + 10s 超时重投 | 无（协议有 `AckReliable`，无 `HubNotifyClientMq`、无 seq、无重投） | ❌ |
| 11 | **跨节点通道** | `hub_hub_{hubId}_mq`（Redis list）+ `HubHubNotifyEntity`，能跑 | `CrossCallNotify` 一条消息，**无实现、无传输、无所有权表** | ❌ |
| 12 | **顶号** | 复用/新建 → Redis Lua `session:{user}` 占位 → 同 hub 踢 / 跨 hub `HubSessionReplaced` → 旧实体 Save + 摘除 | 同节点：`rebind` 复用旧对象；跨节点：`hub.claimUser` 占位 + `HubSessionReplaced` 让旧节点退役；gate 把挤出的会话投对节点并带错误码 4 | ✅（状态不搬运） |
| 13 | 断线重连 | 客户端 SDK 完整（退避重连 + 重同步 + 未认领删除）；服务端只换 `Client`，不重发实体 | `GateForwardClientRequestReconnect` 已转发，逻辑层**计数后丢弃** | ❌ |
| 14 | **迁移** | 六阶段：切割(fence)→落地(Save)→重建(Load+replay)→转尾→墓碑静默→gate re-point；失败回滚 | 协议里明确删掉 `TransferPrepare/Commit`（改为"落库→按 key 重新加载"），代码 0 行 | ❌ |
| 15 | 持久化 | `MongoProxy` + `Player.Save()`（但恒成功、从未被调用） | `core/src/storage/`：`Document<T>` + PG jsonb + 版本 CAS + Redis 缓存 + 两个写盘间隔；**未接生命周期** | 🟡 |
| 16 | 服务发现 | gate/hub 都注册；hub watch consul 自动连 gate；**下线不处理** | gate 注册 + TTL 心跳 + 状态 note + 优雅注销；逻辑层**手填 host:port**，不发现 | 🟡 |
| 17 | 全局实体 | `GlobalEntity`（可存盘的全局单例） | 只有 `global.rpcNotify` 广播助手，无全局实体概念 | 🟡 |
| 18 | 定时器 | `TimerService`：tick / 日 / 周 / 月 / 循环日 / 循环周，主循环 16ms Poll | 无（业务只能 `setTimeout`） | ❌ |
| 19 | 观测 | Prometheus `/metrics` + OTLP trace + 真 `/health`（主循环存活 + 依赖探针） | consul note 里一串计数 + 日志；**无 `/metrics`、无 `/health`、无 trace** | ❌ |
| 20 | GM / 后台 | admin HTTP：大盘 / 玩家 / 支付 / GM 队列 / 邮件 | 无 | ❌ |
| 21 | 客户端 SDK | C#：帧、重连退避、KickOff 不重连、实体重同步、可靠消息 ack、每实体串行队列 | 只有服务端 `Transport` 接口；Cocos 侧 0 行 | ❌ |
| 22 | 优雅停机 | gate/hub 都只是 `_isRun=false` + 关监听（不排空、不落盘、不注销） | gate：deregister + `httpSrv.Shutdown` + 摘节点；逻辑层无排空 | 🟡 |
| 23 | 配置 | `args[0]` 读 JSON，无默认值合并/校验/热更 | 结构体即文档 + `-dump-config` 往返 + 启动校验 | ⭐ meter |
| 24 | 消息队列旁路 | 无（全靠 Redis list） | NATS `entity_{id}_gate_mq` / `_{id}_logic_mq`，订阅随会话生命周期 | ⭐ meter |

**计数**：⭐ meter 反超 4 项（分帧、调用语义、配置、NATS 旁路），✅ 对齐 3 项（会话表、实体生命周期、
组播/广播），🟡 半成品 6 项（WSS、服务级路由、顶号、服务发现、全局实体、优雅停机），❌ 缺失 11 项。
❌ 里真正属于"框架必须补"的是 #8 #10 #11 #13 #14 #15 #18 #19 #21 这 9 项；#3（心跳/空闲清理）
属于接入层加固，#20（GM/后台）属于运维面，可以晚做。

---

## 2. 五个重点缺口

### 2.1 实体串行调度（最关键的缺失）

abelkhan：`hub/Actor.cs` —— 每实体一条 `ConcurrentQueue<IJob>`，`Post` 入队后 CAS claim 起
`PumpAsync`，跑空→释放 claim→复查队列→抢不到就退出。注释里写清了 claim 协议要保证的两件事：
"同一时刻至多一个 drain"、"队列非空必有人 drain"。所有客户端上行在
`hub/GateMsgHandle.OnClientRequestHub` 里都是 `entity.PostTask(...)` 进队列。

meter：`core/src/server.ts` 的 `dispatch()` 在 `transport.onData` 回调里直接
`await e.dispatch(...)`。两个请求先后到达时，第一个 handler 里的 `await` 会让第二个请求**插进来执行**。
后果不是"性能问题"，而是：

- `Entity` 的状态读改写不再串行 → 「只有一个写者」这条核心不变量在代码里不成立；
- 组视图同步（`group.join/leave`）与业务 mutator 交错 → 客户端可能先收到 `deleteRemote` 再收到 `createRemote`；
- 迁移/顶号需要的 **fence**（"切割前入队的 job 都跑完了"）没有可依附的队列，做不了。

**这是唯一一项"不补则后面三件事都做不对"的缺口。** 估算 ~150 行 + 测试（含 FIFO、异常不中断、
重入、并发恰好一次四条断言，abelkhan 的 `ActorSmoke` 就是这四条）。

> **已落地**（`core/src/actor.ts` + `Entity` 接入）：四条断言 + `fence` / `close` 语义都有测试；
> 契约写在 [`../core/SPEC.md`](../core/SPEC.md)「执行模型」。
>
> 顶号的收尾见 `core/SPEC.md`「会话与顶号」：同节点复用旧实体（内存状态不丢），跨节点走
> "会话目录占位 + 通知旧节点退役"。**状态不跟着搬**——存储模块仍是最大的那块缺口。

### 2.2 顶号：meter 现在只做了"挤"，没做"收"

abelkhan 的三段（`hub/Session/SessionCoordinator.cs`）：

1. **复用优先**：`Service.PeekLoginUserId` 能在建实体前看出 userId，就在本 hub 复用活实体
   （`RebindAsync`：换 `clients[userId]` + 重发 `CreatePlayerEntity`），不重建对象；
2. **占位**：`SessionRegistry.ClaimAsync` 单条 Lua 做「读旧值 + seq+1 + 写新值」，跨 hub 并发登录
   只有一个赢家拿到旧记录（`session:{userId}`，TTL 90s，在线续期，续/释都带 seq 比对）；
3. **踢旧**：同 hub → `HubKickOffClient{旧 connId}` + 旧实体 `Save()` 后摘除；
   跨 hub → `hub_hub_{prevHub}_mq` 发 `HubSessionReplaced{entityId, seq}`，旧 hub 只在 seq 更大时
   踢自己的连接 → 游戏钩子 `OnSessionReplacedAsync` → Save → 摘除。

meter 现在（`gate/internal/hub/logic.go` 的 `hub.createPlayerEntity` + `session.Table.Bind`）：

- gate 层**已经**会在新连接绑走同一 entity 时把旧会话挤出来并踢掉（`KickOff{code=4}`）——入口是对的；
- **但**：`Bind` 直接 `delete(t.byConn, old.ConnID)`，旧连接的 WS 关闭时 `RemoveClient` →
  `Unbind` 返回 `nil` → `ClientDisconnect{conn_id, "", ""}`，**user_id / entity_id 是空的**。
  旧逻辑节点收到这条消息无法定位实体 → 旧实体留在 `entities` 表里继续当写者（幽灵实体）。
  这条在 `hub.go` 的 `RemoveClient` 里可以直接看到。
- 同一节点上同 `entityId` 再登录时 `server.ts` 直接 `entities.set(...)` 覆盖：旧实体的在途
  `rpcRequest` 不会被 reject、`onDestroy` 不会跑、组里不会退——泄漏。
- 无 `user_id → entity` 索引、无 `OnSessionReplaced` 钩子、无会话归属记录（跨节点看不到对方）。

### 2.3 迁移：abelkhan 的六阶段在解什么

`docs/session-migration.md` + `SessionCoordinator.MigrateAsync`：

```
A 切割    _migrating=1（新请求只缓冲）→ 投 fence job（跑完=切割前入队都执行完）
B 落地    Save() → HubMigrateRequest{userId, entityId, seq, fromHub, buffer[]}
C 重建    LoadOfflinePlayerAsync → 重挂协议 + 子系统上线 → replay buffer → AttachClientOnly
          → CAS 抢 session(seq+1) → 回 HubMigrateResult{ok}
D 转尾    剩余 buffer 用 HubMigrateForward 追发 → 立墓碑 → RetirePlayerAsync
E 接管    等旧 hub「墓碑静默」→ CreateRemotePlayer → gate RegisterNetwork(entityId, 新 hub)
F 收尾    墓碑到期删除；新 hub 触发 OnEntityMigratedInAsync
```

它整套复杂度的来源只有一条：**玩家是"原地搬走"，客户端连接不动**，所以必须解决
"新旧两个节点同时收到同一条连接的上行"的保序问题（fence、buffer、尾批、墓碑静默、re-point 最后做）。
失败还有回滚（停缓冲 + buffer 本地 replay）。

meter 的协议已经明确不做这件事：`logic_logic.proto` 头部写着"迁移改成**原节点落库 → 新节点按 key
重新加载**，不需要在两台 hub 之间搬状态字节"，`TransferPrepare/Commit` 已删。这条路线的必然结论是
**迁移必须由客户端重新登录来承载**（见 §3），而不是服务端原地搬。所以 meter 缺的不是六阶段，
而是"重新登录 = 迁移"这条路径上的三个小件。

### 2.4 可靠投递 + ack

abelkhan 的链路（`GateForwardHubNotifyClientMq.seq` → `HubNotifyClientMq.seq` → `AckReliabilityMsg.seq`）：

- hub 投递时赋唯一 seq（随机起点 + 自增，保证 < 2^53，TS 客户端用 double 不丢精度；
  重投沿用 Redis 里同一份消息所以 seq 不变）；
- gate 侧 `Front` 窥视队头 → 解析出 seq 与 ack 比对 → 通过才 `DeleteListElem`；
- 同一 userId 的 ack 用 64 个 `SemaphoreSlim` 桶串行，避免两条重复 ack 各自读到同一队头、各出队一次；
- `ReliabilityAckTimeoutMs=10s` 没等到 ack 就把 userId 重新入队重投；投递循环带 try/catch，
  队头脏数据不打死线程。

meter 侧：`gate.proto` 有 `AckReliable`，`gate/internal/hub/client.go` 把它当 `clientUplink`
原样透传，逻辑层 `server.ts` 明确"ack 是框架消息，P0 忽略"。**没有任何一条消息带 seq，
没有队列，没有重投。** 要做的是把 abelkhan 那套（或等价的 NATS JetStream 方案）搬过来，
并把 `HubNotifyClientMq` 补进 `gate_logic.proto`。

### 2.5 持久化

abelkhan：`core/MongoProxy.cs`（update/save/remove/ping/index/guid）+ `Player.Save()`。
能力形状是对的（实体 `FullInfo()` / `ClientInfo()` 双视图），但实现是坏的：`Update/Save/Remove`
恒返回 true，`Save()` 是 `async void` 且**从未被任何代码调用**，无脏标记/批量/重试/版本。

meter：定稿 PostgreSQL + "存储访问下沉为 hub 内的一个模块，不是跨进程协议"。**模块已实现**
（`core/src/storage/`）：`Document<T>`（整个 `T` 走 JSON）、PG `jsonb` 一张通用文档表、版本 CAS
（`STORAGE_CONFLICT` = 12）、Redis 缓存（`SET ... PX`，TTL 淘汰）、事件路径双写、周期写盘的两个间隔
（缓存比库写得勤）。形状取自 go-zero 的 `sqlc` + `cache`，但缓存是**文档粒度**（一个键），
所以没有它那套"索引键 5s 安全间隙"。**还差的是接线**：登录加载 / 周期存盘 / 下线落库 / 迁移前存盘
——见 [`../core/SPEC.md`](../core/SPEC.md)「存储」的"还没接"。

---

## 3. 已定路线：迁移/顶号 = 客户端请求新的 `GateForwardClientRequestService`

这条路线**替掉 abelkhan 的两块**：跨 hub 命令通道（`hub_hub.proto` 五条消息）与六阶段保序机制
（fence / buffer / 尾批 / 墓碑静默）。因为 "新连接 + 重新登录" 天然是一个切割点：
旧连接上的上行到此为止，新连接上的所有上行都排在登录之后——**不需要缓冲，也不需要墓碑**。

### 3.1 时序（顶号）

```
客户端（新设备 / 断线后重连）→ WS 建连
  ① 客户端发 Login（= 一次 GateForwardClientRequestService 请求，method "auth"）
  ② gate 查「user_id → 节点」目录：有记录 → 直接投给该节点；没有 → 任选（首次登录）
  ③ 该节点执行顶号（同一处代码同时是"首次登录"与"顶号"）：
       a. 本地有活实体 → 复用（换 connId，重发 hub.createPlayerEntity）；
          没有但目录指向别的节点 → 走 ④
       b. 目录里的旧 conn/entity → 先让旧实体退场：onPlayerDestroy（存档）→ destroy()
          （reject 在途 rpcRequest、退出所有组、清 handler）
       c. 建/复用实体后下发 hub.createPlayerEntity
  ④ gate Bind 新会话：同 entity 的旧会话被挤出 → 踢旧连接（已有）
     并**用挤出来的会话**给旧节点补一条 ClientDisconnect{user_id, entity_id, KICKED}
  ⑤ 客户端收到 LoginResult{user_id, entity_id, resume_token}（**当前完全没实现**，见 §3.3）
```

### 3.2 时序（迁移）

```
客户端要换场景/换线 → 主动断开（或框架下发"请重连到 server_id=X"）
  ① 客户端按 server_id 重连到目标 gate，发 Login（同一个 GateForwardClientRequestService）
  ② gate 按目录把请求投给"拥有该玩家的节点"；该节点判断目标不是自己：
       落库（Save）→ 返回"已交出" → 目录 CAS 改指向目标节点
     （或：由目标节点直接收登录，先向旧节点发一条 retire 通知——二者都需要目录里的旧节点）
  ③ 目标节点从存储重建实体（无挂状态迁移），下发 hub.createPlayerEntity
  ④ gate Bind → 旧会话挤出 → 旧连接踢掉 + 旧节点收到 ClientDisconnect（按 ④ 的修法）
  ⑤ 客户端本地同 entityId → 走 Refresh/重同步，无感知
```

### 3.3 因此必须补的最小件

| # | 件 | 位置 | 说明 |
|---|---|---|---|
| 1 | **登录回包** ~~`gate/internal/hub/client.go` + `core/src/server.ts`~~ **已完成** | `gate/internal/hub` | `NotifyConnID`（连上就发）、`LoginResult`（由 gate 在 `hub.createPlayerEntity` 时回）、`HeartBeatResult`、空帧 pong。`ReconnectResult` 仍不做（留给重连）；`resume_token` 目前留空 |
| 2 | **会话目录** | 新模块（gate 或逻辑层，Redis） | `user:{id} → {node, entity, conn, seq}`，TTL + 续期 + 带 seq 的 CAS。**这是这条路线唯一的"新增基础设施"**：请求落在哪个节点，必须有人回答"现在归谁" |
| 3 | **挤出的会话要喂回去** | `gate/internal/session/table.go` `Bind` 已有返回值 | `hub.go` 的 `kick` 路径拿它发 `ClientDisconnect{user_id, entity_id, KICKED}`；现在 `RemoveClient` 走 `Unbind`（已被删，返回 nil）导致消息是空的 |
| 4 | **逻辑层 userId 索引 + 退役钩子** | `core/src/server.ts` | `userId → entity`、`onPlayerRetire(player, reason)`（save/destroy/detach）、同 entityId 重复登录时先退役旧的 |
| 5 | **gate 侧 `Rebind` 调用点** | `session.Table.Rebind` 已有，无人调 | 迁移完成后把 conn 重绑到新节点 |
| 6 | **存储模块** | `core/src/` | `save/load/delete`，否则"落库→重新加载"这句是空的 |

### 3.4 这条路线**拿不到**什么（要写进非目标）

- **无人客户端的迁移**：NPC、世界 boss、排水（drain）时的批量搬场——没有"客户端请求"可用。
  要么明确不做（推荐：排水用 `GateDrain` + 逻辑层拒新会话），要么另开内部触发。
- **迁移期间的上行不丢**：新连接之前的旧连接上行在断开时丢弃（Reliable 通道还没有）。
  要"不丢"就必须先补 §2.4，这是独立的一项。
- **多 gate 部署**：目录必须放在共享存储（Redis）；只放 gate 内存 = 只在单 gate 成立。
- **秒级以内的无缝换线**：客户端必然经历一次"断线 + 重连 + 登录"，表现层是一段 loading。
  这是用协议简单性换来的，接受它。

---

## 4. 建议顺序（按"补完之后什么能跑"排）

**P0 — 让框架的两条不变量成立（约 1k 行）**

1. ~~`Actor`：每实体串行队列 + fence 原语（§2.1）~~ **已完成**——它的 fence 是后面顶号/迁移的依赖。
2. ~~登录回包：`NotifyConnID` / `LoginResult` / `HeartBeatResult`~~ **已完成**（`ReconnectResult` 随重连一起做）。
3. ~~顶号收尾：挤出的会话喂 `ClientDisconnect`、逻辑层 `userId → entity` 索引与退役钩子~~ **已完成**
   （含跨 gate：会话目录 + 节点总线）。

**P1 — 持久化与会话归属（约 1.2k 行）**
4. `Storage` 接口 + PG 实现 + 存盘生命周期（登录/定时/下线/被顶/迁移前）。
5. 会话目录（Redis）+ 按目录路由登录 → 顶号跨节点可用。
6. 重连：`gate.clientReconnect` 真处理（`resume_token` 校验、复用实体、重发 `createPlayerEntity`、
   `full_resync` 判定）。

**P2 — 投递保证与跨节点（约 1k 行）**
7. 可靠投递 + ack（§2.4），`gate_logic.proto` 加 `HubNotifyClientMq{seq}`。
8. 跨节点通道：NATS 已经把 subject 铺好了（`entity_{id}_logic_mq`），缺的是逻辑层的
   `CrossCallNotify` 收发与实体所有权表的查询路径。

**P3 — 运维面（约 0.6k 行）**
9. `/health`（主循环存活 + 依赖探针）、`/metrics`（prometheus）、逻辑层定时器、优雅排空。
10. GM/后台最小面（在线数、踢人、封号、补发），不要照抄 abelkhan 的电商面板。

**P4 — 客户端（约 0.8k 行）**
11. Cocos/TS 侧运行时：帧、信封、`RpcMap`、重连、实体重同步、ack。abelkhan 的 `client/` 是
    现成的语义参考（**不是代码参考**：它内部还套了一层 4 字节前缀）。

---

## 5. 附：abelkhan 有而**不该照搬**的地方

比能力时别看这些，它们只是"有这条路径"，不是"这条路径能用"：

| 问题 | 证据 |
|---|---|
| **hub 不是可执行进程**（库，无 `Main`、`OutputType` 不是 Exe）→ 只能被测试 harness 在进程内跑 | `abelkhan/hub/hub.csproj`、全仓 `grep static void Main` 只有 admin/gate/tests |
| `MongoProxy.Update/Save/Remove` 恒返回 true；`Player.Save()` 是 `async void` 且**从未被调用** | `core/MongoProxy.cs`、`hub/Player.cs` |
| 服务端重连只替换 `Client`，**不重发 `CreatePlayerEntity`** → 客户端重同步没有服务端驱动 | `hub/MainClass.cs` `OnReconnect` |
| consul **只加不减**：实例消失后 `_gates` 残留、无重连 | `hub/ConsulServiceWatcher.cs` |
| 单帧 64 KB 硬上限（背包/邮件列表迟早撞上）；WebSocket 里又套一层长度前缀 | `core/OnReceive.cs`、`core/WebSocketNetwork.cs` |
| 请求无超时清理（`_requestCallbacks` 只增不减），节点间丢包 → 调用方永久挂起 | `hub/BaseEntity.cs` |
| 热路径 O(N)：gate 按 userId 线性遍历、hub `TryGetClient` 全表遍历 | `gate/MainClass.cs`、`hub/BaseEntity.cs` |
| `Client.UserId/GateName/ConnId` 的 getter 有副作用（刷新 `LastEventTime`）→ 任何日志读取都会阻止超时清理 | `hub/Client.cs` |
| 重启/停机不排空、不落盘、不注销 consul | `gate/MainClass.cs` `Stop()`、`hub/MainClass.cs` `Stop()` |
| 协议里 `db_proxy` 服务被 watch 但**没有这个工程** | `hub/ConsulServiceWatcher.cs` |

---

## 6. 顺带发现的两处规格漂移（已在本次一并修正）

- `schema/README.md` §1.3 把「实体生命周期控制面（create/delete/refresh remote entity）」列为缺口，
  但 `gate_logic.proto` 与 `gate/internal/hub/logic.go` 已经实现——这条要改成"已补"。
- 同一节的「`TakeOverUser`（同账号抢连接）」按 §3 的路线**不做成独立消息**，
  由客户端重新请求 `GateForwardClientRequestService` 承载；需要补的是目录、退役钩子与登录回包，
  不是一条 `TakeOverUser`。
