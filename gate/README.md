# gate —— 接入层（Go）

**两个监听端口**：对外 WebSocket（客户端），对内 TCP（逻辑节点连入）。P0 骨架：能起来、能切帧、能握手
（`NotifyConnID`）、能建会话与回登录结果、能双向转发、能答心跳。

```
客户端 ──WebSocket(:9001/ws)──►  gate  ──TCP(:9002)──►  逻辑层
                                  │  ↘ NATS（旁路，可选）
                          session 表（conn ⇄ entity）+ hub 路由
```

进程间通信分两层：**TCP 直连**是主通道（gate ⇄ 逻辑层）；**NATS 消息队列层**是旁路
（`nats.enabled` 才连）：服务器→服务器走 `entity_{id}_logic_mq`，服务器→gate 走
`entity_{id}_gate_mq`（消息体与 TCP 同构的 Envelope，hub 收到后送进同一套 OnLogic 分派）。
订阅生命周期跟随会话：建会话订阅、断开/顶号退订。

## 结构

```
gate/
  cmd/gate/main.go          两个监听端口的装配与优雅退出
  internal/clientgate/      对外 WebSocket 接入（gorilla/websocket）
  internal/logiclink/       对内 TCP 接入（逻辑节点连进来）
  internal/hub/             **中央路由**：客户端 ⇄ 逻辑层、组播去重、广播、踢人；NATS 旁路下行
  internal/config/          **JSON 配置**：默认值、注释键剥离、校验、地址/时长换算（14 条测试）
  internal/registry/        **consul**：服务注册 / TTL 心跳 / 状态上报 / 注销（不引 SDK，直接打 HTTP API）
  internal/natsmq/          **NATS 消息队列层**（旁路）：Connect/Publish/Consume(channel)，subject 约定
  internal/session/         会话表：conn → (user, entity, node) / entity → conn
  internal/frame/           8 字节帧头（与 core/src/frame.ts 逐字节一致）
  internal/pb/              codegen 产物（gitignored）
  scripts/smoke.py          端到端冒烟（零依赖，含手写 WebSocket 客户端）
```

## 跑

```bash
cd schema && ./check.sh        # 生成 gate/internal/pb 与 core/src/gen
cd ../gate
go build ./... && go test ./...
go run ./cmd/gate -dump-config > config.json    # 生成带注释的配置（= 默认值）
# 改完再启动：
go run ./cmd/gate -config config.json
```

不带 `-config` 时全用内置默认值（`:9002` 对内 / `:9001/ws` 对外 / consul 关闭），
启动日志第一行会把生效的配置打出来：

```
配置：config.json（对内 0.0.0.0:9002 ｜ 对外 0.0.0.0:9001/ws ｜ consul true）
```

## 配置（`config.json`）

**配置的唯一文档是 `internal/config/config.go` 的结构体**（字段注释 + `Default()`）——
没有单独的 example 文件，免得两份漂移。想要一份能改的配置就跑：

```bash
gate -dump-config > config.json
```

输出就是当前生效的配置，带 `//xxx` 说明键，且**能被自己读回**（有往返测试）。

| 段 | 字段 | 说明 |
|---|---|---|
| `node` | `id` / `hostname` | `id` 留空则推导成 `gate-<ip>-<对内端口>` |
| `listen` | `logic_host` / `logic_port` | **对内 TCP**：逻辑节点连入 |
| | `client_host` / `client_port` / `ws_path` | **对外 WebSocket** |
| | `tls_cert_file` / `tls_key_file` | 两者必须同时给或同时留空；空 = 明文 WS |
| | `max_frame_bytes` / `read_timeout_s` | 单帧上限（≤16 MB，帧头 u24）与读超时 |
| `advertise` | `ip` | 注册到 consul 的地址；留空则探测（见下） |
| `consul` | `enabled` / `url` | 关闭时下面几项忽略 |
| | `ttl_s` / `report_interval_s` | **必须满足 report < ttl**，否则启动就报错；`report_interval_s` 就是"每多少秒上报一次" |
| | `tags` | 注册时带的 tags |
| `redis` | `enabled` / `cache_url` / `session_ttl_s` | **跨 gate 会话目录**（`session:{userId}`）。`enabled=false` 时只跑单 gate；跨 gate 顶号必须打开 |
| | `pool_size` / `dial_timeout_ms` | 连接池与建连超时 |
| `nats` | `enabled` / `url` | **消息队列层**（旁路）：核心 NATS；server↔server `entity_{id}_logic_mq`，server→gate `entity_{id}_gate_mq`；连不上仅记日志，TCP 主通道不受影响 |
| `log` | `dir` / `file_name` | `file_name` 支持 `%Y%m%d%H`；空则只打 stderr |
| | `level` / `max_size_mb` / `keep_days` | 级别与轮转 |

