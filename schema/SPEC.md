---
id: meter-schema
type: module-design
status: draft
title: schema —— 框架协议的定义与生成
parent: meter-architecture
depends-on: [meter-protocol]
tags: [protocol, protobuf]
---

# schema —— 框架协议的定义与生成

## 职责

定义**框架面**的 protobuf 消息（连接、会话、路由、投递、存储原语），并把同一份定义生成到 Go 与 TS
两侧，再用一组结构断言守住「schema 只描述消息」这个形状。线上的形状由
[协议契约](../docs/protocol-map.md) 决定——本目录只是它的落地。

## 边界

- **只放框架面。** 背包、任务、战斗、商城、社交、排行按业务域另开 `schema/pb/<域>.proto`；当前框架面
  一条业务消息都没有。
- **`.proto` 里没有 `service`，也没有外置方法表。** 方法名由调用方给，类型绑定写在业务侧——改消息名
  会让编译失败，而 yaml 方法表只会静默漂移。
- **生成物不进仓库。** `gate/internal/pb`（Go）、`core/src/gen`（TS）、`.build/`（中间产物）都在
  `.gitignore` 里；要改协议就改 `.proto`，不手改生成物。
- **`check.sh` 一条命令做完全部**：protoc 编译 → 两个插件 codegen → 打 bundle → 跑 `verify.mjs`。
  仓库里没有第二处 codegen 入口。

## 11 条断言守的是什么

不是"消息能编解码"（那是 protobuf 自己的事），而是几条**容易被顺手破坏的协议性质**：

- `Envelope` 解出再编码**字节完全一致**（零转码），`content` 原样透传后仍可直接解析——gate 不需要懂它；
- `status == 0` 一个字节都不占（所以「删掉 status 省空间」是零收益）；
- `NOTIFY` 的 `callback_id` 必须为 0；方法名可以是任意字符串（含空串），schema 不约束命名；
- `MsgType` 由 proto enum 生成，不许手写常量；未知 `msg_type` 数字**原样保留**（开放枚举）⇒ 接收端
  必须走 `default → 丢弃 + 计数`。

## 与 abelkhan 的取舍

结构上刻意对齐它的拓扑（gate + hub + protobuf），但六处不同都是决定而非巧合：方法名由调用方给而**类型
绑定有编译期校验**（它是裸字符串）、`status int32` + `detail` 而非只有 `err_msg`、心跳是 `len == 0` 的
空帧、帧头带 `ts`、`callback_id` 是 uint32（省字节，代价是要有 id 分配器）、实体/会话 id 是 uint64。
逐条对照在 [`README.md`](README.md) §1.4。

## 已知缺口

[`README.md`](README.md) §1.3 的三条已不算同一个状态：**可靠投递 + ack（`seq`）仍缺**；实体生命周期
控制面**已补**（`gate_logic.proto` + `gate/internal/hub/logic.go`）；`TakeOverUser` **不做成独立消息**——
顶号/迁移由客户端重新请求 `GateForwardClientRequestService` 承载。逐项对照与优先级见
[`../docs/abelkhan-core-gap.md`](../docs/abelkhan-core-gap.md)。
