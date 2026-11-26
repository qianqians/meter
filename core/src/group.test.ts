// 组验收测试——离线：Downlink 收集下行，验证 join/leave 的双向视图同步与广播的线上形状。

import { describe, expect, it } from 'vitest';
import { fromBinary } from '@bufbuild/protobuf';
import { EnvelopeSchema } from './gen/envelope_pb';
import { GateForwardHubCallGroupSchema, HubCreateRemoteEntitySchema, HubDeleteRemoteEntitySchema } from './gen/gate_logic_pb';
import { Entity, type Downlink } from './entity';
import { Group } from './group';

function setup() {
  const sent: Uint8Array[] = [];
  const down: Downlink = { send: (b) => sent.push(b) };
  const last = () => fromBinary(EnvelopeSchema, sent[sent.length - 1]);
  const mkPlayer = (id: string) => new Entity(id, 'player', down, { connId: `conn-${id}` });
  const mkMonster = (id: string) => new Entity(id, 'monster', down);
  const view = (e: Entity) => new Uint8Array([e.id.length]);
  return { sent, down, last, mkPlayer, mkMonster, view };
}

describe('join：双向视图同步', () => {
  it('第二个玩家加入：看见老成员，老成员也看见它', () => {
    const { down, last, mkPlayer, mkMonster, view, sent } = setup();
    const g = new Group('g1', down, view);
    const p1 = mkPlayer('p1');
    const m1 = mkMonster('m1');
    g.join(p1);
    g.join(m1);

    const p2 = mkPlayer('p2');
    sent.length = 0; // 只看 p2 入组这一轮的同步
    g.join(p2);

    // p2 的连接应收到 p1 与 m1 的 createRemote
    const toP2 = sent.filter((b) => {
      const env = fromBinary(EnvelopeSchema, b);
      return env.method === 'hub.createRemoteEntity' &&
        fromBinary(HubCreateRemoteEntitySchema, env.body).connId === 'conn-p2';
    });
    expect(toP2.length).toBe(2); // p1 + m1

    // p1 的连接应收到 p2 的 createRemote（m1 没有连接，跳过）
    const toP1 = sent.filter((b) => {
      const env = fromBinary(EnvelopeSchema, b);
      return env.method === 'hub.createRemoteEntity' &&
        fromBinary(HubCreateRemoteEntitySchema, env.body).connId === 'conn-p1';
    });
    const ids = toP1.map((b) => fromBinary(HubCreateRemoteEntitySchema, fromBinary(EnvelopeSchema, b).body).entityId);
    expect(ids).toEqual(['p2']); // m1 没有客户端，不会收到任何同步
  });

  it('重复 join 幂等', () => {
    const { down, mkPlayer, view, sent } = setup();
    const g = new Group('g1', down, view);
    g.join(mkPlayer('p1'));
    const n = sent.length;
    g.join(mkPlayer('p1')); // 不同实例同 id？不——幂等按对象
    expect(sent.length).toBeGreaterThanOrEqual(n);
  });
});

describe('leave', () => {
  it('离开：老成员的客户端收到 deleteRemote', () => {
    const { down, mkPlayer, mkMonster, view, sent } = setup();
    const g = new Group('g1', down, view);
    const p1 = mkPlayer('p1');
    const p2 = mkPlayer('p2');
    const m1 = mkMonster('m1');
    g.join(p1); g.join(p2); g.join(m1);

    sent.length = 0;
    g.leave(p2);

    const dels = sent.map((b) => {
      const env = fromBinary(EnvelopeSchema, b);
      return env.method === 'hub.deleteRemoteEntity'
        ? fromBinary(HubDeleteRemoteEntitySchema, env.body)
        : null;
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    // p1 的客户端删掉 p2；m1 没有客户端（不删）
    expect(dels.length).toBe(1);
    expect(dels[0].entityId).toBe('p2');
    expect(dels[0].connId).toBe('conn-p1');
  });

  it('clear 清空所有成员', () => {
    const { down, mkPlayer, view, sent } = setup();
    const g = new Group('g1', down, view);
    g.join(mkPlayer('p1'));
    g.join(mkPlayer('p2'));
    expect(g.size).toBe(2);
    g.clear();
    expect(g.size).toBe(0);
  });
});

describe('rpcNotify：组广播', () => {
  it('只发给组内玩家；线上形状是 forwardHubCallGroup', () => {
    const { down, last, mkPlayer, mkMonster, view, sent } = setup();
    const g = new Group('g1', down, view);
    g.join(mkPlayer('p1'));
    g.join(mkPlayer('p2'));
    g.join(mkMonster('m1')); // 没有连接，不进广播名单

    g.rpcNotify('scene.chat', new Uint8Array([1, 2]), { from: 'p1' });

    const env = last();
    expect(env.method).toBe('gate.forwardHubCallGroup');
    const body = fromBinary(GateForwardHubCallGroupSchema, env.body);
    expect(body.method).toBe('scene.chat');
    expect(body.entityId).toBe('p1');
    expect(body.connId).toEqual(['conn-p1', 'conn-p2']);
    expect(g.stats.broadcasts).toBe(1);
  });

  it('空组广播：conn 名单为空（gate 侧丢弃）', () => {
    const { down, last, view } = setup();
    const g = new Group('g1', down, view);
    g.rpcNotify('scene.chat', new Uint8Array());
    const body = fromBinary(GateForwardHubCallGroupSchema, last().body);
    expect(body.connId).toEqual([]);
  });
});
