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
	sess     *session.Table
	now      func() uint32 // 单调毫秒，用于帧头 ts
	gateName string        // 本 gate 的标识（转发给逻辑层时它需要知道回哪里）

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

func New(sess *session.Table, now func() uint32, gateName string) *Hub {
	return &Hub{
		sess:     sess,
		now:      now,
		gateName: gateName,
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
		if env.GetMsgType() == pb.MsgType_MSG_RESPONSE {
			// ② 客户端对服务端 CallEntity{REQUEST} 的回包：
			// 配对靠 callback_id，逻辑层只关心"哪个实体回的什么"，不关心在哪条连接上。
			s, ok := h.sess.ByConn(connID)
			if !ok {
				h.unknownClient()
				return
			}
			b, err := protoMarshal(&pb.ClientResponseHub{
				EntityId: s.EntityID,
				Error:    errorOf(env.GetStatus(), env.GetBody()),
				Content:  env.GetBody(),
				Method:   env.GetMethod(),
			})
			if err != nil {
				return
			}
			h.sendToLogic(connID, "gate.clientResponse", pb.MsgType_MSG_RESPONSE, env.GetCallbackId(), b)
			h.mu.Lock()
			h.stats.ForwardedUp++
			h.mu.Unlock()
			return
		}
		h.forwardCall(connID, env, body.Call)

	case *pb.ClientUplink_Login:
		// ④ 登录不是透传：逻辑层需要知道"谁在哪台 gate 的哪条连接上登录"，
		// 否则回包（HubCreatePlayerEntity）找不到目标连接。
		b, err := protoMarshal(&pb.GateForwardClientRequestService{
			ServiceName: "auth",
			GateName:    h.gateName,
			ConnId:      connID,
			Content:     marshalUplinkMember(up, env),
		})
		if err != nil {
			return
		}
		h.sendToLogic(connID, "gate.clientLogin", pb.MsgType_MSG_REQUEST, env.GetCallbackId(), b)
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()

	case *pb.ClientUplink_Reconnect:
		// ③ 重连：逻辑层需要旧 conn 的会话信息 + 新连接 id，才能判断"恢复还是全量重建"。
		s, _ := h.sess.ByConn(connID) // 新连接通常还没绑会话
		b, err := protoMarshal(&pb.GateForwardClientRequestReconnect{
			GateName: h.gateName,
			ConnId:   connID,
			UserId:   s.UserID, // 可能为空（旧连接的会话已摘），由逻辑层凭 resume_token 判定
			Content:  marshalUplinkMember(up, env),
		})
		if err != nil {
			return
		}
		h.sendToLogic(connID, "gate.clientReconnect", pb.MsgType_MSG_REQUEST, env.GetCallbackId(), b)
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()

	case *pb.ClientUplink_Logout, *pb.ClientUplink_Heartbeat, *pb.ClientUplink_Ack:
		// 其余框架消息：原样交给逻辑层（gate 不解释）
		h.sendToLogic(connID, "gate.clientUplink", env.GetMsgType(), env.GetCallbackId(), env.GetBody())
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
	h.sendToLogic(connID, "gate.clientRequest", env.GetMsgType(), env.GetCallbackId(), body)
	h.mu.Lock()
	h.stats.ForwardedUp++
	h.mu.Unlock()
}

// sendToLogic 把消息发给逻辑节点。P0：只有一个节点时直发；多个时按会话的 node_id 选。
// sendToLogic 把消息发给逻辑节点。
//
// 寻址规则：**connID 有会话时用会话绑定的 NodeID**（实体在哪个节点就发哪里）；
// 未登录（无会话）则任选一个（登录请求任何节点都能处理，处理完由逻辑层下发
// HubCreatePlayerEntity 把会话绑到那个节点）。
func (h *Hub) sendToLogic(connID, method string, msgType pb.MsgType, callbackID uint32, body []byte) {
	h.mu.RLock()
	var peer Peer
	if connID != "" {
		if s, ok := h.sess.ByConn(connID); ok && s.NodeID != "" {
			peer = h.logics[s.NodeID]
		}
	}
	if peer == nil {
		for _, p := range h.logics { // 未登录或节点不在了：任取一个
			peer = p
			break
		}
	}
	h.mu.RUnlock()
	if peer == nil {
		return // 没有逻辑节点：丢弃（调用方超时）
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

	case "gate.drain":
		// ⑧ 逻辑层通知 gate：我要停机了（gate 会停止向它投递新的上行）。
		// gate 侧的配合动作：把这个节点从"可投递"集合里摘掉（连接本身保留，在途消息能跑完）。
		var m pb.GateDrain
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.mu.Lock()
		delete(h.logics, m.GetGateId()) // 摘掉之后 sendToLogic 的 fallback 不会再选它
		h.mu.Unlock()
		log.Printf("逻辑节点 %s 请求排空（grace=%dms，原因=%s）", m.GetGateId(), m.GetGraceMs(), m.GetReason())

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
