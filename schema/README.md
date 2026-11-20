# 框架协议（底层协议先行，业务协议暂不生成）

本目录是本仓库**第一批真正的工程产物**：`schema/pb/*.proto` 是服务端框架面的协议定义，
`schema/methods.yaml` 是 method code 的唯一分配表。

范围纪律（按需求："先生成底层框架上的协议，功能相关的先不生成"）：

- ✅ 连接、会话、路由、投递、存储原语、节点发现、实体迁移、频道扇出
- ❌ 背包 / 任务 / 战斗 / 商城 / 社交 / 排行 等**业务消息一律不在本目录**

业务域以后从 `methods.yaml` 的 `0x1000` 段往上加，proto 放 `schema/pb/<域>/`。

---

## 1. 与 abelkhan 的对照

abelkhan（`qiankians/abelkhan`，C#、LGPL-2.1，gate + hub + dbproxy）的 `proto/` 是
`client.proto` / `common.proto` / `gate_client.proto` / `hub_gate.proto` / `hub_hub.proto`。
我们的结构**有意保持同一个形状**，只是把"hub"叫"logic"，并补上了它没有的一层：

| 本仓库 | abelkhan 对应 | 职责 |
|---|---|---|
| `pb/common.proto` | `common.proto` | 标识、错误码、通用包装 |
| `pb/envelope.proto` | （无对应，abelkhan 用包头里的 msgId） | RPC 信封：`msg_type / method / callback_id / status / body` |
| `pb/client_gate.proto` | `client.proto` + `gate_client.proto` | 握手、鉴权、断线重连、登出、踢人、错误提示、Ping |
| `pb/gate_logic.proto` | `gate_client.proto`（hub 侧）+ `hub_gate.proto` | 会话绑定/解绑、上下行投递、负载上报、停机排空 |
| `pb/logic_dbproxy.proto` | **（无对应）** abelkhan 由 hub 直连 MongoDB | 存储原语：Get/BatchGet/Set/BatchSet/Delete/Exists + 版本号 CAS |
| `pb/logic_logic.proto` | `hub_hub.proto` | 节点注册与心跳、实体迁移、跨实体调用、频道扇出 |

**两处刻意的不同：**

1. **abelkhan 把消息类型放在包头（msgId）**，我们把类型放在 `Envelope.method`（payload 内）。
   原因是我们的帧头只有 4 字节（压缩位 + 长度），路由靠 gate 的会话表，不靠包里的类型。
   代价是每帧多 ~8–9 字节信封开销，收益是帧头永远不用改、方法表可以自由追加。
2. **abelkhan 的传输只有 TCP/WebSocket**（无 UDP/KCP，见 `docs/mmorpg-engine-choice.md` §8.2）。
   我们的帧头与传输解耦：将来上 UDP/QUIC 时，传输包头包在外面，这四层协议原样复用。

---

## 2. 目录

```
schema/
  pb/
    common.proto          标识 / 错误码 / 通用包装
    envelope.proto        Envelope（客户端可见）+ InternalEnvelope / InternalPayload（内部链路）
    client_gate.proto     客户端 ⇄ gate 的框架面
    gate_logic.proto      gate ⇄ logic
    logic_dbproxy.proto   logic ⇄ dbproxy（存储原语）
    logic_logic.proto     logic ⇄ logic
  methods.yaml            method code 注册表（唯一源）+ msg_type 常量
  check.sh                codegen + 结构校验（一条命令）
  verify.mjs              14 条结构断言
  gen-methods.mjs         methods.yaml → TS/Go 常量
```

生成物全部落在 `schema/.gen/`（已 gitignore）：Go 7 个文件、TS 6 个文件、一份 ESM bundle。

---

## 3. 怎么跑

```bash
cd schema
./check.sh
```

它做五件事：`protoc` 编译（顺带出 descriptor set）→ `protoc-gen-go` → `protoc-gen-es`
（经 `spikes/ser-compare/gen-es.mjs`，绕开 Windows 上 npm 只给 `.cmd`、protoc/buf 不能直接调用的问题）
→ `methods.yaml` 生成常量 → 打一份 bundle 后跑 `verify.mjs`。

**14 条结构断言**（全部实测通过）：

| # | 断言 |
|---|---|
| 1 | 请求信封可往返（`msg_type / method / callback_id`） |
| 2 | `status = 0` 时该字段被省略（响应 29 B，成功路径零成本） |
| 3 | 错误响应可往返且带 `detail` |
| 4 | `NOTIFY` 的 `callback_id` 为 0 时被省略（5 B） |
| 5 | **gate 透传**：`InternalEnvelope` 包住的客户端字节，内层仍能原样解开 |
| 6 | **透传零转码**：解出的内层字节与原始字节逐字节相同 |
| 7 | 外层携带路由信息（`dst_node` / `dst_entity`） |
| 8 | 内部链路的 `InternalPayload` 可往返 |
| 9 | 存储读响应可往返（`value` 为不透明字节，含 `version`） |
| 10 | `methodMeta(code)` 反查可用（接收端按 code 找名字，未知 code 丢弃+计数） |
| 11 | method 常量与 `methods.yaml` 一致（抽样 6 个） |
| 12 | **`MsgType` 由 proto enum 生成**（不再手写常量；`erasableSyntaxOnly` 已放弃，见 `docs/protocol-map.md` §4.6.1） |
| 13 | 未知 `msg_type` 的值被原样保留（proto3 开放枚举）⇒ 接收端必须 `default` 丢弃 |
| 14 | 未知 method code 反查为 `undefined`（据此丢弃 + 计数） |

---

## 4. 三条必须守住的规矩

1. **`methods.yaml` 是唯一源。** 不要在代码里硬编码 method 数字；废弃的 code 进 `retired:`，**永不复用**。
2. **`fmt`/`msgId` 不进帧头。** 帧头只有 4 字节（压缩位 + 长度），任何新语义都加 `Envelope` 字段
   （`reserved 6 to 15` 就是留给它的）。
3. **gate 只解自己那一层。** `DeliverUpstream.payload` 里是客户端原始字节，gate 不解 `Envelope`
   ——第 6 条断言就是在守这条。

---

## 5. 还没做的

| 项 | 状态 |
|---|---|
| 8 字节帧头的 TS/Go 实现 + 15 条帧头验收测试（`docs/protocol-map.md` §8.1） | **未做**（下一步） |
| 业务域 proto（背包/任务/战斗/…） | 按需求**暂不生成** |
| `methods.yaml` 的 CI 生成物一致性检查（`./check.sh && git diff --exit-code`） | 需接进 CI |
| abelkhan 的 `hub_hub` 里那些社交/跨服业务消息 | 属业务域，不在此处 |
