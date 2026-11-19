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
| [`ts-runtime/`](ts-runtime/) | TS 编译后就是 JS，那么 TS 的真实优化手法里哪几条的量级最大？（数据布局 / 遍历 / 分配 / 序列化 / 调用点）；以及两条工具链断言：`erasableSyntaxOnly` 真的能拦住 `enum`、`package.json#imports` 真的不靠转译器 |
| [`aoi-tick/`](aoi-tick/) | 一个 MMO 场景的一 tick（积分 + 网格重建 + AOI 查询 + 属性打包）到底花多少毫秒？按 2w DAU 折算要几核？ |
| [`ser-compare/`](ser-compare/) | 同一份 schema 下 flatbuffer 与 protobuf 的字节数、encode、read 各差多少？该砍一个还是分工？（TS 与 Go 两侧都测） |
| [`rpc-typing/`](rpc-typing/) | 不写泛型参数、让方法名字面量同时决定请求与响应类型的 RPC 类型，在 TS 5.9 `--strict` 下真的成立吗？错用会被编译期拦住吗？ |

## 〇、aoi-tick/soak.mjs：长跑稳态

回答的问题不是"多快"，而是"跑一小时后它还稳不稳"。每个 tick = 一次真实逻辑服 tick + 一次网络往返
（场景 tick + protobuf 编码 + zstd 往返 + 解码），**故意保留分配源**——纯 SoA tick 零分配，测不出 GC 问题。

```bash
node soak.mjs --minutes=1  --hz=10                          # 冒烟
bun  soak.mjs --minutes=60 --hz=20 --scenes=2 --entities=400 # 长跑
```

**判据先写死，再看结果**（脚本里就是这三个）：A RSS 收敛（末 20% vs 首 20% 中位数，增长 <10% 且 <32 MB）；
B p99 不漂移（末 20% ≤ 首 20% × 1.5）；C 末段 10 分钟 RSS 斜率 < 0.5 MB/min；D 兜底：RSS > 1.5 GB 立即中止。
采样写进 `.soak/*.jsonl`（已 gitignore）。

## 一、ts-vs-python：地板与天花板

同一份算法（`x += vx; y += vy; s += x`），N = 100,000 实体 × 60 tick，单位 **ns / 实体·tick**（越小越好）。

| 实现 | ns/实体·tick（3 次运行） | 相对 V8 |
|---|---:|---:|
| **Cython 裸指针**（`cdef class` + `malloc`） | **0.72 – 0.73** | 0.82× |
| Cython `memoryview`（`double[::1]`） | 0.79 – 0.82 | 0.92× |
| Python + numpy 向量化 | 0.89 – 0.91 | 1.01× |
| **Node 18 TypedArray**（SoA，最朴素写法） | **0.85 – 0.97**（4 次） | 1.00× |
| 纯 Python（`list`） | 69.6 – 71.5 | **79 – 82×** |
| Python + `array('d')` | 153.7 – 155.5 | 172× |

### 方法论修正（第一版基准是错的）

第一版基准把 `list → ndarray` 的转换放进了计时区，于是报出"numpy 2.87、Cython memoryview 2.71，只有裸指针 0.92 才追平 V8"。**那是转换成本，不是积分循环。**

把构造与分配移到计时之外后（现在 `bench.py` 就是这样），结论变了：

```diff
- Cython memoryview  2.71  →  "比裸指针慢 3 倍，只有裸指针能追平 V8"
+ Cython memoryview  0.81  →  与 numpy、V8 在 ±10% 内重合；裸指针只再快 11%
```

**保留下来的判断**：
- **地板差约 80 倍**（纯 Python 71.5 vs V8 0.85–0.97）——Python 每步都要字节码分派 + 引用计数，V8 把这段循环直接编成机器码。
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
| 3b | 不逃逸分配（V8 标量替换） vs 逃逸并保留 | 16.6 ms | 0.5 ms | **33×** |
| 4 | `JSON.stringify` vs `DataView` 定长打包（1e4 实体 × 20 轮） | 67.9 ms | 0.5 ms | **130×** |
| 5 | megamorphic 调用点（A..E 混用） vs monomorphic | 83.1 ms | 16.0 ms | **5.19×** |

排序后的结论：**序列化形态 > 数据布局 > 遍历/分配 > 调用点形态**，全部比"挑选 JS 写法"这种微观优化高一个数量级。
第 4 行顺带回答了协议选型的一半问题：二进制打包比 JSON 快两个数量级（但这**不是** flatbuffer vs protobuf 的答案，见 `docs/server-engine-stack.md` 的未核实清单）。

