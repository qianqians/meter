# MMORPG 引擎选型：四个必须先跑的验证实验

> 配套文档：[`mmorpg-engine-choice.md`](mmorpg-engine-choice.md)（文档级对照评估）
> 状态：**方案（protocol），未执行**。本仓库当前没有代码、没有构建产物。
> 撰写环境约束（重要）：本次会话的 shell（pwsh）**完全不可用**（每次调用均以 `0xC0000142` / DLL 初始化失败退出），因此**没有任何一条命令被执行、没有任何一个数字被测出**。本文全部内容是"待执行的实验协议"，不是实测报告。

---

## 0. 为什么是这四个实验

文档级证据（见配套文档）已经能确定一件事：**Stride 不提供网络、无缝大世界、行为树，主循环也不是固定步长的确定性 tick。** 这些"缺什么"已经不需要再测了。

真正无法从文档判断、且**一旦猜错就要重写架构**的，只有四件事：

| # | 未知量 | 猜错的后果 | 严重度 |
|---|---|---|---|
| **E1** | Stride 能否在**无 GPU/无窗口**环境以 `StrideGraphicsApi=Null` 跑起权威模拟（物理/导航/序列化） | "用同一个引擎写客户端和服务器权威逻辑"这条路线整体作废，服务端必须换语言/换栈 | 🔴 架构级 |
| **E2** | 资产能否**按分区运行时加载并干净卸载** | 无缝大世界退化为"读条换场景"；内容管线与 L4 意图编译器的产物形态全部要改 | 🔴 架构级 |
| **E3** | 实体 spawn/despawn 的 **GC 与帧时间代价** | 同屏人数上限、是否需要自研实体/渲染层、是否需要池化基础设施 | 🟠 预算级 |
| **E4** | **QUIC/UDP 在真实玩家网络与目标服务器上是否可用** | 决定战斗通道是"QUIC 主通道"还是"QUIC 仅加速 + TCP 回退" | 🔴 架构级 |

**E1 与 E2 是"通过/不通过"的门（gate），E3 是"调参"的量。** 三者都不需要美术资源、不需要玩法设计，可以在**一周内**用一次性工程做完。相对一个月后才发现，这是最便宜的保险。

---

## 1. 环境前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| .NET SDK | 10.x（Stride 4.3 已对齐 .NET 10 / C# 14） | E1 只需 SDK，不需要 Game Studio |
| Stride | 4.3 | 用 Launcher 安装；E2 需要 Game Studio 建资产 |
| OS | Windows（建资产与 Game Studio） | 4.3 起资产编译器能在 Linux/macOS 构建"较简单项目"，但**本实验不要依赖它**，先用 Windows 拿到基线 |
| 磁盘 | ≥ 20 GB | 官方文档要求 19 GB |
| GPU | E3 需要真实 GPU（测帧时间）；**E1 不需要** | E1 应该在**目标部署环境**（Linux 容器 / CI）里跑，这才是它要验证的场景 |
| 时间盒 | E1 半天、E2 一天、E3 一天 | 超时即停，按"不通过"处理 |

> 明确反对的做法：把这三个实验混进正式项目里做。应该是一个一次性工程 `stride-probe`，测完就丢，只把结论带回来。

---

## 2. E1 — Null 图形后端能否当权威服务器

### 2.1 假设

`<StrideGraphicsApi>Null</StrideGraphicsApi>`（官方列出的合法值之一，见 `graphics-api.html`）可以启动完整的 Game 循环，并在**没有图形设备**的机器上持续运行物理、导航与序列化。若成立，"客户端与服务端共享同一套 C# 逻辑"可行；若不成立，Stride 只能定位为**表现层**。

### 2.2 做法

1. 新建 Stride 项目 `stride-probe`，在可执行项目的 `.csproj` 里加：

```xml
<PropertyGroup>
  <StrideGraphicsApi>Null</StrideGraphicsApi>
</PropertyGroup>
```