**JSON 里怎么写注释**：键名以 `//` 开头的字段会被解析时丢掉（例如 `"//client": "对外 WS"`），
所以配置文件自己带说明，不用再维护一份字段表。

**校验只拦明显矛盾**（`internal/config.Validate`）：同地址同端口、只给证书不给私钥、
`report_interval_s >= ttl_s`、端口越界、`max_frame_bytes` 超过 16 MB——不做风格检查。

端到端冒烟（两个端口一起验）：

```bash
go run ./cmd/gate -config /tmp/gate-test.json &
python3 scripts/smoke.py 127.0.0.1 19301 19302
```

输出：

```
① 两个端口都连上了（TCP 逻辑链路 + WebSocket 客户端）
② gate 把未登录连接的请求**丢弃**了
③ 客户端收到建实体推送: {'method': 'client.createPlayerEntity', 'entity': 'e-smoke'}
④ 建会话后 gate 转发 ClientRequestHub: {'conn': 'c-1', 'entity': 'e-smoke', 'method': 'entity.attack', 'callback': 7}
⑤ 逻辑层调客户端，客户端收到: {'method': 'entity.attack', 'entity': 'e-smoke', 'content': '0909', 'callback': 11}
⑥ 踢人: 收到 KickOff
冒烟通过 ✅
```

## consul：注册 + 状态上报

在 `config.json` 里把 `consul.enabled` 设为 `true` 并填好 `consul.url` 即可：

```json
{ "consul": { "enabled": true, "url": "http://127.0.0.1:8500",
              "ttl_s": 30, "report_interval_s": 10,
              "tags": ["gate", "internal"] } }
```

| 时刻 | 动作 | 落到 consul |
|---|---|---|
| 启动 | `PUT /v1/agent/service/register` | 服务 `gate`、**对内端口**、tags、meta（版本 / 客户端端口 / ws_path）+ **一条 TTL 健康检查** |
| **注册后立刻 + 每 N 秒** | `PUT /v1/agent/check/pass/service:<id>?note=…` | **状态上报，同时就是 TTL 心跳**：`clients=42 logic=1 up=812/s down=640/s miss=3 kicks=1 bad=0` |
| 退出 | `PUT /v1/agent/service/deregister/<id>` | 主动摘掉，不用等 TTL 过期变 critical |

N = `consul.report_interval_s`（默认 10s）。两条纪律：

1. **注册完立刻报一次**——TTL 从注册那一刻开始计时，等一个周期再报会让节点短暂 critical；
2. **N 必须小于 `ttl_s`**（`config.Validate` 强制），且单次上报带 3s 超时，consul 慢不会拖住上报线程。

上报的是**速率**而不是累计计数：`up=812/s` 才能看出"现在忙不忙"，累计值只能看出跑了多久。

### 为什么是 gate 主动 push（TTL），而不是让 consul 来拉

| 理由 | 说明 |
|---|---|
| **网络方向** | gate 常在 NAT / 安全组后面，**consul 反向拨入 gate 不一定通**；而 gate → consul:8500 必通（否则连注册都做不到） |
| **一次请求干两件事** | TTL 的 `?note=` 直接带状态，不用额外开端口、不用加防火墙规则 |
| **失败模式** | TTL 的弱点是"进程僵死但上报线程还在跑"会骗过 consul——但真僵死时 WebSocket 读写循环也早停了，**玩家侧会先暴露** |

### 服务 id 与注册地址：**默认带 IP**

```
id    = gate-<advertise-ip>-<对内端口>     # 例如 gate-10.0.0.11-9002
addr  = 注册到 consul 的 Address
Port  = 对内 TCP 端口（逻辑层连这个）
Meta  = { version, client_port, ws_path }   # 客户端用的 WebSocket 端口在 meta 里
```

