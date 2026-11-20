// hub 是 gate 的中央：连接与会话的唯一真相，两个方向的转发都在这里。
//
//	客户端（WebSocket，对外）  ⇄  hub  ⇄  逻辑层（TCP，对内）
//
// 它**不认识任何业务消息**：客户端的 `content`、逻辑层的 `content` 一律当不透明字节搬。
// 唯一读的字段是寻址用的 `entity_id` / `conn_id`（见 docs/protocol-map.md §4.6）。
package hub

import (
	"log"
	"sync"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

// Peer 是一个能收 Envelope 的对端（客户端连接或逻辑层连接）。
type Peer interface {
	Send(env *pb.Envelope) error
}

// Hub 负责：客户端 ⇄ 逻辑层的转发、会话表维护、广播扇出。
type Hub struct {
	sess *session.Table
	now  func() uint32 // 单调毫秒，用于帧头 ts

	mu      sync.RWMutex
	clients map[string]Peer // conn_id → 客户端连接
	logics  map[string]Peer // node_id → 逻辑层连接

	stats Stats
}

// Stats 是 hub 的计数器（上 metrics 时直接读这个）。
type Stats struct {
	ClientFrames   uint64
	LogicFrames    uint64
	UnknownClient  uint64 // 目标 conn 不存在
	BadEnvelope    uint64
	ForwardedUp    uint64
	ForwardedDown  uint64
	Kicks          uint64
}

func New(sess *session.Table, now func() uint32) *Hub {
	return &Hub{
		sess:    sess,
		now:     now,
		clients: make(map[string]Peer),
		logics:  make(map[string]Peer),
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

// RemoveClient 注销客户端连接，并把它从会话表里摘掉。
func (h *Hub) RemoveClient(connID string) {
	h.mu.Lock()
	delete(h.clients, connID)
	h.mu.Unlock()
	if s := h.sess.Unbind(connID); s != nil {
		log.Printf("[%s] 断开 user=%s entity=%s", connID, s.UserID, s.EntityID)
	}
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

// ---------------- 客户端 → 逻辑层 ----------------

// OnClientFrame 处理一条来自客户端的原始帧：这里统一解 Envelope 并统计该跳的单向延迟。
// 接入层（WebSocket）只负责"把字节读成帧"，不做信封层的事。
func (h *Hub) OnClientFrame(connID string, f frame.Frame) {
	if len(f.Payload) == 0 {
		// len == 0 的帧约定为 ping：由接入层直接回空帧即可，这里无事可做
		return
	}
	if ms, suspect := frame.OneWayDelayMs(h.now(), f.TS); suspect {
		log.Printf("[%s] 异常时钟：延迟 %d ms（已 clamp，不参与判定）", connID, ms)
	}

	var env pb.Envelope
	if err := proto.Unmarshal(f.Payload, &env); err != nil {
		h.mu.Lock()
		h.stats.BadEnvelope++
		h.mu.Unlock()
		return
	}
	h.OnClient(connID, &env)
}


// OnClient 处理一条来自客户端的 Envelope。
func (h *Hub) OnClient(connID string, env *pb.Envelope) {
	h.mu.Lock()
	h.stats.ClientFrames++
	h.mu.Unlock()

	switch env.GetMsgType() {
	case pb.MsgType_MSG_REQUEST, pb.MsgType_MSG_NOTIFY:
		h.forwardUp(connID, env)
	case pb.MsgType_MSG_RESPONSE:
		// 客户端对服务端 CallEntity 的响应：配对靠 callback_id，逻辑层只需要知道是哪个实体
		s, ok := h.sess.ByConn(connID)
		if !ok {
			h.mu.Lock()
			h.stats.UnknownClient++
			h.mu.Unlock()
			return
		}
		body, err := protoMarshal(&pb.ClientResponseHub{
			EntityId: s.EntityID,
			Error:    errorOf(env.GetStatus(), env.GetBody()),
			Content:  env.GetBody(),
		})
		if err != nil {
			return
		}
		h.sendToLogic(env.GetMethod(), pb.MsgType_MSG_RESPONSE, env.GetCallbackId(), body)
	default:
		h.mu.Lock()
		h.stats.BadEnvelope++
		h.mu.Unlock()
	}
}

// forwardUp 把客户端上行包成 ClientRequestHub / ClientNotifyHub 转给逻辑层。
// `content` 原样搬运——gate 不解它（它就是客户端 CallEntity.content 的字节）。
func (h *Hub) forwardUp(connID string, env *pb.Envelope) {
	s, ok := h.sess.ByConn(connID)
	if !ok {
		// 未登录的 REQUEST 也没有目标实体：直接回 NOT_AUTHED 更友好，但 P0 先丢弃并计数
		h.mu.Lock()
		h.stats.UnknownClient++
		h.mu.Unlock()
		return
	}

	var body []byte
	var err error
	if env.GetMsgType() == pb.MsgType_MSG_REQUEST {
		body, err = protoMarshal(&pb.ClientRequestHub{ConnId: connID, EntityId: s.EntityID, Content: env.GetBody()})
	} else {
		body, err = protoMarshal(&pb.ClientNotifyHub{ConnId: connID, EntityId: s.EntityID, Content: env.GetBody()})
	}
	if err != nil {
		return
	}
	h.sendToLogic(env.GetMethod(), env.GetMsgType(), env.GetCallbackId(), body)
	h.mu.Lock()
	h.stats.ForwardedUp++
	h.mu.Unlock()
}

// sendToLogic 把消息发给逻辑节点。P0：只有一个节点时直发；多个时按会话的 node_id 选。
func (h *Hub) sendToLogic(method string, msgType pb.MsgType, callbackID uint32, body []byte) {
	h.mu.RLock()
	var peer Peer
	for _, p := range h.logics {
		peer = p
		break // P0：任取一个（真实现要按 entity→node 选，见 session.Session.NodeID）
	}
	h.mu.RUnlock()
	if peer == nil {
		// 没有逻辑节点：丢弃（客户端会等到超时，这是 P0 的已知行为）
		return
	}
	_ = peer.Send(&pb.Envelope{MsgType: msgType, Method: method, CallbackId: callbackID, Body: body})
}

// ---------------- 逻辑层 → 客户端 ----------------

// OnLogic 处理一条来自逻辑层的 Envelope。
func (h *Hub) OnLogic(nodeID string, env *pb.Envelope) {
	h.mu.Lock()
	h.stats.LogicFrames++
	h.mu.Unlock()

	switch env.GetMethod() {
	case "hub.createPlayerEntity":
		// 建会话 + 给客户端下发 client.proto 的 CreatePlayerEntity。
		// **方法名是 gate 定的**（"client.createPlayerEntity"）：它属于框架面，不是业务方法。
		var m pb.HubCreatePlayerEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		if evicted := h.sess.Bind(session.Session{
			ConnID: m.GetConnId(), UserID: m.GetUserId(), EntityID: m.GetEntityId(), NodeID: nodeID,
		}); evicted != nil {
			log.Printf("实体 %s 被新连接重新绑定，踢掉旧连接 %s", m.GetEntityId(), evicted.ConnID)
			h.kick(evicted.ConnID, 4, "该账号已在别处登录")
		}
		h.deliver(m.GetConnId(), "client.createPlayerEntity", mustMarshal(&pb.CreatePlayerEntity{
			EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
		}))

	case "hub.createRemoteEntity":
		var m pb.HubCreateRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliver(m.GetConnId(), "client.createRemoteEntity", mustMarshal(&pb.CreateRemoteEntity{
			EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
		}))

	case "hub.deleteRemoteEntity":
		var m pb.HubDeleteRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliver(m.GetConnId(), "client.deleteRemoteEntity", mustMarshal(&pb.DeleteEntity{EntityId: m.GetEntityId()}))

	case "hub.refreshEntity":
		var m pb.HubRefreshEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliver(m.GetConnId(), "client.refreshEntity", mustMarshal(&pb.RefreshEntity{
			EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
		}))

	case "hub.kickOffClient":
		var m pb.HubKickOffClient
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.kick(m.GetConnId(), int(m.GetError().GetCode()), m.GetError().GetDetail())

	// 下面三条：外层 `Envelope.method` 是**路由方法**（gate 靠它知道 body 是什么），
	// 真正的业务方法名在 body 的 `method` 字段里，gate 原样放进下发的 Envelope.method。
	case "gate.forwardHubCallClient":
		var m pb.GateForwardHubCallClient
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.sendCallEntity(m.GetConnId(), m.GetEntityId(), m.GetMethod(), env.GetCallbackId(), m.GetContent())

	case "gate.forwardHubCallGroup":
		var m pb.GateForwardHubCallGroup
		if !h.unmarshalBody(env, &m) {
			return
		}
		// 名单是**连接**（由逻辑层解析好），这里只保证去重
		for _, cid := range dedupe(m.GetConnId()) {
			h.sendCallEntity(cid, m.GetEntityId(), m.GetMethod(), 0, m.GetContent())
		}

	case "gate.forwardHubCallGlobal":
		var m pb.GateForwardHubCallGlobal
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.mu.RLock()
		peers := make([]Peer, 0, len(h.clients))
		for _, p := range h.clients {
			peers = append(peers, p)
		}
		h.mu.RUnlock()
		out := &pb.Envelope{
			MsgType: pb.MsgType_MSG_NOTIFY,
			Method:  m.GetMethod(),
			Body:    mustMarshal(&pb.CallGlobal{Content: m.GetContent()}),
		}
		for _, p := range peers {
			_ = p.Send(out)
		}
		h.mu.Lock()
		h.stats.ForwardedDown++
		h.mu.Unlock()

	default:
		h.mu.Lock()
		h.stats.BadEnvelope++
		h.mu.Unlock()
	}
}

// sendCallEntity 把一次调用投给某条连接（客户端收到的 body 是 CallEntity）。
func (h *Hub) sendCallEntity(connID, entityID, method string, callbackID uint32, content []byte) {
	msgType := pb.MsgType_MSG_NOTIFY
	if callbackID != 0 {
		msgType = pb.MsgType_MSG_REQUEST
	}
	body := mustMarshal(&pb.CallEntity{EntityId: entityID, Content: content})
	h.deliver(connID, method, body, withMsgType(msgType), withCallback(callbackID))
}

// deliver 把一段 body 发给某条客户端连接。
func (h *Hub) deliver(connID, method string, body []byte, opts ...deliverOpt) {
	o := deliverOptions{msgType: pb.MsgType_MSG_NOTIFY}
	for _, f := range opts {
		f(&o)
	}
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		h.mu.Lock()
		h.stats.UnknownClient++
		h.mu.Unlock()
		return
	}
	_ = p.Send(&pb.Envelope{MsgType: o.msgType, Method: method, CallbackId: o.callbackID, Body: body})
	h.mu.Lock()
	h.stats.ForwardedDown++
	h.mu.Unlock()
}

type deliverOptions struct {
	msgType    pb.MsgType
	callbackID uint32
}
type deliverOpt func(*deliverOptions)

func withMsgType(t pb.MsgType) deliverOpt { return func(o *deliverOptions) { o.msgType = t } }
func withCallback(id uint32) deliverOpt   { return func(o *deliverOptions) { o.callbackID = id } }

// ShutdownClient 关掉某条客户端连接（Peer 实现了 Close 时调用）。踢人路径使用。
func (h *Hub) ShutdownClient(connID string) {
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		return
	}
	if c, ok := p.(interface{ Close() error }); ok {
		_ = c.Close()
	}
}

// kick 断开某条客户端连接（先发 KickOff，再关）。
func (h *Hub) kick(connID string, code int, prompt string) {
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	env := &pb.Envelope{
		MsgType: pb.MsgType_MSG_NOTIFY,
		Method:  "client.kickOff",
		Body:    mustMarshal(&pb.KickOff{Error: &pb.ErrorCode{Code: int32(code), Detail: prompt}, PromptInfo: prompt}),
	}
	if sc, ok := p.(interface{ SendAndClose(*pb.Envelope) error }); ok && p != nil {
		_ = sc.SendAndClose(env)
	} else if p != nil {
		_ = p.Send(env)
		h.ShutdownClient(connID)
	}
	h.mu.Lock()
	h.stats.Kicks++
	h.mu.Unlock()
}

// ---------------- 小工具 ----------------

func dedupe(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