2. 加入一个探针脚本（骨架，**API 名需在 IDE 中核对，本环境未编译**）：

```csharp
public class HeadlessProbe : StartupScript
{
    private readonly List<double> _dt = new();
    private int _ticks;
    private bool _physOk, _navOk;

    public override void Start()
    {
        Log.ActivateLog(LogMessageType.Info);
        Console.WriteLine($"PROBE_START pid={Environment.ProcessId} " +
                          $"ram={GC.GetTotalMemory(false) / 1024 / 1024}MB");
    }

    // 物理回调：签名以 4.3 的 Bepu 集成为准（Bullet 下不同）
    public override void Update()
    {
        _dt.Add(Game.UpdateTime.Elapsed.TotalSeconds);
        _ticks++;

        // 探针 A：物理是否在跑（做一次 raycast，检查是否返回有效命中）
        if (_ticks == 120) { _physOk = TryRaycast(); }

        // 探针 B：导航是否可用（建一个 navmesh 查询，检查是否返回路径）
        if (_ticks == 240) { _navOk = TryNavQuery(); }

        if (_ticks % 600 == 0)
            Console.WriteLine($"PROBE_TICK n={_ticks} dt_p50={P(50):F4} " +
                              $"dt_p99={P(99):F4} phys={_physOk} nav={_navOk} " +
                              $"gc0={GC.CollectionCount(0)} gc2={GC.CollectionCount(2)}");

        if (_ticks >= 36000)   // ≈10 分钟 @60Hz
        {
            Console.WriteLine($"PROBE_END phys={_physOk} nav={_navOk}");
            Game.Exit();       // API 名需核对
        }
    }
}
```

3. 在**目标部署形态**里跑：Linux 容器、`--no-window` 之类的参数是否存在先按实际情况试，至少要覆盖"没有 DISPLAY 变量 / 没有 GPU 直通"。
4. 记录：启动耗时、RSS、是否创建窗口、dt 的 P50/P99 与方差、物理与导航探针结果、10 分钟是否崩溃、退出码。

### 2.3 通过判据

| 项 | 通过 | 不通过 |
|---|---|---|
| 进程存活 | 10 分钟无崩溃，退出码 0 | 崩溃 / 卡死 / 必须有显示设备 |
| 固定步长 | dt P99 偏差 ≤ 5%（说明可以自建固定 tick 累加器） | dt 抖动到无法做确定性模拟 |
| 物理探针 | raycast 返回有效命中 | 物理在 Null 下不可用 |
| **导航探针** | **navmesh 查询返回有效路径** | **导航不可用 → 服务器必须自带寻路（Recast/Detour 或自研）** |
| 内存 | RSS 稳定，无随 tick 线性增长 | 内存泄漏 |

### 2.4 决策含义

- **全通过** → 可以走"服务端复用 Stride 逻辑（Null 后端）"的混合路线，省掉双份模拟代码；但仍需自研网络层。
- **物理或导航失败** → Stride 降级为**纯表现层**，权威内核另选语言（Go/Rust/Scala，见前序讨论），客户端只做预测与插值。**这是最可能的结果，请按它准备 Plan B。**
- 无论哪种结果，都要顺手量一下 **Null 后端下每实例的 RSS**：它决定单机能跑多少个进程实例。

---

## 3. E2 — 资产按分区加载与干净卸载

### 3.1 假设

世界可以切成若干 bundle，运行时按玩家位置加载、离开后卸载，且卸载后内存回到基线。若卸载不干净，无缝大世界就不成立。

### 3.2 做法

1. 建 3 个"分区"资产包（zone_a / zone_b / zone_c），每个含 1 个大模型 + 1 张 2K 贴图 + 若干材质，**刻意互不引用**。
2. **故意埋一个未引用资产**（`orphan_model`，任何地方都不引用它，也不 Mark as Root），用来验证"未引用资产不进包"这条官方行为。
3. 脚本循环：load(a) → 卸载 → load(b) → 卸载 → load(c)，重复 20 轮，每轮记录：

