// 反例集：每一行都必须在编译期报错。
// 用 `npx tsc -p .` 验证——若某条 @ts-expect-error 没有报错，tsc 会反过来说
// "Unused '@ts-expect-error' directive"，于是"类型安全是否真的存在"变成一条可执行的断言。
import { makeRpc } from './rpc-types-demo.ts';

const transport = {
  async call(_method: string, _payload: unknown): Promise<unknown> {
    return {};
  },
};
const reqEntity = makeRpc(transport);

async function negatives(): Promise<void> {
  // ① 请求体字段写错：PlayerGetInfoReq 上不存在 mailId
  // @ts-expect-error 对象字面量指定了未知属性 mailId
  await reqEntity('player.getInfo', { mailId: 7 });

  // ② 方法名写错：RpcMap 里没有这个方法
  // @ts-expect-error 参数类型 "nope.method" 不可赋给 keyof RpcMap
  await reqEntity('nope.method', {});

  // ③ 拿到了错的响应类型：MailClaimRes 上没有 name
  const res = await reqEntity('mail.claim', { mailId: 1 });
  // @ts-expect-error MailClaimRes 上不存在属性 name
  res.name;

  // ④ 请求/响应不能互换：MoveRes 不能当 MoveReq 用
  const moved = await reqEntity('player.move', { x: 1, y: 2 });
  // @ts-expect-error MoveRes 上不存在属性 vx
  moved.vx;
}

export { negatives };
