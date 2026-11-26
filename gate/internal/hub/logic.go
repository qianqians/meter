// 逻辑层 → 客户端（**下行**）：按 Envelope.method 分派，组装 ClientDownlink 投递给客户端连接。
//
// 入口是 OnLogic（logiclink 把 TCP 字节读成帧、过完 logic.hello 握手后调它）。
// 下行的三段式：OnLogic（分派）→ sendCallEntity / deliverDown（组装+投递）→ wsPeer.Send。
package hub

import (
	"log"

	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

// OnLogic 处理一条来自逻辑层的 Envelope。
func (h *Hub) OnLogic(nodeID string, env *pb.Envelope) {
	h.stats.logicFrames.Add(1)

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
			// 顶号：旧连接的 Unbind 拿不到会话了（已被挤掉），gate_mq 订阅必须在这里退
			h.unsubscribeEntity(evicted.EntityID)
			h.kick(evicted.ConnID, 4, "该账号已在别处登录")
		}
		h.subscribeEntity(m.GetEntityId()) // 会话建立：订阅 entity_{id}_gate_mq（未启用 NATS 时是空操作）
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
		// msgType 三态：逻辑层回包（RESPONSE）**原样透传**——客户端 callEntity 的闭环
		// （请求→gate→逻辑→回包）靠这条；其余维持原语义（有 callback → 服务端调客户端的 REQUEST）。
		msgType := pb.MsgType_MSG_NOTIFY
		switch {
		case env.GetMsgType() == pb.MsgType_MSG_RESPONSE:
			msgType = pb.MsgType_MSG_RESPONSE
		case env.GetCallbackId() != 0:
			msgType = pb.MsgType_MSG_REQUEST
		}
		h.sendCallEntity(m.GetConnId(), m.GetEntityId(), m.GetMethod(), env.GetCallbackId(), m.GetContent(), msgType)

	case "gate.forwardHubCallGroup":
		var m pb.GateForwardHubCallGroup
		if !h.unmarshalBody(env, &m) {
			return
		}
		// 名单是**连接**（由逻辑层解析好），这里只保证去重。
		// 同一条消息只 marshal 一次：逐连接走 SendBytes（只做帧编码+写出）。
		h.broadcastDown(dedupe(m.GetConnId()), &pb.Envelope{
			MsgType: pb.MsgType_MSG_NOTIFY,
			Method:  m.GetMethod(),
			Body: mustMarshal(&pb.ClientDownlink{
				Body: &pb.ClientDownlink_Call{Call: &pb.CallEntity{EntityId: m.GetEntityId(), Content: m.GetContent()}},
			}),
		})

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
		connIDs := make([]string, 0, len(h.clients))
		for cid := range h.clients {
			connIDs = append(connIDs, cid)
		}
		h.mu.RUnlock()
		h.broadcastDown(connIDs, &pb.Envelope{
			MsgType: pb.MsgType_MSG_NOTIFY,
			Method:  m.GetMethod(),
			Body: mustMarshal(&pb.ClientDownlink{
				Body: &pb.ClientDownlink_Global{Global: &pb.CallGlobal{Content: m.GetContent()}},
			}),
		})

	default:
		h.stats.badEnvelope.Add(1)
	}
}

// sendCallEntity 把一次调用投给某条连接（客户端收到的 body 是 CallEntity）。
// msgType 由调用方定：回包透传 RESPONSE、服务端主动调是 REQUEST、广播是 NOTIFY。
func (h *Hub) sendCallEntity(connID, entityID, method string, callbackID uint32, content []byte, msgType pb.MsgType) {
	h.deliverDown(connID, method, &pb.ClientDownlink{
		Body: &pb.ClientDownlink_Call{Call: &pb.CallEntity{EntityId: entityID, Content: content}},
	}, withMsgType(msgType), withCallback(callbackID))
}

// broadcastDown 是组播/全服广播的公共路径：**Envelope 只 marshal 一次**，
// 逐连接 SendBytes（帧编码+写出）。逐连接调 Send 会把同一条消息 proto.Marshal N 遍
// （bench：50 连接 364 allocs → 这条路径 <60）。
// ForwardedDown 按连接计——扇出工作量才是这个指标的语义（单发/组播/全服一致）。
func (h *Hub) broadcastDown(connIDs []string, env *pb.Envelope) {
	b, err := protoMarshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	peers := make([]Peer, 0, len(connIDs))
	for _, cid := range connIDs {
		if p, ok := h.clients[cid]; ok {
			peers = append(peers, p)
		} else {
			h.stats.unknownClient.Add(1)
		}
	}
	h.mu.RUnlock()
	for _, p := range peers {
		if p.SendBytes(b) == nil {
			h.stats.forwardedDown.Add(1)
		}
	}
}

// deliverDown 把一条 ClientDownlink 发给某条客户端连接。
// method 只在 call / global 两种成员上有意义（业务方法名），其余传空。
// Envelope 在这里 marshal 一次，走 SendBytes（与广播同一条零重复-marshal 路径）。
func (h *Hub) deliverDown(connID, method string, down *pb.ClientDownlink, opts ...deliverOpt) {
	o := deliverOptions{msgType: pb.MsgType_MSG_NOTIFY}
	for _, f := range opts {
		f(&o)
	}
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		h.stats.unknownClient.Add(1)
		return
	}
	if p.SendBytes(mustMarshal(&pb.Envelope{MsgType: o.msgType, Method: method, CallbackId: o.callbackID, Body: mustMarshal(down)})) == nil {
		h.stats.forwardedDown.Add(1)
	}
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
	h.stats.kicks.Add(1)
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
