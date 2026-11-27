---
id: meter-gate
type: module-design
status: draft
title: gate —— 接入层
parent: meter-architecture
depends-on: [meter-protocol]
tags: [go, access-layer]
---

# gate —— 接入层

## 职责

两个端口，两种角色：**对外 WebSocket** 接客户端，**对内 TCP** 接逻辑节点（逻辑层主动连进来）。职责止于
切帧、**连接握手与登录回包**、会话表（`conn ⇄ entity`）、路由、心跳、**跨 gate 会话目录**、踢人、consul
注册与状态上报、NATS 旁路下行。它是这套引擎里唯一一个"必须一直活着"的进程。

## 边界

- **禁止**：任何游戏规则；解析业务 `content`（只读 `entity_id` / `conn_id` 做寻址，其余原样搬）；把业务
  语义放进帧头。
- **逻辑层连入，不是 gate 去连**：gate 对外是一层，扩容或滚动发布时不该要求逻辑层改配置。
- **config 结构体就是配置的文档**：没有 example 文件（免得两份漂移），`-dump-config` 导出带注释的默认值，
  且能被自己读回。

## 不变量

- **帧头与 `core/src/frame.ts` 逐字节一致**，黄金向量钉在 `golden_test.go`。两端各写一份实现是有意的
  （gate 不能跑 TS），所以"一致"必须是可执行的断言而不是约定。
- 未登录连接的业务上行**丢弃 + 计数**；同一实体被新连接绑走时，旧会话由 gate 踢掉，且那条旧连接关闭时
  发出的 `ClientDisconnect` **带 user/entity 与错误码 4**、投给**旧会话所属的节点**——否则旧实体永远不退役。
- **握手回包**：逻辑节点首帧 `logic.hello` 之后，gate 回 `logic.hello.ack{GateHello{gate_name, proto_ver}}`。
  多 gate 部署时，逻辑节点靠它知道“每条链路对面是哪台”；实体记住自己那条连接在哪台 gate 上。
- **会话目录**（`redis.enabled=true` 时）：`session:{userId} → {node, gate, conn, entity, seq}`。
  占位、续期、释放全部用一条 Lua：占位是“读旧值 + seq+1 + 写新值”，续/释都**带 gate+conn 比对**——
  迟到的旧连接不能给新会话续命、也删不掉它。gate 按 TTL/3 续期；gate 崩了记录自然过期。
  未启用时 `hub.claimUser` 回一个空的 `GateOwnerInfo`（逻辑层照常登录，只是不做跨节点接管）。
- **握手与登录回包在 gate**：连接一登记就下发 `NotifyConnID`（`conn_id` / `proto_ver` / 建议心跳间隔 /
  解码器真正强制的单帧上限）；`client.login` 是 REQUEST，gate 用 `loginPending` 记住配对号，裁决到了
  才回——成功在 `hub.createPlayerEntity` 之后回 `LoginResult`，失败在 `KickOff` 之前回 `status`（body 为空）。
  `resume_token` 归根到底要由 gate **无状态**校验（旧会话已不在内存里），所以由 gate 签发，当前留空。
- **心跳在 gate 落地，不进逻辑链路**：`HeartBeat` → `HeartBeatResult`（原 callback_id），
  `len == 0` 的帧 → 空帧 pong。逻辑层不处理心跳，多一跳没有收益。
- 组播按连接去重，广播遍历会话表；坏信封只计数。
- `report_interval_s < ttl_s` 启动即校验；consul 注册失败**只记日志、继续跑**——服务发现挂了不该让接入层
  起不来。上报的是**速率**（`up=812/s`）而不是累计值，因为只有速率能看出"现在忙不忙"。
- 传输层的形状归 [协议契约](../docs/protocol-map.md)：帧头只做分帧，路由靠会话表。

## 已知限制（已确认）

- **对外只有明文 WS，WSS 未接。** 定稿是客户端走 WSS 接入，配置里 `tls_cert_file` / `tls_key_file` 也
  已经校验（必须成对、必须读得到），但 `clientgate` 里**没有 TLS 监听器**。对内 TCP 是内网明文，符合设计。
- **无限流、无背压、无写缓冲上限。** 慢客户端目前只能拖住自己的 goroutine。
- **压缩未启用**：帧头 `flags` 的 zstd 位两端都没接（TS 侧同样没接）。
- **10 万连接（S4）未压测**：每连接一个 goroutine + 32 KB 读缓冲的组合没有任何实测。
- **`listen.max_frame_bytes` 仍未接入帧解码器**：`NotifyConnID` 下发的是 `frame.MaxPayload`（真正被强制的
  1 MB），不是配置里那个名字相同、实际没人读的旋钮。
- **`resume_token` 当前为空**：重连本身还没接，签一个没人校验的票据是假承诺；P1 与重连一起做（HMAC，
  gate 侧无状态校验）。
- **登录没有 gate 侧超时**：逻辑层一直不回（例如节点挂了）时，客户端只能等自己的超时。
- **同一连接上的第二次登录会覆盖第一次的配对号**：`loginPending` 是每连接单槽；正常客户端不会这样做。
- **跨 gate 顶号的 split-brain 窗口未解决**：旧 session 节点不可达时（NATS 断了），新节点已经占位、
  旧节点还在跑旧实体；只能等目录 TTL 过期后由业务侧发现。
- **状态不随顶号搬运**：跨节点是“通知旧节点退役 + 新节点重建”，内存状态不跟着走（存储模块还没写）。
- **目录的 seq 在释放后会重头开始**：`session:{user}` 被 DEL 后下一次占位从 1 开始，理论上一个
  恰好滞后的接管通知可能比新会话的 seq 大。窗口极窄，暂不处理（abelkhan 同样如此）。
- **目录故障时拒绝登录**：占位失败会回 `status≠0`，逻辑层就不让登录通过——跨节点部署下“宁可登不上，
  也不要两个写者”；单 gate 部署可以把 `redis.enabled` 关掉。
