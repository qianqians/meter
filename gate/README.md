# gate —— 接入层（Go）

P0 骨架：**能起来、能切帧、能建会话、能回包**，还没接逻辑层。

## 结构

```
gate/
  cmd/gate/main.go           进程入口：TCP 监听、读写循环、method 分派、登录占位、踢人
  internal/frame/            8 字节帧头编解码（**与 core/src/frame.ts 逐字节一致**，有黄金向量测试）
  internal/frame/golden_test.go
  internal/session/          会话表：conn ⇄ entity 双向路由 + 组播按连接去重
  internal/pb/               codegen 产物（gitignored，cd schema && ./check.sh 生成）
```

## 跑

```bash
cd schema && ./check.sh      # 生成 gate/internal/pb 与 core/src/gen
cd ../gate
go build ./...               # 或 go build -o gate.exe ./cmd/gate
go test ./...                # frame / session 两个包
go run ./cmd/gate -listen :9001
```

冒烟（用 Python 手工造一个 `client.login` 帧，不需要任何依赖）：

```bash
python -c "
import socket,struct
def varint(n):
    o=b''
    while True:
        b=n&0x7f; n>>=7; o+=bytes([b|(0x80 if n else 0)])
        if not n: return o
def s(f,v): return varint((f<<3)|2)+varint(len(v))+v
env = varint(8)+varint(1) + s(2,b'client.login') + varint(24)+varint(1) + s(4, s(1,b'tk'))
frame = b'\x00' + struct.pack('<I',len(env))[:3] + struct.pack('<I',0) + env
c = socket.create_connection(('127.0.0.1',9001)); c.sendall(frame); print(c.recv(4096).hex())
"
# 回来的是 Envelope{RESPONSE, method=client.login, callback_id=1, body=LoginResult{...}}
```

## 已实现

| 项 | 说明 |
|---|---|
| 8 字节帧头 | `flags:zstd | len:u24 | ts:u32`；半包不报错、未知 flags 位断开、`len>1MB` 拒绝 |
| 延迟统计 | `frame.OneWayDelayMs()`：有符号 32 位差值处理 49.7 天回绕，异常时钟 clamp + 记日志 |
| 会话表 | 正向 `conn→(user,entity,node)`、反向 `entity→conn`；**同实体被新连接绑走时返回旧会话**，由 gate 踢掉 |
| 组播寻址 | `ConnsOfEntities()`：实体名单 → 连接名单，**按连接去重**，未知实体忽略 |
| 分派骨架 | `Envelope` → `client.login`（占位：token 当 user_id）、其它 REQUEST 回 `NOT_FOUND`、NOTIFY 丢弃 |
| 保活 | `len==0` 的帧原样回一个空帧（最省的心跳） |
| 退出 | SIGINT/SIGTERM 优雅关闭监听 |

## 还没做（按优先级）

1. **真转发到逻辑层**：consul 查 `logic` 节点 → 连接池 → 把 `ClientRequestHub{conn_id, entity_id, content}` 发过去；回程把 `GateForwardHubCall*` 译成 `CallEntity` 下发
2. **WebSocket / TLS**：小游戏渠道只能 WSS，`net.Conn` 要换适配层
3. **压缩**：帧头 `flags` 的 zstd 位已留好，读写两端都还没接
4. **限流与背压**：每连接帧率/字节率、写缓冲上限
5. **`Hub*` 系列消息的处理**：实体创建/删除/刷新、`GateForwardHubCallClient/Group/Global` 的下发
6. 压测：S4（10 万连接）用的就是这个骨架，目前每连接一个 goroutine + 32 KB 读缓冲

## 与 TS 侧的一致性

`internal/frame/golden_test.go` 钉了一个黄金向量：

```
encodeFrame({flags:0, ts:123456, payload:[9,8,7]}) === 0003 0000 40e20100 090807
```

两端任何一侧改了帧头布局，这个测试会先失败。
