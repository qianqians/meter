# spikes —— 本仓库唯一的代码，全部是"可复现的实测"

`docs/` 里的每一份文档都在开头声明"无实测"。这个目录是那条例外的第一次破例：
把所有"设计文档回答不了、只能跑一遍"的问题做成可复现的最小脚本。

## 三条纪律

1. **spike 不是产品代码。** 这里的脚本不追求可维护性、不追求接口稳定，只为回答一个问题。
2. **每个数字必须能被别人在同一台机器上重新跑出来。** 因此脚本 + 命令 + 机型 + 版本号一起提交；数字写进 `docs/` 时标注实测日期。
3. **测到的数字只能支撑它测的那一件事。** 单线程、无网络、无 AOI、无序列化在环内——它不构成任何"生产环境可行"的证据。

## 目录

| 目录 | 回答的问题 |
|---|---|
| [`ts-vs-python/`](ts-vs-python/) | 同一个积分循环，V8（TypedArray）与 CPython 的四种写法各是多少 ns/实体·tick？"TS 封顶、Python 门票制"这个判断成立吗？ |
| [`ts-runtime/`](ts-runtime/) | TS 编译后就是 JS，那么 TS 的真实优化手法里哪几条的量级最大？（数据布局 / 遍历 / 分配 / 序列化 / 调用点） |
| [`rpc-typing/`](rpc-typing/) | 不写泛型参数、让方法名字面量同时决定请求与响应类型的 RPC 类型，在 TS 5.9 `--strict` 下真的成立吗？错用会被编译期拦住吗？ |

## 一、ts-vs-python：地板与天花板

同一份算法（`x += vx; y += vy; s += x`），N = 100,000 实体 × 60 tick，单位 **ns / 实体·tick**（越小越好）。

| 实现 | ns/实体·tick | 相对 V8 |
|---|---:|---:|
| **Cython 裸指针**（`cdef class` + `malloc`） | **0.72** | 0.82× |
| Cython `memoryview`（`double[::1]`） | 0.81 | 0.92× |
| Python + numpy 向量化 | 0.89 | 1.01× |
| **Node 18 TypedArray**（SoA，最朴素写法） | **0.90** | 1.00× |
| 纯 Python（`list`） | 71.5 | **79×** |
| Python + `array('d')` | 154.5 | 172× |

### 方法论修正（第一版基准是错的）

第一版基准把 `list → ndarray` 的转换放进了计时区，于是报出"numpy 2.87、Cython memoryview 2.71，只有裸指针 0.92 才追平 V8"。**那是转换成本，不是积分循环。**

把构造与分配移到计时之外后（现在 `bench.py` 就是这样），结论变了：

```diff
- Cython memoryview  2.71  →  "比裸指针慢 3 倍，只有裸指针能追平 V8"
+ Cython memoryview  0.81  →  与 numpy、V8 在 ±10% 内重合；裸指针只再快 11%
```

**保留下来的判断**：
- **地板差 79 倍**（纯 Python 71.5 vs V8 0.90）——Python 每步都要字节码分派 + 引用计数，V8 把这段循环直接编成机器码。
- **天花板三方重合**（0.72 ~ 0.90）——Cython 与 numpy 走的是同一块 C 代码，V8 的 JIT 也到那里。
- **形状不同才是关键**：TS 是"0.90 白送、没有中间档"；Python 是"71.5 起步、可逐段下沉"。

**没能成立的判断**（第一版说过、本轮被实测推翻）：*"Cython 的优化是手艺活，写成 memoryview 只到 3× V8。"* 在本例的 SoA 稠密循环里，memoryview + `boundscheck=False, wraparound=False` 已经足够；裸指针只在热循环里出现指针算术/自定义 stride/消除最后一次索引运算时才值得写。

## 二、ts-runtime：TS 侧的收益量级（N = 1,000,000）

| # | 对照 | 慢的一方 | 快的一方 | 倍率 |
|---|---|---|---:|---:|
| 1 | 数据布局 AoS（对象数组） vs SoA（`Float64Array`） | 302.4 ms | 85.2 ms | **3.55×** |
| 2 | `for...of` TypedArray vs `for (i++)` | 69.8 ms | 10.0 ms | **7.0×** |
| 2b | `reduce` vs `for (i++)` | 116.3 ms | 10.0 ms | **11.6×** |
| 3 | 逃逸分配 vs 1024 槽对象池 | 16.6 ms | 2.4 ms | **6.99×** |
| 3b | 不逃逸分配（V8 标量替换） | — | 0.5 ms | 比逃逸快 6.3× |
| 4 | `JSON.stringify` vs `DataView` 定长打包（1e4 实体 × 20 轮） | 67.9 ms | 0.5 ms | **130×** |
| 5 | megamorphic 调用点（A..E 混用） vs monomorphic | 83.1 ms | 16.0 ms | **5.19×** |

排序后的结论：**序列化形态 > 数据布局 > 遍历/分配 > 调用点形态**，全部比"挑选 JS 写法"这种微观优化高一个数量级。
第 4 行顺带回答了协议选型的一半问题：二进制打包比 JSON 快两个数量级（但这**不是** flatbuffer vs protobuf 的答案，见 `docs/server-engine-stack.md` 的未核实清单）。

> 第 5 行是最危险的一条：**deopt 不报错**。同样的源码，因为一个调用点混了 5 种类型就慢 5 倍，而且没有任何工具会在 CI 里提示你。

## 三、rpc-typing：类型安全的可执行断言

`rpc-types-demo.ts` 是正例（方法名字面量 → 请求/响应类型的双向绑定，调用处零泛型参数），`negative.ts` 是反例集：四条错用全部用 `@ts-expect-error` 标注。

```bash
npx --yes -p typescript@5.9 tsc -p .
```

**结果：`exit 0`，零错误。** 这条命令同时证明了两件事——正例类型检查通过，且四条反例**确实**会报错（若某条没报错，`@ts-expect-error` 本身会被报成 `Unused '@ts-expect-error' directive`）。
于是"这套 RPC 类型安全吗"从一个主观判断变成了一条可进 CI 的断言。

## 复现

```bash
# 一、二（Node 侧，无需依赖）
node ts-vs-python/node_bench.mjs
node ts-runtime/bench-ts-perf.mjs          # 需要 --max-old-space-size=4096 时见文件头注释

# 一（Python 侧，需要 C 编译器 + numpy + cython）
cd ts-vs-python
pip install numpy cython
python setup.py build_ext --inplace         # 产出 perf.cp314-win_amd64.pyd
python bench.py

# 三
cd ../rpc-typing
npx --yes -p typescript@5.9 tsc -p .
```

**实测环境**（本轮，2026-11-19）：

| 项 | 值 |
|---|---|
| CPU | Intel Core i5-14400F（6P+4E，Windows） |
| Node | v18.20.8（**没有**原生类型擦除，见 `docs/server-engine-stack.md` §4） |
| Python | 3.14.6 |
| numpy / Cython | 2.5.4 / 3.3.1 |
| C 编译器 | MSVC 14.51（VS 18） |

**这些数字不能推出什么**：单线程、无网络 IO、无 AOI 空间查询、无序列化在环内、无 GC 压力叠加。
它们是"同一个循环在两门语言里的原料成本"，不是"一台机器能扛多少玩家"。