```
ZONE_ROUND r=3 zone=b load_ms=142.3 unload_ms=8.1
  mem_before=812MB mem_after_load=1140MB mem_after_unload=845MB
  gc0=41 gc2=2
```

4. build 输出目录里 `grep orphan_model`，确认它是否存在。
5. 采 load_ms 的 P50/P99，以及 `mem_after_unload - mem_before`（泄漏量）。

### 3.3 通过判据

| 项 | 通过 | 不通过 |
|---|---|---|
| 加载耗时 | P99 ≤ 单帧预算的 10 倍（例如 150ms）并能异步化 | 同步阻塞且不可拆分 |
| **卸载泄漏** | 20 轮后 Δmem ≤ 5% 基线，且不再增长 | 每轮单调增长 → 资产不可回收 |
| 未引用资产 | build 输出中**不存在** `orphan_model` | 存在 → 打包规则与文档不符，内容管线要重做 |

### 3.4 决策含义

- **通过** → 分区流式世界按 bundle 粒度做，L4 意图编译器的产物可以是"按 bundle 发布的资产"。
- **卸载泄漏** → 无缝世界不可行，改为"场景级切换 + 读条"，或把资产生命周期完全自管（走自研资源层，等于放弃引擎的资产管理）。
- 注意：官方 `asset-control` 页面**自己标注了 "This section is out of date"**。这一个实验的价值恰恰在于：它验证的是**官方文档已声明不可信的那部分**。

---

## 4. E3 — 实体 churn 的 GC 与帧时间

### 4.1 假设

"实体移除后由 GC 回收、`Prefab.Instantiate()` 返回新列表"（官方文档明写）导致 MMORPG 的持续 spawn/despawn 场景出现 GC 尖峰。需要一个池化层。

### 4.2 做法

- 稳定态 2000 个实体；每秒钟销毁并新建 200 个（模拟玩家/怪物/掉落物进出）。
- 采 60 秒：帧时间 P50/P99/P999、`GC.CollectionCount(0/1/2)`、`GC.GetTotalAllocatedBytes(true)`。
- **对照组**：同一场景改成一个朴素池（复用 `Entity`，`Enabled` 开关或自建 active 列表），其余不变。
- 两个版本各跑 3 次取中位数，避免单次噪声。

### 4.3 通过判据

| 项 | 目标 | 不通过 |
|---|---|---|
| 帧时间 P99 | ≤ 16.7 ms | 尖峰与 GC 相关且无法通过池化消除 |
| GC gen2 次数 | 60 秒内 = 0（理想） | 频繁 gen2 → 强制池化 + 避免每帧分配 |
| 池化收益 | P99 改善 ≥ 30% | 池化无效 → 说明瓶颈在引擎内部（变换矩阵/渲染提交），需要更激进的方案 |

### 4.4 决策含义

这条量出来的是**同屏人数的上限**。如果 2000 实体 churn 就已经打不住，那么"MMO 同屏人流"必须靠剔除 + instancing + 池化三件套，而且**不能把玩家/NPC 做成一个实体一棵子树**的朴素结构。

---

## 5. E4 — QUIC / UDP 可达性与支持矩阵

### 5.1 假设

abelkhan 计划加入 QUIC 通信层（**该仓库无公开记录**，见 `mmorpg-engine-choice.md` §8.5）。但 QUIC 能不能用，取决于三件与引擎无关的事：客户端 OS 版本、服务器是否装了 `libmsquic`、以及**网络是否放行 UDP**。这三件都不是文档能回答的。

### 5.2 做法

1. **客户端支持矩阵**：在 Windows 10、Windows 11、以及目标 Linux 桌面发行版上，分别用 Stride 与 Godot(.NET) 各跑一个最小程序，打印 `QuicConnection.IsSupported`。预期两者结论相同（同一 .NET/MsQuic 约束），但**要实测确认**。
   - 重点：**Windows 10 预期返回 false**（.NET 官方文档原话：早期 Windows 缺少 QUIC 所需的加密 API）。
