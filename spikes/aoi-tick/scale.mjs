// S1 的第二步：把 bench.mjs 的"每 tick 毫秒"折算成"要几台机器"
//
// ⚠️ 这里的每一个数字都分成两类，别混着读：
//   [实测]  = bench.mjs 在同一台机器上跑出来的（本文件的 MEASURED 表，可直接替换）
//   [假设]  = 业务参数，改它就是改结论。全部集中在 ASSUME 里，一行一行能看清
//
// 运行：node scale.mjs

// ---------- [实测] 来自 `node bench.mjs`（i5-14400F / Node 18.20.8 / 200 tick 中位数） ----------
const MEASURED = [
  // 实体数/场景, 中位 tick(ms), P95(ms)
  { N: 400, medianMs: 0.17, p95Ms: 0.19 },
  { N: 1000, medianMs: 0.45, p95Ms: 0.50 },
  { N: 5000, medianMs: 2.45, p95Ms: 2.75 },
  { N: 10000, medianMs: 5.21, p95Ms: 5.62 },
  { N: 30000, medianMs: 15.77, p95Ms: 16.89 },
];

// ---------- [假设] 业务参数 ----------
const ASSUME = {
  dau: 20000,                 // 总 DAU（用户给定）
  peakRatio: 0.20,            // 峰值同时在线占 DAU 的比例 —— 说明性假设
  playersPerScene: 80,        // 单场景玩家上限
  monstersPerPlayer: 4,       // NPC/怪物 : 玩家 的比例 —— 说明性假设
  combatShare: 0.30,          // 处于战斗（20Hz）的场景占比
  tickIdleHz: 10,             // 非战斗场景 tick 频率
  tickCombatHz: 20,           // 战斗场景 tick 频率
  coreBudget: 0.50,           // 逻辑层允许占用单核的比例（余下留给 RPC/GC/DB/syscall/突发）
  unmodeledFactor: 3.0,       // 本 spike 未建模的工作（战斗判定/技能/buff/AI/寻路/RPC 派发）的乐观倍数
};

const fmt = (x, d = 1) => x.toFixed(d);

function msPerSecondPerScene(ms, hz) { return ms * hz; }   // ms/tick × tick/s = ms/s

function report() {
  const ccu = ASSUME.dau * ASSUME.peakRatio;
  const scenes = Math.ceil(ccu / ASSUME.playersPerScene);
  const entitiesPerScene = Math.round(ASSUME.playersPerScene * (1 + ASSUME.monstersPerPlayer));
  const m = MEASURED.find((x) => x.N >= entitiesPerScene) ?? MEASURED[MEASURED.length - 1];

  console.log('===== 假设（改这里就是改结论）=====');
  console.log(`DAU ${ASSUME.dau} × 峰值在线 ${(ASSUME.peakRatio * 100).toFixed(0)}% ⇒ 峰值 CCU ${ccu}`);
  console.log(`单场景 ${ASSUME.playersPerScene} 玩家 × (1 + ${ASSUME.monstersPerPlayer} 倍怪物) ⇒ ${entitiesPerScene} 实体/场景`);
  console.log(`场景数 = ${ccu} / ${ASSUME.playersPerScene} = ${scenes}；其中 ${(ASSUME.combatShare * 100).toFixed(0)}% 战斗(${ASSUME.tickCombatHz}Hz)、其余 ${ASSUME.tickIdleHz}Hz`);
  console.log(`单核预算上限 ${(ASSUME.coreBudget * 100).toFixed(0)}%；未建模工作倍数 ${ASSUME.unmodeledFactor}×\n`);

  console.log(`===== 取实测点：${m.N} 实体/场景（中位 ${m.medianMs} ms，P95 ${m.p95Ms} ms/tick）=====\n`);

  const combatScenes = Math.round(scenes * ASSUME.combatShare);
  const idleScenes = scenes - combatScenes;
  const perSceneCombat = msPerSecondPerScene(m.medianMs, ASSUME.tickCombatHz);
  const perSceneIdle = msPerSecondPerScene(m.medianMs, ASSUME.tickIdleHz);
  const logicMsPerSec = combatScenes * perSceneCombat + idleScenes * perSceneIdle;
  const withUnmodeled = logicMsPerSec * ASSUME.unmodeledFactor;
  const coresRaw = logicMsPerSec / (1000 * ASSUME.coreBudget);
  const coresWithUnmodeled = withUnmodeled / (1000 * ASSUME.coreBudget);

  console.log(`战斗场景 ${combatScenes} × ${fmt(perSceneCombat)} ms/s   = ${fmt(combatScenes * perSceneCombat)} ms/s`);
  console.log(`非战斗   ${idleScenes} × ${fmt(perSceneIdle)} ms/s   = ${fmt(idleScenes * perSceneIdle)} ms/s`);
  console.log(`合计逻辑 CPU ${fmt(logicMsPerSec)} ms/s = ${fmt(logicMsPerSec / 10)}% 单核`);
  console.log(`× 未建模倍数 ${ASSUME.unmodeledFactor} ⇒ ${fmt(withUnmodeled / 10)}% 单核 ⇒ 按 ${(ASSUME.coreBudget * 100).toFixed(0)}% 预算需 ${fmt(coresWithUnmodeled, 2)} 核`);
  console.log(`（不加未建模倍数：${fmt(coresRaw, 2)} 核）\n`);

  console.log('===== 对照：极端情形 =====');
  // A. 全区全服：所有人在一个 3 万实体的大场景里
  const mega = MEASURED.find((x) => x.N === 30000);
  console.log(`A. 3 万实体单一大场景 @${ASSUME.tickCombatHz}Hz：${fmt(mega.medianMs * ASSUME.tickCombatHz / 10)}% 单核（P95 ${mega.p95Ms} ms / 50 ms 预算 = ${fmt(mega.p95Ms / 50 * 100)}%）`);
  // B. 场景数按"每场景 20 人"拆（小场景多开）
  const scenes20 = Math.ceil(ccu / 20);
  const ms20 = MEASURED[0].medianMs * scenes20 * ASSUME.tickIdleHz;
  console.log(`B. 每场景 20 人 ⇒ ${scenes20} 场景（实体仍按 ${MEASURED[0].N} 算）：${fmt(ms20 / 10)}% 单核`);
  // C. 1000 场景（等于放大 20 倍人数）
  console.log(`C. 若 CCU 涨到 8 万（${scenes * 20} 场景）：逻辑层 ${fmt(coresWithUnmodeled * 20, 1)} 核 —— 仍然小于 gate 侧 8 万长连接的压力`);

  console.log('\n===== 这个折算里没算的东西（真实 tick 会更大）=====');
  console.log('· 战斗判定/技能/buff/掉落（本 spike 只做状态同步骨架）');
  console.log('· NPC 的 AI：行为树/状态机/寻路（数量是本表的怪物数，代价通常是 AOI 的数倍）');
  console.log('· RPC 反序列化与派发（S2 测的那一半，但 S2 不含业务分发）');
  console.log('· DB 回调、跨服消息、GC（本 tick 零分配，真实代码不一定）');
  console.log('· 网络发送本身（gate 侧）与带宽');
  console.log(`\n所以结论只能这样用：**逻辑层的骨架成本在 ${m.N} 实体/场景时是 ${m.medianMs} ms/tick**，`);
  console.log(`即使把上面五条按 ${ASSUME.unmodeledFactor}× 计，2w DAU 仍只需 ${fmt(coresWithUnmodeled, 2)} 核的打点。机器数由 gate 与 DB 决定，不由逻辑层决定。`);
}

report();
