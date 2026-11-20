# meter

一个关于 **"基于 AI 的游戏引擎会是什么样子"** 的设计研究仓库。

## 这个仓库是什么

不是一个游戏，也不是一个引擎实现。它包含**七份文档**，外加一个 `spikes/` 实测目录——后者是全仓唯一的代码，只用来给文档里的判断提供可复现的数字：

1. **主设计文档**——对"基于 AI 的游戏引擎会是什么样子"的严肃回答，包含参考架构、硬约束的量化分析，以及一份"最小可行原型"的路线图。
2. **选型评估文档**——把主文档的架构主张落到具体引擎选择上，含证据分级与明确的"未核实"清单。
3. **验证协议文档**——把评估里无法靠文档回答的问题写成可执行的实验，**尚未执行**。
4. **嵌入方案文档**——把 agent 做成"引擎的第三个前端"的具体实现设计：反射生成工具、命令总线、事务与 undo group、无头三级验证、投影、权限。它是主文档 §4.6 的下半身，也是唯一给出"自研引擎里怎么落地"的一份。
5. **资产管线文档**——把 Rodin / Blender(ARP) / GenRA / MiniMax Music / LLM 这五类生成器接成一台"内容编译器"：四类资产四套契约、四条接缝的真实成本、五个子系统（契约 / DAG / 验证 / 缓存 / 账本）、三个尖峰实验。**它先纠正了三个范畴错误**：GenRA 是研究框架不是产品、Music 2.6 是音乐模型不是音效模型、Rodin 自己已经能绑定。
6. **协议分工文档**——把 §8.2 的结论落到"哪条消息走哪个格式"：三档判据、链路与消息族清单、**8 字节帧头**（`flags | len | ts`，只做纯传输分帧：压缩位 + 长度 + 发送时刻；路由靠 gate 会话表、类型靠 RPC 信封的 `method`、配对靠 `req_id`）、压缩策略、P0–P4 分阶段与 15 条帧头验收测试。
7. **服务器技术栈文档**——把一个"通用服务器引擎"的需求史（V1 选 C# → V3 帧同步作废 → V4 Cocos 为一等目标 → 定稿）与最终选型写定：**gate/dbproxy 用 Go、逻辑层用 TS `core`、热路径按 profile 下沉 Cython**。它是本仓库**第一份带实测的文档**：地板与天花板、TS 优化手法的收益排序、工具链断言（`package.json#imports`；`erasableSyntaxOnly` 已被主动放弃，理由见 `protocol-map.md` §4.6.1），以及一条能进 CI 的 RPC 类型断言。

## 核心文档

