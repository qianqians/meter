# ser-compare —— S2：flatbuffer vs protobuf

同一份数据（10 个头字段 + 每实体 15 个字段，共 25 个字段名），四种序列化：

| 变体 | 布局 | 实现 |
|---|---|---|
| protobuf AoS | `repeated EntityState`（每行一个 message） | protobufjs 静态码 / protoc-gen-go |
| FlatBuffers AoS | `[EntityState]`（struct 定长数组，零拷贝） | flatc 生成的 TS / Go |
| protobuf SoA | 每字段一条 `packed` 数组 | 同上 |
| FlatBuffers SoA | 每字段一条 `vector` | 同上 |

外加 JSON 基线（仅 TS 侧）。

## 为什么要做 AoS 与 SoA 两套

因为主文档 §3.3 的实测说明**布局的影响可能大于格式**。只测"格式"会把两件事混在一起：
一层是"varint + tag 的开销"，另一层是"逐行 vs 逐列的内存布局"。分开测才能说清
"该换成 FlatBuffers"和"该换成列式"是两个独立决定。

## 怎么跑

```bash
./build.sh                      # 生成 gen/ 与 bench-go.exe（生成物不入库）
node bench-ts.mjs 1000 300      # 实体数 重复数
GOGC=800 ./bench-go.exe 1000 30
```

## 踩到的两个坑（都已修，并写进 bench 注释）

1. **protoc-gen-go 省略默认值，protobufjs 不省略**：protobufjs 的静态编码器把"显式设成 0"的字段也写出来，
   于是同一份数据两边字节数差 1.7%（50951 vs 50433）。TS 侧改成"建对象时就跳过零值"后才对齐。
2. **protobufjs 的 uint64 不认 `bigint`，会静默写成 0**：`playerId` 与 `buffMask` 必须用 `number`/`string`。
   这个坑很安静——类型检查不报错，只有把两边的字节流 hex 打出来对比才会发现。

对齐后，**四种变体的字节数在 TS 与 Go 两侧完全一致**（50433 / 64096 / 34006 / 64232），
这也是这套实现能互相验证的唯一证据。

## 压缩实验：`compress-bench.mjs`

同一份数据（N=1000 快照 / N=60 每 tick 增量），zstd 经 `@mongodb-js/zstd`：

| 编码 | 原始 | zstd-19（N=1000） | zstd-19（N=60） |
|---|---:|---:|---:|
| protobuf SoA | 30,993 / 1,898 B | 19.60 KB (65%) | **1.49 KB (80%)** |
| protobuf AoS | 47,420 / 2,835 B | 29.90 KB (65%) | 2.04 KB (74%) |
| FlatBuffers AoS | 64,096 / 3,936 B | 24.41 KB (39%) | 1.56 KB (41%) |

**结论**：未压缩时 FB 比 pb SoA 大 107%，压缩后（N=60）只大 **5%**——"省流量"不再构成选格式的理由。
而**布局的影响被压缩放大**：pb SoA 比 pb AoS 小 **34%**。
`brotli-11` 压缩率最好（30 KB → 13 KB），但压缩一个 30 KB 包要 **43,647 µs**，不可用。

## 演进实验：给 struct 加一个字段会发生什么

`fb-evolution.mjs` + `schema/fb-evolution.fbs`（同一份字段，外加一个"新增字段"的 struct 版本与一个 table 版本）：

| 实验 | 结果 |
|---|---|
| 15 字段 struct 的字节，用 16 字段 struct 解 | **不报错**，但第 0 个实体 id 读成 1000999（真值 1000000）、x 读成 11081（真值 -100000），前 50 个实体 **50/50 全错** |
| 同一份字节用 table 代码解 | 也不报错（错误用法没有任何提示） |
| table 数组 vs struct 数组：读 1000 实体 | 36–42 vs 18 ns/实体（**2.0–2.3×**） |
| table 数组 vs struct 数组：字节 | 74,336 vs 64,096 B（**1.16×**） |

结论被写进 [`docs/protocol-map.md`](../../docs/protocol-map.md) §5：**struct 的演进失败是静默数据损坏**，所以每帧消息的 struct 必须一次预留 4 个 `int` 槽位，上线后只允许占坑。

## protobuf-es（第三个 protobuf 实现）

`bench-ts.mjs` 里另有两行 `protobuf-es`：`@bufbuild/protobuf` v2 + `protoc-gen-es` 2.6.3 生成的纯 TS
（type-only interface + `MessageSchema` 常量），64 位用原生 `bigint`。

| N = 1000 | encode µs | wrap µs | read+decode µs | 字节 |
|---|---:|---:|---:|---:|
| protobufjs AoS | 747–758 | 202–203 | 586–589 | 50,433 |
| protobuf-es AoS | 1416–1429 | 823–848 | 846–876 | 50,433 |
| protobufjs SoA | 551–554 | — | 484–498 | 34,006 |
| protobuf-es SoA | 562–582 | — | **176–181** | 34,006 |

**protobuf-es 并不普遍更快**：AoS（大量小 message）慢 1.5×（每个 message 的默认字段都填满），
只有 packed 标量数组快 2.7×。字节流仍与 Go 侧逐字节一致。

包体（esbuild `--minify --format=esm`，gzip level 9）：

| 产物 | minified | gzip |
|---|---:|---:|
| protobuf-es v2（3 个 message） | 100.5 KB | 27.7 KB |
| protobufjs 7（静态码） | 70.6 KB | 16.0 KB |
| flatbuffers 25（生成码） | 23.6 KB | **4.1 KB** |

**行为契约测试**（把 §8.3 里那些容易出 bug 的语义钉成断言，升级库时会先失败）：

```bash
node es-pitfalls.mjs     # 15 条断言，全过 exit 0
```

`erasableSyntaxOnly` 兼容性验证（protobuf-es 生成的 TS 要能在 `core` 的"零编译步骤"约束下编译）：

```bash
npx --yes -p typescript@5.9 tsc -p es-check     # 期望 exit 0
```

## protobuf-es 的 codegen：Windows 上的坑

`protoc` 与 `buf generate` 都要求插件是**可执行文件**，而 npm 在 Windows 上只生成
`protoc-gen-es.cmd` / `.ps1`，直接传 `--plugin=protoc-gen-es=./node_modules/.bin/protoc-gen-es.cmd`
会以 `'.' 不是内部或外部命令` 失败（两种工具都试过）。

解法是 `gen-es.mjs`：用 protoc 只产出 `FileDescriptorSet`，再自己构造 `CodeGeneratorRequest`
喂给插件 stdin，读回 `CodeGeneratorResponse` 写文件 —— 这就是 protoc 内部做的事。

```bash
./tools/protoc/bin/protoc.exe -I schema --descriptor_set_out=gen/state.desc --include_imports schema/state.proto
node gen-es.mjs
```

## 计时方法的坑（本机）

这台机器上 **Go 的单调时钟对微秒级区间经常报 0 ns**（一次 FlatBuffers `wrap` 就落在 0 的分辨率里）。
所以 Go 侧是批量计时（每样本 k 次再除以 k），批量后仍测不出的如实标 `<LOD`，不伪造。
Node 侧的 `hrtime.bigint()` 分辨率足够，直接测即可。
