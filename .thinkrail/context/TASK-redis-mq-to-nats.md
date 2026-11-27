---
id: task-redis-mq-to-nats
title: 消息队列从 Redis 换成 NATS
type: task-spec
status: done
---

# 消息队列从 Redis 换成 NATS

## Request

- 删除 redis 配置里的 `mq_url`（当前无代码消费，纯死配置）。
- 消息队列改用 NATS。

## Product

- **进程间通信分两层**（用户已定）：
  1. **TCP 直连**：gate ↔ 逻辑层现有链路（8 字节帧 + Envelope）不变，仍是主通道。
  2. **NATS 消息队列层**（核心 NATS，无持久化）：
     - 服务器 → 服务器：投递到 `entity_{id}_logic_mq`，entity 所在服务器监听（**TS 侧 core 一起搭**）。
     - 服务器 → gate：投递到 `entity_{id}_gate_mq`，玩家所在 gate 监听并转发给客户端。

## Design（已确认）

- **载荷格式**：复用 Envelope——NATS 消息体 = 逻辑层在 TCP 链路上发的同一个 `pb.Envelope` 字节，
  gate 收到后送进 `hub.OnLogic("nats", &env)` 同一套分派（NATS 只是"另一条进 hub 的路"）。
- **消费接口形态**：channel 拉取（Go: `Consume(subject) (<-chan []byte, func())`；TS: async iterable）。
- **订阅管理**：会话绑定（`hub.createPlayerEntity`）时订阅 `entity_{id}_gate_mq`；
  退绑/断开/顶号挤掉时退订。订阅面 = 在线玩家数。
- **gate 侧不做 queue group**：per-entity subject 的订阅者就是"玩家所在 gate"，
  重绑窗口内多 gate 同订时靠会话表天然过滤（非 owner 投递会落到 UnknownClient 计数）。
- **降级策略**：`nats.enabled=true` 但连不上 → 记日志继续跑（同 consul 注册失败的处理风格），MQ 层不可用不影响 TCP 主通道。
- **配置**：`nats: { enabled, url }`，默认 `false` / `nats://127.0.0.1:4222`；redis 段删掉 `mq_url` 只留缓存。
- **依赖**：Go `github.com/nats-io/nats.go v1.37.0`；TS `nats@2.29.3`。
- **TS 侧（core）**：`core/src/natsmq.ts` 提供 `gateSubject()/logicSubject()` 约定 + publish/consume 封装
  （entity_{id}_logic_mq 的监听由逻辑服务器实现时使用；测试离线，注入假连接）。

## 明确推迟

- JetStream 持久化、消息可靠性（at-most-once 即可）。
- gate 上行（客户端 → 服务器）走 NATS 的路径——上行仍走 TCP 直连。
- TS 侧真实逻辑服务器的 entity 所有权跟踪。

## 验证

- `go build ./... && go vet ./... && go test ./...`
- `core: npm run typecheck && npm test`
- `scripts/smoke.py` 冒烟（NATS 关闭时行为与之前一致）
- 配置 dump 往返（config_test 已覆盖，删 mq_url 后自动适配）