- **[`docs/ai-native-game-engine.md`](docs/ai-native-game-engine.md)** — 主文档 · 基线日期 2026-09-16
- **[`docs/embedded-game-agent.md`](docs/embedded-game-agent.md)** — 嵌入方案：为什么外挂 MCP 有天花板（工具数 14→208，只有极少数接了撤销栈与无头验证）；"像 Godot"可复制的四条机械属性（可内省 / 文本化 / 事务化 / 无头）；E0–E4 嵌入度分级；五层架构（反射 · 命令 · 事务 · 验证 · 会话）与三个关键数字（58 工具 ≈ 55K tokens、>10 工具即应检索、25K 响应上限）；附录 C 是一次含两次拒绝的完整走查
- **[`docs/ai-content-pipeline.md`](docs/ai-content-pipeline.md)** — 资产管线：Rodin Gen-2.5（含 2026-10 的 Rigging API，可直接出 UE5/Unity 绑定）、ARP 3.79.20（无头只能做重定向与导出，自动绑定无公开成功案例）、GenRA（USD 进 USD 出、不重定向、无 loop）、Music 2.6（5 分钟立体声、无音效/loop/分轨，且新用户已停开）；四条接缝、五个子系统、S1–S5 尖峰实验、经济性公式（分母是一次通过率）
- **[`docs/mmorpg-engine-choice.md`](docs/mmorpg-engine-choice.md)** — Stride / Godot / Unity 在四个 MMORPG 硬缺口（网络、无缝大世界、AI、确定性）上的对照；§7「C# 约束下的候选集」（开源 + C# 的引擎只有 Stride 与 Godot，真正的 C# 优势在 Orleans 服务端）；§8「若服务端用 abelkhan」（abelkhan 经 API 核实：纯 C#、LGPL-2.1、gate+hub+protobuf，**传输只有 TCP/WebSocket**；以及由此得出的引擎判定）。全部事实标注【一手】/【否定性】/【未核实】
- **[`docs/mmorpg-verification-plan.md`](docs/mmorpg-verification-plan.md)** — 四个必须先跑的验证实验（Stride `Null` 无头后端 / 资产分区加载与卸载 / 实体 churn 的 GC 代价 / QUIC-UDP 可达性与支持矩阵），含通过判据与"结果如何改写架构决策"
- **[`docs/protocol-map.md`](docs/protocol-map.md)** — 协议分工（**v4**）：全部走 protobuf，热路径用 **SoA 布局**换速度而不是换格式（585 → 176 ns/实体；FB 剩下的优势只有 4 µs/帧 = 0.03% 帧预算）；压缩实测（zstd 后 FB 比 pb SoA 只差 **5%**，brotli 压缩率更好但 30 KB 要 **43 ms**，不可用）；**8 字节帧头**（`flags u8 + len u24 + ts u32`，语义全在 RPC `Envelope` 里；`ts` 是单调毫秒、逐跳覆盖、只做诊断）；P0–P4 路线与 15 条帧头验收测试；重新评估 FB 的量化触发
- **[`docs/server-engine-stack.md`](docs/server-engine-stack.md)** — 服务端技术栈：需求 V1→V6 的收敛史、分层与"每层禁止做什么"、三条 CI 硬规矩；§3 是本机实测（纯 Python 比 V8 慢**约 80×**、天花板三方重合；TS 侧 序列化 **130×** > 遍历/分配 **7×** > 调用点 **5.2×** > 布局 **3.55×**）；§4 TS 工程纪律（擦除≠转换、ESM 无真热更）；§6 把它与 `mmorpg-engine-choice.md` §8 的 abelkhan 结论对齐（**§8 的前提已被改写**）；§7 十条未核实、§8 五个 spike（S1/S2 已执行）+ §8.3「TS 侧用哪个 protobuf 库」

### 文档的三个中心论点

1. **"基于 AI 的游戏引擎"是三个不同的东西**，混为一谈是这个词最大的问题：
   - **AI 辅助引擎**（AI 在工具链里）——已在发货，价值有限但真实
   - **AI 增强引擎**（确定性内核 + 生成式外围）——**可工程化，是真正的答案**
   - **AI 即引擎**（世界模型就是引擎）——是**新媒介**，不是新引擎

2. **模型无状态，内核是唯一写者。** 引擎的本质不是"渲染器 + 物理"，而是**世界真相的权威持有者**。模型只能提议，内核负责校验、具现化、提交。本体层是想象力的类型系统。

3. **烘焙优先，在线为辅。** 所有人都会看到的内容在创作期批量生成、随包发布，边际成本为零；只有必须针对个体玩家响应的内容（对话、难度自适应、调度）才留在运行时——而那一层是文本量级的，是当前唯一算得过来账的层。

### 文档结构

| 章节 | 内容 |
|---|---|
| §1 | 问题的澄清：判断"真 AI 引擎"的单一标准（**拔电源测试**） |
| §2 | 现状切片：世界模型 / 商业引擎 / 运行时智能体 / 生产管线 |
| §3 | 硬约束：帧预算、单位经济学、确定性、状态漂移、意图保真度、法律 |
| §4 | 参考架构 L0–L6 |
| §5 | 关键机制：具现化协议、认知预算、降级阶梯、种子化生成、语义差分、沙箱动作空间 |
| §6 | 开发者的日常长什么样 |
| §7 | 最小可行原型：6 个月路线图 |
| §8 | 反方观点：为什么这件事可能不会发生 |
| §9 | 12 个开放问题 |
| §10 | 结论 |
| 附录 A | 术语表 |
| 附录 B | 研究方法与可信度声明 + 全部参考来源 |
| 附录 C | 数据级走查：一次完整的交互切片（含被拒绝的提议） |

## 关于证据

文档中的事实性陈述**分级标注**：一手核实（论文摘要页 / 官方文档）、二手索引、或明确标注"未核实"。