**为什么注册对内端口而不是对外端口**：consul 的消费方是**逻辑层**——它要发现 gate 的
internal TCP 端口然后连上来（见"两个端口为什么这样分工"）。客户端不走 consul：小游戏/H5
的入口地址是运营配置或平台下发的，把它塞进 `Port` 会让逻辑层连错端口。

为什么不用主机名：gate 会**部署在多台服务器**上，而容器/云主机的 hostname 往往是随机串
（滚动发布每次换一个，consul 里会堆一堆已注销的旧节点）；IP 至少在同一网段内唯一，运维和
客户端都能直接用。

`-advertise` 为空时的探测顺序：

| # | 条件 | 取什么 |
|---|---|---|
| ① | `-advertise 10.0.0.11` | 就用它 |
| ② | `-client 10.0.0.11:9001`（写了具体 IP） | 那个 IP |
| ③ | `-client myhost:9001`（写了主机名） | `LookupHost` 解析出的 IP |
| ④ | `-client :9001` / `0.0.0.0:9001` | **本机第一个非回环 IPv4（私网优先）** |
| ⑤ | 连网卡都查不到 | 退回主机名 |

启动日志会把结果打出来，别猜：

```
注册信息：id=gate-192.168.0.15-19251 addr=192.168.0.15 port=19251
已注册到 consul：gate-192.168.0.15-19251（TTL 30s）
```

要固定一个不随机器变化的 id（比如按角色/序号），显式传 `-node-id gate-a`。

三条设计取舍：

1. **不引 consul SDK**：需要的只有 3 个 PUT，用 `net/http` 直接打，省一个依赖也省一次版本升级。
2. **状态走 TTL check 的 `note`**：consul UI 与 `/v1/health/service/gate` 都能直接读到，不需要再引一套存储；**真正的时序指标（p50/p99、GC、连接曲线）应该交给 Prometheus**，consul 只回答"这个节点活着吗、现在大概什么规模"。
3. **`-consul` 留空 = 空实现**（`registry.Nop`），本地开发不用起 consul；注册失败也只打日志、继续跑——**服务发现挂了不该让接入层起不来**。

## 两个端口为什么这样分工

| | 对外 WebSocket | 对内 TCP |
|---|---|---|
| 谁连过来 | 客户端连 gate | **逻辑节点连 gate** |
| 为什么 | 小游戏 / H5 只能 `new WebSocket`，多数渠道只能 WSS | 内网长连接，没有浏览器限制，裸 TCP 更省 |
| 握手 | HTTP Upgrade；准入在 `client.login`（token）里做 | 首帧必须是 `logic.hello`，body 是 node_id |

**逻辑层主动连入**（而不是 gate 去连）是有意的：gate 是对外的一层，扩容 / 滚动发布时不该要求逻辑层改配置。

## 路由规则（`internal/hub`）

**客户端的 body 永远是 oneof**（`ClientUplink` / `ClientDownlink`），形状由 protobuf 自己表达——
不用靠"方法名以 client. 开头"这种约定去猜是 `CallEntity` 还是别的消息。

