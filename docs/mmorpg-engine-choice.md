---
id: meter-engine-choice
type: architecture-design
title: 引擎选型与更正记录（Cocos 定稿前的对照）
status: draft
parent: meter-goal
---

# MMORPG 引擎选型：Stride / Godot / Unity 在四个硬缺口上的对照

> **规格图采纳说明**：客户端引擎**定稿为 Cocos Creator**（TS），因此本文 §0 的结论、
> §7「C# 约束下的候选集」与 §8「若服务端用 abelkhan」都**退化为条件命题**，不是我方路径。
> 保留本文是因为三样东西仍然在用：§2 的四缺口对照矩阵、§3「该比什么」的重排，
> 以及 §6 的更正记录（Godot 没有 “Linux Server” 导出模板）与附录 B 的未核实清单。
> 读到这里的任何人请注意：**这不是当前选型结论，是一份被推翻过程的可核查记录。**

> 配套文档：[`mmorpg-verification-plan.md`](mmorpg-verification-plan.md)（四个必须实测的实验）
> 上级文档：[`ai-native-game-engine.md`](ai-native-game-engine.md)
> 状态：**文档级评估，无实测**。§7/§8 的前提已被 [`server-engine-stack.md`](server-engine-stack.md) 改写，见下方⚠️。

> ⚠️ **前提变更（2026-11-19）**：§5 的建议、§7（"C# 约束下的候选集"）与 §8（"若服务端用 abelkhan"）建立在一个前提上——**客户端引擎从 Stride / Godot / Unity 中选，且团队与服务端是 C#**。后续的 [`server-engine-stack.md`](server-engine-stack.md) 把这个前提改掉了：客户端以 **Cocos（TS）为一等目标**，逻辑层是 **TS `core`**，gate/dbproxy 是 **Go**。
> 因此 §5/§7/§8 现在**读作条件命题，不是结论**："若哪天决定复用 abelkhan 的**服务端**，则客户端引擎必须重新在 Stride/Godot(.NET) 之间选，且 TS 逻辑层作废"。这两条路互斥。§1–§4 的引擎对照（网络 / 大世界 / AI / 确定性四个硬缺口）与"权威内核不建在引擎里"这条判断**不受影响**。
> 仍然成立、且被新文档直接引用的部分：§8.1 的 abelkhan 一手核实、§8.2 的"传输只有 TCP/WebSocket"与 LGPL-2.1 陷阱。

## 证据等级（沿用主文档附录 B 的纪律）

| 标记 | 含义 |
|---|---|
| **【一手】** | 本轮我实际抓取到的官方页面，URL 见附录 A |
| **【否定性】** | 我逐条看过官方文档目录，确认**没有该条目**。只能证明"没有文档"，不等于绝对不存在 |
| **【未核实】** | 抓取失败或未能取得原文。**不填充，留空或标注** |

⚠️ **证据状态（本轮结束时）：三个列都已核实完毕。**

- **Stride 列**：一手官方文档 + 4.3 release notes。
- **Godot 列**：一手官方 Sphinx 原始页（`https://docs.godotengine.org/en/stable/_sources/...rst.txt`）。**HTML 手册页在本环境抓取只会返回导航栏，必须改抓 `_sources`** —— 这条方法论对后续任何 Godot 调研都适用。
- **Unity 列**：一手官方手册与包页（`docs.unity3d.com/6000.0/...`、`docs.unity3d.com/Packages/...`）。抓取失败的路径已逐条列在附录 B。

**仍然缺失的证据**：`github.com` 全站抓取失败，因此三个引擎**都没有**任何社区/工程实践的一手材料（即"别人真的这么做过吗"这一层完全空白）。本表只反映**官方文档说了什么**，不反映**它在生产中是否可行**。

---

## 0. 结论（先给）

