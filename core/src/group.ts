// 组（参考 abelkhan hub/Group 的结构：clients + entities + players，Join/Leave 时同步视图）。
//
// Group 是"一组实体的管理"：组员之间互相可见（join 时把已有成员的实体视图同步给新客户端，
// 新成员的视图也广播给老成员），离开时反向删除。`rpcNotify` 把一条消息广播给组内所有**玩家**。
//
// 组不持有连接——它只装实体；连接由实体（玩家）自己带。怪/NPC 也在组里（能被组员看见、能被
// rpcNotify 命中吗？不能：广播名单是连接，怪没有连接，视图同步才怪的主场）。

import { create, toBinary } from '@bufbuild/protobuf';

import { MsgType } from './gen/envelope_pb';
import { GateForwardHubCallGroupSchema } from './gen/gate_logic_pb';
import { envelopeBytes, type Entity } from './entity';

/** 实体的视图内容（怎么序列化成 bytes 是业务的事）。 */
export type ViewContent = (e: Entity) => Uint8Array;

export interface GroupStats {
  broadcasts: number;
}

export class Group {
  readonly id: string;
  private readonly members = new Set<Entity>();
  private readonly view: ViewContent;
  private readonly down: { send(bytes: Uint8Array): void };
  readonly stats: GroupStats = { broadcasts: 0 };

  constructor(id: string, down: { send(bytes: Uint8Array): void }, view: ViewContent) {
    this.id = id;
    this.down = down;
    this.view = view;
  }

  /**
   * 加入：双向视图同步（仿 abelkhan Group.Join）——
   * 新成员看到所有老成员的实体；每个老成员也看到新成员的实体。
   */
  join(e: Entity): void {
    if (this.members.has(e)) return;
    const others = [...this.members];
    this.members.add(e);

    if (e.isPlayer) {
      // 新客户端看见组里已有的实体（怪 + 其他玩家）
      for (const o of others) {
        o.createRemoteTo(e, this.view(o));
      }
    }
    // 组里的老客户端看见新实体
    for (const o of others) {
      if (o.isPlayer) {
        e.createRemoteTo(o, this.view(e));
      }
    }
  }

  /** 离开：把自己的视图从所有老成员的客户端里删掉。 */
  leave(e: Entity): void {
    if (!this.members.delete(e)) return;
    for (const o of this.members) {
      if (o.isPlayer) {
        e.deleteRemoteFrom(o);
      }
    }
  }

  /** 组内成员（快照）。 */
  list(): Entity[] {
    return [...this.members];
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * 广播给组内所有玩家：gate.forwardHubCallGroup（gate 侧按连接去重）。
   * content 是业务消息的编码字节；entityId 填广播的"来源实体"（可为空）。
   */
  rpcNotify(method: string, content: Uint8Array, opts: { from?: string } = {}): void {
    const connIds = [...this.members]
      .filter((e) => e.isPlayer)
      .map((e) => e.connId!);
    this.stats.broadcasts++;
    this.down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'gate.forwardHubCallGroup', 0, 0,
      toBinary(GateForwardHubCallGroupSchema, create(GateForwardHubCallGroupSchema, {
        connId: connIds,
        entityId: opts.from ?? '',
        method,
        content,
      }))));
  }

  /** 清空（服务器停机/组销毁时）：所有成员互相删除视图。 */
  clear(): void {
    const all = [...this.members];
    for (const leaver of all) {
      this.leave(leaver);
    }
  }
}
