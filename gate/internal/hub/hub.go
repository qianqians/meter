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

// OnClientFrame 处理一条来自客户端的原始帧：解 Envelope → 解 **ClientUplink oneof** → 分派。
// 接入层（WebSocket）只负责"把字节读成帧"，不做信封层的事。
func (h *Hub) OnClientFrame(connID string, f frame.Frame) {
	if len(f.Payload) == 0 {
		return // len==0 的帧是 ping，接入层直接回空帧
	}
	if ms, suspect := frame.OneWayDelayMs(h.now(), f.TS); suspect {
		log.Printf("[%s] 异常时钟：延迟 %d ms（已 clamp，不参与判定）", connID, ms)
	}

	var env pb.Envelope
	if err := proto.Unmarshal(f.Payload, &env); err != nil {
		h.badEnvelope()
		return
	}
	var up pb.ClientUplink
	if err := proto.Unmarshal(env.GetBody(), &up); err != nil {
		h.badEnvelope()
		return
	}
	h.OnClient(connID, &env, &up)
}

// OnClient 按 oneof 的成员分派。形状由 protobuf 表达，这里不再靠方法名前缀猜。
func (h *Hub) OnClient(connID string, env *pb.Envelope, up *pb.ClientUplink) {
	h.mu.Lock()
	h.stats.ClientFrames++
	h.mu.Unlock()

	switch body := up.GetBody().(type) {
	case *pb.ClientUplink_Call:
		h.forwardCall(connID, env, body.Call)
	case *pb.ClientUplink_Login, *pb.ClientUplink_Reconnect, *pb.ClientUplink_Logout,
		*pb.ClientUplink_Heartbeat, *pb.ClientUplink_Ack:
		// 框架消息：原样交给逻辑层（gate 不解释），body 仍是 ClientUplink 的字节
		h.sendToLogic("gate.clientUplink", env.GetMsgType(), env.GetCallbackId(), env.GetBody())
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()
	default:
		h.badEnvelope()
	}
}

// forwardCall 处理 CallEntity：要回包的走 ClientRequestHub，否则走 ClientNotifyHub。
func (h *Hub) forwardCall(connID string, env *pb.Envelope, call *pb.CallEntity) {
	s, ok := h.sess.ByConn(connID)
	if !ok {
		h.mu.Lock()
		h.stats.UnknownClient++
		h.mu.Unlock()
		return
	}
	_ = s // 会话存在即可；目标实体来自 call.entity_id（可能是别的怪/NPC）

	var body []byte
	var err error
	if env.GetMsgType() == pb.MsgType_MSG_REQUEST {
		body, err = protoMarshal(&pb.ClientRequestHub{
			ConnId: connID, EntityId: call.GetEntityId(), Content: call.GetContent(), Method: env.GetMethod(),
		})
	} else {
		body, err = protoMarshal(&pb.ClientNotifyHub{
			ConnId: connID, EntityId: call.GetEntityId(), Content: call.GetContent(), Method: env.GetMethod(),
		})
	}
	if err != nil {
		return
	}
	h.sendToLogic("gate.clientRequest", env.GetMsgType(), env.GetCallbackId(), body)
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
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_CreatePlayer{CreatePlayer: &pb.CreatePlayerEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

	case "hub.createRemoteEntity":
		var m pb.HubCreateRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_CreateRemote{CreateRemote: &pb.CreateRemoteEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

	case "hub.deleteRemoteEntity":
		var m pb.HubDeleteRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_Delete{Delete: &pb.DeleteEntity{EntityId: m.GetEntityId()}},
		})

	case "hub.refreshEntity":
		var m pb.HubRefreshEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_Refresh{Refresh: &pb.RefreshEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

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
			Body: mustMarshal(&pb.ClientDownlink{
				Body: &pb.ClientDownlink_Global{Global: &pb.CallGlobal{Content: m.GetContent()}},
			}),
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
	h.deliverDown(connID, method, &pb.ClientDownlink{
		Body: &pb.ClientDownlink_Call{Call: &pb.CallEntity{EntityId: entityID, Content: content}},
	}, withMsgType(msgType), withCallback(callbackID))
}

// deliverDown 把一条 ClientDownlink 发给某条客户端连接。
// method 只在 call / global 两种成员上有意义（业务方法名），其余传空。
func (h *Hub) deliverDown(connID, method string, down *pb.ClientDownlink, opts ...deliverOpt) {
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
	_ = p.Send(&pb.Envelope{MsgType: o.msgType, Method: method, CallbackId: o.callbackID, Body: mustMarshal(down)})
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
		Body: mustMarshal(&pb.ClientDownlink{
			Body: &pb.ClientDownlink_KickOff{KickOff: &pb.KickOff{
				Error: &pb.ErrorCode{Code: int32(code), Detail: prompt}, PromptInfo: prompt,
			}},
		}),
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
