// NATS 旁路：hub 的第二条下行入口。
//
// TCP 直连（logiclink → OnLogic）是主通道；这里把 entity_{id}_gate_mq 上收到的
// 消息也送进**同一个** OnLogic——NATS 只是"另一条进 hub 的路"，载荷与分派完全同构：
//
//	逻辑服务器 ──Publish──► entity_{id}_gate_mq ──► 玩家所在 gate ──► OnLogic("nats") ──► 客户端
//
// 订阅生命周期跟随会话：Bind 时订阅、Unbind/顶号挤掉时退订——
// 订阅面恒等于"本 gate 在线玩家数"，断线自动收敛，无需额外对账。
package hub

import (
	"google.golang.org/protobuf/proto"

	"meter/gate/internal/natsmq"
	pb "meter/gate/internal/pb"
)

// MQ 是 hub 用到的消息队列能力（*natsmq.Client 实现它）。
// 单独声明接口而非直接依赖具体类型，是为了 hub_test 能离线注入假实现。
type MQ interface {
	Consume(subject string) (<-chan []byte, func())
}

// natsNodeID 是经 NATS 进来的消息在 OnLogic 里的"来源节点"标记。
// 它不会出现在 logics 表里，所以 sendToLogic 的会话寻址会退化为"任选节点"——
// 对下行转发（本路径的主体）没有影响；经 NATS 收到 hub.createPlayerEntity 属于
// 罕见路径（逻辑层多半走 TCP 发它），绑定后 NodeID 就被真实节点名覆盖了。
const natsNodeID = "nats"

// subscribeEntity 为实体订阅 gate_mq（幂等：已订阅则跳过）。
// hub 拿到会话（hub.createPlayerEntity）时调用。
func (h *Hub) subscribeEntity(entityID string) {
	if h.mq == nil || entityID == "" {
		return
	}
	h.mu.RLock()
	_, exists := h.mqSubs[entityID]
	h.mu.RUnlock()
	if exists {
		return
	}
	// 先订阅再登记：并发订阅同一实体时，后到者发现自己已被抢先，取消自己的订阅
	ch, cancel := h.mq.Consume(natsmq.GateSubject(entityID))
	h.mu.Lock()
	if h.mqSubs == nil {
		h.mqSubs = make(map[string]func())
	}
	if _, exists := h.mqSubs[entityID]; exists {
		h.mu.Unlock()
		cancel()
		return
	}
	h.mqSubs[entityID] = cancel
	h.mu.Unlock()

	go h.pumpEntityMq(entityID, ch)
}

// unsubscribeEntity 退订实体的 gate_mq（未订阅则跳过）。
// Unbind/顶号挤掉时调用——尤其顶号：旧订阅不退，新旧两个订阅会重复消费同一条消息。
func (h *Hub) unsubscribeEntity(entityID string) {
	if h.mq == nil || entityID == "" {
		return
	}
	h.mu.Lock()
	cancel, ok := h.mqSubs[entityID]
	if ok {
		delete(h.mqSubs, entityID)
	}
	h.mu.Unlock()
	if ok {
		cancel() // 返回后 feed 已 close，泵 goroutine 自然退出
	}
}

// pumpEntityMq 把订阅 channel 里的消息泵进 OnLogic。
// body = proto.Marshal(Envelope)，**无帧头**——帧头是给 TCP 流切帧用的，MQ 自带消息边界。
func (h *Hub) pumpEntityMq(entityID string, ch <-chan []byte) {
	for data := range ch {
		var env pb.Envelope
		if err := proto.Unmarshal(data, &env); err != nil {
			h.badEnvelope()
			continue
		}
		h.OnLogic(natsNodeID, &env)
	}
}