| 方向 | 输入 | 输出 |
|---|---|---|
| 客户端 → 逻辑（业务调用） | `Envelope{REQUEST, body=ClientUplink{call}}` | `ClientRequestHub{conn_id, entity_id, content, method}` |
| 客户端 → 逻辑（业务调用响应） | `Envelope{RESPONSE, body=ClientUplink{call}}` | `ClientResponseHub{entity_id, error, content, method}` |
| 客户端 → 逻辑（登录） | `ClientUplink{login}` | `GateForwardClientRequestService{service_name="auth", gate_name, conn_id, content}` |
| 客户端 → 逻辑（重连） | `ClientUplink{reconnect}` | `GateForwardClientRequestReconnect{gate_name, conn_id, user_id, content}` |
| 客户端 → 逻辑（其余框架消息） | `ClientUplink{logout/ack}` | 原样透传 |
| 逻辑 → gate（会话归属） | `hub.claimUser{user_id, entity_id, conn_id}` | 目录 Lua 占位 → `Envelope{RESPONSE, gate.ownerInfo}`（旧主人 + 新 seq）；未启用目录时回空 |
| 客户端 → gate（心跳） | `ClientUplink{heartbeat}` | `Envelope{RESPONSE, body=ClientDownlink{heartbeat}}`（**由 gate 直接答**，不进逻辑链路） |
| 客户端 → gate（保活帧） | `Envelope` 载荷长度 0 | 回一个空帧（最省的 ping/pong） |
| gate → 逻辑（握手回包） | 收到 `logic.hello` | `Envelope{method="logic.hello.ack", body=GateHello{gate_name, proto_ver}}` |
| gate → 客户端（握手） | 连接登记 | `Envelope{method="", body=ClientDownlink{conn_id}}` — 连上第一条 |
| gate → 客户端（登录结果） | 逻辑层 `HubCreatePlayerEntity` / `HubKickOffClient` | 成功：`Envelope{RESPONSE, 原 callback_id, status=0, body=ClientDownlink{login}}`；失败：`status=错误码`、body 为空，随后 `kick_off` |
| 客户端断开 | 连接关闭 / 超时 | `ClientDisconnect{conn_id, user_id, entity_id}` — **逻辑层据此做离线处理** |
| 逻辑 → 客户端（调用） | `GateForwardHubCallClient/Group/Global` | `Envelope{method=业务方法名, body=ClientDownlink{call/global}}` |
| 逻辑 → 客户端（视图） | `HubCreatePlayerEntity/…/RefreshEntity` | `Envelope{method="", body=ClientDownlink{create_player/…}}` |
| 逻辑 → gate（踢人） | `HubKickOffClient` | `ClientDownlink{kick_off}` 后关闭 |
| 逻辑 → gate（排空） | `GateDrain{gate_id, grace_ms}` | 摘掉该节点（不再向它投递新上行） |

**逻辑层寻址**：`sendToLogic` 按**会话的 NodeID** 选节点（实体在哪就发哪）；未登录时任选一个。

**登录回包是 gate 的事**：`client.login` 的裁决在逻辑层（`onLogin`），但结果要等
`HubCreatePlayerEntity`（成功）或 `HubKickOffClient`（失败）才到，而这两条消息里没有客户端的
`callback_id` —— 所以 gate 用 `loginPending` 记住它，裁决到了再回。`resume_token` 归根到底要由 gate
无状态校验（旧会话已不在内存里），当前留空，与重连一起做。

**gate 不解 `content`**：它只读 `entity_id` / `conn_id` 用于寻址，`content` 原样搬。唯一的翻译是"内部消息 → 客户端消息"这一层包装。

## 已验证（`go test ./...` + 冒烟）

- `frame`：往返、半包、未知 flags 位、`ts` 跨 32 位回绕、异常时钟 clamp、**与 TS 侧逐字节一致的黄金向量**
- `session`：绑定/解绑、同实体被新连接接管时返回旧会话、改绑、组播按连接去重
- `hub`：上行转发字段正确、未登录丢弃并计数、`CallClient` 投递（业务方法名透传）、组播去重、广播、建实体时踢掉旧连接、坏信封计数
- `hub`（握手/登录/心跳）：`NotifyConnID` 字段齐全、登录成功在 `createPlayerEntity` 后回 `LoginResult`（原
  callback_id）、登录失败先回 `status` 再 `kick_off`、心跳由 gate 作答且不进逻辑链路、空帧回空帧
- 冒烟：**真实 TCP + 真实 WebSocket**，七步全过（含从 `NotifyConnID` 取 `conn_id`，可重复跑）

## 还没做

1. ~~按 `entity → node` 选逻辑节点~~ ✅ 已按会话 NodeID 选
2. ~~跨 gate 顶号~~ ✅ 已做：会话目录（Redis）+ `hub.claimUser` 占位 + 逻辑节点之间的 NATS 总线
   通知旧节点退役。**状态不跟着搬**（存储模块还没写），跨节点是"退役 + 重建"
2. 压缩（帧头 `flags` 的 zstd 位留好了，两端都没接）
3. 限流与背压、写缓冲上限
4. TLS（WSS 需要证书；现在只有明文 WS）
5. 压测（S4：10 万连接，现在每连接一个 goroutine + 32 KB 读缓冲）
