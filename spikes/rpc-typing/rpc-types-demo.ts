// ============================================================
// 1) codegen 产物：协议消息（protobuf-es / protobuf-ts 生成的形态）
// ============================================================
interface PlayerGetInfoReq { readonly uid: bigint }
interface PlayerGetInfoRes { readonly uid: bigint; readonly name: string; readonly level: number }
interface MailClaimReq { readonly mailId: number }
interface MailClaimRes { readonly items: readonly { readonly id: number; readonly count: number }[] }
interface MoveReq { readonly x: number; readonly y: number }
interface MoveRes { readonly x: number; readonly y: number; readonly corr: boolean }
interface AggroReq { readonly target: bigint }
interface AggroRes { readonly ok: boolean }

// ============================================================
// 2) codegen 产物：方法表（一份 schema → 客户端/服务端同一份）
// ============================================================
interface RpcMap {
  "player.getInfo": [PlayerGetInfoReq, PlayerGetInfoRes];
  "mail.claim": [MailClaimReq, MailClaimRes];
  "player.move": [MoveReq, MoveRes];
}

// ============================================================
// 3) 一个函数：key 同时决定 req 与 res，调用处不写泛型
// ============================================================
declare function reqEntity<K extends keyof RpcMap>(
  method: K,
  req: RpcMap[K][0],
): Promise<RpcMap[K][1]>;

async function usage(): Promise<void> {
  const info = await reqEntity("player.getInfo", { uid: 1n });
  info.level.toFixed(2); // ✅ 推断为 PlayerGetInfoRes
  info.name.toUpperCase(); // ✅

  const r = await reqEntity("mail.claim", { mailId: 7 });
  r.items.map((i) => i.count); // ✅ 推断为 MailClaimRes

  const m = await reqEntity("player.move", { x: 1, y: 2 });
  if (m.corr) { /* 被服务器校正 */ }

  // ❌ 以下三行都会编译报错，见 bad.ts
  // reqEntity("player.getInfo", { mailId: 7 });
  // reqEntity("nope.method", {});
  // (await reqEntity("mail.claim", { mailId: 1 })).name;
}

// ============================================================
// 4) 类型层断言：证明推断结果就是 PlayerGetInfoRes
// ============================================================
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _T1 = Expect<Equal<Awaited<ReturnType<typeof reqEntity<"player.getInfo">>>, PlayerGetInfoRes>>;
type _T2 = Expect<Equal<Awaited<ReturnType<typeof reqEntity<"mail.claim">>>, MailClaimRes>>;
type _T3 = Expect<Equal<Parameters<typeof reqEntity<"mail.claim">>[1], MailClaimReq>>;

// ============================================================
// 5) 实体维度：Player 身上只能调 Player 的接口
// ============================================================
interface EntityApis {
  Player: { "player.getInfo": [PlayerGetInfoReq, PlayerGetInfoRes]; "player.move": [MoveReq, MoveRes] };
  Monster: { "monster.aggro": [AggroReq, AggroRes] };
}

// 双层泛型索引（EntityApis[E][K][0]）TS 推导不出来，需要 conditional helper 兜一下——
// 这是 TS 在这种模式上唯一的真实摩擦点，一次性写两个类型别名即可。
type ReqOf<P> = P extends readonly [infer Rq, unknown] ? Rq : never;
type ResOf<P> = P extends readonly [unknown, infer Rs] ? Rs : never;

declare function reqOn<E extends keyof EntityApis, K extends keyof EntityApis[E]>(
  entity: E,
  method: K,
  req: ReqOf<EntityApis[E][K]>,
): Promise<ResOf<EntityApis[E][K]>>;

async function usage2(): Promise<void> {
  const p = await reqOn("Player", "player.getInfo", { uid: 1n });
  p.level.toFixed(); // ✅
  // reqOn("Monster", "player.move", { x: 1, y: 2 }); // ❌ Monster 上没有该方法
}

// ============================================================
// 6) 真实实现：唯一一处 as，边界之外全是编译期检查
// ============================================================
interface Transport {
  call(method: string, payload: unknown): Promise<unknown>;
}

function makeRpc(transport: Transport) {
  return function reqEntity<K extends keyof RpcMap>(
    method: K,
    req: RpcMap[K][0],
  ): Promise<RpcMap[K][1]> {
    return transport.call(method, req) as Promise<RpcMap[K][1]>;
  };
}

// ============================================================
// 7) 错误用可辨识联合建模，调用方被迫处理
// ============================================================
type RpcResult<T> = { ok: true; value: T } | { ok: false; code: number; msg: string };

declare function tryReqEntity<K extends keyof RpcMap>(
  method: K,
  req: RpcMap[K][0],
): Promise<RpcResult<RpcMap[K][1]>>;

async function usage3(): Promise<number> {
  const res = await tryReqEntity("player.getInfo", { uid: 1n });
  if (!res.ok) return 0; // ✅ 不判 ok 就拿 value 会报错
  return res.value.level;
}

export { usage, usage2, usage3, makeRpc };
