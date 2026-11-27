---
id: meter-spikes
type: module-design
status: draft
title: spikes —— 可复现的实测证据
parent: meter-goal
tags: [benchmark, evidence]
---

# spikes —— 可复现的实测证据

## 职责

给 `docs/` 里那些**只能跑一遍才能回答**的判断提供数字：tick 到底多少毫秒、同一份 schema 换格式省多少、
TS 与 Python 的地板差多少。这里的东西**不进产品**，不追求可维护性，也不承诺接口稳定。

## 三条纪律

1. **一个 spike 只回答一个问题。** 加一个参数就算"更全面"的那种扩展，通常是把两个问题混在了一起。
2. **数字必须能被别人在同一台机器上重新跑出来。** 脚本 + 命令 + 机型 + 版本号一起提交；数字写进文档时
   标注实测日期与运行环境。
3. **测到的数字只支撑它测的那一件事。** 单线程、无网络、无业务逻辑、无 GC 压力叠加——它不构成"一台
   机器能扛多少玩家"的证据。这条纪律是为了防止最坏的情况：一个放错位置的计时区（或一次没标环境的运行）
   让结论差好几倍，而且看起来完全合理。

## 已执行

tick 的真实形状与核数折算（`aoi-tick/`）、序列化格式 × 布局对照与压缩（`ser-compare/`）、TS 与
Python/Cython 的地板与天花板（`ts-vs-python/`）、TS 优化手法的收益排序（`ts-runtime/`）、RPC 类型安全
的可执行断言（`rpc-typing/`）、长跑稳态与 GC 判定（`aoi-tick/soak*.mjs`）。数字与结论归
[服务器引擎技术栈](../docs/server-engine-stack.md) 与 [协议契约](../docs/protocol-map.md) 所有，本目录只
负责"能被重跑"。

## 未执行

S3（kernel 的 Linux 构建链）、S4（gate 的 10 万连接）、S5（滚动重启的用户感知）；
[`docs/mmorpg-verification-plan.md`](../docs/mmorpg-verification-plan.md) 的 E1–E4 四个实验**全部未执行**
——那份文档是待执行的协议，不是实测报告。
