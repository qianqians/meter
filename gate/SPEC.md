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
切帧、会话表（`conn ⇄ entity`）、路由、踢人、consul 注册与状态上报、NATS 旁路下行。它是这套引擎里唯一
一个"必须一直活着"的进程。

## 边界

- **禁止**：任何游戏规则；解析业务 `content`（只读 `entity_id` / `conn_id` 做寻址，其余原样搬）；把业务
  语义放进帧头。
- **逻辑层连入，不是 gate 去连**：gate 对外是一层，扩容或滚动发布时不该要求逻辑层改配置。
- **config 结构体就是配置的文档**：没有 example 文件（免得两份漂移），`-dump-config` 导出带注释的默认值，
  且能被自己读回。

## 不变量

- **帧头与 `core/src/frame.ts` 逐字节一致**，黄金向量钉在 `golden_test.go`。两端各写一份实现是有意的
  （gate 不能跑 TS），所以"一致"必须是可执行的断言而不是约定。
- 未登录连接的业务上行**丢弃 + 计数**；同一实体被新连接绑走时，旧会话由 gate 踢掉。
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