> 第 5 行是最危险的一条：**deopt 不报错**。同样的源码，因为一个调用点混了 5 种类型就慢 5 倍，而且没有任何工具会在 CI 里提示你。

## 三、aoi-tick：真实形状的 tick（S1）

不是"一次积分循环"，而是一个场景的完整 tick 流水，四段分别计时、循环内零分配：
`① 积分 → ② 网格重建（计数排序）→ ③ AOI 查询（3×3 邻居格 + 平方距离）→ ④ 属性 diff + 列式量化打包`。

世界尺寸随实体数按比例放大，密度固定 ⇒ 每个观察者的 3×3 邻居恒为 ~36 个可见实体（否则规模对比会假性超线性）。

| 实体/场景 | 中位 tick | P95 | ③ 查询 | ④ 打包 | ①+② | AOI 对数/tick | 字节/tick |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 400 | **0.17 ms** | 0.19 ms | 0.10 | 0.06 | 0.00 | 9,324 | 111,888 |
| 1,000 | 0.45 ms | 0.50 ms | 0.28 | 0.16 | 0.00 | 23,668 | 284,016 |
| 5,000 | 2.45 ms | 2.75 ms | 1.53 | 0.88 | 0.03 | 119,988 | 1,439,856 |
| 10,000 | **5.21 ms** | 5.62 ms | 3.15 | 1.96 | 0.06 | 256,228 | 3,074,736 |
| 30,000 | 15.77 ms | 16.89 ms | 7.96 | 7.57 | 0.22 | 872,936 | 10,475,232 |

**两条结论**：

1. **③+④ 占 96–98% 的 tick**，① 积分 + ② 网格只占 1–4%。真实场景里单个实体的成本是 425 ns（400 实体），比 §一 的纯积分 0.9 ns 贵 **470 倍**——贵的部分全在 AOI 与打包上。所以优化顺序是"先动 AOI，再动打包"，不是"先动内循环"。
2. `scale.mjs` 折算：50 场景（15 战斗 20Hz + 35 非战斗 10Hz）合计 **110.5 ms/s = 11.1% 单核**；乘 3× 未建模折算（战斗判定 / AI / RPC 派发 / DB 回调）⇒ **0.66 核**。

> ⚠️ 文档原判据是"1 万实体、10Hz 下 tick < 5 ms"，实测 **5.21 ms，差 4%，判据未达成**。但 1 万实体单场景是"全区全服挤一起"的极端形态；真实配置 400 实体/场景是 0.17 ms（判据阈值的 1/30）。
> 未建模：战斗判定/技能/buff、NPC AI 与寻路、RPC 派发、DB 回调与跨服、网络发送；且全部是单线程。

## 四、ser-compare：flatbuffer vs protobuf（S2）

同一份 schema（10 头字段 + 每实体 15 字段），两种格式 × 两种布局，TS 与 Go 各实现一遍。
N = 1000 实体；两侧产出的**字节流完全一致**（50433 / 64096 / 34006 / 64232），这是比较成立的前提。

| 实现 | 字节 | 每实体 B | Go encode | Go read | Node encode | Node read |
|---|---:|---:|---:|---:|---:|---:|
| protobuf AoS | **50,433** | 50.4 | 206–214 µs | 164–166 µs（**166 ns/实体**） | 750–771 µs | 578–586 µs |
| FlatBuffers AoS | 64,096 | 64.1 | **71–74 µs** | **5–8 µs（5–8 ns/实体）** | **150–182 µs** | **103–104 µs** |
| protobuf SoA | **34,006** | **34.0** | 55–57 µs | 50.7–50.9 µs | 550–553 µs | 482–503 µs |
| FlatBuffers SoA | 64,232 | 64.2 | 53–58 µs | 18.9–20.4 µs | 254–262 µs | 150–167 µs |
| JSON（基线） | 178,993 | 179.0 | — | — | 902 µs | 627–634 µs |

**三条结论**：

1. **字节数 protobuf 全胜**（AoS 小 21%、SoA 小 47%）——varint+zigzag+省略默认值 vs 定宽+每字段占位。
2. **读 FlatBuffers 全胜**，Go 里 AoS 是 **5–8 ns vs 165 ns（21–33×）**；`wrap` 在 Node 里 0.7 µs、在 Go 里低于时钟分辨率。
3. **格式与布局正交且方向相反**：同一份 protobuf 改 SoA → 字节 −33%、读 −69%；同一份 FlatBuffers 改 SoA → 字节不变、读**慢 4×**。**没有任何变体在两个维度同时赢。**