2. **服务器支持矩阵**：在目标发行版与**实际容器镜像**里检查 `libmsquic` 是否安装（如 `apt list --installed libmsquic`）以及 `QuicListener.IsSupported`。
3. **真实网络可达性**：部署一台公网 QUIC 端点，在**目标玩家网络类型**下各测 N 次（家庭宽带 / 4G / 5G / 校园网 / 企业网 / 跨运营商）：握手成功率、握手耗时 P50/P99、失败时的具体错误。
4. **对照组**：同一批网络下的 TCP 握手成功率（作为基线）。

### 5.3 通过判据与决策含义

| 项 | 结论 | 决策 |
|---|---|---|
| Win10 支持率 | 若大量玩家为 `false` | QUIC 只能是**加速通道**，不能作唯一通道 |
| UDP 阻断率 | > 5% 即视为不可忽略 | **TCP 回退必须是一等公民**，不允许"QUIC 失败 = 登不上" |
| 握手耗时 | 只有明显优于 TCP 才有收益 | 优势不明显就先不上，省掉双栈维护成本 |
| 容器缺 libmsquic | 任一目标镜像缺失 | 补进基础镜像，写进部署检查清单 |

### 5.4 附带的必答问题（问维护者）

`System.Net.Quic` **未暴露 QUIC DATAGRAM（RFC 9221）**，而 `core/INetwork.cs` 的 `Send(byte[] data)` 也**没有可靠性标记**。要问清楚：QUIC 层打算**单流还是多流**？有没有计划支持**不可靠/无序**发送？

> 如果两者都没有，QUIC 对"即时战斗"的收益就只限于"**流间不互相阻塞**"——仍然值得，但不足以替代真正的不可靠通道。

---

## 6. 优先级（如果只有一天）

**只做 E1 的导航探针（`_navOk`）。**

理由：E1 是唯一会让"服务端复用游戏引擎"这条路线整体作废的未知量，而导航探针是 E1 里最可能在 Null 后端下失败的一项。半天就能拿到答案，答案影响的是语言与架构选择，而不是参数调优。

**如果还有两小时**：跑 E4 的客户端支持矩阵——在 Win10 / Win11 上各打印一次 `QuicConnection.IsSupported`。这是全文档里**最便宜、且同样能改写架构**的一个数字。

---

## 7. 结果记录模板

```markdown
## E1 Null 后端
- 环境：<OS / 容器 / .NET 版本 / Stride 版本>
- 启动耗时：___ ms    空载 RSS：___ MB
- 10 分钟存活：是/否    退出码：___
- dt P50/P99：___ / ___    物理探针：通过/失败    导航探针：通过/失败
- 结论：可作权威服务器 / 仅作表现层

## E2 资产分区
- 加载 P50/P99：___ / ___ ms
- 20 轮后 Δmem：___ MB（基线 ___ MB）
- 未引用资产是否进包：是/否
- 结论：可流式 / 需读条 / 需自研资源层

## E3 实体 churn
- 朴素版 帧 P50/P99/P999：___ / ___ / ___ ms    GC gen2：___
- 池化版 帧 P50/P99/P999：___ / ___ / ___ ms    GC gen2：___
- 结论：同屏上限估计 ___ 实体；必须池化：是/否
```

---

## 8. 本文档的证据等级

- **[一手]**：所有"官方文档写了什么"的引用，均来自配套文档 `mmorpg-engine-choice.md` 附录里的 URL 清单（Stride 官方文档与 4.3 release notes）。
- **[未执行]**：第 2–4 节的**全部实验与数字**。本会话 shell 不可用（`0xC0000142`），没有编译、没有运行、没有测量。
- **[未核实]**：`github.com` 在本环境抓取失败，因此**没有**任何关于"别人做 Stride 大世界/MMO 的实测案例"的一手材料。如果存在此类社区案例，它们可能会让我修改 E2 或 E3 的判据——请在执行前先人工搜一遍。
