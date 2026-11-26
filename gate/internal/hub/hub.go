// hub 是 gate 的中央：连接与会话的唯一真相。
//
//	客户端（WebSocket，对外）  ⇄  hub  ⇄  逻辑层（TCP，对内）
//
// 本文件只放**公共核心**：Hub 结构、计数器、连接注册/注销。两个方向的消息处理各成一个文件：
//
//	client.go —— 客户端 → 逻辑层（上行）
//	logic.go  —— 逻辑层 → 客户端（下行）
//
// 它**不认识任何业务消息**：客户端的 `content`、逻辑层的 `content` 一律当不透明字节搬。
// 唯一读的字段是寻址用的 `entity_id` / `conn_id`（见 docs/protocol-map.md §4.6）。
package hub

import (
	"log"
	"sync"

	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

// Peer 是一个能收 Envelope 的对端（客户端连接或逻辑层连接）。
type Peer interface {
	Send(env *pb.Envelope) error
}

// Hub 负责：客户端 ⇄ 逻辑层的转发、会话表维护、广播扇出。
type Hub struct {
	sess     *session.Table
	now      func() uint32 // 单调毫秒，用于帧头 ts
	gateName string        // 本 gate 的标识（转发给逻辑层时它需要知道回哪里）

	mq     MQ                // NATS 旁路（nil = 未启用，订阅/退订全部跳过）
	mqSubs map[string]func() // entity_id → 退订函数（订阅生命周期跟随会话，见 mq.go）

	mu      sync.RWMutex
	clients map[string]Peer // conn_id → 客户端连接
	logics  map[string]Peer // node_id → 逻辑层连接

	stats Stats
}

// Stats 是 hub 的计数器（上 metrics 时直接读这个）。
type Stats struct {
	ClientFrames  uint64
	LogicFrames   uint64
	UnknownClient uint64 // 目标 conn 不存在
	BadEnvelope   uint64
	ForwardedUp   uint64
	ForwardedDown uint64
	Kicks         uint64
}

func New(sess *session.Table, now func() uint32, gateName string, mq MQ) *Hub {
	return &Hub{
		sess:     sess,
		now:      now,
		gateName: gateName,
		mq:       mq,
		clients:  make(map[string]Peer),
		logics:   make(map[string]Peer),
	}
}

// Stats 返回计数器的快照。
func (h *Hub) Stats() Stats {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.stats
}

// ---------------- 连接注册 ----------------

// AddClient 登记一条已握手的客户端连接。
func (h *Hub) AddClient(connID string, p Peer) {
	h.mu.Lock()
	h.clients[connID] = p
	h.mu.Unlock()
}

// RemoveClient 注销客户端连接：摘会话表 + **通知逻辑层**。
//
// 必须发 ClientDisconnect：否则逻辑层不知道玩家离线——实体不会下线、好友收不到下线事件、
// 离线消息也不会转存。这是"连接断开"成为一条协议消息的全部理由。
func (h *Hub) RemoveClient(connID string) {
	h.mu.Lock()
	delete(h.clients, connID)
	h.mu.Unlock()

	s := h.sess.Unbind(connID)
	var userID, entityID string
	if s != nil {
		userID, entityID = s.UserID, s.EntityID
		log.Printf("[%s] 断开 user=%s entity=%s", connID, userID, entityID)
		h.unsubscribeEntity(entityID) // 会话没了：gate_mq 订阅同步退掉
	}

	body, err := protoMarshal(&pb.ClientDisconnect{
		ConnId:   connID,
		UserId:   userID,   // 未登录为空
		EntityId: entityID, // 同上
		// 断开原因：正常关闭填 0；心跳超时/协议错误由接入层另行通知（P0 全部按正常关闭）
	})
	if err != nil {
		return
	}
	h.sendToLogic(connID, "gate.clientDisconnect", pb.MsgType_MSG_NOTIFY, 0, body)
}

// AddLogic 登记一个逻辑节点（TCP 对内）。
func (h *Hub) AddLogic(nodeID string, p Peer) {
	h.mu.Lock()
	h.logics[nodeID] = p
	h.mu.Unlock()
	log.Printf("逻辑节点接入: %s（共 %d 个）", nodeID, h.logicCount())
}

// RemoveLogic 注销逻辑节点。
func (h *Hub) RemoveLogic(nodeID string) {
	h.mu.Lock()
	delete(h.logics, nodeID)
	h.mu.Unlock()
	log.Printf("逻辑节点断开: %s（剩 %d 个）", nodeID, h.logicCount())
}

// LogicCount 已接入的逻辑节点数。
func (h *Hub) LogicCount() int { return h.logicCount() }

func (h *Hub) logicCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.logics)
}

// ClientCount 在线连接数（压测/指标用）。
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