**请特别读附录 B 的"研究方法与可信度声明"**——本次调查在受限网络环境下完成（`web_search` 不可用、`cn.bing.com` 会静默地只用查询的第一个词元匹配、若干域名被屏蔽），因此关键论据全部改走 arXiv 与一手文档，无法核实的条目**故意留空而非凭记忆填充**。

文档中标注"说明性估算"的数字是基于已核实单价的**算术推演**，用于说明数量级关系，不是实测数据。

## 状态

设计提案（design proposal）。**代码只有四处**：`spikes/`（可复现的基准与探针）、`schema/`（框架协议 + codegen 校验）、`core/`（逻辑层运行时骨架：8 字节帧头 + RPC 三函数，10 条测试）、`gate/`（接入层 Go 骨架：帧头 + 会话表 + 分派，能起、能回包）。**还没有可用的服务端**——逻辑层转发、WebSocket、压缩都没接。

`docs/mmorpg-verification-plan.md` 中的三个实验**均未执行**——本次会话的 shell（pwsh）不可用（每次调用以 `0xC0000142` / DLL 初始化失败退出），因此没有编译、没有运行、没有测量。该文档是**待执行的协议**，不是实测报告。

选型评估文档的**社区实践层证据为零**（`github.com` 抓取失败）：它只反映**官方文档说了什么**，不反映**在生产环境中是否可行**。

`docs/embedded-game-agent.md` 同样是设计提案：**没有任何代码，也没有在真实引擎上验证过**。它的调研在 2026-11-18 于可联网环境下重做：Godot 机制逐条回到官方文档（附录 B.1 给 URL），工具数/事务/无头三项比较来自各项目自述，但**没有任何项目公布任务成功率**——所以本文只比较"可见属性"，不比较"效果"。§8.2 的投影效率与 §13 的全部目标值都是**说明性估算，不是实测**；附录 B.5 列出了全部未核实项。

`docs/ai-content-pipeline.md` 的调研同样在 2026-11-18 于可联网环境下完成，五个生成器各自回到官方文档（附录 B 给 URL）。它的关键限制是：**没有任何一条链路被真实跑通过**——尤其是 S1（glTF→USD→GenRA→USD→glTF 的骨架往返）直接决定美术链的形态，而它只需要 1–2 天就能验证。文中"一次通过率 30%"、"人工 15 分钟/资产"等全部是**说明性目标，不是实测**；附录 B.4 列了 10 条未核实项。

### 第一批工程产物：`schema/`（框架协议）

`schema/pb/*.proto` 是服务端框架面的协议——连接/会话/路由/投递/存储原语/节点迁移，**业务消息暂不生成**。
结构对标 abelkhan 的 `proto/`（`client.proto`/`common.proto`/`gate_client.proto`/`hub_gate.proto`/`hub_hub.proto`），
差别有两条写在该目录的 README 里：类型放 payload（不进帧头）、帧头与传输解耦。

```bash
cd schema && ./check.sh     # protoc + protoc-gen-go + protoc-gen-es，再跑 11 条结构断言
```

`.proto` 只描述消息（**没有 `service`**）：方法名由调用方给，类型绑定在业务侧的 `RpcMap`；`msg_type` 的权威定义是 `envelope.proto` 里的 `MsgType` enum。

### `core/`：逻辑层运行时骨架

`docs/protocol-map.md` 里定的两条硬规格已经落成代码，`npm test` 10 条全过：

- **8 字节帧头**（`flags:zstd | len:u24 | ts:u32`）：编解码、半包、未知 flag 抛错、`ts` 跨 32 位回绕与异常时钟 clamp
- **RPC 三函数**：`callEntity(method, reqBytes, RspSchema)` / `callGroup(method, reqBytes)` / `register(method, ReqSchema, RspSchema, handler)` —— 信封装配、`callback_id` 配对、超时、未知方法丢弃+计数

```bash
cd schema && ./check.sh    # codegen → core/src/gen/（已 gitignore）
cd ../core && npm install && npm test
```

### `gate/`：接入层骨架（Go）

```bash
cd schema && ./check.sh      # codegen → gate/internal/pb 与 core/src/gen
cd ../gate && go build ./... && go test ./... && go run ./cmd/gate -listen :9001
```