**TS 侧用哪个 protobuf 库**（同一条 bench 上加的变体）：protobuf-es v2 在 AoS 上**比 protobufjs 慢 1.5×**（1440 µs vs 750 µs，因为每个 message 的默认字段都要填满），但在 packed 数组上快 **2.7×**（176 µs vs 490 µs）；两者字节流都与 Go 逐字节一致。包体（min+gzip）：protobuf-es 100.5/27.7 KB、protobufjs 70.6/16.0 KB、flatbuffers 23.6/**4.1** KB。

**压缩实验**（`compress-bench.mjs`）：zstd-19 下 pb SoA 19.60 KB / pb AoS 29.90 KB / FB AoS 24.41 KB（N=1000）；N=60 的每 tick 增量里 FB 只比 pb SoA 大 **5%**。**压缩把"FB 费流量"这条理由吃掉了，也让"布局"的权重超过"格式"**（pb SoA 比 pb AoS 小 34%）。brotli-11 压缩率最好但压缩一个 30 KB 包要 43,647 µs，不可用。

**演进实验**（`fb-evolution.mjs`）：给 FB 的 struct 加一个字段，用新代码解老字节 **不报错、前 50 个实体 50/50 全错**——静默数据损坏。改用 table 能演进，代价是读 **2.0–2.3×**、字节 **1.16×**。这条直接决定了 `docs/protocol-map.md` §5 的"预留槽位 + 冻结纪律"。

**两个坑**（已修，但是"双协议"的真实成本）：protobufjs 的 `uint64` 不认 `bigint`（会静默写 0）；protobufjs 会写出显式 0 而 protoc-gen-go 省略默认值（字节差 1.7%）。
详见 [`ser-compare/README.md`](ser-compare/README.md)。

## 五、ts-runtime 的两条工具链断言

| 断言 | 文件 | 结果 |
|---|---|---|
| `erasableSyntaxOnly` 会拦住不可擦除语法 | `ts-runtime/erasable-syntax/enum.ts` | `error TS1294`，**exit 2**（就是要它失败） |
| `package.json#imports` 的 `#core/*` 由运行时自己解析 | `ts-runtime/imports-field/` | `node app.mjs` → `imports-field-ok`，**exit 0**（Node 18.20.8） |

这两条合起来说明一件事：**"零编译步骤也能跑"不是习惯问题，是可以被工具强制的**——
别名由运行时解析（不需要 tsconfig `paths` 与打包器插件），不可擦除的语法由编译器当场拒绝（不需要运行时才发现）。

## 六、rpc-typing：类型安全的可执行断言

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

# 三（Node 侧，无依赖）
node aoi-tick/bench.mjs            # 四段计时，默认 5 组实体规模
node aoi-tick/scale.mjs            # 折算核数（业务假设集中在 ASSUME）

# 四（S2，需要 flatc / protoc / protoc-gen-go 与 npm 依赖）
cd ser-compare
./build.sh                          # 生成 gen/ 与 bench-go.exe
node bench-ts.mjs 1000 300
GOGC=800 ./bench-go.exe 1000 30
node compress-bench.mjs              # 压缩：体积 + 压缩/解压耗时
node fb-evolution.mjs                # FlatBuffers struct 加字段的后果
node es-pitfalls.mjs                 # protobuf-es 的 15 条行为契约

# 五（工具链断言）
cd ../ts-runtime
node imports-field/app.mjs                          # -> imports-field-ok
npx --yes -p typescript@5.9 tsc -p erasable-syntax   # -> 故意失败：TS1294

# 六
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

**运行时有影响（实测）**：`aoi-tick`、`bench-ts`、`compress-bench` 都在 Node 18（V8）与 Bun 1.4.5（JSC）上各跑过一遍。Bun 全面更快（骨架 tick −20~28%、protobuf-es SoA 读 176→98 ns/实体、JSON 快 4×、冷启动 53→25 ms、空载 RSS 40→18 MB），但 **zstd 在 N=1000 上反而慢 2×**。所以每个数字都要带"跑在什么上"，见 `docs/server-engine-stack.md` §8.4。

**这些数字不能推出什么**：单线程、无网络 IO、无 AOI 空间查询、无序列化在环内、无 GC 压力叠加。
它们是"同一个循环在两门语言里的原料成本"，不是"一台机器能扛多少玩家"。
