---
id: task-gate-perf-broadcast-stats
title: gate 性能：广播 marshal 一次 + stats 原子化
type: task-spec
status: done
---

# gate 性能优化（基准驱动的 ①+②）

## Request（用户选定范围）

1. **① 组播/全服广播 marshal 一次**：`gate.forwardHubCallGroup` 50 连接 = 364 allocs（同一消息 marshal N 遍）；`forwardHubCallGlobal` 同病。
2. **② stats 计数原子化**：每条上行对全局 `h.mu` 加锁 3 次（计数与 clients/logics 表共用一把锁），16 并发实测零加速（914 vs 886 ns/op）。

## Design（沿用分析报告里用户认可的方案）

- `Peer` 接口加 `SendBytes(envBytes []byte) error`（已 marshal 的 Envelope 字节）；
  `Send(env)` 保留为便捷方法（= marshal + SendBytes）。wsPeer/tcpPeer 同步实现。
- `deliverDown` / 组播 / 全服广播统一走 **marshal 一次 → 逐连接 SendBytes**（单发路径也省掉一次 Envelope marshal）。
- `Stats` 计数器改 `atomic.Uint64`（内部 `statsCounters`），`Stats()` 返回纯值快照；
  `h.mu` 只守 clients/logics/mqSubs。unknownClient/badEnvelope 等 helper 同步改。
- 计数语义统一：ForwardedDown 按连接计（组播原本 per-conn、全服原本 per-广播，统一为 per-conn——扇出工作量才是该指标的语义）。

## 验证

- `go build/vet/test`（含 -race）
- bench 前后对比（hub/bench_test.go、frame/bench_test.go 已就位）：组播 50 连接 allocs/op 364 → 目标 <60；并行上行应有并发加速
- e2e + smoke 回归