- **8 字节帧头**与 `core/src/frame.ts` **逐字节一致**（`golden_test.go` 里钉了黄金向量）
- **会话表**：`conn → (user, entity, node)` 与 `entity → conn` 双向；同实体被新连接绑走时返回旧会话由 gate 踢掉
- **两个监听端口**：对外 WebSocket（客户端）、对内 TCP（逻辑节点连入，首帧 `logic.hello`）
- **hub 路由**：上行包成 `ClientRequestHub/NotifyHub/ResponseHub`，下行把 `Hub*` / `GateForwardHub*` 译成客户端消息；组播按连接去重、广播遍历
- **consul**：服务注册（**注册对内 TCP 端口**，客户端端口放 meta）+ TTL 心跳 + 状态上报（`clients=… logic=… up=… down=…`）+ 退出注销；不引 SDK，`-consul` 留空则空实现
- 已冒烟（`gate/scripts/smoke.py`，零依赖）：两个端口 → 建会话 → 上行转发 → 逻辑层调客户端 → 踢人，六步全过

### 另一处例外：`spikes/`

`docs/server-engine-stack.md` 是本仓库第一份带实测的文档，它的数字全部出自 [`spikes/`](spikes/)——本仓库唯一的代码：

| 目录 | 断言 | 结果 |
|---|---|---|
| `spikes/ts-vs-python/` | 同一份积分循环，V8 / numpy / Cython 的地板与天花板 | 地板**约 80×**（69.6–71.5 vs 0.85–0.97 ns/实体·tick），天花板三方重合（0.72–0.97） |
| `spikes/ts-runtime/` | TS 优化手法的收益排序 | 序列化 **130×** > 遍历 **7×** ≈ 分配 **7×** > 调用点 **5.2×** > 布局 **3.55×** |
| `spikes/rpc-typing/` | "方法名决定请求/响应类型"是否真安全 | `tsc -p .` **exit 0**：正例通过 + 4 条 `@ts-expect-error` 全部触发 |
| `spikes/aoi-tick/` | 一个场景的完整 tick（积分 + 网格 AOI + 属性打包）与核数折算 | 400 实体/场景 **0.17 ms**（10Hz 占单核 0.2%）、1 万实体 **5.21 ms**；2w DAU 折算 **0.66 核**（含 3× 未建模倍数） |
| `spikes/ser-compare/` | 同一份 schema 的 flatbuffer vs protobuf（TS 与 Go 各一遍，AoS/SoA 两布局），外加 protobuf-es vs protobufjs | 字节 protobuf 小 **21–47%**；读 FlatBuffers 快 **21–33×**（Go AoS 5–8 ns vs 165 ns/实体）；protobuf-es 在 AoS 上**比 protobufjs 慢 1.5×**、在 packed 数组上快 2.7×；包体 gzip：FB **4.1 KB** / protobufjs 16.0 KB / protobuf-es 27.7 KB；三种实现字节流逐字节一致 |
| `spikes/ts-runtime/erasable-syntax/`、`imports-field/` | `erasableSyntaxOnly` 与 `package.json#imports` | 前者报 `TS1294`（就该失败）、后者在 Node 18 直接跑通 |

⚠️ **但这六条都只证明它们自己那一件事**：单线程、无网络 IO、无真实业务逻辑（战斗判定 / NPC AI 未建模）、无 GC 压力叠加。它们**不是**"一台机器能扛多少玩家"的证据。`spikes/aoi-tick/scale.mjs` 已经把 2w DAU 折算过一次核数（0.66 核），但那是**逻辑层骨架**的账，不含战斗判定、NPC AI、RPC 派发、DB 与网络（`docs/server-engine-stack.md` §8.1 列全了）。

下一阶段的建议见文档 §7（M1 与 M2 阶段**不应包含任何 AI 代码**）、嵌入方案 §12 的 P0/P1（**先只读、再用脚本机器人跑通，最后才接模型**）、资产管线 §10 的五个尖峰实验（**先跑 S1 与 S2，再决定要不要 ARP 与 GenRA**），以及服务器技术栈 §8 的五个 spike——其中 **S1 与 S2 已执行**（`spikes/aoi-tick/`、`spikes/ser-compare/`），剩下 S3（kernel 的 Linux 构建链）、S4（gate 的 10 万连接）、S5（滚动重启的用户感知）还没跑。