1. **"网络"这一列，三个引擎都够不上 MMORPG 的门槛。** Stride 完全没有；Godot 有一个极简的高层 API；Unity 最接近（官方 netcode 包 + 专用服务器构建目标 + Relay/Lobby 服务），**但它的 Netcode for GameObjects 在官方手册里仍被列在 Pre-release packages（1.14–2.13 全部标 pre-release）**。没有任何一个提供"权威服务器 + 分区 + 兴趣管理 + 断线重连 + 反作弊"这一整套。
2. **"无缝大世界"这一列，三者都必须自研分区流式。** 差别只在起点：Unity 有地形与 Addressables，Godot 有自动 LOD 与遮挡剔除但没有内建地形与分区，Stride 两者都没有。
3. **"确定性"这一列出现了本轮唯一的分歧，而且它改变结论的强度。**
   - **Godot 明确否定**：*"Physics in Godot, regardless of physics engine, is **not** deterministic."* 【一手：[physics_introduction](https://docs.godotengine.org/en/stable/_sources/tutorials/physics/physics_introduction.rst.txt)】
   - **Stride 无内建确定性**，且同优先级脚本顺序不确定（连"可重现的执行顺序"都没有）**【一手】**。
   - **Unity 的 GameObject + PhysX 路线找不到确定性页面**【否定性】，**但 DOTS Unity Physics 的官方文档首句就是**：*"Unity Physics is a **completely deterministic** rigid body dynamics and spatial query system"*，并且强调 stateless，**便于网络中的 rollback / forward 物理状态**。【一手：[design philosophy](https://docs.unity3d.com/Packages/com.unity.physics@1.5/manual/design.html)】

   > **这是三个引擎里唯一一个官方声称确定性、且明确面向网络回滚设计的物理系统。** 它必须被认真对待，而不是被"三者都不行"一句话抹掉。
   > 但代价是：你要接受 **DOTS/ECS 编程模型**（Entities 1.5.0 官方定位仍只是 *"a modern ECS implementation with a basic set of systems and components"*）、接受 Unity 的**专有许可**，并且把权威内核**重新绑回引擎**——这恰好是主文档 §3.3 想避免的那件事。

   而你的主文档把确定性列为**地基**（[§3.3](ai-native-game-engine.md#L500)、[§7](ai-native-game-engine.md#L925)），所以这一格的分量高于其他所有格。
4. 由此得到本文最重要的一句判断：

   > **权威内核（L0）不要建在任何一个游戏引擎里。** 客户端引擎只承担 L3（呈现）与 L4（创作工具），
   > L0/L1/L2/L6 用独立技术栈实现（见前序 Scala 讨论）。

   **唯一的例外必须在正式评估中正面比较**：路径 D（Unity DOTS Physics），它是三者中唯一对确定性给出官方承诺的组合——见 §4。除了它以外，这条判断成立。

5. 如果接受第 4 点，那么上面四个缺口的**权重会重排**——"网络"和"行为树"几乎不再重要，而"能否被外部权威状态驱动""内容烘焙产物能否按分区打包发布""渲染管线能否挂神经后处理"成为新的关键判据（见 §3）。

---

## 1. 四条判据的定义

| # | 判据 | 为什么它在 MMORPG 里是硬缺口 |
|---|---|---|
| G1 | **网络** | MMO 需要服务器权威、状态复制、兴趣管理（AoI）、断线重连、反作弊、分线/合服 |
| G2 | **无缝大世界** | 连续地图 + 流式加载 + LOD + 遮挡剔除 + 人群渲染；MMO 的"世界感"全在这一层 |
| G3 | **AI 与寻路** | 大量怪物的行为、编队、巡逻、追击、脱战；传统 MMO 的 AI 是行为树而非 LLM |
| G4 | **确定性与固定步长** | 存档/回放/回归测试/反作弊的地基；对应主文档 §3.3 与 M1 |

---

## 2. 对照矩阵

标记含义：**内建** = 引擎自带且官方文档有专章；**插件/生态** = 官方无、靠第三方或官方可选包；**自研** = 必须自己写。

| 判据 | Stride 4.3 | Godot 4.x（stable 文档） | Unity 6（6000.x） |
|---|---|---|---|
| **G1 网络** | **自研**（完全没有）**【否定性】** | **内建**：`SceneMultiplayer` + `ENetMultiplayerPeer` / `WebSocketMultiplayerPeer` / `WebRTCMultiplayerPeer`、`MultiplayerSpawner`、`MultiplayerSynchronizer`、`@rpc`。**但无服务器权威框架、无客户端预测、无 rollback**（全类表无 `Rollback*`）**【一手/否定性】** | **官方包 + 官方服务**：Netcode for GameObjects（**手册中列于 Pre-release packages，1.14–2.13 全部标记 pre-release**）+ 已发布的 Relay 1.2.0 / Lobby 1.3.0。**NGO 无 prediction / rollback**，只有 client-side interpolation、Client anticipation、"Dealing with latency" **【一手/否定性】** |
| **G1b 无头 / 专用服务器** | 有 `Null` 图形后端；**无 dedicated server 章节** **【一手/否定性】** | **有**：`--headless`（≡ `--display-driver headless --audio-driver Dummy`）、导出模式 *Export as dedicated server*、特性标签 `dedicated_server`。**4.0 起不再需要专用服务端二进制，也不存在 "Linux Server" 预设** **【一手】** | **有，且是独立 build target**：Build Profile 选 Linux Server 等、`-standaloneBuildSubtarget Server`、定义 `UNITY_SERVER`、`DedicatedServer.Arguments` API。无头 = 对 Player 传 `-batchmode -nographics`（不初始化图形设备）**【一手】** |
| **G2 地形** | **无**（手册 TOC 无条目）**【否定性】** | **无内建地形**（`tutorials/3d/terrain` 404；特性表 3D tools 只有网格 / GridMap / CSG）**【否定性】** | **内建 Terrain**（GameObject > 3D Object > Terrain，Inspector 五类工具，可建相邻 Terrain tiles）；**但未找到内建地形流式（Terrain streaming）官方页** **【一手/未核实】** |
| **G2 分区流式** | **无**；只有贴图流送与 asset bundles（且**两个资产页面官方自标 out of date**）**【一手】** | **无世界分区 / 场景流式**（`scene_streaming` 404）；只有 `ResourceLoader.load_threaded_request` 后台加载 **【一手/否定性】** | **Addressables 2.10.3（6000.0，released）**：运行时 load/release 资产、自动依赖与内存管理，文档含 *Load scenes* / *Unload Addressable assets* **【一手】** |
| **G2 LOD / 遮挡剔除 / HLOD** | **手册无条目** **【否定性】** | **三者全有**：导入即生成自动网格 LOD（meshoptimizer，`mesh_lod_threshold` 默认 1 像素）、`OccluderInstance3D`（Embree）遮挡剔除、**visibility ranges 官方标题即 HLOD** **【一手】** | **LOD Group**（按屏高比例阈值、Cross Fade、Fade Transition Width）+ **Occlusion Culling**（Editor 烘焙 + 运行时查询；**动态物体可被遮挡但不能遮挡**；URP/HDRP 另有 GPU occlusion culling）**【一手】** |
| **G2 大世界坐标** | 手册无条目 **【否定性】** | **有，但要求自编译**：`precision=double` 重编译全部模板，**且服务端与客户端必须是同一构建** **【一手】** | **未核实**（6000.0 与 6000.3 的 `large-world-coordinates.html`、`world-space-coordinates.html` 均 404） |
| **G2 人群渲染** | 有 instancing；**游戏更新与渲染不并行**（官方明说）**【一手】** | MultiMesh（大规模实例化）**【未核实】** | GPU instancing（单 draw call 渲染同 mesh+material 多物体，`Graphics.RenderMeshInstanced`）；**Entities 1.5.0 官方定位仅"a modern ECS implementation with a basic set of systems and components"，未提世界规模** **【一手】** |
| **G3 行为树** | **无**（手册 TOC 无条目）**【否定性】** | **无内建**（全类表无 `BehaviorTree*`，`class_behaviortree` 404）；官方 Asset Library 有 7 个第三方插件（LimboAI 等）**【否定性/一手】** | **官方 Behavior 1.0.16（released）**：graph-based behavior tree 工具 **【一手】** |
| **G3 寻路** | 有导航（navmesh / 动态导航）**【一手】** | **内建且支持运行时烘焙**：NavigationServer2D/3D、NavigationRegion/Agent/Obstacle/Link、`bake_navigation_mesh(on_thread)`、`bake_from_source_geometry_data_async`；分块大世界用 baking AABB + `border_size` **【一手】** | **AI Navigation 2.0.15（released）**：明确支持 edit-time 与 **runtime** navmesh 构建、dynamic obstacles、links；另有 ML-Agents 4.1.0 **【一手】** |
| **G4 固定步长 tick** | **无游戏级固定 tick**；`SyncScript.Update()` 为可变 dt，只有物理定步长 **【一手】** | **有**：`Engine.physics_ticks_per_second`（默认 60）、`max_physics_steps_per_frame`=8、`physics_jitter_fix`=0.5 **【一手】** | **有**：`Time.fixedDeltaTime`。**但官方明确两件事**：低帧率下 FixedUpdate 会在一帧内累积并补执行多次；**同一事件函数在不同 GameObject 之间的顺序不可依赖** **【一手】** |
| **G4 确定性 / 回放** | 无内建；同优先级脚本顺序不确定 **【一手】** | **官方明确否定确定性**；回放只有 Movie Maker（`--write-movie` / `--fixed-fps`），是**视频录制而非输入回放** **【一手】** | **三者中唯一有官方确定性声明**：DOTS Unity Physics 文档首句 *"completely deterministic rigid body dynamics and spatial query system"*，stateless、面向网络 rollback / forward；但 GameObject + PhysX 路线找不到确定性页面 **【一手/否定性】** |
| **G4 无头回放（回归测试基础设施）** | 需自建（配合 `Null` 后端） | 需自建 | 需自建；官方 Recorder 5.1.7 仅采集（动画/视频/图像/音频/AOV），**不是确定性回放** **【一手】** |
| **渲染可扩展性（L3 挂神经层）** | **强**：graphics compositor、`ISceneRenderer`、RenderFeature 四阶段、pipeline processors、SDSL、4.3 Vulkan compute **【一手】** | 中等：需下探 `RenderingDevice` 层，改动面较大 **【未核实】** | **未核实**（本轮未抓 SRP / RenderGraph 页；仅证实 URP/HDRP 存在 GPU occlusion culling） |
| **编辑器平台** | **Game Studio 仅 Windows**（Avalonia 跨平台在做）**【一手】** | 全平台 | 全平台 |
| **许可** | MIT（开源） | MIT（开源） | 【未核实】（专有，按营收分档） |

**矩阵里最刺眼的一格**：Stride 的资产打包（MMO 内容管线的命脉）**两个官方页面都自己标了 "This section is out of date"**，且创建 bundle "目前需要手工编辑 `sdpkg`"，文档里**只有 `LoadBundle`、没有对应的卸载 API** **【一手】**。这既是风险，也是 E2 实验要验证的对象。

---

## 3. 重排：你的架构真正该用客户端引擎比什么

主文档把引擎的本质重新定义为"世界真相的权威持有者"（[§1.3](ai-native-game-engine.md#L63)），并且明确 M1/M2 **一行 AI 代码都不该有**（[§7](ai-native-game-engine.md#L938)）。既然权威内核要独立实现，客户端引擎的评估判据就应换成下面五条：

| 新判据 | 为什么它比"有没有网络"更重要 |
|---|---|
| **N1 能否被外部权威状态驱动** | 内核是唯一写者。客户端引擎必须能接受一个外部状态流（快照 + 增量）并把它映射到表现，而不是自己拥有模拟真相 |
| **N2 能否**可重现地**回放一帧** | 黄金回放（[§5.5](ai-native-game-engine.md#L834)）要求确定性重放；引擎若不支持固定步进/单帧步进，就必须自建录制层 |
| **N3 烘焙产物能否按分区打包发布** | §5.4"烘焙优先"意味着内容以"种子 + 缓存"形式随包发布；引擎的资产打包粒度直接决定补丁粒度与赛季内容成本 |
| **N4 渲染管线可扩展性** | L3 要挂神经后处理/升采样（[§4.5](ai-native-game-engine.md#L690)），需要能插入自定义 pass 与 compute |
| **N5 许可与长期可得性** | 5–10 年项目周期，许可变更与项目停摆是真实风险 |

按这五条重新看：

- **N1/N2 上三者都弱**，但**弱的方式不同**：Stride 的脚本更新顺序不确定且散落在编辑器数据里；Godot/Unity 有固定物理 tick 但游戏逻辑默认可变 dt。→ 都需要自建"外部状态驱动 + 单帧步进"的适配层。
- **N3 上 Stride 的风险最高**（文档自标过时 + 手工编辑打包配置 + 无卸载 API）；Unity 的 Addressables 最成熟；Godot 的 PCK/资源系统最简单但也没分区概念。
- **N4 上 Stride 反而最强**（一等公民的 render feature + 4.3 已支持 Vulkan compute），Unity 的 SRP 同样强，Godot 需要深入 RD 层。
- **N5**：三个里只有 Stride 与 Godot 是 MIT。

**一个必须写下来的反向事实**：Stride 官方文档明说"**目前不并行化游戏更新与脚本，它们会被阻塞到 prepare 与 draw 阶段结束**" **【一手】**。这意味着在 Stride 里做"渲染线程与推理线程重叠"的 L3 设计是逆着引擎结构走的。

---

## 4. 三条可选路径

| 路径 | 客户端 | 权威内核 | 主要优点 | 主要风险 |
|---|---|---|---|---|
| **A. 纯 Stride** | Stride 4.3 | Stride（`Null` 后端）或自研 | 一门语言、渲染可扩展性最好、MIT | 资产管线文档过时、无网络无大世界、编辑器仅 Windows、`Null` 后端未验证 |
| **B. Godot 客户端** | Godot 4.x | 自研（Scala/Go/Rust） | 无头导出成熟、轻量、MIT、迭代快 | 3D 渲染与大世界能力最弱；GDExtension 才能碰底层 |
| **C. Unity 客户端** | Unity 6 | 自研 | 生态最全（Terrain / Addressables / Behavior / AI Navigation）、专用服务器目标成熟 | 许可风险、工程重量、与"轻量自研内核"的哲学冲突 |
| **D. Unity 全家桶（DOTS 内核）** | Unity 6 | **Unity DOTS Physics** | **唯一有官方确定性声明、且明确面向网络 rollback/forward 的物理系统** | 把权威内核**重新绑回引擎**；Entities 官方仍只称"basic set of systems"；NGO 仍标 pre-release；专有许可 |

四条路的**共同点**比差异更重要：**网络（G1）在四条路里都要自己写**——因为没有任何一家提供"权威服务器 + 分区 + 兴趣管理 + 断线重连 + 反作弊"的整套方案；Unity 的 Relay/Lobby 只解决"连得上"，不解决"MMO 的世界模型"。

路径 D 是唯一在**确定性**这一格上有官方背书的选择，因此它打破了"引擎选型只决定 L3/L4 成本"这句话——**它把 L0 也一起决定了**，代价是绑回引擎。这正是它必须被当作一个正式对照方案、而不是被排除的原因。

---

## 5. 建议

1. **不要把引擎选型当成 MMORPG 的主决策。** 主决策是"权威内核用什么技术栈"，而它已经被 §3.3 的确定性要求与 M1 的定义锁定了（独立于引擎）。
2. **按 N4 与 N3 选客户端引擎**：如果要挂神经后处理且团队是 C#，Stride 的扩展性最强但资产管线风险最高；如果内容规模巨大且能承担许可成本，Unity 的 Addressables/Terrain 省下的工程量是实打实的；如果追求轻量与完全可控，Godot + 自研渲染扩展。
3. **在做这个决策之前，先跑 `mmorpg-verification-plan.md` 的 E1 与 E2。** E1 决定"能否服务端复用客户端逻辑"，E2 决定"无缝世界是否成立"。**这两个答案会直接改写上表**——所以现在不该把矩阵当成结论，它只是一张问题清单。
4. **把路径 D（Unity DOTS 内核）作为正式对照方案评估，而不是默认排除。** 它是三者中唯一对确定性给出官方承诺的路线；如果 §3.3 的确定性确实是地基，那么"绑回引擎 + 专有许可"这个代价就必须被**明确计价**，而不是被忽略。
5. **本文档的社区实践层证据为零**（`github.com` 抓取失败）。以上全部是"官方文档说了什么"，**不是"生产环境中是否可行"**。在做最终决策前，人工补一遍社区案例。

---

## 6. 更正记录

**更正 1（重要）：Godot 没有 "Linux Server" 导出模板。**

在本仓库的前序对话中，我曾根据记忆描述 Godot 的服务器端打包为"4.0–4.2 用独立的 Linux Server 模板，4.3+ 增加 Dedicated Server 选项"。**本次核实推翻了它**：

- Godot 官方文档（stable 分支）说明：**任何二进制都可以 `--headless` 运行**，服务端通过**导出模式 "Export as dedicated server" + 特性标签 `dedicated_server`** 产出，**4.0 起不再需要专用服务端二进制**；
- Linux 导出只需选架构，**不存在 "Linux Server" 预设**。

【一手：[exporting_for_dedicated_servers](https://docs.godotengine.org/en/stable/_sources/tutorials/export/exporting_for_dedicated_servers.rst.txt)、[exporting_for_linux](https://docs.godotengine.org/en/stable/_sources/tutorials/export/exporting_for_linux.rst.txt)】

教训与主文档附录 B 一致：**凭记忆的版本细节会错，必须回原文。**

---

## 7. C# 约束下的候选集（开源 + C#）

### 7.1 字面满足"开源 + 完整 3D 引擎 + C# 为主语言"的，只有两个

| 引擎 | 许可 | C# 地位 | 对 MMORPG 的关键事实 |
|---|---|---|---|
| **Stride 4.3** | MIT | **第一语言**（引擎本身即 C#/.NET 10） | 无网络、无大世界（§2）；资产管线文档官方自标过时；**4.3 已集成 Bepu**（纯 C# 物理）**【一手】** |
| **Godot 4.x (.NET)** | MIT | 官方支持，但非唯一 | **C# 项目无法导出 Web**；Android/iOS 自 4.2 起支持但**官方称 experimental 且有限制**；**热重载不保存/恢复状态**（exported 变量除外）；`GodotObject` 属性访问走 native interop（**必须缓存到局部变量**，否则每帧多次跨边界调用）；`string`/`NodePath`/`StringName` 有 marshalling 成本 **【全部一手】** |

### 7.2 三类容易误认的

| 类别 | 例子 | 为什么不能算 |
|---|---|---|
| **源码可见但不是 OSI 开源** | Flax、CryEngine、Evergine（原 Wave Engine）、NeoAxis | 许可证受限（商用条款/分成/非 OSI）。**本轮未核实其条款细节，使用前必须自己读许可** |
| **是框架不是引擎** | MonoGame、FNA、Silk.NET、raylib-cs、Murder(ECS) | 渲染、资源管线、编辑器全部要自己造 —— 等价于自研引擎，只是复用了底层 |
| **C# 绑定已废弃或非官方** | Urho3D（UrhoSharp 已停）、O3DE（官方为 C++/Lua/Python，**无 C#**）、Fyrox（Rust 为主，C# 实验性） | 不能作为 5–10 年项目的地基 |

### 7.3 C# 的真正优势不在引擎，在服务端

因为你的架构要求 **L0 独立于引擎**（§0 第 4 条），所以"C# 要求"的实际价值落在服务端：

| 需求（对应主文档） | C# 生态 |
|---|---|
| **每实体单写者**（[§5.1](ai-native-game-engine.md#L779) "内核是唯一写者"） | **Microsoft Orleans 的 grain（虚拟 actor）**：官方描述为"永远存在、永远可寻址"，由运行时负责激活/停用与放置 —— 同一 key 在任一时刻只有一个激活实例，**这正是"单写者"的分布式实现** **【一手】** |
| **持久世界与溯源账本**（[§5.7](ai-native-game-engine.md#L859)） | Orleans grain persistence + streams（可检查点/回滚）+ reminders（持久定时器）**【一手】** |
| **弹性伸缩与容错** | Orleans **10.0**（面向 .NET 8/9/10；新增 Dashboard、稳定 Redis providers、CancellationToken 支持）。官方文档把 **Gaming 列为头号典型用途**，并写明自身用于 **Halo / Gears of War / Xbox / PlayFab** **【一手】** |
| 轻量 actor 替代方案 | **Akka.NET**（.NET 版 Akka） |
| **物理（可选）** | **BepuPhysics v2**：纯 C#、面向 .NET 8、MIT；**Stride 4.3 已集成它**。其"确定性"表述**本轮未核实**（官方 FAQ 页 404） |
| 传输与协议 | LiteNetLib / ENet-CSharp（可靠 UDP）、gRPC、MessagePack / MemoryPack |
| **L0 与 L3 共享本体类型** | **同一种语言 ⇒ [§4.3](ai-native-game-engine.md#L636) 的本体类型可以只有一份**（对生成器/校验器/协议/持久化是同一份定义）。这一点比"选哪个引擎"更重要 |

> **关键推论**：C# 约束下，最优组合大概率不是"找到一个能扛 MMORPG 的 C# 引擎"——**那样的引擎不存在**——
> 而是 **Stride 或 Godot(.NET) 做 L3/L4 ＋ Orleans 做 L0/L1/L6 ＋ Bepu 做服务端物理**，进程/服务之间用 MessagePack 或 protobuf 通信。
> 这恰好复用了前几轮已经确立的结论：**权威内核不要建在游戏引擎里。**

### 7.4 建议的评估顺序

1. **先定服务端栈**：确认 Orleans 的 grain 语义能否对上 §5.1 的"唯一写者 + 提交日志 + 回滚"。这是唯一长期决定成败、且无法靠换引擎补救的部分。
2. **再在 Stride 与 Godot(.NET) 之间选 L3**：要渲染可扩展性（挂神经后处理，见 §3 的 N4）选 Stride；要全平台编辑器、成熟无头导出、轻量选 Godot，代价是 C# 无 Web 导出、移动端 experimental、interop 与热重载限制。
3. **无论选谁，先跑 E1/E2**：见配套的 `mmorpg-verification-plan.md`。

---

## 8. 若服务端用 abelkhan：Stride 还是 Godot(.NET)

> ⚠️ **本节是条件命题。** 它的前提（客户端 .NET 引擎 + 服务端 abelkhan）在 [`server-engine-stack.md`](server-engine-stack.md) 里已被改为"Cocos(TS) + Go gate + TS `core`"。§8.1/§8.2 的核实结论仍被新文档引用；§8.3 的引擎判定只在"决定复用 abelkhan 服务端"时才生效——而那意味着 TS 逻辑层整段作废。

### 8.1 abelkhan 是什么（先核实，不凭记忆）

上一轮我把仓库猜成 `abelkhan/abelkhan`，**是错的**。经 GitHub API 核实（`github.com` HTML 页在本环境抓不到，但 `api.github.com` 与 `raw.githubusercontent.com` 可用）：

| 项 | 事实 | 等级 |
|---|---|---|
| 仓库 | **`qianqians/abelkhan`**，134★ / 41 fork | 【一手】 |
| 语言 | **C# 占 99%**（619,198 字节；其余仅 Batchfile/Dockerfile/Shell） | 【一手】 |
| 许可 | **LGPL-2.1** | 【一手】 |
| 活跃度 | created 2016-06-28，**最后一次 push 2026-09-16** | 【一手】 |
| README 自述 | 轻量级游戏服务器框架，C# 开发，**MongoDB** 存储，基于 **consul** 服务发现，**protobuf** 序列化，**dbproxy + gate 网关 + hub 微服务**架构 | 【一手】 |
| 结构 | `core/`（RPC/网络）、`engine/`（`WRpc.cs`、`Result.cs`）、`gate/`、`hub/`、`proto/`、`client/csharp/`、`dependences/{linux,windows}/`＝**consul + redis** | 【一手】 |
| **客户端绑定** | **只有 C#**：`client/csharp/Client.cs`(81 KB) + `Common.cs`(51 KB)，无引擎专用文件 | 【一手】 |
| 协议层 | `proto/` 下共 **16 个文件**：框架面 `common`/`client`/`gate_client`/`hub_gate`/`gate_hub`/`hub_hub`，业务面 `bag`/`mail`/`shop`/`leaderboard`/`friend`/`chat`/`guild`/`quest`，加 `codegen.bat`/`codegen.sh`（**只有 `--csharp_out`，无任何 rpc 插件**）。线上协议本体是 `common.proto` 的 `Msg{oneof Request/Response/Notify/HeartBeats}` + `CallRpc{string proto_name, bytes content}`；**全仓没有 `service` 定义** | 【一手：2026-11 抓取原文】 |
| **传输层** | **只有 TCP 与 WebSocket**：`core/` 下是 `TcpNetwork`/`TcpAcceptService`/`TcpConnectService`、`WebSocketNetwork`/`WebSocketAcceptService`/`WebSocketConnectService`。**没有 UDP / KCP / ENet** | 【一手（否定性）】 |
| 未核实 | `core.csproj` 的目标框架；`Client.cs` 内部是否依赖 AOT 不友好的反射；是否有 UDP 路线图；生产案例（社区证据为零） | 【未核实】 |
| 不一致 | README 写"支持 C# 和 **TypeScript** 前端"，但仓库 `client/` 下**只有 csharp** | 【一手】 |

### 8.2 对"即时战斗"最重要的一条：传输是 TCP / WebSocket

- **TCP 有队头阻塞**：丢一个包，后面所有战斗消息一起等重传。即时战斗（位移/技能/命中判定）对这条最敏感。
- abelkhan 本身**不提供** tick、状态复制、兴趣管理、客户端预测、回滚 —— 它是 RPC 与微服务框架，**不是 netcode 框架**。
- 结论：**"即时战斗的延迟问题与选哪个客户端引擎无关"**，它由传输层决定。要么接受 TCP（20–30Hz 状态同步、同屏实体数受限，国内不少 MMO 就这么做），要么**在 abelkhan 之外加一条 UDP/KCP 通道**专门跑战斗。
- ⚠️ **许可陷阱**：如果你为了加 UDP 而**修改 abelkhan 的 core**，那就是修改 LGPL-2.1 库 —— 对库本身的修改需要按 LGPL 公开。**外挂一条独立通道（不改 abelkhan）在合规上干净得多。**（本条是工程+许可推断，非法律意见。）

### 8.3 Stride vs Godot(.NET)：判定

**先说共同点**：abelkhan 客户端是纯 C# 源码，两个引擎都是 .NET，**都能直接用**（拖入两个 .cs 或作为项目引用）。所以"能不能接上"**不是**区分点。真正要看的只有四条：

| 判据 | Stride 4.3 | Godot(.NET) | 谁赢 |
|---|---|---|---|
| **每帧属性访问的跨语言税** | 纯托管，无 interop 边界 | **官方文档明确警告**：`GodotObject` 属性访问走 native interop，须缓存到局部变量；`string`/`NodePath`/`StringName` 有 marshalling 成本 | **Stride** |
| **固定 tick** | 无游戏级固定 tick（`SyncScript.Update()` 为可变 dt） | **内建** `_physics_process` + `physics_ticks_per_second` | **Godot** |
| **无头运行（战斗 bot / 压测 / 黄金回放）** | 有 `Null` 后端但**能力未验证**（配套文档的 E1） | **成熟**：`--headless` + 专用服务器导出 | **Godot** |
| **改动渲染管线（L3 神经后处理）** | **强**：graphics compositor / `ISceneRenderer` / RenderFeature 四阶段 / 4.3 Vulkan compute | 需下探 `RenderingDevice` 层 | **Stride** |
| 共享服务端物理（Bepu） | 4.3 **已集成 Bepu**（与纯 C# 服务端可共享） | 用 Godot 自带物理，无法与服务端共享 | **Stride** |

**判定规则只有一条**：

> **客户端要不要把"战斗实体模型"建在引擎对象上？**

- **若建在引擎对象上**（实体=Node/Entity，每帧改节点属性）→ 选 **Stride**。Godot 的 interop 税会在同屏几百个实时实体时变成硬成本。
- **若战斗实体模型放在纯 C# 数据结构里，引擎节点只做视图**（每帧只把可见实体的变换写回节点）→ 选 **Godot(.NET)**。此时 Godot 最大的客户端弱点被**架构本身**规避，而它的固定 tick、成熟无头、跨平台编辑器、迭代速度全部变成净收益。

**对你这个项目的具体建议**：主文档 §4.2 已经规定 **L0 内核独立于引擎、内核是唯一写者**（[§4.2](ai-native-game-engine.md#L624)、[§5.1](ai-native-game-engine.md#L779)）。也就是说，"纯 C# 数据 + 引擎只做视图"**本来就是你的架构** —— 那么第二条判定成立，**默认选 Godot(.NET)**；只有当你要把神经后处理深度插进渲染管线（§4.5 的 L3）或要让服务端与客户端共享 Bepu 物理时，才转向 Stride。

### 8.4 两个必须避免的坑

1. **绝对不要用 Godot 的 `MultiplayerAPI`/`MultiplayerSynchronizer`**。权威属于 abelkhan，两套同步机制会互相打架。Godot 这边只用**裸套接字**（`System.Net.Sockets`，因为它是 .NET）或 `StreamPeerTCP` 承载 abelkhan 协议。
2. **别把战斗逻辑写进 Godot 的 `_physics_process`**，除非你确认它与你服务端的 tick 完全对齐 —— 否则客户端预测与服务器校正会持续打架。固定 tick 只用来做**表现层插值**，不是权威。

### 8.5 若 abelkhan 加入 QUIC：需要修订的三条

**先做核实。** 我查了三条第一方路径，**都没有找到"加入 QUIC"的公开记录**：

- 仓库 issues/PR 全量只有 **2 条**，且都是 2022–2023 年的 **dependabot 依赖升级 PR**（MongoDB.Driver、Newtonsoft.Json），已关闭 **【一手】**；
- README 未提 **【一手】**；
- **最新一次 push（2026-09-16）的 `core/` 里没有任何 `Quic*` 文件**，只有 `Tcp*` 与 `WebSocket*` **【一手】**。

> 因此把"加入 QUIC"当作**未公开的路线图**处理：方向可信，但**不要按未交付的能力做架构**。仓库仍在活跃 push，它可能落地；也可能只落在 fork 或私有分支里。

**修订 1：你不必等它——传输层已经抽象好了。**

`core/INetwork.cs` 全文只有 141 字节（经 GitHub blob API 取回并解码）：

```csharp
namespace core;

public interface INetwork
{
    Task Send(byte[] data);
    void OnReceive(Action<byte[]> onReceive);
    Task Close();
}
```

**三个方法。** 这意味着：

- 自己写一个 QUIC 版 `INetwork` 是**几十行**的事，不需要 fork 核心逻辑；
- **不必为加 UDP 而修改 abelkhan 的 core** —— §8.2 里那条"改 LGPL 核心要公开修改"的风险，因此大幅下降（新增一个实现文件通常属于"使用库"而非修改库；**这是工程判断，不是法律意见，上线前请法务确认**）。

**修订 2：.NET 的 QUIC 有三条硬约束（微软官方文档，全部【一手】）。**

| 约束 | 原文/事实 | 对游戏客户端的含义 |
|---|---|---|
| **Windows 版本** | 需要 **Windows 11 / Windows Server 2022 或更高**；"Earlier Windows versions are missing the cryptographic APIs required to support QUIC" | **Windows 10 客户端的 .NET QUIC 不可用**。中国区 MMO 的 Win10 占比很高 → **QUIC 只能当加速通道，不能当唯一通道** |
| Linux | 必须**手动安装 `libmsquic`**（.NET 7+ 需 2.2+；依赖 OpenSSL、libnuma1）；Windows 上 msquic.dll 随 .NET 运行时提供 | 服务器/容器镜像要显式装，别到压测时才发现 |
| macOS / 其他 | macOS 仅"**partial support**"（Homebrew）且**不在微软测试矩阵内**；其他平台需自行编译 MsQuic，"unforeseen problems might occur" | 别把 mac 客户端写进 QUIC 计划 |
| 网络可达性 | 微软自己写的："**QUIC traffic may be even blocked by some networking components.**" | 企业网/校园网/部分 ISP 会掐 UDP → **回退必须是一等公民** |

另外：`System.Net.Quic` 在 .NET 7/8 是 **preview**，**从 .NET 9 起才 stable**（Stride 4.3 = .NET 10，Godot 4.5 需 .NET 8+，都够用）。

**修订 3：QUIC 消除的是"流间"队头阻塞，不是"流内"——用不好就白加。**

- QUIC 的收益来自**多条独立流**。如果把战斗消息全塞进**同一个可靠流**，你等于又实现了一遍 TCP，收益归零。
- 要用好它，必须**按关注点拆流**：位移/技能、聊天、资源下载、登录/背包各自成流 —— 这样聊天丢包不会卡住位移。
- ⚠️ **最需要向作者确认的一点**：`System.Net.Quic` 只公开了 `QuicListener` / `QuicConnection` / `QuicStream` 三类，**文档中没有暴露 QUIC DATAGRAM（RFC 9221）的 API**。而 `INetwork` 的 `Send(byte[] data)` 也**不带可靠性标记**。也就是说：**"不可靠、无序"的战斗包在当前接口下表达不出来**，除非扩展接口（如加 `SendUnreliable`）并 P/Invoke MsQuic。**这是"QUIC 能否真正解决即时战斗"的分水岭问题，应当直接问维护者。**

### 8.6 对引擎选择的影响：零

QUIC 在 .NET 层，Stride 与 Godot(.NET) **用的是同一份 QUIC 实现**；Windows 10 跑不了 .NET QUIC 这件事，对两个引擎**同样成立**。所以 §8.3 的判定规则**不变**。

唯一新增的引擎相关考虑：Godot 的移动端 C# 本就是 experimental，而 QUIC 在 Android/iOS 上的支持**不在 .NET 的测试矩阵内** **【未核实】** → 若做移动端，QUIC 通道基本只能靠原生/第三方实现。

**行动建议（按顺序）：**

1. 把传输当**可替换件**：实现自己的 `INetwork`（TCP 版今天就能用），并预留 `SendUnreliable` 之类的扩展位。
2. **UDP 可达性探测做成运营能力**，不是优化项：`QuicConnection.IsSupported` 检测 + 握手失败静默回退 TCP。
3. 立刻可做的实测（半小时）：在**目标玩家机（Win10）、目标服务器发行版、目标容器镜像**上分别打印 `QuicConnection.IsSupported` 与 `QuicListener.IsSupported`。已列入配套文档的 **E4**。

---

## 附录 A：本轮抓取成功的 URL（一手证据来源）

Stride 官方文档：

- https://doc.stride3d.net/latest/en/manual/toc.html （完整手册目录，用于"否定性"判断）
- https://doc.stride3d.net/latest/en/manual/scripts/scheduling-and-priorities.html （脚本顺序不确定、优先级散落）
- https://doc.stride3d.net/latest/en/manual/engine/assets/asset-control.html （自标 out of date）
- https://doc.stride3d.net/latest/en/manual/engine/assets/asset-bundles.html （自标 out of date、手工编辑 sdpkg、无卸载 API）
- https://doc.stride3d.net/latest/en/manual/files-and-folders/building-the-game/build-file-structure.html （`data/` 目录存放 asset bundles → 补丁粒度）
- https://doc.stride3d.net/latest/en/manual/graphics/rendering-pipeline/render-features.html （四阶段；**不并行化游戏更新与渲染**）
- https://doc.stride3d.net/latest/en/manual/graphics/graphics-compositor/custom-scene-renderers.html （ISceneRenderer / DelegateSceneRenderer）
- https://doc.stride3d.net/latest/en/manual/platforms/index.html （平台列表：无 macOS、无主机；页面内容陈旧）
- https://doc.stride3d.net/latest/en/manual/graphics/graphics-api.html （`Null` / D3D11 / D3D12 / OpenGL / GLES / Vulkan；无 Metal）
- https://doc.stride3d.net/latest/en/manual/stride-for-godot-developers/index.html （实体 GC 回收、多根 prefab、WorldMatrix 更新时机）
- https://doc.stride3d.net/en/release-notes/4.3.html （.NET 10、Bepu、Vulkan compute、资产编译器跨平台、着色器排列编译卡顿）

Godot 官方文档（**均取自 Sphinx 原始页** `_sources/*.rst.txt`，因 HTML 页正文被导航栏挤掉；以下省略该前缀与 `.rst.txt` 后缀，实际 URL 形如 `https://docs.godotengine.org/en/stable/_sources/classes/class_engine.rst.txt`）：

- `tutorials/networking/high_level_multiplayer`、`classes/class_scenemultiplayer`、`classes/class_multiplayerspawner`、`classes/class_multiplayersynchronizer` （高层多人 API；无 rollback）
- `tutorials/networking/websocket`、`tutorials/networking/webrtc` （WebSocket / WebRTC 内建）
- `tutorials/export/exporting_for_dedicated_servers`、`tutorials/export/exporting_for_linux`、`tutorials/editor/command_line_tutorial` （`--headless`、dedicated server 导出模式、无 Linux Server 预设）
- `tutorials/3d/mesh_lod`、`tutorials/3d/occlusion_culling`、`tutorials/3d/visibility_ranges`、`tutorials/3d/index` （自动 LOD、遮挡剔除、HLOD）
- `tutorials/io/background_loading` （后台线程加载；无世界分区）
- `tutorials/physics/physics_introduction` （**官方：物理非确定性**）
- `tutorials/physics/large_world_coordinates` （`precision=double` 需自编译，客户端服务端须同一构建）
- `tutorials/navigation/index`、`tutorials/navigation/navigation_using_navigationmeshes` （寻路与运行时烘焙）
- `classes/class_engine`、`classes/index`、`about/list_of_features`、`tutorials/index` （固定 tick 参数；行为树等缺失的否定性证据）
- `tutorials/animation/creating_movies` （Movie Maker，非输入回放）
- https://godotengine.org/asset-library/api/asset?filter=behavior%20tree （第三方行为树插件 7 项）
- **404（作为否定性证据）**：`tutorials/3d/terrain`、`tutorials/3d/scene_streaming`、`classes/class_behaviortree`、`tutorials/networking/rollback_netcode`

Unity 官方文档（缩写 **M** = `https://docs.unity3d.com/6000.0/Documentation/Manual/`，**P** = `https://docs.unity3d.com/Packages/`）：

- `Mcom.unity.netcode.gameobjects.html`、`Pcom.unity.netcode.gameobjects@2.13/manual/index.html`、`Pcom.unity.netcode.gameobjects@2.13/manual/toc.html` （NGO 定位、pre-release 标记、无 prediction/rollback）
- `Mmultiplayer.html`、`Mcom.unity.multiplayer.center.html` （Multiplayer Center 为官方推荐入口）
- `Mdedicated-server.html`、`Mdedicated-server-build.html`、`Mdesktop-headless-mode.html`、`MEditorCommandLineArguments.html` （Dedicated Server build target、`UNITY_SERVER`、`-batchmode -nographics`）
- `Mcom.unity.services.relay.html`、`Mcom.unity.services.lobby.html` （Relay 1.2.0 / Lobby 1.3.0 released）
- `Mterrain-UsingTerrains.html` （内建 Terrain 与相邻 tiles）
- `Mcom.unity.addressables.html`、`Pcom.unity.addressables@2.10/manual/toc.html` （Addressables 2.10.3：Load scenes / Unload Addressable assets）
- `Mclass-LODGroup.html`、`MOcclusionCulling.html`、`MGPUInstancing.html` （LOD Group、遮挡剔除、GPU instancing）
- `Mcom.unity.entities.html` （Entities 1.5.0，定位"basic set of systems"）
- `Mcom.unity.behavior.html`、`Mcom.unity.ai.navigation.html`、`Mcom.unity.ml-agents.html` （Behavior 1.0.16、AI Navigation 2.0.15、ML-Agents 4.1.0）
- `Mclass-TimeManager.html`、`Mfixed-updates.html`、`Mexecution-order.html` （Fixed Timestep；低帧率补执行；GameObject 间执行顺序不可依赖）
- `Mcom.unity.physics.html`、`Pcom.unity.physics@1.5/manual/design.html` （**DOTS Physics：completely deterministic**）
- `Mcom.unity.recorder.html` （Recorder 5.1.7，仅采集，非确定性回放）
- **404（作为否定性证据）**：`dedicated-server-build-target.html`、`gpu-instancing.html`、`physics-overview.html`、`large-world-coordinates.html`、`world-space-coordinates.html`、`deterministic-simulation.html`

§7（C# 约束）新增来源：

- https://learn.microsoft.com/en-us/dotnet/orleans/overview （Orleans 10.0；虚拟 actor / grain / silo；Gaming 列为首要用途；Halo、Gears of War、Xbox、PlayFab）
- https://docs.godotengine.org/en/stable/_sources/tutorials/scripting/c_sharp/c_sharp_basics.rst.txt （**C# 无法导出 Web**；Android/iOS 自 4.2 起 experimental；热重载不保存状态；interop 与 marshalling 成本；Godot 4.5 需 .NET 8+，Android 导出需 .NET 9+）
- https://docs.bepuphysics.com/ （BepuPhysics 面向 .NET 8；`System.Numerics.Vectors`）——**其 FAQ 页 404，确定性表述未取得**

§8（abelkhan）新增来源（本环境 `github.com` HTML 页不可达，**但 `api.github.com` 与 `raw.githubusercontent.com` 可用**）：

- https://api.github.com/repos/qianqians/abelkhan （134★/41 fork、C#、LGPL-2.1、created 2016-06-28、**pushed 2026-09-16**）
- https://api.github.com/repos/qianqians/abelkhan/languages （C# 619198 / Batchfile / Dockerfile / Shell）
- https://api.github.com/repos/qianqians/abelkhan/contents/ （`abelkhan/`、`client/`、`dependences/`、`proto/`、`tools/`；根有 `package.json`）
- https://api.github.com/repos/qianqians/abelkhan/git/blobs/a6523ffc33e72e15c5d7c092b39e0e8050f9e6ce （README：MongoDB、consul、protobuf、dbproxy/gate/hub；**声称支持 TypeScript 前端**）
- https://api.github.com/repos/qianqians/abelkhan/git/trees/9361feb211ecc78f070050cd27c7976cca8f6d0a （`client/csharp`：仅 `Client.cs` 81 KB + `Common.cs` 51 KB）
- https://api.github.com/repos/qianqians/abelkhan/git/trees/f4aaf87b68b15c6ad8e080913ee01a271fc5c5fb （`core/`：**只有 Tcp\* 与 WebSocket\*，无 UDP/KCP**；另有 `MongoProxy.cs`、`RedisHandle.cs`、`TimerService.cs` 20 KB）
- https://api.github.com/repos/qianqians/abelkhan/git/trees/f6c1b7475ca2e2b9e994b0da993b101ea2abeb67 （`proto/`：protobuf 定义 + `codegen.bat`/`codegen.sh`）
- https://api.github.com/repos/qianqians/abelkhan/git/trees/d85f59ef3576d7fe6291e581c30dbaa81e731a98 （`dependences/windows`：**consul + redis**）
- https://api.github.com/repos/qianqians/abelkhan/git/trees/15778dc60495c340ae522d3a466657db11471ca3 （`engine/`：`WRpc.cs`、`Result.cs`）
- 相关 fork：`yinchunlong/abelkhan-1`（"分布式游戏服务器框架"）、`michaelchenqing/abelkhan_demo_mj`（棋牌 demo）、`isoundy000/abelkhan_client_il2cpp`（**IL2CPP 客户端**，暗示历史上面向 Unity AOT）

§8.5（QUIC）新增来源：

- https://api.github.com/repos/qianqians/abelkhan/issues?state=all&per_page=50 （**全量仅 2 条，均为 2022–2023 的 dependabot 依赖 PR** → "加入 QUIC"无公开记录）
- https://api.github.com/repos/qianqians/abelkhan/git/blobs/93cf36e583ebecb45145df12b6ed373d2ff84560 （**`core/INetwork.cs` 全文 141 字节**：`Task Send(byte[])` / `void OnReceive(Action<byte[]>)` / `Task Close()`）
- https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview （**Windows 11 / Server 2022+ 才支持**；Linux 需手动装 `libmsquic`；macOS 仅 partial support 且不在测试矩阵；"QUIC traffic may be even blocked by some networking components"；.NET 7/8 preview，**.NET 9 起 stable**；API 只有 `QuicListener`/`QuicConnection`/`QuicStream`，**未暴露 DATAGRAM**）

## 附录 B：未核实清单（明确留空，不填充）

1. **社区/工程实践层证据：零。** `github.com` 全站抓取失败，因此"别人真的用 Stride / Godot / Unity 做过 MMO 或无缝大世界吗、结果如何"这一整层**完全空白**。本评估只覆盖"官方文档说了什么"。
2. **三个引擎是否存在"被外部权威状态驱动 + 单帧步进"的既有实践或社区方案** —— 同上，零一手材料。
3. **Stride 是否有 LOD / 遮挡剔除 / 地形 / 行为树的 API（只是没写手册）** —— 手册缺失只能证明"没有文档"，不能证明"没有实现"。
4. **Stride 的 `Null` 图形后端能否真正承载权威模拟** —— 文档只说明它是合法取值，未说明能力边界（这正是 `mmorpg-verification-plan.md` 的 E1）。
5. **Godot 的 `precision=double` 构建在导出模板层面的完整限制** —— 只核实到"需重编译全部模板且客户端服务端须同一构建"，未核实其对物理、导航、网络协议的具体影响。
6. **Unity 的大世界/双精度坐标能力** —— `large-world-coordinates.html` 与 `world-space-coordinates.html` 在 6000.0 / 6000.3 均 404。
7. **Unity 是否存在内建 Terrain streaming** —— 只找到"可建相邻 Terrain tiles"，未找到流式加载官方页。
8. **Unity SRP / RenderGraph 的可扩展性细节（N4 判据）** —— 本轮未抓该页，只证实 URP/HDRP 存在 GPU occlusion culling。
9. **各引擎的许可条款细节（尤其 Unity 的分档与营收门槛）** —— 本轮未核实。
