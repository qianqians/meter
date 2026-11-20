# gate —— 接入层（Go）

**两个监听端口**：对外 WebSocket（客户端），对内 TCP（逻辑节点连入）。P0 骨架：能起来、能切帧、能建会话、能双向转发。

```
客户端 ──WebSocket(:9001/ws)──►  gate  ──TCP(:9002)──►  逻辑层
                                  │
                          session 表（conn ⇄ entity）+ hub 路由
```

## 结构

```
gate/
  cmd/gate/main.go          两个监听端口的装配与优雅退出
  internal/clientgate/      对外 WebSocket 接入（gorilla/websocket）
  internal/logiclink/       对内 TCP 接入（逻辑节点连进来）
  internal/hub/             **中央路由**：客户端 ⇄ 逻辑层、组播去重、广播、踢人
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
go run ./cmd/gate -client :9001 -logic :9002 -ws-path /ws
```

端到端冒烟（两个端口一起验）：

```bash
go run ./cmd/gate -client :19101 -logic :19102 &
python3 scripts/smoke.py 127.0.0.1 19101 19102
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

## 两个端口为什么这样分工

| | 对外 WebSocket | 对内 TCP |
|---|---|---|
| 谁连过来 | 客户端连 gate | **逻辑节点连 gate** |
| 为什么 | 小游戏 / H5 只能 `new WebSocket`，多数渠道只能 WSS | 内网长连接，没有浏览器限制，裸 TCP 更省 |
| 握手 | HTTP Upgrade；准入在 `client.login`（token）里做 | 首帧必须是 `logic.hello`，body 是 node_id |

**逻辑层主动连入**（而不是 gate 去连）是有意的：gate 是对外的一层，扩容 / 滚动发布时不该要求逻辑层改配置。

## 路由规则（`internal/hub`）

| 方向 | 输入 | 输出 |
|---|---|---|
| 客户端 → 逻辑 | `Envelope{REQUEST/NOTIFY, method, body=CallEntity}` | `ClientRequestHub` / `ClientNotifyHub{conn_id, entity_id, content}` |
| 客户端 → 逻辑（响应） | `Envelope{RESPONSE}` | `ClientResponseHub{entity_id, error, content}` |
| 逻辑 → 客户端（调用） | `GateForwardHubCallClient/Group/Global` | `Envelope{method=业务方法名, body=CallEntity/CallGlobal}` |
| 逻辑 → 客户端（视图） | `HubCreatePlayerEntity/CreateRemoteEntity/DeleteRemoteEntity/RefreshEntity` | `client.createPlayerEntity` 等固定方法名 |
| 逻辑 → gate（踢人） | `HubKickOffClient{conn_id, error, prompt_info}` | `KickOff` 后关闭（`SendAndClose`，尽量不留关闭竞态） |

**gate 不解 `content`**：它只读 `entity_id` / `conn_id` 用于寻址，`content` 原样搬。唯一的翻译是"内部消息 → 客户端消息"这一层包装。

## 已验证（`go test ./...` + 冒烟）

- `frame`：往返、半包、未知 flags 位、`ts` 跨 32 位回绕、异常时钟 clamp、**与 TS 侧逐字节一致的黄金向量**
- `session`：绑定/解绑、同实体被新连接接管时返回旧会话、改绑、组播按连接去重
- `hub`：上行转发字段正确、未登录丢弃并计数、`CallClient` 投递（业务方法名透传）、组播去重、广播、建实体时踢掉旧连接、坏信封计数
- 冒烟：**真实 TCP + 真实 WebSocket**，六步全过

## 还没做

1. 真按 `entity → node` 选逻辑节点（现在 P0 是"任取一个"）
2. 压缩（帧头 `flags` 的 zstd 位留好了，两端都没接）
3. 限流与背压、写缓冲上限
4. TLS（WSS 需要证书；现在只有明文 WS）
5. 压测（S4：10 万连接，现在每连接一个 goroutine + 32 KB 读缓冲）
